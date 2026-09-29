/**
 * Configuration loader & Air-Gap guard for @krusch/polygres-connector
 */

import path from 'path';

/**
 * Validates that cloud egress is explicitly authorized when connecting to non-local endpoints.
 */
export function assertCloudAllowed(target, allowCloud) {
  if (allowCloud) return true;
  if (!target) return true;

  // Local/private targets are always permitted without cloud egress flag
  const isLocal = /localhost|127\.0\.0\.1|::1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+/i.test(target);
  if (!isLocal) {
    throw new Error(
      `[AirGapSecurityError] Cloud egress to '${target}' blocked. Set ALLOW_CLOUD=1 in your environment to authorize remote communication with Polygres Cloud / Wondersearch.`
    );
  }
  return true;
}

export function loadConfig(overrides = {}) {
  const polygresUrl = overrides.polygresUrl || process.env.POLYGRES_URL || process.env.DATABASE_URL || null;
  const polygresApiKey = overrides.polygresApiKey || process.env.POLYGRES_API_KEY || null;

  const wondersearchApiKey = overrides.wondersearchApiKey || process.env.WONDERSEARCH_API_KEY || polygresApiKey || null;
  const wondersearchBaseUrl = (overrides.wondersearchBaseUrl || process.env.WONDERSEARCH_BASE_URL || 'https://api.wondersearch.ai').replace(/\/+$/, '');
  const wondersearchWorkspaceId = overrides.wondersearchWorkspaceId || process.env.WONDERSEARCH_WORKSPACE_ID || null;

  const localContextDbPath = overrides.localContextDbPath || process.env.KRUSCH_CONTEXT_DB_PATH || path.resolve(process.cwd(), '.agent/context.db');
  const localGitDbUrl = overrides.localGitDbUrl || process.env.KRUSCH_GIT_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/kruschdb';

  const allowCloud = overrides.allowCloud !== undefined
    ? Boolean(overrides.allowCloud)
    : (process.env.ALLOW_CLOUD === '1' || process.env.ALLOW_CLOUD === 'true');

  return {
    polygresUrl,
    polygresApiKey,
    wondersearchApiKey,
    wondersearchBaseUrl,
    wondersearchWorkspaceId,
    localContextDbPath,
    localGitDbUrl,
    allowCloud,
    ...overrides
  };
}
