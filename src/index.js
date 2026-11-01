/**
 * @krusch/polygres-connector
 * Standalone plugin & connector toolkit bridging KruschContext and KruschGit
 * with PostgreSQL / Polygres and Wondersearch.
 */

import { existsSync } from 'node:fs';
import pg from 'pg';
import { loadConfig, assertCloudAllowed, SCHEMA_VERSION } from './config.js';
import { ContextBridge } from './context-bridge.js';
import { GitBridge } from './git-bridge.js';
import { WondersearchBridge } from './wondersearch-bridge.js';
import { isEphemeralMode, createMockPolygresPool } from './db-mock.js';

async function resolveCreatePgPool() {
  const siblingPgUrl = new URL('../../../lib/pg.js', import.meta.url);
  if (existsSync(siblingPgUrl)) {
    try {
      const mod = await import(siblingPgUrl.href);
      if (typeof mod.createPgPool === 'function') {
        return mod.createPgPool;
      }
    } catch {
      // Fall through to @krusch/toolkit/pg or standalone CI fallback
    }
  }
  try {
    const mod = await import('@krusch/toolkit/pg');
    if (typeof mod.createPgPool === 'function') {
      return mod.createPgPool;
    }
  } catch {
    // Standalone CI fallback when sibling toolkit is unavailable
  }
  return function standaloneCreatePgPool(dbConfig = {}, options = {}) {
    const connectionString =
      typeof dbConfig === 'string'
        ? dbConfig.trim()
        : String(dbConfig?.connectionString || dbConfig?.url || '').trim();
    const PoolCtor = options.PoolClass || pg['Pool'];
    const pool = Reflect.construct(PoolCtor, [
      {
        connectionString,
        ...(options.max !== undefined ? { max: options.max } : {}),
        ...(options.idleTimeoutMillis !== undefined
          ? { idleTimeoutMillis: options.idleTimeoutMillis }
          : {}),
        ...(options.connectionTimeoutMillis !== undefined
          ? { connectionTimeoutMillis: options.connectionTimeoutMillis }
          : {})
      }
    ]);
    pool.on?.('error', (err) => {
      options.logger?.error?.('Unexpected error on idle PostgreSQL client', err);
    });
    return {
      pool,
      query: (sql, params = []) => pool.query(sql, params),
      close: () => pool.end()
    };
  };
}

const createPgPool = await resolveCreatePgPool();
const silentPoolLogger = {
  info() {},
  debug() {},
  warn() {},
  error() {}
};

export { loadConfig, SCHEMA_VERSION } from './config.js';
export { ContextBridge } from './context-bridge.js';
export { GitBridge } from './git-bridge.js';
export { WondersearchBridge } from './wondersearch-bridge.js';

export class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export function validatePolygresUrl(url) {
  if (!url || typeof url !== 'string') {
    throw new ConfigurationError('Polygres URL is required to obtain a remote pool');
  }
  try {
    const parsed = new URL(url);
    if (!parsed.protocol.startsWith('postgres')) {
      throw new ConfigurationError('polygresUrl must use postgres:// or postgresql:// protocol');
    }
  } catch (err) {
    if (err instanceof ConfigurationError) throw err;
    throw new ConfigurationError('polygresUrl must be a valid URL');
  }
}

export function validateCliString(name, value, { allowRelativeSymbolPath = false } = {}) {
  if (!value || typeof value !== 'string') {
    throw new ConfigurationError(`${name} is invalid: must be a non-empty string`);
  }
  const trimmed = value.trim();
  const pattern = allowRelativeSymbolPath ? /^[\w./@-]+$/ : /^[\w.-]+$/;
  if (!trimmed || !pattern.test(trimmed) || (!allowRelativeSymbolPath && trimmed.includes('..'))) {
    throw new ConfigurationError(`${name} is invalid: contains disallowed characters`);
  }
  return trimmed;
}

/**
 * Convenience factory to create a fully configured connector instance
 * Shares a single remote PostgreSQL pool between Context and Git bridges if polygresUrl is provided.
 */
export function createPolygresConnector(options = {}) {
  const config = loadConfig(options);

  const remotePoolState = {
    pool: null,
    initPromise: null
  };

  const instantiateRemotePool = () => {
    validatePolygresUrl(config.polygresUrl);
    assertCloudAllowed(config.polygresUrl, config.allowCloud);
    const pool = isEphemeralMode()
      ? createMockPolygresPool()
      : createPgPool(
          { connectionString: config.polygresUrl },
          {
            serviceName: 'polygres-connector',
            PoolClass: pg.Pool,
            logger: silentPoolLogger
          }
        ).pool;
    if (typeof pool.on === 'function') {
      pool.on('error', (err) => {
        console.error('[PolygresConnector] Remote pool error:', err.message);
        process.emit('polygresPoolError', err);
        if (typeof pool.end === 'function') {
          Promise.resolve(pool.end()).catch(() => {});
        }
        if (remotePoolState.pool === pool) {
          remotePoolState.pool = null;
          remotePoolState.initPromise = null;
        }
      });
    }
    return pool;
  };

  const getSharedRemotePool = () => {
    if (!remotePoolState.pool) {
      const pool = instantiateRemotePool();
      remotePoolState.pool = pool;
      remotePoolState.initPromise = Promise.resolve(pool);
    }
    return remotePoolState.pool;
  };

  const getSharedRemotePoolAsync = async () => {
    if (remotePoolState.pool) {
      return remotePoolState.pool;
    }
    if (!remotePoolState.initPromise) {
      remotePoolState.initPromise = Promise.resolve().then(() => {
        if (!remotePoolState.pool) {
          remotePoolState.pool = instantiateRemotePool();
        }
        return remotePoolState.pool;
      }).catch((err) => {
        remotePoolState.initPromise = null;
        throw err;
      });
    }
    return remotePoolState.initPromise;
  };

  const context = new ContextBridge({
    ...config,
    get sharedRemotePool() {
      return config.polygresUrl ? getSharedRemotePool() : null;
    }
  });

  const git = new GitBridge({
    ...config,
    get sharedRemotePool() {
      return config.polygresUrl ? getSharedRemotePool() : null;
    }
  });

  const wondersearch = new WondersearchBridge(config);

  return {
    config,
    context,
    git,
    wondersearch,
    getSharedRemotePool,
    getSharedRemotePoolAsync,
    schemaVersion: SCHEMA_VERSION,

    /**
     * Diagnostic network probe verifying connectivity to local and remote data planes
     */
    async probeStatus() {
      const report = {
        schemaVersion: SCHEMA_VERSION,
        allowCloud: config.allowCloud,
        localContext: { ok: false, count: 0, error: null },
        localGit: { ok: false, repos: 0, commits: 0, error: null },
        remotePostgres: { ok: false, tables: [], syncRuns: 0, error: null },
        wondersearch: { ok: false, drives: 0, error: null }
      };

      // 1. Local context SQLite probe
      try {
        const rows = context.readLocalEntries();
        report.localContext.ok = true;
        report.localContext.count = rows.length;
      } catch (err) {
        report.localContext.error = err.message;
      }

      // 2. Local git Postgres probe
      try {
        const localPool = git._getLocalPool();
        const res = await localPool.query('SELECT COUNT(*) as repos FROM repositories;').catch(() => null);
        if (res) {
          report.localGit.ok = true;
          report.localGit.repos = parseInt(res.rows[0].repos, 10);
        } else {
          report.localGit.error = 'Tables missing (run krusch-git migrate)';
        }
      } catch (err) {
        report.localGit.error = err.message;
      }

      // 3. Remote Postgres probe
      if (config.polygresUrl) {
        try {
          const pool = getSharedRemotePool();
          const pingRes = await pool.query('SELECT 1 as ping;');
          if (pingRes) {
            report.remotePostgres.ok = true;
            const tableRes = await pool.query(`
              SELECT table_name FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name LIKE 'pg_git_%' OR table_name = 'pg_context_items';
            `).catch((err) => {
              if (process.env.KRUSCH_DEBUG) console.warn(`[PolygresDoctor] information_schema query warning: ${err.message}`);
              return { rows: [] };
            });
            report.remotePostgres.tables = tableRes.rows.map(r => r.table_name);

            const runsRes = await pool.query('SELECT COUNT(*) as runs FROM sync_runs;').catch((err) => {
              if (process.env.KRUSCH_DEBUG) console.warn(`[PolygresDoctor] sync_runs count warning: ${err.message}`);
              return null;
            });
            if (runsRes) {
              report.remotePostgres.syncRuns = parseInt(runsRes.rows[0].runs, 10);
            }
          }
        } catch (err) {
          report.remotePostgres.error = err.message;
        }
      }

      // 4. Wondersearch probe
      if (config.wondersearchApiKey) {
        try {
          const wsContext = await wondersearch.getWorkspaceContext().catch((err) => {
            if (process.env.KRUSCH_DEBUG) console.warn(`[PolygresDoctor] getWorkspaceContext fallback warning: ${err.message}`);
            return {};
          });
          const targetWorkspaceId = config.wondersearchWorkspaceId || wsContext.workspaceId;
          if (targetWorkspaceId) {
            const listUrl = `${wondersearch.baseUrl}/v1/workspaces/${targetWorkspaceId}/drives`;
            const wsRes = await fetch(listUrl, {
              headers: wondersearch._headers(),
              signal: AbortSignal.timeout(5000)
            });
            if (wsRes.ok) {
              const data = await wsRes.json();
              report.wondersearch.ok = true;
              report.wondersearch.drives = (data.data || data.drives || []).length;
            } else {
              report.wondersearch.error = `HTTP ${wsRes.status}`;
            }
          } else {
            report.wondersearch.error = 'No workspace configured or resolvable';
          }
        } catch (err) {
          report.wondersearch.error = err.message;
        }
      }

      return report;
    },

    /**
     * Cross-substrate bridge combining pgGraph (AST symbol + caller/callee CTE)
     * with KruschContext (active steering invariants, decisions, and blockers).
     */
    async getSymbolContext({ repoName, symbolName, sha = null, workspaceName = null }) {
      if (!repoName || !symbolName) {
        throw new Error('getSymbolContext() requires both repoName and symbolName');
      }
      const targetWorkspace = workspaceName || repoName;

      // 1. AST Symbol declaration from pg_git_symbols
      const symbol = await git.findSymbol(repoName, symbolName, { sha });

      // 2. Caller-callee graph from pgGraph recursive CTE
      const dependencyGraph = await git.getDependencyGraph(repoName, symbolName);
      const inboundCallers = dependencyGraph.inboundCallers || [];
      const outboundCallees = dependencyGraph.outboundCallees || [];
      const blastRadius = inboundCallers.length;

      // 3. Relevant invariants from pg_context_items
      const symbolQuery = symbolName.replace(/^[./\\]+/, '');
      const filePath = symbol?.file_path || '';

      const [symbolInvariants, fileInvariants, generalInvariants, rawBlockers] = await Promise.all([
        context.queryRemoteContext({ workspaceName: targetWorkspace, query: symbolQuery, category: 'invariant', limit: 20 }),
        filePath ? context.queryRemoteContext({ workspaceName: targetWorkspace, query: filePath, limit: 20 }) : Promise.resolve([]),
        context.queryRemoteContext({ workspaceName: targetWorkspace, category: 'invariant', limit: 20 }),
        context.queryRemoteContext({ workspaceName: targetWorkspace, query: symbolQuery, category: 'blocker', limit: 10 })
      ]);
      const activeBlockers = rawBlockers.filter((b) => {
        const match = String(b.content || '').match(/^\[([a-zA-Z0-9_.-]+)\]/);
        if (match && match[1] && match[1] !== repoName) {
          return false;
        }
        return true;
      });

      // Deduplicate items
      const seenIds = new Set();
      const uniqueContext = [];
      for (const item of [...symbolInvariants, ...fileInvariants]) {
        const key = `${item.category}:${item.local_id || item.id}`;
        if (!seenIds.has(key)) {
          seenIds.add(key);
          uniqueContext.push(item);
        }
      }

      // 4. Invariant audit and warnings
      const warnings = [];
      const requiresCallerAudit = blastRadius > 0;
      if (requiresCallerAudit) {
        warnings.push(
          `[InvariantRule] Symbol '${symbolName}' has ${blastRadius} inbound caller(s). Project rule requires AST caller verification before signature or behavior changes.`
        );
      }
      if (activeBlockers.length > 0) {
        for (const b of activeBlockers) {
          warnings.push(`[ActiveBlocker #${b.local_id || b.id}] ${b.content}`);
        }
      }

      return {
        repository: repoName,
        symbolName,
        symbol,
        dependencyGraph: {
          symbol: symbolName,
          repository: repoName,
          inboundCallers,
          outboundCallees,
          blastRadius
        },
        context: {
          symbolInvariants,
          fileInvariants,
          generalInvariants: generalInvariants.slice(0, 5),
          activeBlockers,
          allAttachedItems: uniqueContext
        },
        audit: {
          blastRadius,
          requiresCallerAudit,
          hasBlockers: activeBlockers.length > 0,
          governingInvariantsCount: symbolInvariants.length + fileInvariants.length,
          warnings
        }
      };
    },

    /**
     * Traces the transitive blast radius of a symbol across pgGraph
     * and joins with all active invariants governing every caller node.
     */
    async traceBlastRadiusWithInvariants({ repoName, symbolName, workspaceName = null }) {
      if (!repoName || !symbolName) {
        throw new Error('traceBlastRadiusWithInvariants() requires both repoName and symbolName');
      }
      const targetWorkspace = workspaceName || repoName;

      const graph = await git.getDependencyGraph(repoName, symbolName);
      const callers = graph.inboundCallers || [];

      // Collect all unique caller files and symbols
      const callerNodes = [];
      const nodeMap = new Map();

      for (const c of callers) {
        const callerKey = `${c.source_path}:${c.source_symbol}`;
        if (!nodeMap.has(callerKey)) {
          const nodeObj = {
            symbol: c.source_symbol,
            filePath: c.source_path,
            depth: c.depth,
            relation: c.relation,
            invariants: []
          };
          nodeMap.set(callerKey, nodeObj);
          callerNodes.push(nodeObj);
        }
      }

      // For each caller node, fetch attaching invariants from pg_context_items
      for (const node of callerNodes) {
        const matching = await context.queryRemoteContext({
          workspaceName: targetWorkspace,
          query: node.symbol,
          category: 'invariant',
          limit: 5
        });
        node.invariants = matching;
      }

      return {
        repository: repoName,
        rootSymbol: symbolName,
        blastRadius: callerNodes.length,
        callerNodes,
        outboundCallees: graph.outboundCallees || []
      };
    },

    /**
     * Executes direct SQL join between pg_git_symbols and pg_context_items
     * in Polygres / PostgreSQL.
     */
    async queryCrossSubstrate({ repoName, workspaceName = null, limit = 50 }) {
      const pool = getSharedRemotePool() || git._getRemotePool();
      const targetWorkspace = workspaceName || repoName;
      const cappedLimit = Math.min(Math.max(1, limit), 200);

      const res = await pool.query(`
        SELECT 
          s.symbol_name,
          s.file_path,
          s.symbol_type,
          s.start_line,
          s.end_line,
          s.signature,
          c.local_id as context_id,
          c.category as context_category,
          c.content as context_content,
          c.status as context_status
        FROM pg_git_symbols s
        JOIN pg_context_items c ON (
          c.content ILIKE '%' || s.symbol_name || '%' OR
          (length(s.file_path) > 3 AND c.content ILIKE '%' || s.file_path || '%')
        )
        WHERE s.repository_name = $1 
          AND (c.source_workspace = $2 OR c.source_workspace = '*' OR c.source_workspace = 'default' OR c.source_workspace = 'homelab')
          AND c.status = 'active'
        ORDER BY s.file_path ASC, s.start_line ASC
        LIMIT $3;
      `, [repoName, targetWorkspace, cappedLimit]);

      return res.rows;
    },

    /**
     * Audits a proposed mutation or refactoring against pgGraph call edges
     * and KruschContext steering invariants.
     */
    async auditSymbolRefactor({ repoName, symbolName, proposedAction = 'modify', workspaceName = null }) {
      const symContext = await this.getSymbolContext({ repoName, symbolName, workspaceName });
      const { blastRadius, requiresCallerAudit, warnings } = symContext.audit;

      const allowed = !symContext.audit.hasBlockers;
      const requiresManualConfirmation = requiresCallerAudit && proposedAction === 'rename';

      return {
        repoName,
        symbolName,
        proposedAction,
        allowed,
        requiresManualConfirmation,
        blastRadius,
        warnings,
        inboundCallers: symContext.dependencyGraph.inboundCallers
      };
    },

    async close() {
      await context.close();
      await git.close();
      await wondersearch.close();
      const activePool = remotePoolState.pool || (remotePoolState.initPromise ? await remotePoolState.initPromise.catch(() => null) : null);
      remotePoolState.pool = null;
      remotePoolState.initPromise = null;
      if (activePool) {
        await activePool.end();
      }
    }
  };
}

