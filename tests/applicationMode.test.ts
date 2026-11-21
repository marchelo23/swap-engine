import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { setup, testAccount } from './helpers.js';
import { createApi } from '../src/api/server.js';
import { applicationMode, config, type ApplicationMode } from '../src/config.js';
import type { SwapManager } from '../src/core/SwapManager.js';

const env = (values: Record<string, string>): NodeJS.ProcessEnv => values as NodeJS.ProcessEnv;

test('application mode defaults to simulation and accepts only simulation or regtest', () => {
  assert.equal(applicationMode(undefined), 'simulation');
  assert.equal(applicationMode('simulation'), 'simulation');
  assert.equal(applicationMode('SIMULATION'), 'simulation');
  assert.equal(applicationMode(' regtest '), 'regtest');
  assert.equal(applicationMode('regtest-read-only'), 'regtest');
  for (const mode of ['mainnet', 'MAINNET', 'main', 'bitcoin', 'live', 'production']) {
    assert.throws(() => applicationMode(mode), /Mainnet is rejected/);
  }
  assert.throws(() => applicationMode('testnet'), /Invalid application mode/);
  assert.equal(config({}).mode, 'simulation');
  assert.equal(config(env({ APP_MODE: 'regtest' })).mode, 'regtest');
  assert.equal(config(env({ APP_MODE: 'regtest' })).readOnly, true);
  assert.equal(config(env({ APP_MODE: 'regtest' })).network, 'regtest');
  assert.throws(() => config(env({ APP_MODE: 'mainnet' })), /Mainnet is rejected/);
});

test('ENABLE_LIVE_SWAPS=true remains a startup refusal in both application modes', () => {
  for (const mode of ['simulation', 'regtest']) {
    assert.throws(() => config(env({ APP_MODE: mode, ENABLE_LIVE_SWAPS: 'true' })), /unavailable/);
    assert.equal(config(env({ APP_MODE: mode, ENABLE_LIVE_SWAPS: 'false' })).mode, mode);
  }
});

async function serve(mode: ApplicationMode, manager: SwapManager, diagnostics?: () => any, storePath?: string) {
  const server = createApi(manager, async () => ({ onchainSats: 1_000_000, incomingSats: 1_000_000 }), diagnostics, mode, { auth: { storePath } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

test('health clearly labels simulation and regtest read-only modes without enabling swaps', async () => {
  const f = await setup();
  try {
    for (const mode of ['simulation', 'regtest'] as const) {
      const app = await serve(mode, f.manager);
      try {
        const response = await fetch(`${app.base}/v1/health`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { status: 'components-only', liveSwapsEnabled: false, readOnly: true, network: 'regtest', mode });
      } finally { await app.close(); }
    }
  } finally { await f.cleanup(); }
});

test('reverse-swap execution gate stays at 503 in simulation and regtest modes', async () => {
  const f = await setup();
  try {
    const account = await testAccount(f.directory, 'USER');
    const before = Object.keys(f.store.read().swaps).length;
    for (const mode of ['simulation', 'regtest'] as const) {
      const app = await serve(mode, f.manager, undefined, account.storePath);
      try {
        const response = await fetch(`${app.base}/v1/swaps/reverse`, {
          method: 'POST',
          headers: { ...await account.headers(app.base), 'content-type': 'application/json', 'idempotency-key': `gate-${mode}-1` },
          body: JSON.stringify({ quoteId: f.quote.id, paymentHash: f.contract.paymentHash, claimPublicKey: f.contract.claimPublicKey }),
        });
        assert.equal(response.status, 503);
        assert.equal((await response.json()).error, 'LIVE_SWAPS_DISABLED_OBSERVER_AND_RECOVERY_NOT_VERIFIED');
        assert.equal(Object.keys(f.store.read().swaps).length, before);
      } finally { await app.close(); }
    }
  } finally { await f.cleanup(); }
});

test('simulation has no node diagnostics while regtest can expose mocked preflight diagnostics', async () => {
  const f = await setup();
  const report = { prerequisitesSatisfied: true, diagnosticsOk: true };
  try {
    const simulation = await serve('simulation', f.manager);
    try {
      const response = await fetch(`${simulation.base}/v1/preflight`);
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error, 'DIAGNOSTICS_NOT_CONFIGURED');
    } finally { await simulation.close(); }
    const regtest = await serve('regtest', f.manager, () => report);
    try {
      assert.equal((await fetch(`${regtest.base}/v1/preflight`)).status, 200);
    } finally { await regtest.close(); }
  } finally { await f.cleanup(); }
});
