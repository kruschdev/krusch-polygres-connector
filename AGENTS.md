# Krusch Polygres Connector Guidelines (`AGENTS.md`)

> **Package**: `@krusch/polygres-connector`  
> **Type**: Standalone Plugin / Storage Adapter  
> **Status**: 0.1 preview  
> **Schema Version**: 1 (compatible with standard PostgreSQL & Polygres)

---

## 🎯 Purpose & Constraints
1. **Peripheral Plugin**: This package MUST remain decoupled from the local sovereign monorepo core. It is an optional toolkit bridging Krusch fleet agents to PostgreSQL (Polygres Cloud or self-hosted) and Wondersearch.
2. **Dual-Path Storage Protocol**:
   - Commits, Git DAG, Trees, AST symbols, caller/callee edges, and Invariants go to **PostgreSQL**.
   - Code blobs, text passages, and semantic retrieval go to **Wondersearch Drives** (`repo-<name>`).
3. **Zero GPU Dependency**: When operating in cloud mode, semantic code search utilizes Wondersearch rather than local Ollama vector pipelines.
4. **Air-Gap Invariant**: Privileged litigation matters from `krusch-law` are strictly air-gapped on-premises (ABA Model Rule 1.6). Any cloud egress attempt fails closed with `AirGapSecurityError`.
5. **Frozen Contracts**: All sync operations execute in atomic transactions (`sync_runs` tracking, non-destructive upserts, 40-character SHA pinning, and credential redaction).

---

## 🧪 Testing
Run tests via Node's native test runner:
```bash
npm test
```
