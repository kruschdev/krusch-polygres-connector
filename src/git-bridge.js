/**
 * Git Bridge for @krusch/polygres-connector
 * Connects krusch-git (DAG & AST symbol graph) to Polygres Cloud (pgGraph)
 * and codebase semantic search to Wondersearch Drives.
 */

import pg from 'pg';
import { WondersearchBridge } from './wondersearch-bridge.js';

export class GitBridge {
  constructor(config = {}) {
    this.localDbUrl = config.localGitDbUrl || process.env.KRUSCH_GIT_DATABASE_URL;
    this.polygresUrl = config.polygresUrl || process.env.POLYGRES_URL || process.env.DATABASE_URL;

    this.localPool = this.localDbUrl ? new pg.Pool({ connectionString: this.localDbUrl }) : null;
    this.remotePool = this.polygresUrl ? new pg.Pool({ connectionString: this.polygresUrl }) : null;

    this.wondersearch = new WondersearchBridge(config);
  }

  async close() {
    if (this.localPool) await this.localPool.end();
    if (this.remotePool) await this.remotePool.end();
  }

  /**
   * Initialize remote schema in Polygres Cloud for Git DAG & AST symbols
   */
  async initializeRemoteSchema() {
    if (!this.remotePool) throw new Error('GitBridge requires polygresUrl.');

    await this.remotePool.query(`
      CREATE TABLE IF NOT EXISTS pg_git_repositories (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        description TEXT,
        wondersearch_drive_id VARCHAR(255),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS pg_git_commits (
        id VARCHAR(40) PRIMARY KEY,
        repository_name VARCHAR(255) NOT NULL,
        tree_id VARCHAR(40) NOT NULL,
        parent_id VARCHAR(40),
        message TEXT NOT NULL,
        author VARCHAR(255) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS pg_git_symbols (
        id SERIAL PRIMARY KEY,
        repository_name VARCHAR(255) NOT NULL,
        file_path TEXT NOT NULL,
        symbol_name VARCHAR(255) NOT NULL,
        symbol_type VARCHAR(50) NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        signature TEXT,
        content TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS pg_git_symbol_edges (
        id SERIAL PRIMARY KEY,
        repository_name VARCHAR(255) NOT NULL,
        source_path TEXT NOT NULL,
        target_path TEXT NOT NULL,
        relation VARCHAR(50) NOT NULL,
        symbol_name VARCHAR(255)
      );

      CREATE INDEX IF NOT EXISTS idx_pg_git_symbols_repo_name ON pg_git_symbols(repository_name, symbol_name);
      CREATE INDEX IF NOT EXISTS idx_pg_git_commits_repo ON pg_git_commits(repository_name);
      CREATE INDEX IF NOT EXISTS idx_pg_git_edges_repo ON pg_git_symbol_edges(repository_name);
    `);
  }

  /**
   * Push Git DAG (commits, tree) and AST Symbols from local krusch-git to Polygres Cloud
   */
  async pushGitDagAndSymbols(repoName) {
    if (!this.localPool || !this.remotePool) {
      throw new Error('pushGitDagAndSymbols() requires both localGitDbUrl and polygresUrl.');
    }
    await this.initializeRemoteSchema();

    // 1. Fetch repository
    const repoRes = await this.localPool.query('SELECT id, name, description FROM repositories WHERE name = $1', [repoName]);
    if (repoRes.rows.length === 0) {
      throw new Error(`Repository '${repoName}' not found in local krusch-git database.`);
    }
    const localRepoId = repoRes.rows[0].id;

    // Upsert repository in Polygres
    await this.remotePool.query(`
      INSERT INTO pg_git_repositories (name, description)
      VALUES ($1, $2)
      ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description;
    `, [repoName, repoRes.rows[0].description]);

    // 2. Fetch and push commits (The Git DAG)
    const commitsRes = await this.localPool.query(`
      SELECT id, tree_id, parent_id, message, author, created_at
      FROM commits WHERE repository_id = $1
    `, [localRepoId]);

    for (const c of commitsRes.rows) {
      await this.remotePool.query(`
        INSERT INTO pg_git_commits (id, repository_name, tree_id, parent_id, message, author, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (id) DO NOTHING;
      `, [c.id, repoName, c.tree_id, c.parent_id, c.message, c.author, c.created_at]);
    }

    // 3. Fetch and push AST symbols
    const symbolsRes = await this.localPool.query(`
      SELECT file_path, symbol_name, symbol_type, start_line, end_line, signature, content
      FROM code_symbols WHERE repository_id = $1
    `, [localRepoId]);

    // Clear old symbols for this repo and repopulate
    await this.remotePool.query('DELETE FROM pg_git_symbols WHERE repository_name = $1', [repoName]);
    for (const s of symbolsRes.rows) {
      await this.remotePool.query(`
        INSERT INTO pg_git_symbols (
          repository_name, file_path, symbol_name, symbol_type, start_line, end_line, signature, content
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8);
      `, [repoName, s.file_path, s.symbol_name, s.symbol_type, s.start_line, s.end_line, s.signature, s.content]);
    }

    return {
      repository: repoName,
      commitsPushed: commitsRes.rows.length,
      symbolsPushed: symbolsRes.rows.length
    };
  }

  /**
   * Push code blobs to Wondersearch Drive for semantic code search
   */
  async syncCodebaseToWondersearch(repoName, driveName = null) {
    if (!this.localPool) throw new Error('syncCodebaseToWondersearch() requires localGitDbUrl.');

    const targetDriveName = driveName || `repo-${repoName}`;
    const driveId = await this.wondersearch.createOrGetDrive(targetDriveName);

    // Save driveId in Polygres repository record if remote pool is available
    if (this.remotePool) {
      await this.remotePool.query(`
        UPDATE pg_git_repositories SET wondersearch_drive_id = $1 WHERE name = $2;
      `, [driveId, repoName]);
    }

    // Fetch latest blobs
    const blobsRes = await this.localPool.query(`
      SELECT b.id, b.file_path, b.file_name, b.content, b.summary
      FROM blobs b
      JOIN repositories r ON b.repository_id = r.id
      WHERE r.name = $1 AND b.file_path IS NOT NULL
    `, [repoName]);

    let indexedCount = 0;
    for (const b of blobsRes.rows) {
      let text = '';
      if (b.content) {
        text = Buffer.isBuffer(b.content) ? b.content.toString('utf8') : String(b.content);
      }
      if (!text && b.summary) text = b.summary;
      if (!text) continue;

      await this.wondersearch.ingestDocument({
        driveId,
        externalId: b.file_path,
        text,
        metadata: {
          repository: repoName,
          file_name: b.file_name,
          blob_id: b.id
        }
      });
      indexedCount++;
    }

    return {
      repository: repoName,
      driveId,
      documentsIndexed: indexedCount
    };
  }

  /**
   * Search repository code using Wondersearch
   */
  async searchCode(repoName, query, limit = 5) {
    // Resolve driveId
    let driveId = null;
    if (this.remotePool) {
      const res = await this.remotePool.query('SELECT wondersearch_drive_id FROM pg_git_repositories WHERE name = $1', [repoName]);
      if (res.rows.length > 0 && res.rows[0].wondersearch_drive_id) {
        driveId = res.rows[0].wondersearch_drive_id;
      }
    }

    if (!driveId) {
      driveId = await this.wondersearch.createOrGetDrive(`repo-${repoName}`);
    }

    return this.wondersearch.search({
      driveId,
      query,
      limit
    });
  }

  /**
   * Query AST symbols from Polygres Cloud (Find declarations, methods, classes)
   */
  async findSymbols(repoName, query) {
    if (!this.remotePool) throw new Error('findSymbols() requires polygresUrl.');

    const res = await this.remotePool.query(`
      SELECT file_path, symbol_name, symbol_type, start_line, end_line, signature, content
      FROM pg_git_symbols
      WHERE repository_name = $1 AND symbol_name ILIKE $2
      ORDER BY symbol_name ASC
      LIMIT 20;
    `, [repoName, `%${query}%`]);

    return res.rows;
  }
}
