import test from 'node:test';
import assert from 'node:assert';
import { loadConfig } from '../src/config.js';
import { WondersearchBridge } from '../src/wondersearch-bridge.js';

test('Wondersearch Live: getWorkspaceContext resolves workspace and default drive', async () => {
  const config = loadConfig();
  if (!config.wondersearchApiKey) {
    console.log('Skipping live test: WONDERSEARCH_API_KEY not configured');
    return;
  }

  const bridge = new WondersearchBridge(config);
  try {
    const ctx = await bridge.getWorkspaceContext();
    assert.ok(ctx.workspaceId, 'workspaceId should be resolved');
    assert.strictEqual(typeof ctx.workspaceId, 'string');
    assert.ok(ctx.defaultDriveId, 'defaultDriveId should be resolved');
    assert.strictEqual(typeof ctx.defaultDriveId, 'string');
  } finally {
    await bridge.close();
  }
});

test('Wondersearch Live: createOrGetDrive resolves existing drive and caches driveId', async () => {
  const config = loadConfig();
  if (!config.wondersearchApiKey) return;

  const bridge = new WondersearchBridge(config);
  try {
    const driveId1 = await bridge.createOrGetDrive('repo-krusch-git');
    assert.ok(driveId1, 'driveId should be returned');
    assert.strictEqual(typeof driveId1, 'string');

    // Second call should return immediately from in-memory driveCache
    const driveId2 = await bridge.createOrGetDrive('repo-krusch-git');
    assert.strictEqual(driveId1, driveId2, 'Cached driveId must match');
  } finally {
    await bridge.close();
  }
});

test('Wondersearch Live: search retrieves code passages with byte spans, SHA pinning, and scores', async () => {
  const config = loadConfig();
  if (!config.wondersearchApiKey) return;

  const bridge = new WondersearchBridge(config);
  try {
    const driveId = await bridge.createOrGetDrive('repo-krusch-git');
    const res = await bridge.search({
      driveId,
      query: 'AST symbol chunker',
      limit: 3,
      effort: 'medium',
      groupByDocument: true
    });

    assert.ok(res.requestId, 'Response should contain requestId');
    assert.strictEqual(res.driveId, driveId, 'Returned driveId should match query drive');
    assert.ok(Array.isArray(res.results), 'Results should be an array');
    assert.ok(res.results.length > 0, 'Should find indexed passages for "AST symbol chunker"');
    assert.ok(res.results.length <= 3, 'Results count should adhere to limit parameter');

    const first = res.results[0];
    assert.ok(first.externalId, 'Result should have externalId file path');
    assert.strictEqual(typeof first.startByte, 'number', 'startByte should be a number');
    assert.strictEqual(typeof first.endByte, 'number', 'endByte should be a number');
    assert.ok(first.endByte > first.startByte, 'endByte should be strictly greater than startByte');
    assert.strictEqual(typeof first.score, 'number', 'Score should be a number');
    assert.ok(first.score > 0, 'Score should be positive');

    if (first.metadata && first.metadata.commit_sha) {
      assert.match(first.metadata.commit_sha, /^[0-9a-f]{40}$/i, 'Commit SHA must be a 40-character hex string');
    }
  } finally {
    await bridge.close();
  }
});

test('Wondersearch Live: batch document ingestion succeeds for non-privileged code passages', async () => {
  const config = loadConfig();
  if (!config.wondersearchApiKey) return;

  const bridge = new WondersearchBridge(config);
  try {
    const driveId = await bridge.createOrGetDrive('repo-krusch-git');
    const testDocId = `test://synthetic-${Date.now()}`;
    const testText = `export function testWondersearchIntegration() {\n  return "Wondersearch live test verified";\n}`;

    const ingestRes = await bridge.ingestDocuments({
      driveId,
      documents: [
        {
          externalId: testDocId,
          text: testText,
          metadata: {
            domain: 'testing',
            test_run: true,
            indexed_by: '@krusch/polygres-connector'
          }
        }
      ]
    });

    assert.ok(ingestRes, 'Ingestion response should be defined');
  } finally {
    await bridge.close();
  }
});

test('Wondersearch Live: air-gap guard rejects privileged litigation matter before network egress', async () => {
  const config = loadConfig();
  const bridge = new WondersearchBridge(config);

  try {
    await assert.rejects(async () => {
      await bridge.ingestDocuments({
        driveId: 'mock_or_real_drive_id',
        documents: [
          {
            externalId: 'matter://client-smith-confidential.pdf',
            text: 'Privileged attorney-client communication regarding antitrust settlement.',
            metadata: {
              classification: 'privileged',
              domain: 'matter'
            }
          }
        ]
      });
    }, /\[AirGapSecurityError\] Document '.*' marked as privileged litigation matter/);
  } finally {
    await bridge.close();
  }
});

test('Wondersearch Live: air-gap blocks cloud egress when ALLOW_CLOUD=0 even with valid API key', async () => {
  const config = loadConfig({ allowCloud: false });
  const bridge = new WondersearchBridge(config);

  try {
    await assert.rejects(async () => {
      await bridge.search({
        driveId: 'repo-krusch-git',
        query: 'test query'
      });
    }, /\[AirGapSecurityError\] Cloud egress to .* blocked/);
  } finally {
    await bridge.close();
  }
});
