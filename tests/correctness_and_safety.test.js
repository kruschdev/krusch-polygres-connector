import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { assertMatterNotPrivileged, maskUrl, maskToken } from '../src/config.js';
import { sanitizeMemoryRecord, redactSensitiveText, ContextBridge } from '../src/context-bridge.js';
import { GitBridge } from '../src/git-bridge.js';
import { createPolygresConnector } from '../src/index.js';

test('assertMatterNotPrivileged enforces realpath denial for privileged matter paths', () => {
  // 1. Allowed paths
  assert.strictEqual(assertMatterNotPrivileged('/tmp/public-statutes/ca-civil-code.yaml'), true);
  assert.strictEqual(assertMatterNotPrivileged('./data/playbooks/standard-msa.md'), true);

  // 2. Denied paths
  assert.throws(() => {
    assertMatterNotPrivileged('/home/krusch/homelab/projects/krusch-law/data/matters/matter_001/deposition.yaml');
  }, /AirGapSecurityError/);

  assert.throws(() => {
    assertMatterNotPrivileged('/home/krusch/homelab/projects/krusch-law/evidence/case_44/docs.pdf');
  }, /AirGapSecurityError/);

  assert.throws(() => {
    assertMatterNotPrivileged('/var/data/matters/client_privilege.json');
  }, /AirGapSecurityError/);
});

test('redactSensitiveText replaces credentials and connection strings with [REDACTED_SECRET]', () => {
  const dirty = `
    OpenAI key: sk-abcdef123456789012345678
    AWS key: AKIAIOSFODNN7EXAMPLE
    Slack token: xoxb-1234567890-abcdefghij
    Database URL: postgres://admin:super_secret_pw@10.0.0.85:5432/kruschdb
    JWT: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c
  `;

  const cleaned = redactSensitiveText(dirty);
  assert.ok(!cleaned.includes('sk-abcdef123456789012345678'));
  assert.ok(!cleaned.includes('AKIAIOSFODNN7EXAMPLE'));
  assert.ok(!cleaned.includes('xoxb-1234567890-abcdefghij'));
  assert.ok(!cleaned.includes('super_secret_pw'));
  assert.ok(cleaned.includes('[REDACTED_SECRET]'));
});

test('sanitizeMemoryRecord with redact: true preserves sync while removing secrets', () => {
  const dirtyRecord = {
    id: 101,
    category: 'decision',
    content: 'Connect to prod with postgresql://dbuser:mypassword123@prod.internal:5432/app',
    metadata: { key: 'sk-abcdef123456789012345678' }
  };

  const { record, redacted } = sanitizeMemoryRecord(dirtyRecord, { redact: true });
  assert.strictEqual(redacted, true);
  assert.strictEqual(record.id, 101);
  assert.ok(!record.content.includes('mypassword123'));
  assert.ok(record.content.includes('[REDACTED_SECRET]'));
  assert.strictEqual(record.metadata.key, '[REDACTED_SECRET]');
});

test('maskUrl and maskToken protect sensitive DSNs and tokens from console leakage', () => {
  const dsn = 'postgresql://postgres:mypassword123@cloud.polygres.com:5432/team_db';
  const maskedDsn = maskUrl(dsn);
  assert.ok(!maskedDsn.includes('mypassword123'));
  assert.ok(maskedDsn.includes('********@cloud.polygres.com'));

  const token = 'ws_live_secret_token_123456789';
  const maskedToken = maskToken(token);
  assert.strictEqual(maskedToken, 'ws_l...6789');
  assert.strictEqual(maskToken(null), 'not configured');
});

test('resolveHeadSha rejects invalid SHA strings and resolves 40-char commit SHA', async () => {
  const gitBridge = new GitBridge({
    localGitDbUrl: 'postgresql://postgres:postgres@localhost:5432/kruschdb',
    polygresUrl: 'postgresql://postgres:postgres@localhost:5432/kruschdb'
  });

  // Mock _getLocalPool
  gitBridge._getLocalPool = () => ({
    query: async (sql, params) => {
      if (sql.includes('FROM branches')) {
        return { rows: [{ commit_id: '0123456789abcdef0123456789abcdef01234567', name: 'main' }] };
      }
      if (sql.includes('FROM commits')) {
        return { rows: [{ id: '0123456789abcdef0123456789abcdef01234567' }] };
      }
      return { rows: [] };
    }
  });

  // 1. Valid 40-char SHA passed
  const explicit = '0123456789abcdef0123456789abcdef01234567';
  const resolved = await gitBridge.resolveHeadSha(1, explicit);
  assert.strictEqual(resolved, explicit);

  // 2. String 'HEAD' resolves to 40-char SHA from branch tip, never stores literal 'HEAD'
  const resolvedHead = await gitBridge.resolveHeadSha(1, 'HEAD');
  assert.strictEqual(resolvedHead, '0123456789abcdef0123456789abcdef01234567');
  assert.notStrictEqual(resolvedHead, 'HEAD');

  // 3. Invalid non-hex SHA throws
  await assert.rejects(async () => {
    await gitBridge.resolveHeadSha(1, 'not-a-valid-sha');
  }, /Invalid commit SHA/);
});

test('ContextBridge writeLocalEntries writes remote items back into local SQLite', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-test-'));
  const dbPath = path.join(tmpDir, 'context.db');

  const bridge = new ContextBridge({ localContextDbPath: dbPath });

  const testItems = [
    {
      local_id: 1,
      category: 'invariant',
      content: 'Rule #1: Zero-trust context verification on turn 1',
      status: 'active',
      metadata: { tag: 'security' }
    },
    {
      local_id: 2,
      category: 'decision',
      content: 'Decision #2: Swappable storage substrates for agent memory',
      status: 'active',
      metadata: { tag: 'architecture' }
    }
  ];

  const written = bridge.writeLocalEntries(testItems);
  assert.strictEqual(written, 2);

  const localEntries = bridge.readLocalEntries();
  assert.strictEqual(localEntries.length, 2);
  assert.strictEqual(localEntries[0].id, 1);
  assert.strictEqual(localEntries[0].category, 'invariant');
  assert.strictEqual(localEntries[1].id, 2);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('createPolygresConnector shares a single remote pool between Context and Git bridges', async () => {
  const connector = createPolygresConnector({
    polygresUrl: 'postgresql://postgres:postgres@localhost:5432/kruschdb'
  });

  // Check that both bridges reference the shared remote pool
  const ctxPool = connector.context.sharedPool;
  const gitPool = connector.git.sharedRemotePool;
  assert.ok(ctxPool);
  assert.strictEqual(ctxPool, gitPool);

  await connector.close();
});

test('connector.probeStatus returns clean structured health report without throwing', async () => {
  const connector = createPolygresConnector({
    localContextDbPath: '/tmp/nonexistent-test-context.db',
    localGitDbUrl: 'postgresql://invalid:invalid@127.0.0.1:59999/nodb',
    polygresUrl: null
  });

  const probe = await connector.probeStatus();
  assert.strictEqual(typeof probe.schemaVersion, 'number');
  assert.strictEqual(typeof probe.localContext.ok, 'boolean');
  assert.strictEqual(probe.remotePostgres.ok, false);

  await connector.close();
});
