# Install `krusch-polygres-connector`

These are instructions for a coding agent (Claude Code, Codex, Cursor, Windsurf, or Antigravity) that a person asked to install and configure `krusch-polygres-connector` (`@krusch/polygres-connector` `v0.1.0`) inside their Node.js repository or as a standalone checkout on their machine.

`krusch-polygres-connector` (`kruschdev/krusch-polygres-connector`) is an opt-in storage and graph connector bridging local **KruschContext** working memory (`.agent/context.db` via `node:sqlite`) and **KruschGit** (Git DAG, trees, AST symbols, and caller/callee edges) with **PostgreSQL / Polygres Cloud** (`sql/schema_v1.sql`) and **Wondersearch** hosted semantic code/clause drives. It ships both a programmatic ESM SDK (`createPolygresConnector`, `ContextBridge`, `GitBridge`, `WondersearchBridge`) and a 14-command CLI (`krusch-polygres`), enforcing fail-closed air-gap boundaries (`ALLOW_CLOUD=0` by default), automatic credential redaction (`[REDACTED_SECRET]`), and ABA Model Rule 1.6 `realpath` exclusion of privileged matter directories.

## 1. Check Prerequisites First (All at Once)

Run one read-only check before making any changes:

```bash
id -u
node -v 2>/dev/null || echo "MISSING: node"
npm -v 2>/dev/null || echo "MISSING: npm"
git --version 2>/dev/null || echo "MISSING: git"
psql --version 2>/dev/null || echo "OPTIONAL_MISSING: psql"
```

Evaluate the results:
1. **User check**: If `id -u` prints `0` (root), stop and ask the person to run you under a standard non-root developer account.
2. **Node.js `>= 22.5.0` (Node 22 LTS Required)**: Although `package.json` specifies `>=20.0.0` for syntax compatibility, `ContextBridge` (`src/context-bridge.js`) imports Node's built-in `node:sqlite` (`DatabaseSync`) to read and write local `.agent/context.db` working memory without C++ compilation. If `node -v` is missing or below `v22.5.0`, ask the person before installing or switching to Node 22 (`nvm install 22` or `fnm use 22`).
3. **PostgreSQL / Polygres & Wondersearch (Strictly Optional for Local Setup)**: Local/private PostgreSQL (`127.0.0.1`, RFC1918 subnets, Unix sockets) works with `ALLOW_CLOUD=0`. Remote Polygres Cloud (`POLYGRES_URL`) and Wondersearch (`WONDERSEARCH_API_KEY`, `WONDERSEARCH_WORKSPACE_ID`) are opt-in and require `ALLOW_CLOUD=1`. Hermetic verification (`KRUSCH_EPHEMERAL=1`) runs 100% in memory with zero database servers or API keys.

## 2. Choose the Right Setup Mode

- **Mode A: Install into an Existing Node.js `>= 22` Project (Default inside an existing `package.json` repository)**: Installs `github:kruschdev/krusch-polygres-connector` and verifies ESM SDK resolution plus hermetic `probeStatus()` and `getSymbolContext()` execution.
- **Mode B: Standalone Source Checkout + CLI & Hermetic Test Suite (Default when asked to "set up krusch-polygres-connector on this machine" outside an existing app)**: Clones `https://github.com/kruschdev/krusch-polygres-connector.git`, installs `pg`, runs the `47` offline hermetic unit/parity/security/CLI tests, and verifies `krusch-polygres` CLI diagnostics.

## 3. Install & Verify

### Mode A: Install into an Existing Node.js `>= 22` Project

Inside the person's existing Node.js repository:

```bash
npm install github:kruschdev/krusch-polygres-connector
```

*(If published to the person's configured npm registry, `npm install @krusch/polygres-connector` is also supported.)*

Verify ESM imports (`createPolygresConnector`, `ContextBridge`, `GitBridge`, `WondersearchBridge`), air-gap configuration defaults, and hermetic cross-substrate AST + invariant resolution with zero network calls:

```bash
KRUSCH_EPHEMERAL=1 node --input-type=module -e '
  import { createPolygresConnector } from "@krusch/polygres-connector";
  const connector = createPolygresConnector({ polygresUrl: "postgresql://127.0.0.1:5432/postgres" });
  const status = await connector.probeStatus();
  const sym = await connector.getSymbolContext({ repoName: "demo-repo", symbolName: "calculateCentroid" });
  await connector.close();
  console.log({
    allowCloudDefault: status.allowCloud === false,
    remoteMockOk: status.remotePostgres.ok === true,
    symbolResolved: sym.symbol?.symbol_name === "calculateCentroid",
    blastRadius: sym.audit.blastRadius
  });
'
```

### Mode B: Standalone Source Checkout, CLI & Offline Hermetic Verification

Check `pwd` first. Clone into the current directory (or into `~/src/krusch-polygres-connector` if the current directory is `$HOME` or another unrelated project):

```bash
git clone https://github.com/kruschdev/krusch-polygres-connector.git
cd krusch-polygres-connector
npm install
```

Run the 47-test offline hermetic suite (`KRUSCH_EPHEMERAL=1` uses the built-in mock pool so zero PostgreSQL daemons or cloud API keys are needed):

```bash
KRUSCH_EPHEMERAL=1 node --test \
  tests/cli.test.js \
  tests/codebase_parity.test.js \
  tests/connector.test.js \
  tests/context_pggraph.test.js \
  tests/correctness_and_safety.test.js \
  tests/hardening.test.js \
  tests/pool_concurrency.test.js
```

Verify the `krusch-polygres` CLI health probe and AST blast-radius / invariant join in ephemeral mode:

```bash
KRUSCH_EPHEMERAL=1 node ./bin/krusch-polygres.js status --json
KRUSCH_EPHEMERAL=1 node ./bin/krusch-polygres.js symbol-context demo-repo calculateCentroid --json
```

*(Note: Full `npm test` additionally executes `tests/wondersearch_live.test.js` against `https://api.wondersearch.ai` only when live `WONDERSEARCH_API_KEY` credentials are configured in `.env`.)*

## 4. Optional PostgreSQL / Polygres Schema & `.env` Setup

Do **not** create fake credentials in `.env` or run DDL migrations against a database unless the person explicitly asks. If the person asks to prepare a local `.env` template, create `.env` only if it does not already exist, with empty placeholders and `ALLOW_CLOUD=0`:

```bash
if [ ! -f .env ]; then
  cat <<'EOF' > .env
# Local or Polygres Cloud PostgreSQL connection string
POLYGRES_URL=
# Optional local KruschContext SQLite path (defaults to ./.agent/context.db)
KRUSCH_CONTEXT_DB_PATH=./.agent/context.db
# Optional Wondersearch hosted semantic search credentials
WONDERSEARCH_API_KEY=
WONDERSEARCH_WORKSPACE_ID=
# Keep 0 for local/RFC1918 PostgreSQL; set to 1 only to authorize remote cloud egress
ALLOW_CLOUD=0
EOF
  chmod 600 .env
fi
```

If the person provides a target PostgreSQL / Polygres database and asks to initialize the 7 remote tables (`sync_runs`, `pg_context_items`, `pg_git_repositories`, `pg_git_commits`, `pg_git_trees`, `pg_git_tree_entries`, `pg_git_symbols`, `pg_git_symbol_edges`), apply the idempotent DDL in `sql/schema_v1.sql`:

```bash
psql "$POLYGRES_URL" -f sql/schema_v1.sql
```

## Never

- **Never run `npm`, `node`, or `psql` with `sudo` or as `root`**.
- **Never ask for, paste in chat, or invent database DSNs or API keys** (`POLYGRES_URL`, `WONDERSEARCH_API_KEY`); let the person populate `.env` directly on disk (`chmod 600 .env`).
- **Never overwrite an existing `.env` file**.
- **Never set `ALLOW_CLOUD=1` or push local `.agent/context.db` / repository graphs to remote cloud endpoints** without explicit confirmation from the person (always preview with `--dry-run` first, e.g. `krusch-polygres sync-context default --dry-run`).
- **Never attempt to sync privileged legal matter or evidence directories**; `assertMatterNotPrivileged` blocks those paths by design.

## Tell the Person After

Share a concise status report:
1. **Install mode & location**: Confirm whether `@krusch/polygres-connector` was added to their project (Mode A) or cloned standalone with CLI access at `./bin/krusch-polygres.js` (Mode B).
2. **Verification results**: Confirm the offline `KRUSCH_EPHEMERAL=1` verification passed (`47/47` hermetic unit/parity/CLI/security tests plus `krusch-polygres status --json` and `symbol-context`) with `ALLOW_CLOUD=0` enforced.
3. **Optional live connection steps**: Explain where `.env` and `sql/schema_v1.sql` live if they want to connect a local PostgreSQL 16 instance or set `ALLOW_CLOUD=1` with `POLYGRES_URL` / `WONDERSEARCH_API_KEY`, and recommend running `krusch-polygres sync-context <workspace> --dry-run` before their first live push.
