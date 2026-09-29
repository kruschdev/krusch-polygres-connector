/**
 * Git Bridge for @krusch/polygres-connector
 * Connects krusch-git (DAG, trees & AST symbol graph) to PostgreSQL / Polygres
 * and codebase semantic search to Wondersearch Drives with 40-char SHA pinning.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { WondersearchBridge } from './wondersearch-bridge.js';
import { assertCloudAllowed, SCHEMA_VERSION } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class GitBridge {
  constructor(config = {}) {
    this.localDbUrl = config.localGitDbUrl || process.env.KRUSCH_GIT_DATABASE_URL;
    this.polygresUrl = config.polygresUrl || process.env.POLYGRES_URL || process.env.DATABASE_URL;
    this.allowCloud = config.allowCloud;

    this.localPool = null;   // Lazy-initialized
    this.sharedRemotePool = config.sharedRemotePool || null;
    this.remotePool = this.sharedRemotePool;
    this.ownsRemotePool = !this.sharedRemotePool;

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
      this.ownsRemotePool = true;
    }
    return this.remotePool;
  }

  async close() {
    if (this.localPool) {
      await this.localPool.end();
      this.localPool = null;
    }
    if (this.remotePool && this.ownsRemotePool) {
      await this.remotePool.end();
      this.remotePool = null;
    }
    await this.wondersearch.close();
  }

  /**
   * Initialize remote schema in PostgreSQL / Polygres using sql/schema_v1.sql
   */
  async initializeRemoteSchema() {
    const remotePool = this._getRemotePool();
    const schemaPath = path.resolve(__dirname, '../sql/schema_v1.sql');
    let sql;
    try {
      sql = fs.readFileSync(schemaPath, 'utf8');
    } catch {
      // Fallback inline schema
      sql = `
        CREATE TABLE IF NOT EXISTS pg_git_repositories (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) UNIQUE NOT NULL,
          description TEXT,
          head_commit_sha VARCHAR(40),
          wondersearch_drive_id VARCHAR(255),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS pg_git_commits (
          id VARCHAR(40) PRIMARY KEY,
          repository_name VARCHAR(255) NOT NULL,
          tree_id VARCHAR(40) NOT NULL,
          parent_id VARCHAR(40),
          parent_shas TEXT[] DEFAULT ARRAY[]::TEXT[],
          message TEXT NOT NULL,
          author VARCHAR(255) NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS pg_git_trees (
          id VARCHAR(40) PRIMARY KEY,
          repository_name VARCHAR(255) NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS pg_git_tree_entries (
          id SERIAL PRIMARY KEY,
          tree_id VARCHAR(40) NOT NULL,
          repository_name VARCHAR(255) NOT NULL,
          type VARCHAR(10) NOT NULL,
          name VARCHAR(255) NOT NULL,
          object_id VARCHAR(40) NOT NULL,
          UNIQUE(tree_id, name)
        );
        CREATE TABLE IF NOT EXISTS pg_git_symbols (
          id SERIAL PRIMARY KEY,
          repository_name VARCHAR(255) NOT NULL,
          commit_sha VARCHAR(40) NOT NULL,
          file_path TEXT NOT NULL,
          symbol_name VARCHAR(255) NOT NULL,
          symbol_type VARCHAR(50) NOT NULL,
          start_line INTEGER NOT NULL,
          end_line INTEGER NOT NULL,
          signature TEXT,
          content TEXT,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(repository_name, commit_sha, file_path, symbol_name, start_line)
        );
        CREATE TABLE IF NOT EXISTS pg_git_symbol_edges (
          id SERIAL PRIMARY KEY,
          repository_name VARCHAR(255) NOT NULL,
          commit_sha VARCHAR(40) NOT NULL,
          source_symbol VARCHAR(255) NOT NULL,
          source_path TEXT NOT NULL,
          target_symbol VARCHAR(255) NOT NULL,
          target_path TEXT NOT NULL,
          relation VARCHAR(50) NOT NULL DEFAULT 'CALLS',
          line_number INTEGER,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(repository_name, commit_sha, source_symbol, source_path, target_symbol, target_path, relation, line_number)
        );
      `;
    }

    await remotePool.query(sql);
  }

  /**
   * Resolves repository tip to an authoritative 40-character commit SHA.
   * Priority: explicit valid SHA > branch tip (main/master/HEAD) > newest commit by created_at.
   */
  async resolveHeadSha(repoId, explicitSha = null) {
    const localPool = this._getLocalPool();

    if (explicitSha && explicitSha !== 'HEAD') {
      if (!/^[0-9a-f]{40}$/i.test(explicitSha)) {
        throw new Error(`Invalid commit SHA '${explicitSha}'. Must be a 40-character hexadecimal string.`);
      }
      const checkRes = await localPool.query(
        'SELECT id FROM commits WHERE repository_id = $1 AND id = $2',
        [repoId, explicitSha]
      );
      if (checkRes.rows.length === 0) {
        throw new Error(`Commit SHA '${explicitSha}' does not exist in local repository.`);
      }
      return explicitSha;
    }

    // 1. Resolve via branches table
    const branchRes = await localPool.query(`
      SELECT commit_id, name FROM branches
      WHERE repository_id = $1 AND name IN ('main', 'master', 'HEAD')
      ORDER BY CASE WHEN name = 'main' THEN 1 WHEN name = 'master' THEN 2 ELSE 3 END
      LIMIT 1;
    `, [repoId]).catch(() => ({ rows: [] }));

    if (branchRes.rows.length > 0 && branchRes.rows[0].commit_id) {
      const branchSha = branchRes.rows[0].commit_id;
      if (/^[0-9a-f]{40}$/i.test(branchSha)) {
        return branchSha;
      }
    }

    // 2. Resolve via newest commit
    const latestCommitRes = await localPool.query(`
      SELECT id FROM commits
      WHERE repository_id = $1
      ORDER BY created_at DESC
      LIMIT 1;
    `, [repoId]);

    if (latestCommitRes.rows.length > 0 && latestCommitRes.rows[0].id) {
      const commitSha = latestCommitRes.rows[0].id;
      if (/^[0-9a-f]{40}$/i.test(commitSha)) {
        return commitSha;
      }
    }

    throw new Error(`Cannot resolve repository #${repoId} to a valid 40-character commit SHA.`);
  }

  /**
   * Push Git DAG (commits, trees) and AST Symbols/Edges from local krusch-git to remote database
   * using chunked multi-row batch inserts within an atomic ACID transaction.
   */
  async pushGitDagAndSymbols(repoName, commitSha = null, options = {}) {
    if (!this.localDbUrl || !this.polygresUrl) {
      throw new Error('pushGitDagAndSymbols() requires both localGitDbUrl and polygresUrl.');
    }
    const { dryRun = false } = options;
    const localPool = this._getLocalPool();
    const remotePool = this._getRemotePool();
    await this.initializeRemoteSchema();

    // 1. Probe local schema
    const schemaProbe = await localPool.query(`
      SELECT to_regclass('repositories') as has_repos, to_regclass('commits') as has_commits;
    `).catch(() => ({ rows: [{}] }));

    if (!schemaProbe.rows[0].has_repos || !schemaProbe.rows[0].has_commits) {
      throw new Error('Local krusch-git database schema missing required tables. Run "krusch-git migrate" or sync local repository first.');
    }

    // 2. Fetch repository from local
    const repoRes = await localPool.query('SELECT id, name, description FROM repositories WHERE name = $1', [repoName]);
    if (repoRes.rows.length === 0) {
      throw new Error(`Repository '${repoName}' not found in local krusch-git database.`);
    }
    const localRepoId = repoRes.rows[0].id;

    // 3. Resolve active 40-character commit SHA
    const activeSha = await this.resolveHeadSha(localRepoId, commitSha);

    // 4. Fetch commits (The Git DAG)
    const commitsRes = await localPool.query(`
      SELECT id, tree_id, parent_id, message, author, created_at
      FROM commits WHERE repository_id = $1
      ORDER BY created_at ASC
    `, [localRepoId]);

    // 5. Fetch trees and tree entries
    const treesRes = await localPool.query(`
      SELECT id, created_at FROM trees WHERE repository_id = $1
    `, [localRepoId]).catch(() => ({ rows: [] }));

    const treeEntriesRes = await localPool.query(`
      SELECT te.tree_id, te.type, te.name, te.object_id
      FROM tree_entries te
      JOIN trees t ON te.tree_id = t.id
      WHERE t.repository_id = $1
    `, [localRepoId]).catch(() => ({ rows: [] }));

    // 6. Fetch symbols
    const symbolsRes = await localPool.query(`
      SELECT file_path, symbol_name, symbol_type, start_line, end_line, signature, content
      FROM code_symbols WHERE repository_id = $1
    `, [localRepoId]);

    // 7. Fetch symbol edges (inspecting column availability)
    let edges = [];
    try {
      const edgeColumnsRes = await localPool.query(`
        SELECT column_name FROM information_schema.columns WHERE table_name = 'code_symbol_edges';
      `);
      const colNames = new Set(edgeColumnsRes.rows.map(r => r.column_name));

      if (colNames.has('source_symbol') && colNames.has('target_symbol')) {
        const directEdges = await localPool.query(`
          SELECT source_symbol, source_path, target_symbol, target_path, relation, line_number
          FROM code_symbol_edges WHERE repository_id = $1
        `, [localRepoId]);
        edges = directEdges.rows;
      } else if (colNames.has('symbols')) {
        const rawEdges = await localPool.query(`
          SELECT source_path, target_path, relation, symbols
          FROM code_symbol_edges WHERE repository_id = $1
        `, [localRepoId]);
        for (const row of rawEdges.rows) {
          const symList = Array.isArray(row.symbols) ? row.symbols : (row.symbols ? [String(row.symbols)] : []);
          for (const s of symList) {
            edges.push({
              source_symbol: s,
              source_path: row.source_path,
              target_symbol: row.target_path,
              target_path: row.target_path,
              relation: row.relation || 'CALLS',
              line_number: 1
            });
          }
        }
      }
    } catch {
      edges = [];
    }

    if (dryRun) {
      return {
        repository: repoName,
        commitSha: activeSha,
        commitsPushed: commitsRes.rows.length,
        treesPushed: treesRes.rows.length,
        treeEntriesPushed: treeEntriesRes.rows.length,
        symbolsPushed: symbolsRes.rows.length,
        edgesPushed: edges.length,
        dryRun: true
      };
    }

    // 8. Execute sync inside a single ACID transaction with sync_runs tracking
    const client = await remotePool.connect();
    let syncRunId = null;

    try {
      await client.query('BEGIN');

      const runRes = await client.query(`
        INSERT INTO sync_runs (domain, workspace_or_repo, commit_sha, status, metadata)
        VALUES ('git', $1, $2, 'running', $3)
        RETURNING id;
      `, [repoName, activeSha, JSON.stringify({ schema_version: SCHEMA_VERSION })]);
      syncRunId = runRes.rows[0].id;

      // Upsert repository record
      await client.query(`
        INSERT INTO pg_git_repositories (name, description, head_commit_sha, updated_at)
        VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
        ON CONFLICT (name) DO UPDATE SET
          description = EXCLUDED.description,
          head_commit_sha = EXCLUDED.head_commit_sha,
          updated_at = CURRENT_TIMESTAMP;
      `, [repoName, repoRes.rows[0].description, activeSha]);

      // Batch insert commits
      const CHUNK_SIZE = 250;
      for (let i = 0; i < commitsRes.rows.length; i += CHUNK_SIZE) {
        const chunk = commitsRes.rows.slice(i, i + CHUNK_SIZE);
        const placeholders = [];
        const params = [];

        chunk.forEach((c, idx) => {
          const off = idx * 8;
          placeholders.push(`($${off + 1}, $${off + 2}, $${off + 3}, $${off + 4}, $${off + 5}, $${off + 6}, $${off + 7}, $${off + 8})`);
          const parentShas = c.parent_id ? [c.parent_id] : [];
          params.push(c.id, repoName, c.tree_id, c.parent_id, parentShas, c.message, c.author, c.created_at);
        });

        await client.query(`
          INSERT INTO pg_git_commits (id, repository_name, tree_id, parent_id, parent_shas, message, author, created_at)
          VALUES ${placeholders.join(', ')}
          ON CONFLICT (id) DO NOTHING;
        `, params);
      }

      // Batch insert trees & tree entries
      if (treesRes.rows.length > 0) {
        for (let i = 0; i < treesRes.rows.length; i += CHUNK_SIZE) {
          const chunk = treesRes.rows.slice(i, i + CHUNK_SIZE);
          const placeholders = chunk.map((_, idx) => `($${idx * 3 + 1}, $${idx * 3 + 2}, $${idx * 3 + 3})`).join(', ');
          const params = [];
          chunk.forEach(t => params.push(t.id, repoName, t.created_at));
          await client.query(`
            INSERT INTO pg_git_trees (id, repository_name, created_at)
            VALUES ${placeholders}
            ON CONFLICT (id) DO NOTHING;
          `, params);
        }
      }

      if (treeEntriesRes.rows.length > 0) {
        for (let i = 0; i < treeEntriesRes.rows.length; i += CHUNK_SIZE) {
          const chunk = treeEntriesRes.rows.slice(i, i + CHUNK_SIZE);
          const placeholders = chunk.map((_, idx) => `($${idx * 5 + 1}, $${idx * 5 + 2}, $${idx * 5 + 3}, $${idx * 5 + 4}, $${idx * 5 + 5})`).join(', ');
          const params = [];
          chunk.forEach(te => params.push(te.tree_id, repoName, te.type, te.name, te.object_id));
          await client.query(`
            INSERT INTO pg_git_tree_entries (tree_id, repository_name, type, name, object_id)
            VALUES ${placeholders}
            ON CONFLICT (tree_id, name) DO NOTHING;
          `, params);
        }
      }

      // Batch upsert symbols on (repository_name, commit_sha, file_path, symbol_name, start_line)
      for (let i = 0; i < symbolsRes.rows.length; i += CHUNK_SIZE) {
        const chunk = symbolsRes.rows.slice(i, i + CHUNK_SIZE);
        const placeholders = [];
        const params = [];

        chunk.forEach((s, idx) => {
          const off = idx * 9;
          placeholders.push(`($${off + 1}, $${off + 2}, $${off + 3}, $${off + 4}, $${off + 5}, $${off + 6}, $${off + 7}, $${off + 8}, $${off + 9})`);
          params.push(repoName, activeSha, s.file_path, s.symbol_name, s.symbol_type, s.start_line, s.end_line, s.signature, s.content);
        });

        await client.query(`
          INSERT INTO pg_git_symbols (
            repository_name, commit_sha, file_path, symbol_name, symbol_type, start_line, end_line, signature, content
          ) VALUES ${placeholders.join(', ')}
          ON CONFLICT (repository_name, commit_sha, file_path, symbol_name, start_line)
          DO UPDATE SET
            end_line = EXCLUDED.end_line,
            signature = EXCLUDED.signature,
            content = EXCLUDED.content;
        `, params);
      }

      // Batch upsert symbol edges
      if (edges.length > 0) {
        for (let i = 0; i < edges.length; i += CHUNK_SIZE) {
          const chunk = edges.slice(i, i + CHUNK_SIZE);
          const placeholders = [];
          const params = [];

          chunk.forEach((e, idx) => {
            const off = idx * 8;
            placeholders.push(`($${off + 1}, $${off + 2}, $${off + 3}, $${off + 4}, $${off + 5}, $${off + 6}, $${off + 7}, $${off + 8})`);
            params.push(repoName, activeSha, e.source_symbol, e.source_path, e.target_symbol, e.target_path, e.relation || 'CALLS', e.line_number || 1);
          });

          await client.query(`
            INSERT INTO pg_git_symbol_edges (
              repository_name, commit_sha, source_symbol, source_path, target_symbol, target_path, relation, line_number
            ) VALUES ${placeholders.join(', ')}
            ON CONFLICT (repository_name, commit_sha, source_symbol, source_path, target_symbol, target_path, relation, line_number)
            DO NOTHING;
          `, params);
        }
      }

      const totalRows = commitsRes.rows.length + symbolsRes.rows.length + edges.length + treesRes.rows.length;
      await client.query(`
        UPDATE sync_runs
        SET status = 'success', rows_synced = $1, finished_at = CURRENT_TIMESTAMP
        WHERE id = $2;
      `, [totalRows, syncRunId]);

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      if (syncRunId) {
        try {
          await remotePool.query(`
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

    return {
      repository: repoName,
      commitSha: activeSha,
      commitsPushed: commitsRes.rows.length,
      treesPushed: treesRes.rows.length,
      treeEntriesPushed: treeEntriesRes.rows.length,
      symbolsPushed: symbolsRes.rows.length,
      edgesPushed: edges.length,
      dryRun: false
    };
  }

  /**
   * Push code blobs to Wondersearch Drive for semantic code search with commit SHA metadata
   */
  async syncCodebaseToWondersearch(repoName, driveName = null, commitSha = null) {
    const localPool = this._getLocalPool();
    const repoRes = await localPool.query('SELECT id FROM repositories WHERE name = $1', [repoName]);
    if (repoRes.rows.length === 0) {
      throw new Error(`Repository '${repoName}' not found in local database.`);
    }
    const localRepoId = repoRes.rows[0].id;
    const activeSha = await this.resolveHeadSha(localRepoId, commitSha);

    const targetDriveName = driveName || `repo-${repoName}`;
    const driveId = await this.wondersearch.createOrGetDrive(targetDriveName);

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
          commit_sha: activeSha
        }
      });
      indexedCount++;
    }

    return {
      repository: repoName,
      driveId,
      commitSha: activeSha,
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
      limit: Math.min(Math.max(1, limit), 100)
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
   * Query AST symbols from PostgreSQL (parameterized SQL, capped limit)
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

    const requestedLimit = typeof options.limit === 'number' ? options.limit : 20;
    const cappedLimit = Math.min(Math.max(1, requestedLimit), 100);
    sql += ` ORDER BY symbol_name ASC LIMIT $${params.length + 1};`;
    params.push(cappedLimit);

    const res = await remotePool.query(sql, params);
    return res.rows;
  }

  /**
   * Authoritative single symbol lookup helper (exact match)
   */
  async findSymbol(repoName, symbolName, options = {}) {
    const remotePool = this._getRemotePool();

    let sql = `
      SELECT file_path, symbol_name, symbol_type, start_line, end_line, signature, content, commit_sha
      FROM pg_git_symbols
      WHERE repository_name = $1 AND symbol_name = $2
    `;
    const params = [repoName, symbolName];

    if (options.sha) {
      sql += ` AND commit_sha = $${params.length + 1}`;
      params.push(options.sha);
    }

    sql += ` ORDER BY start_line ASC LIMIT 1;`;
    const res = await remotePool.query(sql, params);

    if (res.rows.length === 0) return null;
    const s = res.rows[0];
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
   * Walk caller and callee dependency graph via cycle-guarded recursive relational CTEs
   */
  async getDependencyGraph(repoName, symbolName) {
    const remotePool = this._getRemotePool();

    // Inbound callers (who calls this symbol, with visited array cycle guard)
    const inboundRes = await remotePool.query(`
      WITH RECURSIVE callers AS (
        SELECT source_symbol, source_path, target_symbol, target_path, relation, line_number, 1 as depth,
               ARRAY[target_symbol, source_symbol]::TEXT[] as visited
        FROM pg_git_symbol_edges
        WHERE repository_name = $1 AND target_symbol = $2
        UNION
        SELECT e.source_symbol, e.source_path, e.target_symbol, e.target_path, e.relation, e.line_number, c.depth + 1,
               c.visited || e.source_symbol
        FROM pg_git_symbol_edges e
        JOIN callers c ON e.target_symbol = c.source_symbol
        WHERE e.repository_name = $1 AND c.depth < 3 AND NOT (e.source_symbol = ANY(c.visited))
      )
      SELECT DISTINCT source_symbol, source_path, target_symbol, relation, line_number, depth FROM callers;
    `, [repoName, symbolName]);

    // Outbound callees (who does this symbol call, with visited array cycle guard)
    const outboundRes = await remotePool.query(`
      WITH RECURSIVE callees AS (
        SELECT source_symbol, source_path, target_symbol, target_path, relation, line_number, 1 as depth,
               ARRAY[source_symbol, target_symbol]::TEXT[] as visited
        FROM pg_git_symbol_edges
        WHERE repository_name = $1 AND source_symbol = $2
        UNION
        SELECT e.source_symbol, e.source_path, e.target_symbol, e.target_path, e.relation, e.line_number, c.depth + 1,
               c.visited || e.target_symbol
        FROM pg_git_symbol_edges e
        JOIN callees c ON e.source_symbol = c.target_symbol
        WHERE e.repository_name = $1 AND c.depth < 3 AND NOT (e.target_symbol = ANY(c.visited))
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
