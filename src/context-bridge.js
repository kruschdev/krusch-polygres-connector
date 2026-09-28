/**
 * Context Bridge for @krusch/polygres-connector
 * Connects krusch-context-mcp working memory (.agent/context.db) with Polygres Cloud pgContext.
 */

import fs from 'fs';
import pg from 'pg';
import { DatabaseSync } from 'node:sqlite';

export class ContextBridge {
  constructor(config = {}) {
    this.contextDbPath = config.localContextDbPath;
    this.polygresUrl = config.polygresUrl || process.env.POLYGRES_URL || process.env.DATABASE_URL;
    this.pool = this.polygresUrl ? new pg.Pool({ connectionString: this.polygresUrl }) : null;
  }

  async close() {
    if (this.pool) {
      await this.pool.end();
    }
  }

  /**
   * Initialize remote table in Polygres Cloud
   */
  async initializeRemoteSchema() {
    if (!this.pool) throw new Error('ContextBridge requires polygresUrl to connect.');

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS pg_context_items (
        id SERIAL PRIMARY KEY,
        local_id INTEGER,
        category VARCHAR(50) NOT NULL,
        content TEXT NOT NULL,
        status VARCHAR(20) DEFAULT 'active',
        parent_id INTEGER,
        superseded_by INTEGER,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        source_workspace VARCHAR(255) DEFAULT 'default',
        metadata JSONB DEFAULT '{}'::jsonb,
        UNIQUE(source_workspace, local_id)
      );

      CREATE INDEX IF NOT EXISTS idx_pg_context_category ON pg_context_items(category);
      CREATE INDEX IF NOT EXISTS idx_pg_context_status ON pg_context_items(status);
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
      // Query items from context_items table
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
   * Push local working memory entries to Polygres Cloud
   */
  async pushLocalContext(workspaceName = 'homelab') {
    if (!this.pool) throw new Error('ContextBridge requires polygresUrl to push.');
    await this.initializeRemoteSchema();

    const localEntries = this.readLocalEntries();
    if (localEntries.length === 0) {
      return { pushed: 0, total: 0 };
    }

    let pushedCount = 0;
    for (const entry of localEntries) {
      const meta = typeof entry.metadata === 'string' ? entry.metadata : JSON.stringify(entry.metadata || {});
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
          updated_at = CURRENT_TIMESTAMP;
      `;
      await this.pool.query(query, [
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

    return { pushed: pushedCount, total: localEntries.length };
  }

  /**
   * Pull active invariants & decisions from Polygres Cloud for remote agent hydration
   */
  async pullRemoteContext(workspaceName = 'homelab') {
    if (!this.pool) throw new Error('ContextBridge requires polygresUrl to pull.');
    await this.initializeRemoteSchema();

    const res = await this.pool.query(`
      SELECT local_id, category, content, status, parent_id, superseded_by, created_at, metadata
      FROM pg_context_items
      WHERE source_workspace = $1 AND status = 'active'
      ORDER BY category ASC, id ASC
    `, [workspaceName]);

    return res.rows;
  }
}
