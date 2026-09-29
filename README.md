# @krusch/polygres-connector (v0.1.0-preview)

> Opt-in storage adapter bridging **KruschContext** (working memory/invariants) and **KruschGit** (Git DAG & AST symbol graph) with **PostgreSQL** (Polygres Cloud or any standard PostgreSQL instance) and **Wondersearch** (hosted semantic search).

---

> [!IMPORTANT]
> **Intentional Air-Gapped Exclusion of KruschLaw:**  
> **KruschLaw is deliberately excluded from cloud synchronization.** While commercial contracting (`krusch-biz`), codebase graphs (`krusch-git`), and agent memory (`krusch-context`) can use cloud synchronization, privileged legal defense and active litigation discovery remain 100% air-gapped on local PostgreSQL 16 + pgvector to strictly uphold ABA Model Rule 1.6 confidentiality. Any attempt to sync paths resolving to litigation matters or containing privileged classification metadata fails closed with an `AirGapSecurityError`.

---

## 🏛️ Architecture: Where Data Lives

This connector writes standard PostgreSQL tables compatible with Polygres-hosted databases:

| Domain / Project | Remote Destination | Target Tables | Underlying Mechanism |
| :--- | :--- | :--- | :--- |
| **`krusch-context`**<br>(Working Memory & Invariants) | **PostgreSQL / Polygres** | `pg_context_items`, `sync_runs` | Atomic multi-row `INSERT ... ON CONFLICT (source_workspace, local_id)` with credential redaction (`[REDACTED_SECRET]`). |
| **`krusch-git`**<br>(Git DAG, Trees & AST Symbols) | **PostgreSQL / Polygres** | `pg_git_repositories`, `pg_git_commits`, `pg_git_trees`, `pg_git_tree_entries`, `pg_git_symbols`, `pg_git_symbol_edges`, `sync_runs` | Transactional batch sync with 40-char SHA pinning; non-destructive upserts on `(repository_name, commit_sha, file_path, symbol_name, start_line)`. |
| **`krusch-git`**<br>(Codebase Search & Blobs) | **Wondersearch Drives (`repo-<name>`)** | Hosted Passages / Wondersearch API | Semantic code search with 40-char SHA assertion without requiring local GPU embedding clusters. |
| **`krusch-biz`**<br>(Contract Playbooks & MSAs) | **Wondersearch Drives (`repo-krusch-biz-playbooks`)** | Hosted Passages / Wondersearch API | Hosted clause retrieval across commercial contract playbooks and standard agreements. |
| **`krusch-law`**<br>(Tenant Defense & Litigation) | <strong style="color: #ff5252;">100% Air-Gapped Local</strong> | Local PostgreSQL 16 (`pgvector`) | Strictly air-gapped. Zero cloud egress. Enforces absolute privilege boundaries under ABA Model Rule 1.6. |

---

## 🔒 Security & Air-Gap Invariants

1. **Private Network Boundaries**: Loopback (`127.0.0.1`), RFC1918 subnets (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local (`169.254.0.0/16`), `.local`, and Unix domain sockets are permitted without `ALLOW_CLOUD`. All remote endpoints require `ALLOW_CLOUD=1`.
2. **Credential Redaction**: Working memory sync scans and replaces secrets with `[REDACTED_SECRET]` (covering OpenAI/Anthropic keys, AWS Access Keys, Slack tokens, JWTs, connection strings with passwords, and PEM private keys) rather than dropping batches.
3. **Privileged Matter Realpath Deny**: Paths resolving via `fs.realpathSync` to matter storage or evidence directories are strictly blocked from egress.
4. **Masked CLI Logging**: Connection strings and tokens are masked in `krusch-polygres status` (passwords hidden as `********`).

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
export ALLOW_CLOUD=1
```

### As a Library
```javascript
import { createPolygresConnector } from '@krusch/polygres-connector';

const connector = createPolygresConnector({
  polygresUrl: process.env.POLYGRES_URL,
  wondersearchApiKey: process.env.WONDERSEARCH_API_KEY,
  wondersearchWorkspaceId: process.env.WONDERSEARCH_WORKSPACE_ID
});

// 1. Probe network and database health
const health = await connector.probeStatus();
console.log(health);

// 2. Sync working memory invariants (transactional chunked batch)
await connector.context.pushLocalContext('homelab', { dryRun: false });

// 3. Pull active invariants & write back into local SQLite
const items = await connector.context.pullRemoteContext('homelab');
connector.context.writeLocalEntries(items);

// 4. Sync Git DAG, trees, AST symbols, and caller/callee edges (with 40-char SHA pin)
const gitResult = await connector.git.pushGitDagAndSymbols('krusch-biz');
console.log(`Synced repo at commit ${gitResult.commitSha}`);

// 5. Look up an exact symbol declaration
const symbol = await connector.git.findSymbol('krusch-biz', 'resolveControllingLaw');

// 6. Query dependency graph (cycle-guarded recursive CTE)
const graph = await connector.git.getDependencyGraph('krusch-biz', 'resolveControllingLaw');

await connector.close();
```

---

## 🛠️ CLI Tooling

```bash
# Check connectivity across local SQLite/PG, remote PostgreSQL, and Wondersearch
krusch-polygres status [--json]

# Push local working memory (.agent/context.db) to remote PostgreSQL
krusch-polygres sync-context [workspace] [--dry-run] [--json]

# Pull active invariants & decisions (optionally write back to local SQLite)
krusch-polygres pull-context [workspace] [--write] [--json]

# Sync Git DAG, trees, AST symbols, and caller/callee edges
krusch-polygres sync-git <repo_name> [commit_sha] [--dry-run] [--json]

# Authoritative exact AST symbol lookup
krusch-polygres find-symbol <repo_name> <symbol_name> [--json]

# Search codebase passages via Wondersearch
krusch-polygres search-code <repo_name> <query> [--json]

# Sync commercial contract playbooks to Wondersearch
krusch-polygres sync-biz [playbooks_dir]

# Search commercial clauses via Wondersearch
krusch-polygres search-biz <query>
```
