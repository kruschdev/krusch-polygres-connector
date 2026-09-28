#!/usr/bin/env node
/**
 * CLI launcher for @krusch/polygres-connector
 */

import { createPolygresConnector } from '../src/index.js';

const [,, command, ...args] = process.argv;

async function main() {
  const connector = createPolygresConnector();

  try {
    switch (command) {
      case 'status': {
        console.log('=== Polygres Connector Status ===');
        console.log(`Polygres URL: ${connector.config.polygresUrl ? 'Configured ✅' : 'Missing ❌'}`);
        console.log(`Wondersearch API Key: ${connector.config.wondersearchApiKey ? 'Configured ✅' : 'Missing ❌'}`);
        console.log(`Wondersearch Base URL: ${connector.config.wondersearchBaseUrl}`);
        console.log(`Local Context DB: ${connector.config.localContextDbPath}`);
        console.log(`Local Git DB: ${connector.config.localGitDbUrl}`);
        break;
      }

      case 'sync-context': {
        const workspace = args[0] || 'homelab';
        console.log(`Pushing working memory to Polygres pgContext for workspace '${workspace}'...`);
        const result = await connector.context.pushLocalContext(workspace);
        console.log(`✅ Synced ${result.pushed} entries to Polygres Cloud.`);
        break;
      }

      case 'pull-context': {
        const workspace = args[0] || 'homelab';
        console.log(`Pulling active invariants & decisions from Polygres Cloud for '${workspace}'...`);
        const items = await connector.context.pullRemoteContext(workspace);
        console.log(`Found ${items.length} active items:`);
        for (const item of items) {
          console.log(`- [${item.category}] #${item.local_id}: ${item.content.substring(0, 80)}...`);
        }
        break;
      }

      case 'sync-git': {
        const repoName = args[0];
        if (!repoName) {
          console.error('Error: specify a repository name: krusch-polygres sync-git <repo_name>');
          process.exit(1);
        }
        console.log(`Syncing Git DAG & AST symbols to Polygres Cloud for '${repoName}'...`);
        const gitRes = await connector.git.pushGitDagAndSymbols(repoName);
        console.log(`✅ Synced ${gitRes.commitsPushed} commits and ${gitRes.symbolsPushed} AST symbols to Polygres.`);

        if (connector.config.wondersearchApiKey) {
          console.log(`Syncing codebase blobs to Wondersearch drive for semantic code search...`);
          const wsRes = await connector.git.syncCodebaseToWondersearch(repoName);
          console.log(`✅ Indexed ${wsRes.documentsIndexed} code documents into Wondersearch drive '${wsRes.driveId}'.`);
        } else {
          console.log('ℹ️ Skipping Wondersearch code indexing (WONDERSEARCH_API_KEY not configured).');
        }
        break;
      }

      case 'search-code': {
        const repoName = args[0];
        const query = args.slice(1).join(' ');
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

      default: {
        console.log(`
@krusch/polygres-connector CLI
Usage:
  krusch-polygres status
  krusch-polygres sync-context [workspace]
  krusch-polygres pull-context [workspace]
  krusch-polygres sync-git <repo_name>
  krusch-polygres search-code <repo_name> <query>
        `);
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
