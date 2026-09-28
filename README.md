# @krusch/polygres-connector

> Standalone plugin and cloud bridge toolkit connecting **KruschContext** (working memory/invariants), **KruschGit** (Git DAG & AST symbols), **KruschBiz** (contract playbooks & commercial graphs), and **KruschNexus** (ingestion bridge) to **Polygres Cloud** and **Wondersearch**.

---

> [!IMPORTANT]
> **Intentional Air-Gapped Exclusion of KruschLaw:**  
> **KruschLaw is deliberately excluded from cloud synchronization.** While commercial contracting (`krusch-biz`), codebase graphs (`krusch-git`), and agent memory (`krusch-context`) benefit from zero-friction cloud acceleration, privileged legal defense, active litigation discovery, and tenant defense work remain 100% air-gapped on local PostgreSQL 16 + pgvector to strictly uphold ABA Model Rule 1.6 confidentiality.

---

## 🏛️ Architecture: Where Data Lives

| Domain / Project | Cloud Destination | Underlying Engine | Why It Lives There |
| :--- | :--- | :--- | :--- |
| **`krusch-context`**<br>(Working Memory & Invariants) | **Polygres Cloud (`pgContext`)** | PostgreSQL Relational / JSONB | Invariants, active blockers, and decision lineages require ACID integrity and cross-agent synchronization across IDE swarms. |
| **`krusch-git`**<br>(Git DAG & AST Symbol Graph) | **Polygres Cloud (`pgGraph`)** | PostgreSQL Relational / Graph | Commits, parent pointers, trees, and caller/callee AST edges require recursive CTE graph traversals. |
| **`krusch-git`**<br>(Codebase Search & Blobs) | **Wondersearch Drives (`repo-<name>`)** | Wondersearch / Vector Substrate | High-throughput semantic code search without requiring local GPU embedding inference. |
| **`krusch-biz`**<br>(Contract Playbooks & MSAs) | **Wondersearch Drives (`repo-krusch-biz-playbooks`)** | Wondersearch / Vector Substrate | Instant cloud-hosted clause search across commercial contract playbooks, standard MSAs, and SOWs. |
| **`krusch-biz`**<br>(Contract Relational Graph) | **Polygres Cloud (`pgGraph`)** | PostgreSQL Relational / Graph | Resolves multi-document contract families (MSA ➔ SOW ➔ Amendment) and topic-level precedence hierarchies. |
| **`krusch-law`**<br>(Tenant Defense & Litigation) | <strong style="color: #ff5252;">100% Air-Gapped Local</strong> | Local PostgreSQL 16 (`pgvector`) | Strictly air-gapped. Zero cloud egress. Enforces absolute privilege boundaries under ABA Model Rule 1.6. |

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
await connector.git.pushGitDagAndSymbols('krusch-biz');

// 3. Search codebase using Wondersearch (no local GPU embeddings needed)
const codeHits = await connector.git.searchCode('krusch-biz', 'contract precedence resolver');

// 4. Sync commercial contract playbooks to Wondersearch drive
await connector.wondersearch.syncBizPlaybooks('./data/playbooks');

// 5. Search commercial clauses via Wondersearch
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

# Sync Git DAG, commits, and AST symbols to Polygres Cloud pgGraph
krusch-polygres sync-git krusch-biz

# Semantic search across repository files via Wondersearch
krusch-polygres search-code krusch-biz "resolver topic precedence"

# Sync commercial contract playbooks to Wondersearch
krusch-polygres sync-biz ./data/playbooks

# Search commercial contract clauses via Wondersearch
krusch-polygres search-biz "late payment interest 1.5%"
```

---

## 🛡️ Zero Sovereignty Contamination
This package is an **opt-in peripheral connector**. 
* **Air-Gapped by Default**: Local homelab nodes retain their air-gapped, zero-cost SQLite and local Postgres databases (`ALLOW_CLOUD=0`).
* **Zero Infrastructure Friction**: Remote agents (Cursor, Windsurf, GitHub Codespaces, Cloudflare Workers) can install this toolkit to access team invariants, code search, and legal/biz RAG over Polygres Cloud without managing GPU clusters or local pgvector servers.
