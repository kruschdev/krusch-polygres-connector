/**
 * Configuration loader & Air-Gap guard for @krusch/polygres-connector
 */

import fs from 'fs';
import path from 'path';

export const SCHEMA_VERSION = 1;

/**
 * Robust check if a target host/URL is local, private RFC1918, Docker/K8s, or IPv6 ULA.
 */
export function isPrivateOrLocalHost(target) {
  if (!target) return false; // Fail-closed on empty/null target
  let hostname = target;

  try {
    if (target.startsWith('/') || target.startsWith('socket:')) {
      // Unix domain socket is local
      return true;
    }
    if (target.includes('://')) {
      const parsed = new URL(target);
      hostname = parsed.hostname;
    } else {
      hostname = target.split(':')[0];
    }
  } catch (err) {
    console.error('[Config] Invalid URL:', err.message);
    hostname = target;
  }

  // Strip brackets from IPv6 if present
  hostname = hostname.replace(/^\[|\]$/g, '').toLowerCase();

  // 1. Loopback
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    return true;
  }

  // 2. Local mDNS / Unix domain
  if (hostname.endsWith('.local') || hostname === 'localhost.localdomain') {
    return true;
  }

  // 3. RFC1918: 10.0.0.0/8
  if (/^10\.\d+\.\d+\.\d+$/.test(hostname)) {
    return true;
  }

  // 4. RFC1918: 172.16.0.0/12 (Docker, Kubernetes, WSL)
  const match172 = hostname.match(/^172\.(\d+)\.\d+\.\d+$/);
  if (match172) {
    const secondOctet = parseInt(match172[1], 10);
    if (secondOctet >= 16 && secondOctet <= 31) return true;
  }

  // 5. RFC1918: 192.168.0.0/16
  if (/^192\.168\.\d+\.\d+$/.test(hostname)) {
    return true;
  }

  // 6. Link-Local: 169.254.0.0/16
  if (/^169\.254\.\d+\.\d+$/.test(hostname)) {
    return true;
  }

  // 7. IPv6 ULA / Link-Local: fc00::/7, fd00::/8, fe80::/10
  if (/^(?:fc|fd|fe80)/i.test(hostname)) {
    return true;
  }

  return false;
}

/**
 * Validates that cloud egress is explicitly authorized when connecting to non-local endpoints.
 * Fails closed if target is empty and allowCloud is false.
 */
export function assertCloudAllowed(target, allowCloud) {
  if (allowCloud) return true;
  if (!target) {
    throw new Error(
      `[AirGapSecurityError] Target endpoint is empty or undefined. Cannot verify local boundary without ALLOW_CLOUD=1.`
    );
  }

  if (!isPrivateOrLocalHost(target)) {
    throw new Error(
      `[AirGapSecurityError] Cloud egress to '${target}' blocked. Set ALLOW_CLOUD=1 in your environment to authorize remote communication with Polygres Cloud / Wondersearch.`
    );
  }
  return true;
}

/**
 * Validates that a directory path does not resolve to an air-gapped litigation matter or evidence directory.
 */
export function assertMatterNotPrivileged(targetPath) {
  if (!targetPath) return true;
  let resolvedPath = targetPath;
  try {
    resolvedPath = fs.realpathSync(targetPath);
  } catch (err) {
    console.warn('[config] realpathSync failed:', err.message);
    resolvedPath = path.resolve(targetPath);
  }

  const normalized = resolvedPath.replace(/\\/g, '/').toLowerCase();
  const forbiddenSegments = [
    '/krusch-law/data/matters',
    '/krusch-law/evidence',
    '/data/matters',
    '/matters/',
    '/evidence/'
  ];

  for (const seg of forbiddenSegments) {
    if (normalized.includes(seg) || normalized.endsWith('/matters') || normalized.endsWith('/evidence')) {
      throw new Error(
        `[AirGapSecurityError] Path '${targetPath}' resolves to privileged matter directory ('${resolvedPath}'). Cloud egress is blocked under ABA Model Rule 1.6.`
      );
    }
  }
  return true;
}

/**
 * Mask sensitive credentials in URLs for logging
 */
export function maskUrl(urlString) {
  if (!urlString) return 'none';
  try {
    const parsed = new URL(urlString);
    if (parsed.password) {
      parsed.password = '********';
    }
    return parsed.toString();
  } catch {
    return urlString.replace(/:([^@/:]+)@/, ':********@');
  }
}

/**
 * Mask sensitive API tokens for logging
 */
export function maskToken(token) {
  if (!token) return 'not configured';
  if (token.length <= 8) return '********';
  return token.substring(0, 4) + '...' + token.substring(token.length - 4);
}

export class ConfigurationError extends Error {
  constructor(message, cause = undefined) {
    super(message);
    this.name = 'ConfigurationError';
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

export function loadConfig(overrides = {}) {
  const fileEnv = {};
  const envPath = overrides.envPath
    ? path.resolve(overrides.envPath)
    : path.resolve(process.cwd(), '.env');

  if (fs.existsSync(envPath)) {
    try {
      const lines = fs.readFileSync(envPath, 'utf8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
        const [k, ...v] = trimmed.split('=');
        const key = k.trim();
        const val = v.join('=').trim().replace(/^["']|["']$/g, '');
        if (key) {
          fileEnv[key] = val;
        }
      }
    } catch (err) {
      console.warn(`[PolygresConfig] Failed reading .env at ${envPath}: ${err.message}`);
      throw new ConfigurationError(`Failed reading .env at ${envPath}: ${err.message}`, err);
    }
  }

  const getEnv = (key) =>
    Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : fileEnv[key];

  const gitDbPassword = overrides.gitDbPassword ?? getEnv('KRUSCH_GIT_DB_PASSWORD');
  if (
    overrides.requireGitDbPassword &&
    !overrides.localGitDbUrl &&
    !getEnv('KRUSCH_GIT_DATABASE_URL') &&
    !gitDbPassword
  ) {
    throw new ConfigurationError(
      'Missing required database credentials: set KRUSCH_GIT_DATABASE_URL or KRUSCH_GIT_DB_PASSWORD'
    );
  }

  const defaultLocalGitDbUrl = gitDbPassword
    ? `postgresql://kdcode:${encodeURIComponent(gitDbPassword)}@localhost:5432/kdcode`
    : 'postgresql://localhost:5432/kdcode';

  const localGitDbUrl =
    overrides.localGitDbUrl || getEnv('KRUSCH_GIT_DATABASE_URL') || defaultLocalGitDbUrl;

  const polygresUrl = overrides.polygresUrl !== undefined
    ? overrides.polygresUrl
    : (getEnv('POLYGRES_URL') || getEnv('DATABASE_URL') || getEnv('KRUSCH_GIT_DATABASE_URL') || localGitDbUrl);
  const polygresApiKey = overrides.polygresApiKey || getEnv('POLYGRES_API_KEY') || null;

  // Separate Wondersearch credentials; do not reuse polygresApiKey by default
  const wondersearchApiKey = overrides.wondersearchApiKey || getEnv('WONDERSEARCH_API_KEY') || null;
  const wondersearchBaseUrl = (overrides.wondersearchBaseUrl || getEnv('WONDERSEARCH_BASE_URL') || 'https://api.wondersearch.ai').replace(/\/+$/, '');
  const wondersearchWorkspaceId = overrides.wondersearchWorkspaceId || getEnv('WONDERSEARCH_WORKSPACE_ID') || null;
  const wondersearchDefaultDriveId = overrides.wondersearchDefaultDriveId || getEnv('WONDERSEARCH_DEFAULT_DRIVE_ID') || null;

  const localContextDbPath = overrides.localContextDbPath || getEnv('KRUSCH_CONTEXT_DB_PATH') || path.resolve(process.cwd(), '.agent/context.db');

  const rawAllowCloud = getEnv('ALLOW_CLOUD');
  const allowCloud = overrides.allowCloud !== undefined
    ? Boolean(overrides.allowCloud)
    : (rawAllowCloud === '1' || rawAllowCloud === 'true');

  return {
    polygresUrl,
    polygresApiKey,
    wondersearchApiKey,
    wondersearchBaseUrl,
    wondersearchWorkspaceId,
    wondersearchDefaultDriveId,
    localContextDbPath,
    localGitDbUrl,
    allowCloud,
    ...overrides
  };
}

export function resolvePolygresUrl(config = {}, env = process.env) {
  if (config.polygresUrl !== undefined) {
    return config.polygresUrl;
  }
  return env.POLYGRES_URL || env.DATABASE_URL || null;
}

export function isDebugEnabled(config = {}, env = process.env) {
  if (config.debug !== undefined) {
    return Boolean(config.debug);
  }
  return Boolean(env.KRUSCH_DEBUG);
}

export function getWondersearchConfig(config = {}, env = process.env) {
  const rawApiKey = config.wondersearchApiKey !== undefined
    ? config.wondersearchApiKey
    : (config.apiKey !== undefined ? config.apiKey : (env.WONDERSEARCH_API_KEY || null));

  if (rawApiKey !== null && (typeof rawApiKey !== 'string' || rawApiKey.trim() === '')) {
    throw new ConfigurationError('Invalid Wondersearch API key: must be a non-empty string');
  }
  if (config.requireApiKey && !rawApiKey) {
    throw new ConfigurationError('Missing required Wondersearch API key (WONDERSEARCH_API_KEY)');
  }

  const rawBaseUrl = config.wondersearchBaseUrl || config.baseUrl || env.WONDERSEARCH_BASE_URL || 'https://api.wondersearch.ai';
  if (typeof rawBaseUrl !== 'string' || !rawBaseUrl.trim()) {
    throw new ConfigurationError('Invalid Wondersearch baseUrl: must be a non-empty URL string');
  }

  const baseUrl = rawBaseUrl.trim().replace(/\/+$/, '');
  let parsedUrl;
  try {
    parsedUrl = new URL(baseUrl);
  } catch (err) {
    throw new ConfigurationError(`Invalid Wondersearch baseUrl '${baseUrl}': ${err.message}`, err);
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new ConfigurationError(`Invalid Wondersearch baseUrl protocol '${parsedUrl.protocol}': must be http: or https:`);
  }

  if (Array.isArray(config.allowedHosts) && config.allowedHosts.length > 0) {
    const host = parsedUrl.hostname.toLowerCase();
    const allowed = config.allowedHosts.map((h) => String(h).toLowerCase());
    if (!allowed.includes(host)) {
      throw new ConfigurationError(`Wondersearch host '${host}' is not in allowedHosts whitelist`);
    }
  }

  const workspaceId = config.wondersearchWorkspaceId || config.workspaceId || env.WONDERSEARCH_WORKSPACE_ID || null;
  const defaultDriveId = config.wondersearchDefaultDriveId || config.defaultDriveId || env.WONDERSEARCH_DEFAULT_DRIVE_ID || null;
  const allowCloud = config.allowCloud !== undefined
    ? config.allowCloud
    : (env.ALLOW_CLOUD === '1' || env.ALLOW_CLOUD === 'true' ? true : undefined);

  return {
    apiKey: rawApiKey ? rawApiKey.trim() : null,
    baseUrl,
    workspaceId,
    defaultDriveId,
    allowCloud
  };
}


