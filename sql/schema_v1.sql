-- @krusch/polygres-connector: Remote PostgreSQL Schema v1
-- Compatible with plain PostgreSQL and Polygres-hosted databases.

-- 1. Sync Runs Audit Log (Track snapshot runs, row counts, and status)
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

CREATE INDEX IF NOT EXISTS idx_sync_runs_target ON sync_runs(domain, workspace_or_repo);
CREATE INDEX IF NOT EXISTS idx_sync_runs_status ON sync_runs(status);

-- 2. Working Memory & Invariants (pgContext compatible)
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

-- 3. Repositories Registry
CREATE TABLE IF NOT EXISTS pg_git_repositories (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) UNIQUE NOT NULL,
  description TEXT,
  head_commit_sha VARCHAR(40),
  wondersearch_drive_id VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 4. Commits (The Git DAG)
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

CREATE INDEX IF NOT EXISTS idx_pg_git_commits_repo ON pg_git_commits(repository_name);

-- 5. Trees and Tree Entries
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

CREATE INDEX IF NOT EXISTS idx_pg_git_tree_entries_tree ON pg_git_tree_entries(tree_id);

-- 6. AST Symbols
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

CREATE INDEX IF NOT EXISTS idx_pg_git_symbols_repo_name ON pg_git_symbols(repository_name, symbol_name);
CREATE INDEX IF NOT EXISTS idx_pg_git_symbols_repo_sha ON pg_git_symbols(repository_name, commit_sha);

-- 7. AST Symbol Edges (Caller & Callee Graph)
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

CREATE INDEX IF NOT EXISTS idx_pg_git_edges_repo ON pg_git_symbol_edges(repository_name, source_symbol);
CREATE INDEX IF NOT EXISTS idx_pg_git_edges_target ON pg_git_symbol_edges(repository_name, target_symbol);
CREATE INDEX IF NOT EXISTS idx_pg_git_edges_sha ON pg_git_symbol_edges(repository_name, commit_sha);
