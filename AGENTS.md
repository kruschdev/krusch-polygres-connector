# Krusch Polygres Connector Guidelines (`AGENTS.md`)

> **Package**: `@krusch/polygres-connector`  
> **Type**: Standalone Plugin / Cloud Connector  
> **Status**: Production Ready  

---

## 🎯 Purpose & Constraints
1. **Peripheral Plugin**: This package MUST remain decoupled from the local sovereign monorepo core. It is an optional toolkit that bridges Krusch fleet agents to Polygres Cloud and Wondersearch.
2. **Dual-Path Storage Protocol**:
   - Commits, Git DAG, AST symbols, and Invariants go to **Polygres Cloud** (`pgContext` / `pgGraph`).
   - Code blobs, text passages, and semantic retrieval go to **Wondersearch Drives** (`repo-<name>`).
3. **Zero GPU Dependency**: When operating in cloud mode, semantic code search utilizes Wondersearch rather than local Ollama vector pipelines.
4. **Frozen Contracts**: Adheres to the 3-Tier Coding Agent Standard.

---

## 🧪 Testing
Run tests via Node's native test runner:
```bash
npm test
```
