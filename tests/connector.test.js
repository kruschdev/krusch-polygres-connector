import test from 'node:test';
import assert from 'node:assert';
import { loadConfig } from '../src/config.js';
import { WondersearchBridge } from '../src/wondersearch-bridge.js';
import { ContextBridge } from '../src/context-bridge.js';
import { GitBridge } from '../src/git-bridge.js';
import { createPolygresConnector } from '../src/index.js';

test('loadConfig() returns defaulted and overridden options', () => {
  const cfg = loadConfig({
    polygresUrl: 'postgresql://test:test@polygres.com:5432/db',
    wondersearchApiKey: 'ws_key_123'
  });

  assert.strictEqual(cfg.polygresUrl, 'postgresql://test:test@polygres.com:5432/db');
  assert.strictEqual(cfg.wondersearchApiKey, 'ws_key_123');
  assert.strictEqual(cfg.wondersearchBaseUrl, 'https://api.wondersearch.ai');
  assert.ok(cfg.localContextDbPath.endsWith('.agent/context.db'));
});

test('WondersearchBridge validates API key requirement', async () => {
  const bridge = new WondersearchBridge({ wondersearchApiKey: null });
  assert.throws(() => {
    bridge._headers();
  }, /requires an API key/);
});

test('WondersearchBridge generates correct headers with idempotency key', () => {
  const bridge = new WondersearchBridge({ wondersearchApiKey: 'test_token_abc' });
  const headers = bridge._headers('custom-key-1');
  assert.strictEqual(headers['Authorization'], 'Bearer test_token_abc');
  assert.strictEqual(headers['Idempotency-Key'], 'custom-key-1');
  assert.strictEqual(headers['Content-Type'], 'application/json');
});

test('ContextBridge handles missing polygresUrl gracefully', async () => {
  const bridge = new ContextBridge({ localContextDbPath: '/tmp/nonexistent.db', polygresUrl: null });
  assert.strictEqual(bridge.readLocalEntries().length, 0);

  await assert.rejects(async () => {
    await bridge.pushLocalContext();
  }, /requires polygresUrl/);
});

test('GitBridge requires database connections', async () => {
  const bridge = new GitBridge({ localGitDbUrl: null, polygresUrl: null });
  await assert.rejects(async () => {
    await bridge.pushGitDagAndSymbols('test_repo');
  }, /requires both localGitDbUrl and polygresUrl/);
});

test('createPolygresConnector factory bundles all bridges', async () => {
  const connector = createPolygresConnector({
    wondersearchApiKey: 'dummy_key'
  });

  assert.ok(connector.context instanceof ContextBridge);
  assert.ok(connector.git instanceof GitBridge);
  assert.ok(connector.wondersearch instanceof WondersearchBridge);

  await connector.close();
});

test('WondersearchBridge syncAuthorityPacks validates directory existence', async () => {
  const bridge = new WondersearchBridge({ wondersearchApiKey: 'dummy_key', wondersearchWorkspaceId: 'ws_1' });
  bridge.createOrGetDrive = async () => 'mock_drive_1';

  await assert.rejects(async () => {
    await bridge.syncAuthorityPacks('/tmp/nonexistent_authority_packs_dir');
  }, /Authority packs directory not found/);
});

test('WondersearchBridge syncPlaybooks validates directory existence', async () => {
  const bridge = new WondersearchBridge({ wondersearchApiKey: 'dummy_key', wondersearchWorkspaceId: 'ws_1' });
  bridge.createOrGetDrive = async () => 'mock_drive_2';

  await assert.rejects(async () => {
    await bridge.syncPlaybooks('/tmp/nonexistent_playbooks_dir');
  }, /Playbooks directory not found/);
});
