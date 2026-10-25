import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPolygresConnector, ConfigurationError } from '../src/index.js';

describe('getSharedRemotePool concurrency & validation (BUG-01, BUG-02, SEC-01, TEST-01)', () => {
  it('returns the exact same singleton pool instance across 10 concurrent getSharedRemotePoolAsync calls', async () => {
    const prevEphemeral = process.env.KRUSCH_EPHEMERAL;
    process.env.KRUSCH_EPHEMERAL = '1';
    try {
      const connector = createPolygresConnector({
        polygresUrl: 'postgresql://127.0.0.1:5432/kdcode'
      });

      const pools = await Promise.all(
        Array.from({ length: 10 }, () => connector.getSharedRemotePoolAsync())
      );
      const first = pools[0];
      assert.ok(first, 'Expected a pool instance');
      for (const p of pools) {
        assert.equal(p, first, 'All concurrent callers must receive the exact same pool singleton');
      }
      await connector.close();
    } finally {
      if (prevEphemeral === undefined) {
        delete process.env.KRUSCH_EPHEMERAL;
      } else {
        process.env.KRUSCH_EPHEMERAL = prevEphemeral;
      }
    }
  });

  it('rejects malformed polygresUrl with ConfigurationError before pool creation', async () => {
    assert.throws(
      () =>
        createPolygresConnector({
          polygresUrl: 'not-a-valid-url'
        }),
      (err) => err instanceof ConfigurationError
    );

    const connector = createPolygresConnector({ polygresUrl: null });
    connector.config.polygresUrl = 'not-a-valid-url';
    assert.throws(
      () => connector.getSharedRemotePool(),
      (err) => err instanceof ConfigurationError
    );
    await assert.rejects(
      () => connector.getSharedRemotePoolAsync(),
      (err) => err instanceof ConfigurationError
    );
  });

  it('logs warning when fs.realpathSync fails in assertMatterNotPrivileged and still blocks privileged paths (BUG-01)', async () => {
    const { assertMatterNotPrivileged } = await import('../src/config.js');
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      assert.equal(assertMatterNotPrivileged('/tmp/nonexistent-polygres-safe-dir-99999'), true);
      assert.ok(warnings.some((w) => w.includes('[config] realpathSync failed:')));
      assert.throws(
        () => assertMatterNotPrivileged('/tmp/nonexistent-polygres/krusch-law/data/matters/case-1'),
        /AirGapSecurityError/
      );
    } finally {
      console.warn = origWarn;
    }
  });
});

