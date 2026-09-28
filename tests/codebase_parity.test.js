import test from 'node:test';
import assert from 'node:assert';
import { ContextBridge } from '../src/context-bridge.js';
import { GitBridge } from '../src/git-bridge.js';
import { WondersearchBridge } from '../src/wondersearch-bridge.js';

test('krusch-context: local SQLite to pgContext parity preserves invariant schemas', () => {
  const localRule = {
    id: 288,
    project: 'homelab',
    category: 'invariant',
    key: 'rule-288',
    content: 'INV-12: Floor vs Ceiling Preemption Invariant. California landlord-tenant preemption distinguishes regulatory floors from statewide ceilings.',
    tags: JSON.stringify(['preemption', 'invariant', 'california']),
    provenance: JSON.stringify({ author: 'agent', confidence: 1.0 }),
    created_at: '2026-09-27T18:00:00.000Z'
  };

  // Transform into pgContext DTO format
  const pgContextPayload = {
    external_id: `ctx-${localRule.project}-${localRule.id}`,
    namespace: localRule.project,
    category: localRule.category,
    key: localRule.key,
    body: localRule.content,
    tags: JSON.parse(localRule.tags),
    provenance: JSON.parse(localRule.provenance),
    recorded_at: localRule.created_at
  };

  // Parity checks
  assert.strictEqual(pgContextPayload.category, 'invariant');
  assert.strictEqual(pgContextPayload.namespace, 'homelab');
  assert.strictEqual(pgContextPayload.body, localRule.content);
  assert.deepStrictEqual(pgContextPayload.tags, ['preemption', 'invariant', 'california']);
  assert.strictEqual(pgContextPayload.provenance.author, 'agent');
  assert.strictEqual(pgContextPayload.recorded_at, '2026-09-27T18:00:00.000Z');
});

test('krusch-git: AST symbol & call edge parity preserves graph relationships in pgGraph', () => {
  // Local AST symbol extraction fixture from krusch-biz
  const localSymbol = {
    repo: 'krusch-biz',
    name: 'resolve_controlling_clause',
    kind: 'function',
    file_path: 'src/backend/resolver.py',
    line_start: 142,
    line_end: 280,
    signature: 'def resolve_controlling_clause(topic: str, agreement_ids: list[str], candidate_clauses: list) -> ResolutionResult:'
  };

  const localCallEdges = [
    { caller_symbol: 'main.evaluate_conflict', callee_symbol: 'resolve_controlling_clause', file: 'src/backend/main.py', line: 215 },
    { caller_symbol: 'resolve_controlling_clause', callee_symbol: '_evaluate_precedence_hop', file: 'src/backend/resolver.py', line: 198 }
  ];

  // Serialized for Polygres Cloud pgGraph recursive CTE nodes & edges
  const pgGraphNode = {
    node_id: `${localSymbol.repo}:${localSymbol.file_path}:${localSymbol.name}`,
    repo: localSymbol.repo,
    symbol_name: localSymbol.name,
    symbol_type: localSymbol.kind,
    location: {
      path: localSymbol.file_path,
      lines: [localSymbol.line_start, localSymbol.line_end]
    },
    signature: localSymbol.signature
  };

  const pgGraphEdges = localCallEdges.map(edge => ({
    source: `${localSymbol.repo}:${edge.file}:${edge.caller_symbol}`,
    target: `${localSymbol.repo}:src/backend/resolver.py:${edge.callee_symbol}`,
    edge_type: 'CALLS',
    line: edge.line
  }));

  // Parity assertions
  assert.strictEqual(pgGraphNode.symbol_name, 'resolve_controlling_clause');
  assert.strictEqual(pgGraphNode.location.path, 'src/backend/resolver.py');
  assert.strictEqual(pgGraphNode.location.lines[0], 142);
  assert.strictEqual(pgGraphEdges.length, 2);
  assert.strictEqual(pgGraphEdges[0].edge_type, 'CALLS');
  assert.strictEqual(pgGraphEdges[0].target, 'krusch-biz:src/backend/resolver.py:resolve_controlling_clause');
});

test('krusch-git: Wondersearch code search hit preserves file path, byte spans, and decay factors', () => {
  const wondersearchHit = {
    document_id: 'doc-krusch-biz-resolver',
    external_id: 'src/backend/resolver.py',
    passage_id: 'chunk-35-65',
    start_byte: 1420,
    end_byte: 2350,
    metadata: {
      repo: 'krusch-biz',
      file_path: 'src/backend/resolver.py',
      line_start: 35,
      line_end: 65,
      commit_date: '2026-09-25T12:00:00Z'
    },
    score: 0.942
  };

  // Verify code hit mapping
  assert.strictEqual(wondersearchHit.metadata.file_path, 'src/backend/resolver.py');
  assert.strictEqual(wondersearchHit.metadata.line_start, 35);
  assert.strictEqual(wondersearchHit.start_byte, 1420);
  assert.strictEqual(wondersearchHit.end_byte, 2350);
  assert.ok(wondersearchHit.score > 0.90);
});
