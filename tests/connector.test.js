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
  const bridge = new WondersearchBridge({ wondersearchApiKey: 'test_token_abc', allowCloud: true });
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

test('createPolygresConnector creates only one sharedRemotePool across concurrent async contexts (BUG-01)', async () => {
  const connector = createPolygresConnector({
    polygresUrl: 'postgresql://postgres:postgres@127.0.0.1:5432/kdcode'
  });

  try {
    const pools = await Promise.all([
      connector.getSharedRemotePoolAsync(),
      connector.getSharedRemotePoolAsync(),
      Promise.resolve(connector.context.sharedRemotePool),
      Promise.resolve(connector.git.sharedRemotePool)
    ]);

    assert.ok(pools[0], 'sharedRemotePool should be initialized');
    for (const p of pools) {
      assert.strictEqual(p, pools[0], 'All concurrent callers must receive the exact same pg.Pool singleton');
    }
  } finally {
    await connector.close();
  }

  // BUG-02 & BUG-03: Missing polygresUrl throws synchronously in getSharedRemotePool and rejects in getSharedRemotePoolAsync
  const noUrlConnector = createPolygresConnector({ polygresUrl: '' });
  assert.throws(
    () => noUrlConnector.getSharedRemotePool(),
    /Polygres URL is required/
  );
  await assert.rejects(
    () => noUrlConnector.getSharedRemotePoolAsync(),
    /Polygres URL is required/
  );
});

test('missing-config guards reject when ContextBridge({}) and WondersearchBridge({}) lack credentials (TEST-01)', async () => {
  const prevPolygres = process.env.POLYGRES_URL;
  const prevDb = process.env.DATABASE_URL;
  const prevWsKey = process.env.WONDERSEARCH_API_KEY;
  delete process.env.POLYGRES_URL;
  delete process.env.DATABASE_URL;
  delete process.env.WONDERSEARCH_API_KEY;

  try {
    const ctxBridge = new ContextBridge({});
    assert.throws(() => ctxBridge._getPool(), /ContextBridge requires polygresUrl/);

    const wsBridge = new WondersearchBridge({});
    assert.throws(() => wsBridge._headers(), /requires an API key/);
  } finally {
    if (prevPolygres !== undefined) process.env.POLYGRES_URL = prevPolygres;
    if (prevDb !== undefined) process.env.DATABASE_URL = prevDb;
    if (prevWsKey !== undefined) process.env.WONDERSEARCH_API_KEY = prevWsKey;
  }
});

test('BUG-01, BUG-02, SEC-01: loadConfig avoids mutating process.env, surfaces .env read errors, and eliminates hardcoded passwords', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { ConfigurationError } = await import('../src/config.js');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygres-cfg-'));
  const customEnvPath = path.join(tmpDir, '.env');
  const uniqueEnvKey = `POLYGRES_TEST_ISOLATION_${Date.now()}`;
  fs.writeFileSync(
    customEnvPath,
    `${uniqueEnvKey}=isolated_val\nWONDERSEARCH_WORKSPACE_ID=ws_from_file\nKRUSCH_GIT_DB_PASSWORD=dynamic_secret\n`,
    'utf8'
  );

  const prevGitUrl = process.env.KRUSCH_GIT_DATABASE_URL;
  const prevGitPw = process.env.KRUSCH_GIT_DB_PASSWORD;
  const prevWsId = process.env.WONDERSEARCH_WORKSPACE_ID;
  delete process.env.KRUSCH_GIT_DATABASE_URL;
  delete process.env.KRUSCH_GIT_DB_PASSWORD;
  delete process.env.WONDERSEARCH_WORKSPACE_ID;

  try {
    const cfg = loadConfig({ envPath: customEnvPath });
    // BUG-01: process.env must not be mutated by .env loading
    assert.strictEqual(process.env[uniqueEnvKey], undefined);
    assert.strictEqual(process.env.WONDERSEARCH_WORKSPACE_ID, undefined);
    assert.strictEqual(cfg.wondersearchWorkspaceId, 'ws_from_file');
    // SEC-01: Uses KRUSCH_GIT_DB_PASSWORD instead of hardcoded 'password'
    assert.strictEqual(cfg.localGitDbUrl, 'postgresql://kdcode:dynamic_secret@localhost:5432/kdcode');

    // SEC-01: Throws ConfigurationError when requireGitDbPassword is set and no credentials exist
    const emptyEnvPath = path.join(tmpDir, '.env.empty');
    fs.writeFileSync(emptyEnvPath, '# empty\n', 'utf8');
    assert.throws(
      () => loadConfig({ envPath: emptyEnvPath, requireGitDbPassword: true }),
      (err) => err instanceof ConfigurationError && /Missing required database credentials/.test(err.message)
    );

    // BUG-02: Surfaces .env read errors (e.g., when envPath is a directory instead of a file)
    assert.throws(
      () => loadConfig({ envPath: tmpDir }),
      (err) => err instanceof ConfigurationError && /Failed reading \.env/.test(err.message)
    );
  } finally {
    if (prevGitUrl !== undefined) process.env.KRUSCH_GIT_DATABASE_URL = prevGitUrl;
    if (prevGitPw !== undefined) process.env.KRUSCH_GIT_DB_PASSWORD = prevGitPw;
    if (prevWsId !== undefined) process.env.WONDERSEARCH_WORKSPACE_ID = prevWsId;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SEC-01 & BUG-01: validateCliString and validatePolygresUrl enforce input validation', async () => {
  const { validateCliString, validatePolygresUrl } = await import('../src/index.js');

  assert.strictEqual(validateCliString('repo_name', 'krusch-git'), 'krusch-git');
  assert.strictEqual(
    validateCliString('symbol', '../db/pool.js', { allowRelativeSymbolPath: true }),
    '../db/pool.js'
  );
  assert.throws(() => validateCliString('repo_name', '../etc/passwd'), /is invalid/);
  assert.throws(() => validateCliString('repo_name', 'repo; rm -rf /'), /is invalid/);
  assert.throws(() => validateCliString('repo_name', ''), /is invalid/);

  validatePolygresUrl('postgresql://user:pass@localhost:5432/db');
  assert.throws(() => validatePolygresUrl('http://localhost:5432/db'), /postgres:\/\/ or postgresql:\/\/ protocol/);
  assert.throws(() => validatePolygresUrl('not-a-url'), /must be a valid URL/);
});

test('SEC-02: getWondersearchConfig centralizes and validates Wondersearch settings', async () => {
  const { getWondersearchConfig, ConfigurationError } = await import('../src/config.js');

  const cfg = getWondersearchConfig(
    {
      wondersearchApiKey: 'ws_key_abc',
      wondersearchBaseUrl: 'https://api.wondersearch.ai///',
      wondersearchWorkspaceId: 'ws_1',
      wondersearchDefaultDriveId: 'drv_1',
      allowCloud: true,
      allowedHosts: ['api.wondersearch.ai']
    },
    {}
  );
  assert.deepStrictEqual(cfg, {
    apiKey: 'ws_key_abc',
    baseUrl: 'https://api.wondersearch.ai',
    workspaceId: 'ws_1',
    defaultDriveId: 'drv_1',
    allowCloud: true
  });

  assert.throws(
    () => getWondersearchConfig({ wondersearchApiKey: '   ' }, {}),
    (err) => err instanceof ConfigurationError && /Invalid Wondersearch API key/.test(err.message)
  );
  assert.throws(
    () => getWondersearchConfig({ requireApiKey: true, wondersearchApiKey: null }, {}),
    (err) => err instanceof ConfigurationError && /Missing required Wondersearch API key/.test(err.message)
  );
  assert.throws(
    () => getWondersearchConfig({ wondersearchBaseUrl: 'ftp://api.wondersearch.ai' }, {}),
    (err) => err instanceof ConfigurationError && /Invalid Wondersearch baseUrl protocol/.test(err.message)
  );
  assert.throws(
    () => getWondersearchConfig({ wondersearchBaseUrl: 'https://evil.example.com', allowedHosts: ['api.wondersearch.ai'] }, {}),
    (err) => err instanceof ConfigurationError && /not in allowedHosts whitelist/.test(err.message)
  );
});





