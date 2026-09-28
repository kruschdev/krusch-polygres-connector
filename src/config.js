/**
 * Configuration loader for @krusch/polygres-connector
 */

import path from 'path';

export function loadConfig(overrides = {}) {
  const polygresUrl = overrides.polygresUrl || process.env.POLYGRES_URL || process.env.DATABASE_URL || null;
  const polygresApiKey = overrides.polygresApiKey || process.env.POLYGRES_API_KEY || null;

  const wondersearchApiKey = overrides.wondersearchApiKey || process.env.WONDERSEARCH_API_KEY || polygresApiKey || null;
  const wondersearchBaseUrl = (overrides.wondersearchBaseUrl || process.env.WONDERSEARCH_BASE_URL || 'https://api.wondersearch.ai').replace(/\/+$/, '');
  const wondersearchWorkspaceId = overrides.wondersearchWorkspaceId || process.env.WONDERSEARCH_WORKSPACE_ID || null;

  const localContextDbPath = overrides.localContextDbPath || process.env.KRUSCH_CONTEXT_DB_PATH || path.resolve(process.cwd(), '.agent/context.db');
  const localGitDbUrl = overrides.localGitDbUrl || process.env.KRUSCH_GIT_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/kruschdb';

  return {
    polygresUrl,
    polygresApiKey,
    wondersearchApiKey,
    wondersearchBaseUrl,
    wondersearchWorkspaceId,
    localContextDbPath,
    localGitDbUrl,
    ...overrides
  };
}
