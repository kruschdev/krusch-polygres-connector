import test from 'node:test';
import assert from 'node:assert';
import { createPolygresConnector } from '../src/index.js';
import { loadConfig } from '../src/config.js';

test('Context + pgGraph: remote PostgreSQL schemas initialize idempotently', async () => {
  const config = loadConfig();
  const connector = createPolygresConnector({
    polygresUrl: config.localGitDbUrl || 'postgresql://kdcode:password@localhost:5432/kdcode',
    localGitDbUrl: config.localGitDbUrl || 'postgresql://kdcode:password@localhost:5432/kdcode',
    allowCloud: true
  });

  try {
    await connector.git.initializeRemoteSchema();
    await connector.context.initializeRemoteSchema();

    const probe = await connector.probeStatus();
    assert.strictEqual(probe.remotePostgres.ok, true, 'Remote Postgres probe should be OK');
    assert.ok(probe.remotePostgres.tables.includes('pg_context_items'), 'Should include pg_context_items');
    assert.ok(probe.remotePostgres.tables.includes('pg_git_symbols'), 'Should include pg_git_symbols');
    assert.ok(probe.remotePostgres.tables.includes('pg_git_symbol_edges'), 'Should include pg_git_symbol_edges');
  } finally {
    await connector.close();
  }
});

test('Context + pgGraph: GitBridge pushes AST symbols and call graph edges to pgGraph', async () => {
  const config = loadConfig();
  const connector = createPolygresConnector({
    polygresUrl: config.localGitDbUrl || 'postgresql://kdcode:password@localhost:5432/kdcode',
    localGitDbUrl: config.localGitDbUrl || 'postgresql://kdcode:password@localhost:5432/kdcode',
    allowCloud: true
  });

  try {
    const pushRes = await connector.git.pushGitDagAndSymbols('krusch-git');
    assert.strictEqual(pushRes.repository, 'krusch-git');
    assert.ok(pushRes.symbolsPushed > 0, 'Symbols should be pushed');
    assert.ok(pushRes.edgesPushed > 0, 'Symbol edges should be pushed');
    assert.strictEqual(pushRes.dryRun, false);

    // Verify symbols can be queried
    const symbols = await connector.git.findSymbols('krusch-git', '', { limit: 10 });
    assert.ok(symbols.length > 0, 'Should find symbols in pg_git_symbols');
    const firstSym = symbols[0];
    assert.ok(firstSym.symbol_name);
    assert.ok(firstSym.file_path);
    assert.strictEqual(typeof firstSym.start_line, 'number');
    assert.strictEqual(typeof firstSym.end_line, 'number');
  } finally {
    await connector.close();
  }
});

test('Context + pgGraph: ContextBridge pushes working memory and invariants from ide_agent_memory', async () => {
  const config = loadConfig();
  const connector = createPolygresConnector({
    polygresUrl: config.localGitDbUrl || 'postgresql://kdcode:password@localhost:5432/kdcode',
    localContextDbPath: '/home/krusch/homelab/projects/krusch-context-mcp/.agent/context.db',
    allowCloud: true
  });

  try {
    const pushRes = await connector.context.pushLocalContext('krusch-context-mcp');
    assert.ok(pushRes.pushed > 0, 'Should push context items');
    assert.strictEqual(typeof pushRes.redacted, 'number');

    const invariants = await connector.context.getActiveInvariants('krusch-context-mcp');
    assert.ok(invariants.length > 0, 'Should retrieve active invariants');
    const firstInv = invariants[0];
    assert.strictEqual(firstInv.category, 'invariant');
    assert.strictEqual(firstInv.status, 'active');
    assert.ok(firstInv.content);
  } finally {
    await connector.close();
  }
});

test('Context + pgGraph: getSymbolContext marries AST symbol, recursive caller CTE, and steering invariants', async () => {
  const config = loadConfig();
  const connector = createPolygresConnector({
    polygresUrl: config.localGitDbUrl || 'postgresql://kdcode:password@localhost:5432/kdcode',
    localGitDbUrl: config.localGitDbUrl || 'postgresql://kdcode:password@localhost:5432/kdcode',
    allowCloud: true
  });

  try {
    const symContext = await connector.getSymbolContext({
      repoName: 'krusch-git',
      symbolName: '../db/pool.js',
      workspaceName: 'krusch-context-mcp'
    });

    assert.strictEqual(symContext.repository, 'krusch-git');
    assert.strictEqual(symContext.symbolName, '../db/pool.js');
    assert.ok(symContext.dependencyGraph, 'Dependency graph must be present');
    assert.ok(symContext.dependencyGraph.inboundCallers.length > 0, 'Should have inbound callers from pgGraph');
    assert.strictEqual(symContext.audit.blastRadius, symContext.dependencyGraph.inboundCallers.length);
    assert.strictEqual(symContext.audit.requiresCallerAudit, true, 'Inbound callers must trigger requiresCallerAudit');
    assert.ok(symContext.audit.warnings.length > 0, 'Should include invariant enforcement warnings');
    assert.match(symContext.audit.warnings[0], /\[InvariantRule\]/);
  } finally {
    await connector.close();
  }
});

test('Context + pgGraph: getSymbolContext resolves exact AST function definition and line numbers', async () => {
  const config = loadConfig();
  const connector = createPolygresConnector({
    polygresUrl: config.localGitDbUrl || 'postgresql://kdcode:password@localhost:5432/kdcode',
    localGitDbUrl: config.localGitDbUrl || 'postgresql://kdcode:password@localhost:5432/kdcode',
    allowCloud: true
  });

  try {
    const symContext = await connector.getSymbolContext({
      repoName: 'krusch-git',
      symbolName: 'calculateCentroid',
      workspaceName: 'krusch-context-mcp'
    });

    assert.ok(symContext.symbol, 'Symbol calculateCentroid should be resolved');
    assert.strictEqual(symContext.symbol.symbol_name, 'calculateCentroid');
    assert.strictEqual(symContext.symbol.file_path, 'lib/embedding.js');
    assert.strictEqual(symContext.symbol.kind, 'function');
    assert.deepStrictEqual(symContext.symbol.location.lines, [79, 105]);
    assert.match(symContext.symbol.signature, /calculateCentroid/);
    assert.match(symContext.symbol.commit_sha, /^[0-9a-f]{40}$/);
    assert.ok(symContext.context.generalInvariants.length > 0, 'Should hydrate general invariants');
  } finally {
    await connector.close();
  }
});

test('Context + pgGraph: traceBlastRadiusWithInvariants attaches invariants to each caller node in graph', async () => {
  const config = loadConfig();
  const connector = createPolygresConnector({
    polygresUrl: config.localGitDbUrl || 'postgresql://kdcode:password@localhost:5432/kdcode',
    localGitDbUrl: config.localGitDbUrl || 'postgresql://kdcode:password@localhost:5432/kdcode',
    allowCloud: true
  });

  try {
    const blast = await connector.traceBlastRadiusWithInvariants({
      repoName: 'krusch-git',
      symbolName: '../db/pool.js',
      workspaceName: 'krusch-context-mcp'
    });

    assert.strictEqual(blast.rootSymbol, '../db/pool.js');
    assert.ok(blast.blastRadius > 0, 'Blast radius should be greater than 0');
    assert.ok(Array.isArray(blast.callerNodes), 'callerNodes should be an array');

    for (const node of blast.callerNodes) {
      assert.ok(node.symbol);
      assert.ok(node.filePath);
      assert.strictEqual(typeof node.depth, 'number');
      assert.ok(Array.isArray(node.invariants));
    }
  } finally {
    await connector.close();
  }
});

test('Context + pgGraph: auditSymbolRefactor flags manual confirmation when renaming public callers', async () => {
  const config = loadConfig();
  const connector = createPolygresConnector({
    polygresUrl: config.localGitDbUrl || 'postgresql://kdcode:password@localhost:5432/kdcode',
    localGitDbUrl: config.localGitDbUrl || 'postgresql://kdcode:password@localhost:5432/kdcode',
    allowCloud: true
  });

  try {
    const auditRename = await connector.auditSymbolRefactor({
      repoName: 'krusch-git',
      symbolName: '../db/pool.js',
      proposedAction: 'rename',
      workspaceName: 'krusch-context-mcp'
    });

    assert.strictEqual(auditRename.allowed, true);
    assert.strictEqual(auditRename.requiresManualConfirmation, true, 'Renaming with inbound callers requires manual confirmation');
    assert.ok(auditRename.blastRadius > 0);
    assert.ok(auditRename.inboundCallers.length > 0);

    // Modifying without renaming does not flag manual confirmation if allowed
    const auditModify = await connector.auditSymbolRefactor({
      repoName: 'krusch-git',
      symbolName: '../db/pool.js',
      proposedAction: 'modify',
      workspaceName: 'krusch-context-mcp'
    });
    assert.strictEqual(auditModify.requiresManualConfirmation, false);
  } finally {
    await connector.close();
  }
});

test('Context + pgGraph: queryCrossSubstrate executes relational JOIN between AST symbols and context items', async () => {
  const config = loadConfig();
  const connector = createPolygresConnector({
    polygresUrl: config.localGitDbUrl || 'postgresql://kdcode:password@localhost:5432/kdcode',
    localGitDbUrl: config.localGitDbUrl || 'postgresql://kdcode:password@localhost:5432/kdcode',
    allowCloud: true
  });

  try {
    const rows = await connector.queryCrossSubstrate({
      repoName: 'krusch-git',
      workspaceName: 'krusch-context-mcp',
      limit: 20
    });

    assert.ok(Array.isArray(rows));
    if (rows.length > 0) {
      const first = rows[0];
      assert.ok(first.symbol_name);
      assert.ok(first.file_path);
      assert.ok(first.context_content);
      assert.strictEqual(first.context_status, 'active');
    }
  } finally {
    await connector.close();
  }
});
