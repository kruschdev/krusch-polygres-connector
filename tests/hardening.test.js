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

  // 5. Valid architectural invariant passes cleanly
  const validRecord = {
    id: 5,
    category: 'invariant',
    content: 'Rule #310: Public interface modifications must verify inbound callers via krusch-git first',
    metadata: { author: 'agent', tags: ['git', 'ast'] }
  };
  assert.strictEqual(sanitizeMemoryRecord(validRecord), true);
});

test('assertCloudAllowed enforces air-gap boundary for remote endpoints', () => {
  // Local endpoints allowed without ALLOW_CLOUD
  assert.strictEqual(assertCloudAllowed('http://localhost:11434', false), true);
  assert.strictEqual(assertCloudAllowed('postgresql://user:pass@127.0.0.1:5432/db', false), true);
  assert.strictEqual(assertCloudAllowed('http://10.0.0.85:5432', false), true);

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
