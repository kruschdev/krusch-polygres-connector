/**
 * Context Bridge for @krusch/polygres-connector
 * Connects krusch-context-mcp working memory (.agent/context.db) with Polygres Cloud / PostgreSQL.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { DatabaseSync } from 'node:sqlite';
import { assertCloudAllowed, SCHEMA_VERSION } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const SENSITIVE_PATTERNS = [
  /sk-[a-zA-Z0-9_-]{20,}/g,                                      // OpenAI / OpenRouter / Anthropic keys
  /cfut_[a-zA-Z0-9_-]{20,}/g,                                    // Cloudflare tokens
  /ghp_[a-zA-Z0-9]{20,}/g,                                       // GitHub personal access tokens
  /glpat-[a-zA-Z0-9_-]{20,}/g,                                   // GitLab tokens
  /AKIA[0-9A-Z]{16}/g,                                           // AWS Access Key ID
  /xox[baprs]-[0-9a-zA-Z]{10,}/g,                                // Slack API tokens
  /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, // Generic JWT tokens
  /(?:postgres|postgresql|mysql|redis|mongodb):\/\/[^:\s]+:[^@\s]+@[^\s]+/g, // Connection strings with passwords
  /-----BEGIN [A-Z ]*(?:PRIVATE KEY|KEY BLOCK)-----[\s\S]*?-----END [A-Z ]*(?:PRIVATE KEY|KEY BLOCK)-----/g, // Cryptographic private keys
  /(?:password|passwd|secret)\s*[:=]\s*['"][^'"]{8,}['"]/gi       // Plaintext hardcoded passwords
];

/**
 * Redacts any detected sensitive credentials with [REDACTED_SECRET].
 */
export function redactSensitiveText(text) {
  if (!text || typeof text !== 'string') return text;
  let result = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, '[REDACTED_SECRET]');
  }
  return result;
}

/**
 * Sanitizes or redacts memory entries to prevent leaking credentials.
 */
export function sanitizeMemoryRecord(record, options = {}) {
  const { redact = false } = options;
  const contentStr = record.content || record.body || '';
  const metaStr = typeof record.metadata === 'string' ? record.metadata : JSON.stringify(record.metadata || {});
  const combined = contentStr + ' ' + metaStr;

  let hasSecret = false;
  for (const pattern of SENSITIVE_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(combined)) {
      hasSecret = true;
      break;
    }
  }

  if (hasSecret) {
    if (redact) {
      const redactedContent = redactSensitiveText(contentStr);
      let redactedMetadata = record.metadata;
      if (typeof record.metadata === 'string') {
        redactedMetadata = redactSensitiveText(record.metadata);
      } else if (record.metadata && typeof record.metadata === 'object') {
        redactedMetadata = JSON.parse(redactSensitiveText(JSON.stringify(record.metadata)));
      }
      return {
        record: {
          ...record,
          content: redactedContent,
          metadata: redactedMetadata
        },
        redacted: true
      };
    } else {
      throw new Error(
        `[SanitizationError] Memory record #${record.id || record.local_id || 'new'} contains sensitive credentials. Sync to remote cloud rejected.`
      );
    }
  }

  if (redact) {
    return { record, redacted: false };
  }
  return true;
}

export class ContextBridge {
  constructor(config = {}) {
    this.contextDbPath = config.localContextDbPath;
    this.polygresUrl = config.polygresUrl !== undefined
      ? config.polygresUrl
      : (process.env.POLYGRES_URL || process.env.DATABASE_URL || null);
    this.allowCloud = config.allowCloud;
    this.sharedPool = config.sharedRemotePool || null;
    this.pool = this.sharedPool;
    this.ownsPool = !this.sharedPool;
  }

  _getPool() {
    if (!this.pool) {
      if (!this.polygresUrl) {
        throw new Error('ContextBridge requires polygresUrl to connect to remote database.');
      }
      assertCloudAllowed(this.polygresUrl, this.allowCloud);
      this.pool = new pg.Pool({ connectionString: this.polygresUrl });
      this.ownsPool = true;
    }
    return this.pool;
  }

  async close() {
    if (this.pool && this.ownsPool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  /**
   * Initialize remote table in Polygres / PostgreSQL using sql/schema_v1.sql
   */
  async initializeRemoteSchema() {
    const pool = this._getPool();
    const schemaPath = path.resolve(__dirname, '../sql/schema_v1.sql');
    let sql;
    try {
      sql = fs.readFileSync(schemaPath, 'utf8');
    } catch {
      // Fallback inline schema if file read fails
      sql = `
        CREATE TABLE IF NOT EXISTS pg_context_items (
          id SERIAL PRIMARY KEY,
          local_id INTEGER,
          category VARCHAR(50) NOT NULL,
          content TEXT NOT NULL,
          status VARCHAR(20) DEFAULT 'active',
          parent_id INTEGER,
          superseded_by INTEGER,
          justification TEXT,
          version INTEGER DEFAULT 1,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          source_workspace VARCHAR(255) DEFAULT 'default',
          metadata JSONB DEFAULT '{}'::jsonb,
          UNIQUE(source_workspace, local_id)
        );
        CREATE TABLE IF NOT EXISTS sync_runs (
          id SERIAL PRIMARY KEY,
          domain VARCHAR(50) NOT NULL,
          workspace_or_repo VARCHAR(255) NOT NULL,
          commit_sha VARCHAR(40),
          started_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          finished_at TIMESTAMP WITH TIME ZONE,
          status VARCHAR(20) NOT NULL DEFAULT 'running',
          rows_synced INTEGER DEFAULT 0,
          error_message TEXT,
          metadata JSONB DEFAULT '{}'::jsonb
        );
      `;
    }

    await pool.query(sql);
  }

  /**
   * Read all active entries from local SQLite .agent/context.db
   * Fails noisily if the database is corrupt or locked.
   */
  readLocalEntries() {
    if (!fs.existsSync(this.contextDbPath)) {
      return [];
    }

    let db;
    try {
      db = new DatabaseSync(this.contextDbPath);
      // Check which table exists: ide_agent_memory or context_items
      const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('ide_agent_memory', 'context_items')").all();
      const tableNames = new Set(tableCheck.map(t => t.name));

      if (tableNames.has('ide_agent_memory')) {
        const stmt = db.prepare(`
          SELECT id, category, content, status, supersedes_id, superseded_by, invalidated_reason, created_at, tags
          FROM ide_agent_memory
          ORDER BY id ASC
        `);
        const rows = stmt.all();
        return rows.map(r => ({
          id: r.id,
          category: r.category,
          content: r.content,
          status: (r.status || 'active').toLowerCase(),
          parent_id: r.supersedes_id || null,
          superseded_by: r.superseded_by || null,
          justification: r.invalidated_reason || null,
          created_at: r.created_at,
          metadata: { tags: r.tags || [] }
        }));
      } else if (tableNames.has('context_items')) {
        const stmt = db.prepare(`
          SELECT id, category, content, status, parent_id, superseded_by, created_at, metadata
          FROM context_items
          ORDER BY id ASC
        `);
        return stmt.all();
      }
      return [];
    } catch (err) {
      throw new Error(`[ContextBridge] Local SQLite database at '${this.contextDbPath}' corrupt or unreadable: ${err.message}`);
    } finally {
      if (db) {
        try { db.close(); } catch {}
      }
    }
  }

  /**
   * Write items pulled from remote back to local SQLite database
   */
  writeLocalEntries(items = []) {
    if (!fs.existsSync(path.dirname(this.contextDbPath))) {
      fs.mkdirSync(path.dirname(this.contextDbPath), { recursive: true });
    }

    const db = new DatabaseSync(this.contextDbPath);
    try {
      // Ensure local schema exists
      db.exec(`
        CREATE TABLE IF NOT EXISTS context_items (
          id INTEGER PRIMARY KEY,
          category TEXT NOT NULL,
          content TEXT NOT NULL,
          status TEXT DEFAULT 'active',
          parent_id INTEGER,
          superseded_by INTEGER,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          metadata TEXT DEFAULT '{}'
        );
      `);

      const stmt = db.prepare(`
        INSERT INTO context_items (id, category, content, status, parent_id, superseded_by, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          category = excluded.category,
          content = excluded.content,
          status = excluded.status,
          parent_id = excluded.parent_id,
          superseded_by = excluded.superseded_by,
          metadata = excluded.metadata
      `);

      let writtenCount = 0;
      for (const item of items) {
        const id = item.local_id || item.id;
        const metaStr = typeof item.metadata === 'string' ? item.metadata : JSON.stringify(item.metadata || {});
        stmt.run(
          id,
          item.category,
          item.content,
          item.status || 'active',
          item.parent_id || null,
          item.superseded_by || null,
          metaStr
        );
        writtenCount++;
      }

      return writtenCount;
    } finally {
      db.close();
    }
  }

  /**
   * Push local working memory entries to PostgreSQL with transactional batching and credential redaction
   */
  async pushLocalContext(workspaceName = 'homelab', options = {}) {
    const { dryRun = false, redact = true } = options;
    const pool = this._getPool();
    await this.initializeRemoteSchema();

    const localEntries = this.readLocalEntries();
    if (localEntries.length === 0) {
      return { pushed: 0, redacted: 0, total: 0, dryRun };
    }

    // Pre-sync sanitization and redaction pass
    const processedEntries = [];
    let redactedCount = 0;

    for (const entry of localEntries) {
      const { record, redacted } = sanitizeMemoryRecord(entry, { redact });
      if (redacted) redactedCount++;
      processedEntries.push(record);
    }

    if (dryRun) {
      return {
        pushed: processedEntries.length,
        redacted: redactedCount,
        total: localEntries.length,
        dryRun: true
      };
    }

    // Execute within a single ACID transaction with sync_runs tracking
    const client = await pool.connect();
    let syncRunId = null;

    try {
      await client.query('BEGIN');

      const runRes = await client.query(`
        INSERT INTO sync_runs (domain, workspace_or_repo, status, metadata)
        VALUES ('context', $1, 'running', $2)
        RETURNING id;
      `, [workspaceName, JSON.stringify({ total: processedEntries.length, schema_version: SCHEMA_VERSION })]);
      syncRunId = runRes.rows[0].id;

      // Batch insert in chunks of 250 rows
      const CHUNK_SIZE = 250;
      let pushedCount = 0;

      for (let i = 0; i < processedEntries.length; i += CHUNK_SIZE) {
        const chunk = processedEntries.slice(i, i + CHUNK_SIZE);
        const valuePlaceholders = [];
        const params = [];

        chunk.forEach((entry, idx) => {
          const offset = idx * 8;
          valuePlaceholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}::jsonb)`);

          let metaJson = '{}';
          if (typeof entry.metadata === 'string') {
            metaJson = entry.metadata;
          } else if (entry.metadata && typeof entry.metadata === 'object') {
            metaJson = JSON.stringify(entry.metadata);
          }

          params.push(
            entry.id,
            entry.category,
            entry.content,
            entry.status || 'active',
            entry.parent_id || null,
            entry.superseded_by || null,
            workspaceName,
            metaJson
          );
        });

        const batchSql = `
          INSERT INTO pg_context_items (
            local_id, category, content, status, parent_id, superseded_by, source_workspace, metadata
          ) VALUES ${valuePlaceholders.join(', ')}
          ON CONFLICT (source_workspace, local_id)
          DO UPDATE SET
            category = EXCLUDED.category,
            content = EXCLUDED.content,
            status = EXCLUDED.status,
            parent_id = EXCLUDED.parent_id,
            superseded_by = EXCLUDED.superseded_by,
            metadata = EXCLUDED.metadata,
            version = pg_context_items.version + 1,
            updated_at = CURRENT_TIMESTAMP;
        `;

        await client.query(batchSql, params);
        pushedCount += chunk.length;
      }

      await client.query(`
        UPDATE sync_runs
        SET status = 'success', rows_synced = $1, finished_at = CURRENT_TIMESTAMP
        WHERE id = $2;
      `, [pushedCount, syncRunId]);

      await client.query('COMMIT');
      return { pushed: pushedCount, redacted: redactedCount, total: localEntries.length, dryRun: false };
    } catch (err) {
      await client.query('ROLLBACK');
      if (syncRunId) {
        try {
          await pool.query(`
            UPDATE sync_runs
            SET status = 'failed', error_message = $1, finished_at = CURRENT_TIMESTAMP
            WHERE id = $2;
          `, [err.message, syncRunId]);
        } catch {}
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Pull active invariants & decisions from PostgreSQL for remote agent hydration
   */
  async pullRemoteContext(workspaceName = 'homelab') {
    const pool = this._getPool();
    await this.initializeRemoteSchema();

    const res = await pool.query(`
      SELECT local_id, category, content, status, parent_id, superseded_by, created_at, metadata
      FROM pg_context_items
      WHERE (source_workspace = $1 OR $1 = '*') AND status = 'active'
      ORDER BY category ASC, local_id ASC
    `, [workspaceName]);

    if (res.rows.length === 0) {
      try {
        const memCheck = await pool.query("SELECT to_regclass('ide_agent_memory') as tbl;");
        if (memCheck.rows[0]?.tbl) {
          const altRes = await pool.query(`
            SELECT id as local_id, category, content, LOWER(status) as status,
                   supersedes_id as parent_id, superseded_by, created_at,
                   json_build_object('tags', tags) as metadata
            FROM ide_agent_memory
            WHERE (project = $1 OR $1 = '*' OR $1 = 'default' OR $1 = 'homelab')
              AND UPPER(status) = 'ACTIVE'
            ORDER BY category ASC, id ASC;
          `, [workspaceName]);
          return altRes.rows;
        }
      } catch {}
    }

    return res.rows;
  }

  /**
   * Search active invariants, decisions, or blockers from PostgreSQL matching text or category
   */
  async queryRemoteContext({ workspaceName = 'homelab', query = '', category = null, limit = 50 } = {}) {
    const pool = this._getPool();
    await this.initializeRemoteSchema();

    let sql = `
      SELECT local_id, category, content, status, parent_id, superseded_by, created_at, metadata
      FROM pg_context_items
      WHERE (source_workspace = $1 OR $1 = '*') AND status = 'active'
    `;
    const params = [workspaceName];

    if (query) {
      sql += ` AND content ILIKE $${params.length + 1}`;
      params.push(`%${query}%`);
    }

    if (category) {
      sql += ` AND category = $${params.length + 1}`;
      params.push(category);
    }

    const cappedLimit = Math.min(Math.max(1, limit), 200);
    sql += ` ORDER BY category ASC, local_id ASC LIMIT $${params.length + 1};`;
    params.push(cappedLimit);

    const res = await pool.query(sql, params);
    if (res.rows.length > 0) return res.rows;

    // Fallback to ide_agent_memory if pg_context_items has no matches
    try {
      const memCheck = await pool.query("SELECT to_regclass('ide_agent_memory') as tbl;");
      if (memCheck.rows[0]?.tbl) {
        let altSql = `
          SELECT id as local_id, category, content, LOWER(status) as status,
                 supersedes_id as parent_id, superseded_by, created_at,
                 json_build_object('tags', tags) as metadata
          FROM ide_agent_memory
          WHERE (project = $1 OR $1 = '*' OR $1 = 'default' OR $1 = 'homelab')
            AND UPPER(status) = 'ACTIVE'
        `;
        const altParams = [workspaceName];
        if (query) {
          altSql += ` AND content ILIKE $${altParams.length + 1}`;
          altParams.push(`%${query}%`);
        }
        if (category) {
          altSql += ` AND category = $${altParams.length + 1}`;
          altParams.push(category);
        }
        altSql += ` ORDER BY category ASC, id ASC LIMIT $${altParams.length + 1};`;
        altParams.push(cappedLimit);

        const altRes = await pool.query(altSql, altParams);
        return altRes.rows;
      }
    } catch {}

    return [];
  }

  /**
   * Get active invariants specifically for agent prompt turn-1 hydration
   */
  async getActiveInvariants(workspaceName = 'homelab') {
    const items = await this.pullRemoteContext(workspaceName);
    return items.filter(i => i.category === 'invariant');
  }

  /**
   * Retire or supersede a rule in PostgreSQL with mandatory lineage justification
   */
  async retireRule(workspaceName = 'homelab', localId, supersededBy = null, justification = '') {
    const pool = this._getPool();
    await this.initializeRemoteSchema();

    const status = supersededBy ? 'superseded' : 'invalidated';
    await pool.query(`
      UPDATE pg_context_items
      SET status = $1, superseded_by = $2, justification = $3, updated_at = CURRENT_TIMESTAMP
      WHERE source_workspace = $4 AND local_id = $5;
    `, [status, supersededBy, justification, workspaceName, localId]);

    return { localId, status, supersededBy, justification };
  }
}
