/**
 * Configuration loader & Air-Gap guard for @krusch/polygres-connector
 */

import path from 'path';

/**
 * Robust check if a target host/URL is local, private RFC1918, Docker/K8s, or IPv6 ULA.
 */
export function isPrivateOrLocalHost(target) {
  if (!target) return true;
  let hostname = target;

  try {
    if (target.includes('://')) {
      const parsed = new URL(target);
      hostname = parsed.hostname;
    } else {
      hostname = target.split(':')[0];
    }
  } catch {
    hostname = target;
  }

  // Strip brackets from IPv6 if present
  hostname = hostname.replace(/^\[|\]$/g, '').toLowerCase();

  // 1. Loopback
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    return true;
  }

  // 2. RFC1918: 10.0.0.0/8
  if (/^10\.\d+\.\d+\.\d+$/.test(hostname)) {
    return true;
  }

  // 3. RFC1918: 172.16.0.0/12 (Docker, Kubernetes, WSL)
  const match172 = hostname.match(/^172\.(\d+)\.\d+\.\d+$/);
  if (match172) {
    const secondOctet = parseInt(match172[1], 10);
    if (secondOctet >= 16 && secondOctet <= 31) return true;
  }

  // 4. RFC1918: 192.168.0.0/16
  if (/^192\.168\.\d+\.\d+$/.test(hostname)) {
    return true;
  }

  // 5. Link-Local: 169.254.0.0/16
  if (/^169\.254\.\d+\.\d+$/.test(hostname)) {
    return true;
  }

  // 6. IPv6 ULA / Link-Local: fc00::/7, fd00::/8, fe80::/10
  if (/^(?:fc|fd|fe80)/i.test(hostname)) {
    return true;
  }

  return false;
}

/**
 * Validates that cloud egress is explicitly authorized when connecting to non-local endpoints.
 */
export function assertCloudAllowed(target, allowCloud) {
  if (allowCloud) return true;
  if (!target) return true;

  if (!isPrivateOrLocalHost(target)) {
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
