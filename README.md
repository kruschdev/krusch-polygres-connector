# @krusch/polygres-connector

> Standalone plugin and cloud bridge toolkit connecting **KruschContext** (working memory/invariants) and **KruschGit** (Git DAG & AST symbols) to **Polygres Cloud** and **Wondersearch**.

---

## 🏛️ Architecture: Where Data Lives

| Data Type | Destination | Engine | Why? |
| :--- | :--- | :--- | :--- |
| **Working Memory & Invariants** | **Polygres Cloud (`pgContext`)** | PostgreSQL Relational / JSONB | Invariants, active blockers, and decision lineages require ACID integrity and superseding links. |
| **Git DAG & AST Symbol Graph** | **Polygres Cloud (`pgGraph`)** | PostgreSQL Relational / Graph | Commits, parent pointers, trees, and caller/callee edges are graph structures. |
| **Codebase Search & Blob Passages** | **Wondersearch Drives (`repo-<name>`)** | Wondersearch / Vector Substrate | Code search requires fast semantic passage ranking, byte offsets, and document citations without running local GPU embeddings. |

---

## 🚀 Installation & Usage

### As a Library
```javascript
import { createPolygresConnector } from '@krusch/polygres-connector';

const connector = createPolygresConnector({
  polygresUrl: process.env.POLYGRES_URL,
  wondersearchApiKey: process.env.WONDERSEARCH_API_KEY
});

// 1. Sync working memory invariants to Polygres Cloud
await connector.context.pushLocalContext('homelab');

// 2. Sync Git DAG & AST symbols to Polygres Cloud
await connector.git.pushGitDagAndSymbols('krusch-law');

// 3. Search codebase using Wondersearch (no local GPU embeddings needed)
const results = await connector.git.searchCode('krusch-law', 'statute precedence DAG');
console.log(results);

await connector.close();
```

---

## 🛠️ CLI Tooling

```bash
# Check configuration and connectivity status
krusch-polygres status

# Push local working memory (.agent/context.db) to Polygres Cloud pgContext
krusch-polygres sync-context homelab

# Pull active invariants & decisions for remote agent prompt hydration
krusch-polygres pull-context homelab

# Sync Git DAG, commits, and AST symbols to Polygres
krusch-polygres sync-git krusch-law

# Semantic search across repository files via Wondersearch
krusch-polygres search-code krusch-law "tenant rent cap calculations"
```

---

## 🛡️ Zero Sovereignty Contamination
This package is an **opt-in peripheral connector**. 
* Local homelab nodes retain their air-gapped, zero-cost SQLite and local Postgres databases.
* Remote agents (Cursor, Windsurf, GitHub Codespaces) can install this toolkit to access team invariants and code search over Polygres Cloud without requiring direct Tailscale or SSH mesh access.
