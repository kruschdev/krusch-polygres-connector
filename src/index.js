/**
 * @krusch/polygres-connector
 * Standalone plugin & connector toolkit bridging KruschContext and KruschGit
 * with PostgreSQL / Polygres and Wondersearch.
 */

import pg from 'pg';
import { loadConfig, assertCloudAllowed, SCHEMA_VERSION } from './config.js';
import { ContextBridge } from './context-bridge.js';
import { GitBridge } from './git-bridge.js';
import { WondersearchBridge } from './wondersearch-bridge.js';

export { loadConfig, SCHEMA_VERSION } from './config.js';
export { ContextBridge } from './context-bridge.js';
export { GitBridge } from './git-bridge.js';
export { WondersearchBridge } from './wondersearch-bridge.js';

/**
 * Convenience factory to create a fully configured connector instance
 * Shares a single remote PostgreSQL pool between Context and Git bridges if polygresUrl is provided.
 */
export function createPolygresConnector(options = {}) {
  const config = loadConfig(options);

  let sharedRemotePool = null;
  const getSharedRemotePool = () => {
    if (!sharedRemotePool && config.polygresUrl) {
      assertCloudAllowed(config.polygresUrl, config.allowCloud);
      sharedRemotePool = new pg.Pool({ connectionString: config.polygresUrl });
    }
    return sharedRemotePool;
  };

  const context = new ContextBridge({
    ...config,
    get sharedRemotePool() {
      return getSharedRemotePool();
    }
  });

  const git = new GitBridge({
    ...config,
    get sharedRemotePool() {
      return getSharedRemotePool();
    }
  });

  const wondersearch = new WondersearchBridge(config);

  return {
    config,
    context,
    git,
    wondersearch,
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
            `).catch(() => ({ rows: [] }));
            report.remotePostgres.tables = tableRes.rows.map(r => r.table_name);

            const runsRes = await pool.query('SELECT COUNT(*) as runs FROM sync_runs;').catch(() => null);
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
          const wsContext = await wondersearch.getWorkspaceContext().catch(() => ({}));
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

      const [symbolInvariants, fileInvariants, generalInvariants, activeBlockers] = await Promise.all([
        context.queryRemoteContext({ workspaceName: targetWorkspace, query: symbolQuery, category: 'invariant', limit: 20 }),
        filePath ? context.queryRemoteContext({ workspaceName: targetWorkspace, query: filePath, limit: 20 }) : Promise.resolve([]),
        context.queryRemoteContext({ workspaceName: targetWorkspace, category: 'invariant', limit: 20 }),
        context.queryRemoteContext({ workspaceName: targetWorkspace, query: symbolQuery, category: 'blocker', limit: 10 })
      ]);

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
      if (sharedRemotePool) {
        await sharedRemotePool.end();
        sharedRemotePool = null;
      }
    }
  };
}
