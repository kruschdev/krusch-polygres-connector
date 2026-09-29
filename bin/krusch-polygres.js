#!/usr/bin/env node
/**
 * CLI launcher for @krusch/polygres-connector
 */

import { createPolygresConnector } from '../src/index.js';
import { maskUrl, maskToken, SCHEMA_VERSION } from '../src/config.js';

const rawArgs = process.argv.slice(2);
const flags = new Set(rawArgs.filter(a => a.startsWith('-')));
const positionalArgs = rawArgs.filter(a => !a.startsWith('-'));
const command = positionalArgs[0];

const isJson = flags.has('--json');
const isDryRun = flags.has('--dry-run');
const isWriteBack = flags.has('--write');

if (!command || flags.has('--help') || flags.has('-h') || command === 'help') {
  console.log(`
@krusch/polygres-connector CLI (v0.1.0-preview)
Swappable cloud & local storage adapter for AI coding agents.

Usage:
  krusch-polygres <command> [arguments] [flags]

Core Commands:
  status                                 Probe local & remote databases and print health
  sync-context [workspace]               Push local working memory (.agent/context.db) to PostgreSQL
  pull-context [workspace]               Pull active invariants & decisions from remote PostgreSQL
  sync-git <repo_name> [commit_sha]      Sync Git DAG, trees, and AST symbols/edges to PostgreSQL
  find-symbol <repo_name> <symbol>       Authoritative AST symbol declaration lookup
  search-code <repo_name> <query>        Semantic code search via Wondersearch drive
  sync-biz [playbooks_dir]               Sync commercial contract playbooks to Wondersearch
  search-biz <query>                     Search commercial clauses via Wondersearch

Flags:
  --dry-run                              Simulate sync without mutating remote database
  --write                                (pull-context) Write remote items back into local SQLite
  --json                                 Output results in JSON format
  -h, --help                             Show this help message
  -v, --version                          Print version

Environment Variables:
  POLYGRES_URL                           PostgreSQL connection string (Polygres Cloud or standard PG)
  WONDERSEARCH_API_KEY                   API Key for Wondersearch Drive search
  WONDERSEARCH_WORKSPACE_ID              Workspace UUID for Wondersearch drives
  ALLOW_CLOUD=1                          Mandatory flag authorizing remote cloud egress
`);
  process.exit(0);
}

if (flags.has('--version') || flags.has('-v') || command === 'version') {
  console.log('@krusch/polygres-connector v0.1.0-preview');
  process.exit(0);
}

async function main() {
  const connector = createPolygresConnector();

  try {
    switch (command) {
      case 'status': {
        const probe = await connector.probeStatus();
        if (isJson) {
          console.log(JSON.stringify({
            schemaVersion: SCHEMA_VERSION,
            config: {
              allowCloud: connector.config.allowCloud,
              polygresUrl: maskUrl(connector.config.polygresUrl),
              wondersearchBaseUrl: connector.config.wondersearchBaseUrl,
              wondersearchApiKey: maskToken(connector.config.wondersearchApiKey),
              localContextDbPath: connector.config.localContextDbPath,
              localGitDbUrl: maskUrl(connector.config.localGitDbUrl)
            },
            probe
          }, null, 2));
        } else {
          console.log('=== Polygres Connector Status ===');
          console.log(`Schema Version: ${SCHEMA_VERSION}`);
          console.log(`Cloud Egress: ${connector.config.allowCloud ? 'AUTHORIZED (ALLOW_CLOUD=1) ✅' : 'AIR-GAPPED LOCAL ONLY (ALLOW_CLOUD=0) 🛡️'}`);
          console.log(`Polygres / Remote PG: ${maskUrl(connector.config.polygresUrl)}`);
          console.log(`Remote DB Connected: ${probe.remotePostgres.ok ? `YES (${probe.remotePostgres.tables.length} tables, ${probe.remotePostgres.syncRuns} sync runs) ✅` : `NO (${probe.remotePostgres.error || 'not configured'}) ⚠️`}`);
          console.log(`Wondersearch API: ${maskToken(connector.config.wondersearchApiKey)}`);
          console.log(`Wondersearch Connected: ${probe.wondersearch.ok ? `YES (${probe.wondersearch.drives} drives) ✅` : `NO (${probe.wondersearch.error || 'not configured'}) ⚠️`}`);
          console.log(`Local Context DB: ${connector.config.localContextDbPath}`);
          console.log(`Local Context Status: ${probe.localContext.ok ? `OK (${probe.localContext.count} items) ✅` : `FAIL (${probe.localContext.error}) ❌`}`);
          console.log(`Local Git DB: ${maskUrl(connector.config.localGitDbUrl)}`);
          console.log(`Local Git Status: ${probe.localGit.ok ? `OK (${probe.localGit.repos} repos) ✅` : `FAIL (${probe.localGit.error}) ❌`}`);
        }
        break;
      }

      case 'sync-context': {
        const workspace = positionalArgs[1] || 'homelab';
        if (!isJson) {
          console.log(`Syncing working memory for workspace '${workspace}' (dryRun: ${isDryRun})...`);
        }
        const result = await connector.context.pushLocalContext(workspace, { dryRun: isDryRun });
        if (isJson) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`✅ Synced ${result.pushed} entries (${result.redacted} redacted) to PostgreSQL. Total: ${result.total}.`);
        }
        break;
      }

      case 'pull-context': {
        const workspace = positionalArgs[1] || 'homelab';
        const items = await connector.context.pullRemoteContext(workspace);
        let written = 0;
        if (isWriteBack) {
          written = connector.context.writeLocalEntries(items);
        }
        if (isJson) {
          console.log(JSON.stringify({ workspace, count: items.length, writtenToLocal: written, items }, null, 2));
        } else {
          console.log(`Found ${items.length} active items for workspace '${workspace}':`);
          for (const item of items) {
            console.log(`- [${item.category}] #${item.local_id}: ${item.content.substring(0, 100)}...`);
          }
          if (isWriteBack) {
            console.log(`\n💾 Successfully wrote ${written} items into local SQLite: ${connector.config.localContextDbPath}`);
          }
        }
        break;
      }

      case 'sync-git': {
        const repoName = positionalArgs[1];
        const sha = positionalArgs[2] || null;
        if (!repoName) {
          console.error('Error: specify a repository name: krusch-polygres sync-git <repo_name> [commit_sha] [--dry-run]');
          process.exit(1);
        }
        if (!isJson) {
          console.log(`Syncing Git DAG & AST symbols for '${repoName}' (dryRun: ${isDryRun})...`);
        }
        const gitRes = await connector.git.pushGitDagAndSymbols(repoName, sha, { dryRun: isDryRun });

        let wsRes = null;
        if (!isDryRun && connector.config.wondersearchApiKey && connector.config.wondersearchWorkspaceId) {
          if (!isJson) console.log(`Syncing codebase blobs to Wondersearch drive for semantic code search...`);
          wsRes = await connector.git.syncCodebaseToWondersearch(repoName, null, gitRes.commitSha);
        }

        if (isJson) {
          console.log(JSON.stringify({ git: gitRes, wondersearch: wsRes }, null, 2));
        } else {
          console.log(`✅ Synced commit ${gitRes.commitSha}: ${gitRes.commitsPushed} commits, ${gitRes.treesPushed} trees, ${gitRes.symbolsPushed} symbols, ${gitRes.edgesPushed} edges.`);
          if (wsRes) {
            console.log(`✅ Indexed ${wsRes.documentsIndexed} code documents into Wondersearch drive '${wsRes.driveId}'.`);
          }
        }
        break;
      }

      case 'find-symbol': {
        const repoName = positionalArgs[1];
        const symbolName = positionalArgs[2];
        if (!repoName || !symbolName) {
          console.error('Error: specify repo and symbol: krusch-polygres find-symbol <repo_name> <symbol_name>');
          process.exit(1);
        }
        const symbol = await connector.git.findSymbol(repoName, symbolName);
        if (isJson) {
          console.log(JSON.stringify(symbol, null, 2));
        } else if (!symbol) {
          console.log(`❌ Symbol '${symbolName}' not found in '${repoName}'.`);
        } else {
          console.log(`\n📍 ${symbol.symbol_name} (${symbol.kind}):`);
          console.log(`   File: ${symbol.file_path}:${symbol.location.lines[0]}-${symbol.location.lines[1]}`);
          if (symbol.signature) console.log(`   Signature: ${symbol.signature}`);
          if (symbol.commit_sha) console.log(`   Commit: ${symbol.commit_sha}`);
        }
        break;
      }

      case 'search-code': {
        const repoName = positionalArgs[1];
        const query = positionalArgs.slice(2).join(' ');
        if (!repoName || !query) {
          console.error('Error: specify repo and query: krusch-polygres search-code <repo_name> <query>');
          process.exit(1);
        }
        const searchRes = await connector.git.searchCode(repoName, query);
        if (isJson) {
          console.log(JSON.stringify(searchRes, null, 2));
        } else {
          console.log(`Found ${searchRes.results.length} matches in '${repoName}':`);
          for (const r of searchRes.results) {
            console.log(`\n📄 ${r.externalId} (score: ${r.score}):`);
            console.log(r.text.substring(0, 200) + '...\n');
          }
        }
        break;
      }

      case 'sync-biz': {
        const playbooksDir = positionalArgs[1] || './data/playbooks';
        const res = await connector.wondersearch.syncPlaybooks(playbooksDir);
        if (isJson) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          console.log(`✅ Indexed ${res.documentsIndexed} playbook documents into Wondersearch drive '${res.driveId}'.`);
        }
        break;
      }

      case 'search-biz': {
        const query = positionalArgs.slice(1).join(' ');
        if (!query) {
          console.error('Error: specify a commercial query: krusch-polygres search-biz <query>');
          process.exit(1);
        }
        const res = await connector.wondersearch.searchBiz(query);
        if (isJson) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          console.log(`Found ${res.results.length} results:`);
          for (const r of res.results) {
            console.log(`\n💼 ${r.externalId} (score: ${r.score}):`);
            console.log(r.text.substring(0, 200) + '...\n');
          }
        }
        break;
      }

      default: {
        console.error(`Unknown command: '${command}'. Run 'krusch-polygres --help' for available commands.`);
        process.exit(1);
      }
    }
  } catch (err) {
    if (isJson) {
      console.error(JSON.stringify({ error: err.message }, null, 2));
    } else {
      console.error(`❌ Error: ${err.message}`);
    }
    process.exit(1);
  } finally {
    await connector.close();
  }
}

main();
