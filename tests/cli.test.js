import test from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const binPath = path.resolve(__dirname, '../bin/krusch-polygres.js');

test('CLI: --help prints command list including new pgGraph commands', async () => {
  const { stdout } = await execFileAsync(process.execPath, [binPath, '--help']);
  assert.ok(stdout.includes('symbol-context <repo> <symbol> [ws]'));
  assert.ok(stdout.includes('dep-graph <repo_name> <symbol>'));
  assert.ok(stdout.includes('blast-radius <repo> <symbol> [ws]'));
  assert.ok(stdout.includes('audit-refactor <repo> <sym> [action]'));
  assert.ok(stdout.includes('cross-query <repo_name> [workspace]'));
});

test('CLI: --version prints version string', async () => {
  const { stdout } = await execFileAsync(process.execPath, [binPath, '--version']);
  assert.ok(stdout.includes('@krusch/polygres-connector v0.1.0-preview'));
});

test('CLI: status --json returns valid JSON health diagnostics', async () => {
  const { stdout } = await execFileAsync(process.execPath, [binPath, 'status', '--json']);
  const parsed = JSON.parse(stdout);
  assert.strictEqual(parsed.schemaVersion, 1);
  assert.ok(parsed.probe);
  assert.strictEqual(typeof parsed.probe.localGit.ok, 'boolean');
  assert.strictEqual(typeof parsed.probe.remotePostgres.ok, 'boolean');
});

test('CLI: symbol-context --json returns structured AST symbol and context', async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    binPath,
    'symbol-context',
    'krusch-git',
    'calculateCentroid',
    'krusch-context-mcp',
    '--json'
  ]);
  const parsed = JSON.parse(stdout);
  assert.strictEqual(parsed.repository, 'krusch-git');
  assert.strictEqual(parsed.symbolName, 'calculateCentroid');
  assert.strictEqual(parsed.symbol.kind, 'function');
  assert.strictEqual(parsed.symbol.file_path, 'lib/embedding.js');
  assert.ok(Array.isArray(parsed.dependencyGraph.inboundCallers));
  assert.ok(parsed.audit);
});

test('CLI: dep-graph returns recursive caller hierarchy', async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    binPath,
    'dep-graph',
    'krusch-git',
    '../db/pool.js',
    '--json'
  ]);
  const parsed = JSON.parse(stdout);
  assert.strictEqual(parsed.symbol, '../db/pool.js');
  assert.ok(parsed.inboundCallers.length > 0);
  assert.ok(parsed.inboundCallers.some(c => c.source_path.includes('sync_to_pg.js')));
});

test('CLI: blast-radius returns decorated upstream nodes', async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    binPath,
    'blast-radius',
    'krusch-git',
    '../db/pool.js',
    'krusch-context-mcp',
    '--json'
  ]);
  const parsed = JSON.parse(stdout);
  assert.strictEqual(parsed.rootSymbol, '../db/pool.js');
  assert.ok(parsed.blastRadius >= 1);
  assert.ok(parsed.callerNodes.length >= 1);
});

test('CLI: audit-refactor enforces caller invariant on rename', async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    binPath,
    'audit-refactor',
    'krusch-git',
    '../db/pool.js',
    'rename',
    'krusch-context-mcp',
    '--json'
  ]);
  const parsed = JSON.parse(stdout);
  assert.strictEqual(parsed.symbolName, '../db/pool.js');
  assert.strictEqual(parsed.proposedAction, 'rename');
  assert.strictEqual(parsed.requiresManualConfirmation, true);
  assert.ok(parsed.warnings.some(w => w.includes('AST caller verification')));
});

test('CLI: cross-query returns relational join between symbols and context', async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    binPath,
    'cross-query',
    'krusch-git',
    'krusch-context-mcp',
    '--json'
  ]);
  const parsed = JSON.parse(stdout);
  assert.ok(Array.isArray(parsed));
  assert.ok(parsed.length > 0);
  assert.ok(parsed[0].symbol_name);
  assert.ok(parsed[0].context_content);
});
