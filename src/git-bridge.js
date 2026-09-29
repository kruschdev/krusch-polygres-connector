/**
 * Git Bridge for @krusch/polygres-connector
 * Connects krusch-git (DAG & AST symbol graph) to Polygres Cloud (pgGraph)
 * and codebase semantic search to Wondersearch Drives with SHA pinning.
 */

import pg from 'pg';
import { WondersearchBridge } from './wondersearch-bridge.js';
import { assertCloudAllowed } from './config.js';

export class GitBridge {
  constructor(config = {}) {
    this.localDbUrl = config.localGitDbUrl || process.env.KRUSCH_GIT_DATABASE_URL;
    this.polygresUrl = config.polygresUrl || process.env.POLYGRES_URL || process.env.DATABASE_URL;
    this.allowCloud = config.allowCloud;

    this.localPool = null;   // Lazy-initialized
    this.remotePool = null;  // Lazy-initialized

    this.wondersearch = new WondersearchBridge(config);
  }

  _getLocalPool() {
    if (!this.localPool) {
      if (!this.localDbUrl) {
        throw new Error('GitBridge requires localGitDbUrl to access local repository database.');
      }
      this.localPool = new pg.Pool({ connectionString: this.localDbUrl });
    }
    return this.localPool;
  }

  _getRemotePool() {
    if (!this.remotePool) {
      if (!this.polygresUrl) {
        throw new Error('GitBridge requires polygresUrl to access remote database.');
      }
      assertCloudAllowed(this.polygresUrl, this.allowCloud);
      this.remotePool = new pg.Pool({ connectionString: this.polygresUrl });
    }
    return this.remotePool;
  }

  async close() {
    if (this.localPool) {
      await this.localPool.end();
      this.localPool = null;
    }
    if (this.remotePool) {
      await this.remotePool.end();
      this.remotePool = null;
    }
  }

  /**
   * Initialize remote schema in Polygres Cloud for Git DAG & AST symbols
   */
  async initializeRemoteSchema() {
    const remotePool = this._getRemotePool();

    await remotePool.query(`
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
        commit_sha VARCHAR(40),
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
        commit_sha VARCHAR(40),
        source_symbol VARCHAR(255) NOT NULL,
        source_path TEXT NOT NULL,
        target_symbol VARCHAR(255) NOT NULL,
        target_path TEXT NOT NULL,
        relation VARCHAR(50) NOT NULL DEFAULT 'CALLS',
        line_number INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_pg_git_symbols_repo_name ON pg_git_symbols(repository_name, symbol_name);
      CREATE INDEX IF NOT EXISTS idx_pg_git_symbols_repo_sha ON pg_git_symbols(repository_name, commit_sha);
      CREATE INDEX IF NOT EXISTS idx_pg_git_commits_repo ON pg_git_commits(repository_name);
      CREATE INDEX IF NOT EXISTS idx_pg_git_edges_repo ON pg_git_symbol_edges(repository_name, source_symbol);
      CREATE INDEX IF NOT EXISTS idx_pg_git_edges_target ON pg_git_symbol_edges(repository_name, target_symbol);
    `);
  }

  /**
   * Push Git DAG (commits, tree) and AST Symbols from local krusch-git to Polygres Cloud with atomic transaction
   */
  async pushGitDagAndSymbols(repoName, commitSha = null) {
    if (!this.localDbUrl || !this.polygresUrl) {
      throw new Error('pushGitDagAndSymbols() requires both localGitDbUrl and polygresUrl.');
    }
    const localPool = this._getLocalPool();
    const remotePool = this._getRemotePool();
    await this.initializeRemoteSchema();

    // 1. Fetch repository from local
    const repoRes = await localPool.query('SELECT id, name, description FROM repositories WHERE name = $1', [repoName]);
    if (repoRes.rows.length === 0) {
      throw new Error(`Repository '${repoName}' not found in local krusch-git database.`);
    }
    const localRepoId = repoRes.rows[0].id;

    // 2. Fetch commits (The Git DAG)
    const commitsRes = await localPool.query(`
      SELECT id, tree_id, parent_id, message, author, created_at
      FROM commits WHERE repository_id = $1
      ORDER BY created_at ASC
    `, [localRepoId]);

    const activeSha = commitSha || (commitsRes.rows.length > 0 ? commitsRes.rows[commitsRes.rows.length - 1].id : 'HEAD');

    // 3. Fetch symbols
    const symbolsRes = await localPool.query(`
      SELECT file_path, symbol_name, symbol_type, start_line, end_line, signature, content
      FROM code_symbols WHERE repository_id = $1
    `, [localRepoId]);

    // 4. Fetch symbol edges (callers & callees)
    const edgesRes = await localPool.query(`
      SELECT source_symbol, source_path, target_symbol, target_path, relation, line_number
      FROM code_symbol_edges WHERE repository_id = $1
    `, [localRepoId]).catch(() => ({ rows: [] }));

    // 5. Execute sync inside a single ACID transaction on remote
    const client = await remotePool.connect();
    try {
      await client.query('BEGIN');

      // Upsert repository in Polygres
      await client.query(`
        INSERT INTO pg_git_repositories (name, description)
        VALUES ($1, $2)
        ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description;
      `, [repoName, repoRes.rows[0].description]);

      // Push commits
      for (const c of commitsRes.rows) {
        await client.query(`
          INSERT INTO pg_git_commits (id, repository_name, tree_id, parent_id, message, author, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (id) DO NOTHING;
        `, [c.id, repoName, c.tree_id, c.parent_id, c.message, c.author, c.created_at]);
      }

      // Replace symbols for this repo atomically
      await client.query('DELETE FROM pg_git_symbols WHERE repository_name = $1', [repoName]);
      for (const s of symbolsRes.rows) {
        await client.query(`
          INSERT INTO pg_git_symbols (
            repository_name, commit_sha, file_path, symbol_name, symbol_type, start_line, end_line, signature, content
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);
        `, [repoName, activeSha, s.file_path, s.symbol_name, s.symbol_type, s.start_line, s.end_line, s.signature, s.content]);
      }

      // Replace symbol edges atomically
      await client.query('DELETE FROM pg_git_symbol_edges WHERE repository_name = $1', [repoName]);
      for (const e of edgesRes.rows) {
        await client.query(`
          INSERT INTO pg_git_symbol_edges (
            repository_name, commit_sha, source_symbol, source_path, target_symbol, target_path, relation, line_number
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8);
        `, [repoName, activeSha, e.source_symbol, e.source_path, e.target_symbol, e.target_path, e.relation || 'CALLS', e.line_number]);
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return {
      repository: repoName,
      commitSha: activeSha,
      commitsPushed: commitsRes.rows.length,
      symbolsPushed: symbolsRes.rows.length,
      edgesPushed: edgesRes.rows.length
    };
  }

  /**
   * Push code blobs to Wondersearch Drive for semantic code search with commit SHA metadata
   */
  async syncCodebaseToWondersearch(repoName, driveName = null, commitSha = 'HEAD') {
    const localPool = this._getLocalPool();

    const targetDriveName = driveName || `repo-${repoName}`;
    const driveId = await this.wondersearch.createOrGetDrive(targetDriveName);

    // Save driveId in Polygres repository record if remote pool is configured
    if (this.polygresUrl) {
      const remotePool = this._getRemotePool();
      await remotePool.query(`
        UPDATE pg_git_repositories SET wondersearch_drive_id = $1 WHERE name = $2;
      `, [driveId, repoName]);
    }

    // Fetch latest blobs
    const blobsRes = await localPool.query(`
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
          blob_id: b.id,
          commit_sha: commitSha
        }
      });
      indexedCount++;
    }

    return {
      repository: repoName,
      driveId,
      commitSha,
      documentsIndexed: indexedCount
    };
  }

  /**
   * Search repository code using Wondersearch with optional SHA assertion
   */
  async searchCode(repoName, query, limit = 5, expectedSha = null) {
    let driveId = null;
    if (this.polygresUrl) {
      const remotePool = this._getRemotePool();
      const res = await remotePool.query('SELECT wondersearch_drive_id FROM pg_git_repositories WHERE name = $1', [repoName]);
      if (res.rows.length > 0 && res.rows[0].wondersearch_drive_id) {
        driveId = res.rows[0].wondersearch_drive_id;
      }
    }

    if (!driveId) {
      driveId = await this.wondersearch.createOrGetDrive(`repo-${repoName}`);
    }

    const searchRes = await this.wondersearch.search({
      driveId,
      query,
      limit
    });

    if (expectedSha) {
      for (const r of searchRes.results) {
        if (r.metadata && r.metadata.commit_sha && r.metadata.commit_sha !== expectedSha) {
          console.warn(`[GitBridge] SHA mismatch detected on passage ${r.externalId}: expected ${expectedSha}, got ${r.metadata.commit_sha}`);
        }
      }
    }

    return searchRes;
  }

  /**
   * Query AST symbols from Polygres Cloud (parameterized SQL, no string interpolation)
   */
  async findSymbols(repoName, query, options = {}) {
    const remotePool = this._getRemotePool();

    let sql = `
      SELECT file_path, symbol_name, symbol_type, start_line, end_line, signature, content, commit_sha
      FROM pg_git_symbols
      WHERE repository_name = $1 AND symbol_name ILIKE $2
    `;
    const params = [repoName, `%${query}%`];

    if (options.sha) {
      sql += ` AND commit_sha = $${params.length + 1}`;
      params.push(options.sha);
    }

    const limit = typeof options.limit === 'number' ? options.limit : 20;
    sql += ` ORDER BY symbol_name ASC LIMIT $${params.length + 1};`;
    params.push(limit);

    const res = await remotePool.query(sql, params);
    return res.rows;
  }

  /**
   * Authoritative single symbol lookup helper
   */
  async findSymbol(repoName, symbolName, options = {}) {
    const symbols = await this.findSymbols(repoName, symbolName, { ...options, limit: 1 });
    if (symbols.length === 0) return null;
    const s = symbols[0];
    return {
      file_path: s.file_path,
      symbol_name: s.symbol_name,
      kind: s.symbol_type,
      location: {
        lines: [s.start_line, s.end_line]
      },
      signature: s.signature,
      commit_sha: s.commit_sha
    };
  }

  /**
   * Walk caller and callee dependency graph via recursive relational CTEs
   */
  async getDependencyGraph(repoName, symbolName) {
    const remotePool = this._getRemotePool();

    // Inbound callers (who calls this symbol)
    const inboundRes = await remotePool.query(`
      WITH RECURSIVE callers AS (
        SELECT source_symbol, source_path, target_symbol, target_path, relation, line_number, 1 as depth
        FROM pg_git_symbol_edges
        WHERE repository_name = $1 AND target_symbol = $2
        UNION
        SELECT e.source_symbol, e.source_path, e.target_symbol, e.target_path, e.relation, e.line_number, c.depth + 1
        FROM pg_git_symbol_edges e
        JOIN callers c ON e.target_symbol = c.source_symbol
        WHERE e.repository_name = $1 AND c.depth < 3
      )
      SELECT DISTINCT source_symbol, source_path, target_symbol, relation, line_number, depth FROM callers;
    `, [repoName, symbolName]);

    // Outbound callees (who does this symbol call)
    const outboundRes = await remotePool.query(`
      WITH RECURSIVE callees AS (
        SELECT source_symbol, source_path, target_symbol, target_path, relation, line_number, 1 as depth
        FROM pg_git_symbol_edges
        WHERE repository_name = $1 AND source_symbol = $2
        UNION
        SELECT e.source_symbol, e.source_path, e.target_symbol, e.target_path, e.relation, e.line_number, c.depth + 1
        FROM pg_git_symbol_edges e
        JOIN callees c ON e.source_symbol = c.target_symbol
        WHERE e.repository_name = $1 AND c.depth < 3
      )
      SELECT DISTINCT source_symbol, target_symbol, target_path, relation, line_number, depth FROM callees;
    `, [repoName, symbolName]);

    return {
      symbol: symbolName,
      repository: repoName,
      inboundCallers: inboundRes.rows,
      outboundCallees: outboundRes.rows
    };
  }
}
