# @krusch/polygres-connector

> Standalone plugin and cloud bridge toolkit connecting **KruschContext** (working memory/invariants), **KruschGit** (Git DAG & AST symbols), **KruschLaw** (statutory Authority Packs), and **KruschBiz** (contract playbooks) to **Polygres Cloud** and **Wondersearch**.

---

## 🏛️ Architecture: Where Data Lives

| Domain / Data Type | Cloud Destination | Underlying Engine | Why It Lives There |
| :--- | :--- | :--- | :--- |
| **Working Memory & Invariants** | **Polygres Cloud (`pgContext`)** | PostgreSQL Relational / JSONB | Invariants, active blockers, and decision lineages require ACID integrity and superseding links. |
| **Git DAG & AST Symbol Graph** | **Polygres Cloud (`pgGraph`)** | PostgreSQL Relational / Graph | Commits, parent pointers, trees, and caller/callee edges are graph structures with recursive CTEs. |
| **Codebase Search & Blob Passages** | **Wondersearch Drives (`repo-<name>`)** | Wondersearch / Vector Substrate | Code search requires fast semantic passage ranking, byte offsets, and document citations without running local GPU embeddings. |
| **Statutes & Authority Packs** | **Wondersearch Drives (`repo-krusch-law-statutes`)** | Wondersearch / Vector Substrate | Offloads multi-megabyte municipal and state codes into high-speed search drives with physical citation coordinates. |
| **Contract Playbooks & Templates** | **Wondersearch Drives (`repo-krusch-biz-playbooks`)** | Wondersearch / Vector Substrate | Provides instant cloud-hosted clause search across corporate contract playbooks, MSAs, and SOWs. |

---

## 🚀 Installation & Usage

```bash
npm install -g @krusch/polygres-connector
```

### Environment Configuration
```bash
export POLYGRES_URL="postgresql://user:secret@cloud.polygres.com:5432/team_db"
export WONDERSEARCH_API_KEY="ws_live_secret_key"
export WONDERSEARCH_WORKSPACE_ID="workspace_uuid"
```

### As a Library
```javascript
import { createPolygresConnector } from '@krusch/polygres-connector';

const connector = createPolygresConnector({
  polygresUrl: process.env.POLYGRES_URL,
  wondersearchApiKey: process.env.WONDERSEARCH_API_KEY,
  wondersearchWorkspaceId: process.env.WONDERSEARCH_WORKSPACE_ID
});

// 1. Sync working memory invariants to Polygres Cloud
await connector.context.pushLocalContext('homelab');

// 2. Sync Git DAG & AST symbols to Polygres Cloud
await connector.git.pushGitDagAndSymbols('krusch-law');

// 3. Search codebase using Wondersearch (no local GPU embeddings needed)
const codeHits = await connector.git.searchCode('krusch-law', 'statute precedence DAG');

// 4. Sync Authority Packs to Wondersearch drive
await connector.wondersearch.syncAuthorityPacks('/path/to/packs');

// 5. Search statutory law via Wondersearch
const lawHits = await connector.wondersearch.searchLaw('eviction notice 30 days');

// 6. Search commercial clauses via Wondersearch
const bizHits = await connector.wondersearch.searchBiz('limitation of liability cap 12 months');

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

# Sync Git DAG, commits, and AST symbols to Polygres Cloud
krusch-polygres sync-git krusch-law

# Semantic search across repository files via Wondersearch
krusch-polygres search-code krusch-law "tenant rent cap calculations"

# Sync Authority Packs & statutory rulebooks to Wondersearch
krusch-polygres sync-law ./data/packs

# Sync commercial contract playbooks to Wondersearch
krusch-polygres sync-biz ./data/playbooks

# Search statutory codes via Wondersearch
krusch-polygres search-law "California security deposit 21 days"

# Search commercial contract clauses via Wondersearch
krusch-polygres search-biz "late payment interest 1.5%"
```

---

## 🛡️ Zero Sovereignty Contamination
This package is an **opt-in peripheral connector**. 
* **Air-Gapped by Default**: Local homelab nodes retain their air-gapped, zero-cost SQLite and local Postgres databases (`ALLOW_CLOUD=0`).
* **Zero Infrastructure Friction**: Remote agents (Cursor, Windsurf, GitHub Codespaces, Cloudflare Workers) can install this toolkit to access team invariants, code search, and legal/biz RAG over Polygres Cloud without managing GPU clusters or local pgvector servers.
