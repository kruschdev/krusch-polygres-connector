/**
 * Hermetic in-memory database fixture for @krusch/polygres-connector.
 * Activated automatically when KRUSCH_EPHEMERAL=1 in isolated test/CI environments.
 */

const DEFAULT_SHA = 'a1b2c3d4e5f60123456789abcdef0123456789ab';
const DEFAULT_TREE_SHA = 'b1b2c3d4e5f60123456789abcdef0123456789ab';

export function isEphemeralMode() {
  return process.env.KRUSCH_EPHEMERAL === '1' || process.env.KRUSCH_EPHEMERAL === 'true';
}

export function createMockPolygresPool() {
  async function query(sqlText, params = []) {
    const sql = String(sqlText || '').trim();
    const norm = sql.replace(/\s+/g, ' ').toUpperCase();

    if (norm.startsWith('SELECT 1')) {
      return { rows: [{ ping: 1 }], rowCount: 1 };
    }

    if (norm.includes('COUNT(*) AS REPOS FROM REPOSITORIES')) {
      return { rows: [{ repos: '1' }], rowCount: 1 };
    }

    if (norm.includes('FROM INFORMATION_SCHEMA.TABLES')) {
      return {
        rows: [
          { table_name: 'pg_context_items' },
          { table_name: 'pg_git_repositories' },
          { table_name: 'pg_git_commits' },
          { table_name: 'pg_git_trees' },
          { table_name: 'pg_git_tree_entries' },
          { table_name: 'pg_git_symbols' },
          { table_name: 'pg_git_symbol_edges' }
        ],
        rowCount: 7
      };
    }

    if (norm.includes('COUNT(*) AS RUNS FROM SYNC_RUNS')) {
      return { rows: [{ runs: '2' }], rowCount: 1 };
    }

    if (norm.includes("TO_REGCLASS('REPOSITORIES')")) {
      return { rows: [{ has_repos: 'repositories', has_commits: 'commits' }], rowCount: 1 };
    }

    if (norm.includes("TO_REGCLASS('IDE_AGENT_MEMORY')")) {
      return { rows: [{ tbl: 'ide_agent_memory' }], rowCount: 1 };
    }

    if (norm.includes('FROM REPOSITORIES WHERE NAME = $1')) {
      return {
        rows: [{ id: 1, name: String(params[0] || 'krusch-git'), description: 'Hermetic baseline repository' }],
        rowCount: 1
      };
    }

    if (norm.includes('FROM COMMITS WHERE REPOSITORY_ID = $1 ORDER BY CREATED_AT DESC LIMIT 1')) {
      return { rows: [{ id: DEFAULT_SHA }], rowCount: 1 };
    }

    if (norm.includes('FROM COMMITS WHERE REPOSITORY_ID = $1')) {
      return {
        rows: [{
          id: DEFAULT_SHA,
          tree_id: DEFAULT_TREE_SHA,
          parent_id: null,
          message: 'Hermetic test commit',
          author: 'krusch',
          created_at: new Date()
        }],
        rowCount: 1
      };
    }

    if (norm.includes('FROM TREES WHERE REPOSITORY_ID = $1')) {
      return { rows: [{ id: DEFAULT_TREE_SHA, created_at: new Date() }], rowCount: 1 };
    }

    if (norm.includes('FROM TREE_ENTRIES')) {
      return { rows: [], rowCount: 0 };
    }

    if (norm.includes('FROM CODE_SYMBOLS WHERE REPOSITORY_ID = $1')) {
      return {
        rows: [
          {
            file_path: 'lib/embedding.js',
            symbol_name: 'calculateCentroid',
            symbol_type: 'function',
            start_line: 10,
            end_line: 42,
            signature: 'export function calculateCentroid(vectors = [])',
            content: 'export function calculateCentroid(vectors = []) { return []; }'
          }
        ],
        rowCount: 1
      };
    }

    if (norm.includes("TABLE_NAME = 'CODE_SYMBOL_EDGES'")) {
      return {
        rows: [{ column_name: 'source_symbol' }, { column_name: 'target_symbol' }],
        rowCount: 2
      };
    }

    if (norm.includes('FROM CODE_SYMBOL_EDGES WHERE REPOSITORY_ID = $1')) {
      return {
        rows: [
          {
            source_symbol: 'syncToPg',
            source_path: 'scripts/sync_to_pg.js',
            target_symbol: '../db/pool.js',
            target_path: 'db/pool.js',
            relation: 'IMPORTS',
            line_number: 5
          }
        ],
        rowCount: 1
      };
    }

    if (norm.startsWith('INSERT INTO SYNC_RUNS')) {
      return { rows: [{ id: 1 }], rowCount: 1 };
    }

    if (norm.includes('FROM PG_GIT_SYMBOLS S JOIN PG_CONTEXT_ITEMS C')) {
      return {
        rows: [
          {
            symbol_name: 'calculateCentroid',
            file_path: 'lib/embedding.js',
            symbol_type: 'function',
            start_line: 10,
            end_line: 42,
            signature: 'export function calculateCentroid(vectors = [])',
            context_id: 1,
            context_category: 'invariant',
            context_content: 'INV-GIT-01: AST caller verification required for calculateCentroid in lib/embedding.js',
            context_status: 'active'
          }
        ],
        rowCount: 1
      };
    }

    if (norm.includes('FROM PG_GIT_SYMBOLS')) {
      const symName = String(params[1] || 'calculateCentroid').replace(/%/g, '') || 'calculateCentroid';
      const filePath = symName === 'calculateCentroid' ? 'lib/embedding.js' : 'db/pool.js';
      return {
        rows: [
          {
            file_path: filePath,
            symbol_name: symName,
            symbol_type: 'function',
            start_line: 10,
            end_line: 42,
            signature: `export function ${symName}(vectors = [])`,
            content: `export function ${symName}(vectors = []) {}`,
            commit_sha: DEFAULT_SHA
          }
        ],
        rowCount: 1
      };
    }

    if (norm.startsWith('WITH RECURSIVE CALLERS AS')) {
      const targetSym = String(params[1] || '../db/pool.js');
      return {
        rows: [
          {
            source_symbol: 'syncToPg',
            source_path: 'scripts/sync_to_pg.js',
            target_symbol: targetSym,
            relation: 'IMPORTS',
            line_number: 5,
            depth: 1
          }
        ],
        rowCount: 1
      };
    }

    if (norm.startsWith('WITH RECURSIVE CALLEES AS')) {
      return { rows: [], rowCount: 0 };
    }

    if (norm.includes('FROM PG_CONTEXT_ITEMS') || norm.includes('FROM IDE_AGENT_MEMORY')) {
      if (norm.includes("CATEGORY = $") && params.includes('blocker')) {
        return { rows: [], rowCount: 0 };
      }
      return {
        rows: [
          {
            local_id: 1,
            category: 'invariant',
            content: 'INV-GIT-01: AST caller verification required for db/pool.js and calculateCentroid in lib/embedding.js',
            status: 'active',
            parent_id: null,
            superseded_by: null,
            created_at: new Date(),
            metadata: {}
          }
        ],
        rowCount: 1
      };
    }

    return { rows: [], rowCount: 0 };
  }

  return {
    query,
    async connect() {
      return {
        query,
        release() {}
      };
    },
    async end() {},
    on() {}
  };
}
