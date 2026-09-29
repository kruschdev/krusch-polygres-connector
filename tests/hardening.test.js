import test from 'node:test';
import assert from 'node:assert';
import { assertCloudAllowed } from '../src/config.js';
import { sanitizeMemoryRecord } from '../src/context-bridge.js';

test('sanitizeMemoryRecord blocks credentials and private keys from cloud sync', () => {
  // 1. OpenAI key pattern
  assert.throws(() => {
    sanitizeMemoryRecord({
      id: 1,
      content: 'Use OpenAI key sk-abcdef123456789012345678 for embeddings'
    });
  }, /contains sensitive credentials/);

  // 2. Cloudflare token pattern
  assert.throws(() => {
    sanitizeMemoryRecord({
      id: 2,
      content: 'Set token to cfut_abcdef123456789012345678 for deployment'
    });
  }, /contains sensitive credentials/);

  // 3. GitHub personal access token pattern
  assert.throws(() => {
    sanitizeMemoryRecord({
      id: 3,
      content: 'Configured ghp_1234567890abcdef1234567890abcdef in CI'
    });
  }, /contains sensitive credentials/);

  // 4. Private key block pattern
  assert.throws(() => {
    sanitizeMemoryRecord({
      id: 4,
      content: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0... \n-----END RSA PRIVATE KEY-----'
    });
  }, /contains sensitive credentials/);

  // 5. AWS Access Key ID
  assert.throws(() => {
    sanitizeMemoryRecord({
      id: 5,
      content: 'Configured AWS key AKIAIOSFODNN7EXAMPLE for S3 backup'
    });
  }, /contains sensitive credentials/);

  // 6. Slack bot token
  assert.throws(() => {
    sanitizeMemoryRecord({
      id: 6,
      content: 'Alert webhook token xoxb-1234567890-abcdefghij'
    });
  }, /contains sensitive credentials/);

  // 7. JWT token
  assert.throws(() => {
    sanitizeMemoryRecord({
      id: 7,
      content: 'Session token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
    });
  }, /contains sensitive credentials/);

  // 8. Valid architectural invariant passes cleanly
  const validRecord = {
    id: 8,
    category: 'invariant',
    content: 'Rule #310: Public interface modifications must verify inbound callers via krusch-git first',
    metadata: { author: 'agent', tags: ['git', 'ast'] }
  };
  assert.strictEqual(sanitizeMemoryRecord(validRecord), true);
});

test('assertCloudAllowed enforces air-gap boundary for remote endpoints and allows private subnets', () => {
  // Local and loopback endpoints allowed without ALLOW_CLOUD
  assert.strictEqual(assertCloudAllowed('http://localhost:11434', false), true);
  assert.strictEqual(assertCloudAllowed('postgresql://user:pass@127.0.0.1:5432/db', false), true);
  assert.strictEqual(assertCloudAllowed('http://10.0.0.85:5432', false), true);
  assert.strictEqual(assertCloudAllowed('postgresql://user:pass@192.168.1.50:5432/db', false), true);

  // Docker internal bridge (172.16.0.0/12) allowed without ALLOW_CLOUD
  assert.strictEqual(assertCloudAllowed('postgresql://user:pass@172.17.0.2:5432/db', false), true);
  assert.strictEqual(assertCloudAllowed('http://172.31.255.255:8080', false), true);

  // Link-local and IPv6 ULA allowed without ALLOW_CLOUD
  assert.strictEqual(assertCloudAllowed('http://169.254.10.20:8080', false), true);
  assert.strictEqual(assertCloudAllowed('http://[fc00::1]:5432', false), true);
  assert.strictEqual(assertCloudAllowed('http://[fd12:3456:789a::1]:5432', false), true);

  // Public IP blocked when allowCloud is false
  assert.throws(() => {
    assertCloudAllowed('http://172.32.0.1:5432', false);
  }, /AirGapSecurityError/);

  // Remote cloud endpoint blocked when allowCloud is false
  assert.throws(() => {
    assertCloudAllowed('https://cloud.polygres.com:5432/db', false);
  }, /AirGapSecurityError/);

  assert.throws(() => {
    assertCloudAllowed('https://api.wondersearch.ai', false);
  }, /AirGapSecurityError/);

  // Remote cloud endpoint allowed when allowCloud is true
  assert.strictEqual(assertCloudAllowed('https://cloud.polygres.com:5432/db', true), true);
  assert.strictEqual(assertCloudAllowed('https://api.wondersearch.ai', true), true);
});

test('WondersearchBridge enforces classification air-gap guards on documents', async () => {
  const { WondersearchBridge } = await import('../src/wondersearch-bridge.js');
  const bridge = new WondersearchBridge({ wondersearchApiKey: 'dummy_key', allowCloud: true });

  await assert.rejects(async () => {
    await bridge.ingestDocument({
      driveId: 'drv_test',
      externalId: 'matter://1234/deposition',
      text: 'Confidential client interview transcript',
      metadata: { classification: 'privileged' }
    });
  }, /AirGapSecurityError/);

  await assert.rejects(async () => {
    await bridge.ingestDocument({
      driveId: 'drv_test',
      externalId: 'matter://5678/motion',
      text: 'Motion in limine draft',
      metadata: { domain: 'matter' }
    });
  }, /AirGapSecurityError/);
});

test('GitBridge and ContextBridge initialize pools lazily', async () => {
  const { GitBridge } = await import('../src/git-bridge.js');
  const { ContextBridge } = await import('../src/context-bridge.js');

  const gitBridge = new GitBridge({
    localGitDbUrl: 'postgresql://postgres:postgres@localhost:5432/kruschdb',
    polygresUrl: 'postgresql://postgres:postgres@localhost:5432/kruschdb'
  });
  assert.strictEqual(gitBridge.localPool, null);
  assert.strictEqual(gitBridge.remotePool, null);
  await gitBridge.close();

  const ctxBridge = new ContextBridge({
    polygresUrl: 'postgresql://postgres:postgres@localhost:5432/kruschdb'
  });
  assert.strictEqual(ctxBridge.pool, null);
  await ctxBridge.close();
});

