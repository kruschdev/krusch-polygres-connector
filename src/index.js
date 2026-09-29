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
      if (config.wondersearchApiKey && config.wondersearchWorkspaceId) {
        try {
          const listUrl = `${wondersearch.baseUrl}/v1/workspaces/${config.wondersearchWorkspaceId}/drives`;
          const wsRes = await fetch(listUrl, {
            headers: wondersearch._headers(),
            signal: AbortSignal.timeout(5000)
          });
          if (wsRes.ok) {
            const data = await wsRes.json();
            report.wondersearch.ok = true;
            report.wondersearch.drives = (data.drives || []).length;
          } else {
            report.wondersearch.error = `HTTP ${wsRes.status}`;
          }
        } catch (err) {
          report.wondersearch.error = err.message;
        }
      }

      return report;
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
