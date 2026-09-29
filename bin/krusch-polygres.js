#!/usr/bin/env node
/**
 * CLI launcher for @krusch/polygres-connector
 */

import { createPolygresConnector } from '../src/index.js';

const args = process.argv.slice(2);
const command = args[0];

if (!command || command === '--help' || command === '-h' || command === 'help') {
  console.log(`
@krusch/polygres-connector CLI (v0.1.0)
Swappable cloud & local storage adapter for AI coding agents.

Usage:
  krusch-polygres <command> [options]

Core Commands:
  status                                 Verify connection to Polygres Cloud & Wondersearch
  sync-context [workspace]               Push local working memory (.agent/context.db) to pgContext
  pull-context [workspace]               Pull active invariants & decisions for prompt hydration
  sync-git <repo_name> [commit_sha]      Sync Git DAG, commits, and AST symbols to pgGraph
  find-symbol <repo_name> <symbol>       Authoritative AST symbol declaration lookup
  search-code <repo_name> <query>        Semantic code search via Wondersearch with recency decay
  sync-biz [playbooks_dir]               Sync commercial contract playbooks to Wondersearch
  search-biz <query>                     Search commercial clauses via Wondersearch

Options:
  -h, --help                             Show this help message
  -v, --version                          Print version (0.1.0)

Environment Variables:
  POLYGRES_URL                           Connection string for Polygres Cloud (PostgreSQL)
  WONDERSEARCH_API_KEY                   API Key for Wondersearch Drive search
  WONDERSEARCH_WORKSPACE_ID              Workspace UUID for Wondersearch drives
  ALLOW_CLOUD=1                          Mandatory flag authorizing remote cloud egress
`);
  process.exit(0);
}

if (command === '--version' || command === '-v') {
  console.log('@krusch/polygres-connector v0.1.0');
  process.exit(0);
}

async function main() {
  const connector = createPolygresConnector();

  try {
    switch (command) {
      case 'status': {
        console.log('=== Polygres Connector Status ===');
        console.log(`Cloud Egress Allowed: ${connector.config.allowCloud ? 'YES (ALLOW_CLOUD=1) ✅' : 'LOCAL ONLY (ALLOW_CLOUD=0) 🛡️'}`);
        console.log(`Polygres URL: ${connector.config.polygresUrl ? 'Configured ✅' : 'Missing (local only) ℹ️'}`);
        console.log(`Wondersearch API Key: ${connector.config.wondersearchApiKey ? 'Configured ✅' : 'Missing (local only) ℹ️'}`);
        console.log(`Wondersearch Base URL: ${connector.config.wondersearchBaseUrl}`);
        console.log(`Local Context DB: ${connector.config.localContextDbPath}`);
        console.log(`Local Git DB: ${connector.config.localGitDbUrl}`);
        break;
      }

      case 'sync-context': {
        const workspace = args[1] || 'homelab';
        console.log(`Pushing working memory to Polygres pgContext for workspace '${workspace}'...`);
        const result = await connector.context.pushLocalContext(workspace);
        console.log(`✅ Synced ${result.pushed} entries to Polygres Cloud.`);
        break;
      }

      case 'pull-context': {
        const workspace = args[1] || 'homelab';
        console.log(`Pulling active invariants & decisions from Polygres Cloud for '${workspace}'...`);
        const items = await connector.context.pullRemoteContext(workspace);
        console.log(`Found ${items.length} active items:`);
        for (const item of items) {
          console.log(`- [${item.category}] #${item.local_id}: ${item.content.substring(0, 80)}...`);
        }
        break;
      }

      case 'sync-git': {
        const repoName = args[1];
        const sha = args[2] || 'HEAD';
        if (!repoName) {
          console.error('Error: specify a repository name: krusch-polygres sync-git <repo_name> [commit_sha]');
          process.exit(1);
        }
        console.log(`Syncing Git DAG & AST symbols to Polygres Cloud for '${repoName}' (SHA: ${sha})...`);
        const gitRes = await connector.git.pushGitDagAndSymbols(repoName, sha);
        console.log(`✅ Synced ${gitRes.commitsPushed} commits and ${gitRes.symbolsPushed} AST symbols to Polygres (SHA: ${gitRes.commitSha}).`);

        if (connector.config.wondersearchApiKey) {
          console.log(`Syncing codebase blobs to Wondersearch drive for semantic code search...`);
          const wsRes = await connector.git.syncCodebaseToWondersearch(repoName, null, sha);
          console.log(`✅ Indexed ${wsRes.documentsIndexed} code documents into Wondersearch drive '${wsRes.driveId}'.`);
        } else {
          console.log('ℹ️ Skipping Wondersearch code indexing (WONDERSEARCH_API_KEY not configured).');
        }
        break;
      }

      case 'find-symbol': {
        const repoName = args[1];
        const symbolName = args[2];
        if (!repoName || !symbolName) {
          console.error('Error: specify repo and symbol: krusch-polygres find-symbol <repo_name> <symbol_name>');
          process.exit(1);
        }
        console.log(`Looking up authoritative symbol '${symbolName}' in '${repoName}'...`);
        const symbol = await connector.git.findSymbol(repoName, symbolName);
        if (!symbol) {
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
        const repoName = args[1];
        const query = args.slice(2).join(' ');
        if (!repoName || !query) {
          console.error('Error: specify repo and query: krusch-polygres search-code <repo_name> <query>');
          process.exit(1);
        }
        console.log(`Searching code in '${repoName}' for "${query}" via Wondersearch...`);
        const searchRes = await connector.git.searchCode(repoName, query);
        console.log(`Found ${searchRes.results.length} matches:`);
        for (const r of searchRes.results) {
          console.log(`\n📄 ${r.externalId} (score: ${r.score}):`);
          console.log(r.text.substring(0, 200) + '...\n');
        }
        break;
      }

      case 'sync-biz': {
        const playbooksDir = args[1] || './data/playbooks';
        console.log(`Syncing commercial playbooks from '${playbooksDir}' to Wondersearch...`);
        const res = await connector.wondersearch.syncPlaybooks(playbooksDir);
        console.log(`✅ Indexed ${res.documentsIndexed} playbook documents into Wondersearch drive '${res.driveId}'.`);
        break;
      }

      case 'search-biz': {
        const query = args.slice(1).join(' ');
        if (!query) {
          console.error('Error: specify a commercial query: krusch-polygres search-biz <query>');
          process.exit(1);
        }
        console.log(`Searching commercial clauses for "${query}" via Wondersearch...`);
        const res = await connector.wondersearch.searchBiz(query);
        console.log(`Found ${res.results.length} results:`);
        for (const r of res.results) {
          console.log(`\n💼 ${r.externalId} (score: ${r.score}):`);
          console.log(r.text.substring(0, 200) + '...\n');
        }
        break;
      }

      default: {
        console.error(`Unknown command: '${command}'. Run 'krusch-polygres --help' for available commands.`);
        process.exit(1);
      }
    }
  } catch (err) {
    console.error(`❌ Error: ${err.message}`);
    process.exit(1);
  } finally {
    await connector.close();
  }
}

main();
