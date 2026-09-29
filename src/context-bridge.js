/**
 * Context Bridge for @krusch/polygres-connector
 * Connects krusch-context-mcp working memory (.agent/context.db) with Polygres Cloud.
 */

import fs from 'fs';
import pg from 'pg';
import { DatabaseSync } from 'node:sqlite';
import { assertCloudAllowed } from './config.js';

export const SENSITIVE_PATTERNS = [
  /sk-[a-zA-Z0-9_-]{20,}/i,                                      // OpenAI / OpenRouter / Anthropic keys
  /cfut_[a-zA-Z0-9_-]{20,}/i,                                    // Cloudflare tokens
  /ghp_[a-zA-Z0-9]{20,}/i,                                       // GitHub personal access tokens
  /glpat-[a-zA-Z0-9_-]{20,}/i,                                   // GitLab tokens
  /AKIA[0-9A-Z]{16}/,                                            // AWS Access Key ID
  /xox[baprs]-[0-9a-zA-Z]{10,}/,                                 // Slack API tokens
  /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/, // Generic JWT tokens
  /-----BEGIN [A-Z ]*(?:PRIVATE KEY|KEY BLOCK)-----/i,           // Cryptographic private keys
  /(?:password|passwd|secret)\s*[:=]\s*['"][^'"]{8,}['"]/i       // Plaintext hardcoded passwords
];

/**
 * Validates that memory entries do not contain sensitive tokens, API keys, or private keys.
 */
export function sanitizeMemoryRecord(record) {
  const content = (record.content || record.body || '') + ' ' + JSON.stringify(record.metadata || {});
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(content)) {
      throw new Error(
        `[SanitizationError] Memory record #${record.id || record.local_id || 'new'} contains sensitive credentials (${pattern}). Sync to remote cloud rejected.`
      );
    }
  }
  return true;
}

export class ContextBridge {
  constructor(config = {}) {
    this.contextDbPath = config.localContextDbPath;
    this.polygresUrl = config.polygresUrl || process.env.POLYGRES_URL || process.env.DATABASE_URL;
    this.allowCloud = config.allowCloud;
    this.pool = null; // Lazy-initialized
  }

  _getPool() {
    if (!this.pool) {
      if (!this.polygresUrl) {
        throw new Error('ContextBridge requires polygresUrl to connect to remote database.');
      }
      assertCloudAllowed(this.polygresUrl, this.allowCloud);
      this.pool = new pg.Pool({ connectionString: this.polygresUrl });
    }
    return this.pool;
  }

  async close() {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  /**
   * Initialize remote table in Polygres Cloud
   */
  async initializeRemoteSchema() {
    const pool = this._getPool();

    await pool.query(`
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

      CREATE INDEX IF NOT EXISTS idx_pg_context_category ON pg_context_items(category);
      CREATE INDEX IF NOT EXISTS idx_pg_context_status ON pg_context_items(status);
      CREATE INDEX IF NOT EXISTS idx_pg_context_workspace ON pg_context_items(source_workspace);
    `);
  }

  /**
   * Read all active entries from local SQLite .agent/context.db
   */
  readLocalEntries() {
    if (!fs.existsSync(this.contextDbPath)) {
      return [];
    }

    try {
      const db = new DatabaseSync(this.contextDbPath);
      const stmt = db.prepare(`
        SELECT id, category, content, status, parent_id, superseded_by, created_at, metadata
        FROM context_items
        ORDER BY id ASC
      `);
      const rows = stmt.all();
      db.close();
      return rows;
    } catch (err) {
      console.warn(`[ContextBridge] Could not read local SQLite database: ${err.message}`);
      return [];
    }
  }

  /**
   * Push local working memory entries to Polygres Cloud with pre-sync sanitization and transactional safety
   */
  async pushLocalContext(workspaceName = 'homelab', options = {}) {
    const pool = this._getPool();
    await this.initializeRemoteSchema();

    const localEntries = this.readLocalEntries();
    if (localEntries.length === 0) {
      return { pushed: 0, skipped: 0, total: 0 };
    }

    // Pre-sync sanitization filter
    const validEntries = [];
    let skippedCount = 0;

    for (const entry of localEntries) {
      try {
        sanitizeMemoryRecord(entry);
        validEntries.push(entry);
      } catch (err) {
        if (options.skipInvalid) {
          console.warn(`[ContextBridge] Skipping dirty record #${entry.id}: ${err.message}`);
          skippedCount++;
        } else {
          throw err;
        }
      }
    }

    if (validEntries.length === 0) {
      return { pushed: 0, skipped: skippedCount, total: localEntries.length };
    }

    // Execute within a single ACID transaction
    const client = await pool.connect();
    let pushedCount = 0;

    try {
      await client.query('BEGIN');

      const query = `
        INSERT INTO pg_context_items (
          local_id, category, content, status, parent_id, superseded_by, source_workspace, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
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

      for (const entry of validEntries) {
        const meta = typeof entry.metadata === 'string' ? entry.metadata : JSON.stringify(entry.metadata || {});
        await client.query(query, [
          entry.id,
          entry.category,
          entry.content,
          entry.status || 'active',
          entry.parent_id || null,
          entry.superseded_by || null,
          workspaceName,
          meta
        ]);
        pushedCount++;
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return { pushed: pushedCount, skipped: skippedCount, total: localEntries.length };
  }

  /**
   * Pull active invariants & decisions from Polygres Cloud for remote agent hydration
   */
  async pullRemoteContext(workspaceName = 'homelab') {
    const pool = this._getPool();
    await this.initializeRemoteSchema();

    const res = await pool.query(`
      SELECT local_id, category, content, status, parent_id, superseded_by, created_at, metadata
      FROM pg_context_items
      WHERE source_workspace = $1 AND status = 'active'
      ORDER BY category ASC, local_id ASC
    `, [workspaceName]);

    return res.rows;
  }

  /**
   * Get active invariants specifically for agent prompt turn-1 hydration
   */
  async getActiveInvariants(workspaceName = 'homelab') {
    const items = await this.pullRemoteContext(workspaceName);
    return items.filter(i => i.category === 'invariant');
  }

  /**
   * Retire or supersede a rule in Polygres Cloud with mandatory lineage justification
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
