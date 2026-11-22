import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { fixture, privateTestDirectory, routingFixture } from './helpers.js';
import { Store } from '../src/persistence/Store.js';
import { startApplication, guestStartupArguments } from '../src/main.js';
import { GuestStartupError, createGuestRuntime, guestStartupPolicySchema } from '../src/guest/GuestStartup.js';
import type { GuestReverseClients } from '../src/guest/GuestReverse.js';
import type { GuestExecution } from '../src/guest/GuestExecution.js';

async function validPolicy() {
  const f = fixture(); const directory = await privateTestDirectory('guest-startup'); const routing = routingFixture();
  const policy = { mode: 'regtest' as const, isolationId: randomUUID(), providerNode: f.contract.claimPublicKey,
    payerNode: f.contract.refundPublicKey, routing, refundPublicKey: f.contract.refundPublicKey,
    refundDestination: f.destination, funding: { txid: 'ab'.repeat(32), vout: 0, valueSats: 100000 },
    runsDirectory: directory, watcherIntervalMs: 5000,
    clients: { bitcoin: { url: routing.bitcoinOrigin, wallet: 'lqwd-lab' },
      provider: { url: routing.providerOrigin, certPath: join(directory, 'provider.cert') },
      payer: { url: routing.payerOrigin, certPath: join(directory, 'payer.cert') },
      invoices: { url: routing.providerOrigin, certPath: join(directory, 'provider.cert') },
      credentials: { bitcoinCookiePath: join(directory, 'cookie'),
        providerReadMacaroonPath: join(directory, 'provider-read'),
        providerInvoiceMacaroonPath: join(directory, 'provider-invoice'),
        providerSettleMacaroonPath: join(directory, 'provider-settle'),
        payerReadMacaroonPath: join(directory, 'payer-read') } } };
  return { policy, directory, routing };
}
function fakeClients(routing: ReturnType<typeof routingFixture>): GuestReverseClients {
  return {
    bitcoin: { origin: routing.bitcoinOrigin, call: async () => { throw new Error('unexpected Core call'); },
      confirmed: async () => ({ hex: '', confirmations: 0 }) },
    provider: { origin: routing.providerOrigin, call: async () => { throw new Error('unexpected provider call'); },
      assertRegtest: async () => ({ chains: [{ chain: 'bitcoin', network: 'regtest' }], synced_to_chain: true }) },
    payer: { origin: routing.payerOrigin, call: async () => { throw new Error('unexpected payer call'); },
      assertRegtest: async () => ({ chains: [{ chain: 'bitcoin', network: 'regtest' }], synced_to_chain: true }) },
    invoices: { origin: routing.providerOrigin, create: async () => { throw new Error('unexpected invoice call'); },
      lookup: async () => ({ status: 'ABSENT' as const }) },
    tip: async () => 100, now: () => 1000,
  };
}
function fakeExecution(actions: string[]): GuestExecution {
  const stop = async (): Promise<never> => { actions.push('called'); throw new Error('unexpected guest execution'); };
  return { fund: stop, confirm: stop, settle: stop, markPaid: stop, complete: stop, expire: stop };
}

test('guest startup arguments are explicit, regtest-only and default closed', async () => {
  const directory = await privateTestDirectory('guest-args');
  try {
    const path = join(directory, 'policy.json');
    const args = ['--guest-regtest', '--policy-path', path, '--policy-sha256', 'ab'.repeat(32)];
    assert.equal(guestStartupArguments([], 'regtest'), undefined);
    assert.deepEqual(guestStartupArguments(args, 'regtest'), { path, hash: 'ab'.repeat(32), watch: false });
    assert.deepEqual(guestStartupArguments([...args, '--guest-watch'], 'regtest'), { path, hash: 'ab'.repeat(32), watch: true });
    assert.throws(() => guestStartupArguments(args, 'simulation'), /GUEST_STARTUP_REJECTED/);
    assert.throws(() => guestStartupArguments(args.slice(0, 4), 'regtest'), /GUEST_STARTUP_REJECTED/);
    assert.throws(() => guestStartupArguments([...args, '--guest-watch', 'extra'], 'regtest'), /GUEST_STARTUP_REJECTED/);
    assert.throws(() => guestStartupArguments([...args, '--unknown'], 'regtest'), /GUEST_STARTUP_REJECTED/);
    assert.throws(() => guestStartupArguments(['--guest-regtest', '--policy-path', 'relative', '--policy-sha256',
      'ab'.repeat(32)], 'regtest'), /GUEST_STARTUP_REJECTED/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('guest startup policy rejects mainnet, remote endpoints and substituted identities', async () => {
  const x = await validPolicy();
  try {
    assert.equal(guestStartupPolicySchema.parse(x.policy).mode, 'regtest');
    assert.throws(() => guestStartupPolicySchema.parse({ ...x.policy, mode: 'mainnet' }));
    assert.throws(() => guestStartupPolicySchema.parse({ ...x.policy,
      clients: { ...x.policy.clients, provider: { ...x.policy.clients.provider, url: 'https://example.com' } } }));
    assert.throws(() => guestStartupPolicySchema.parse({ ...x.policy, payerNode: x.policy.providerNode }));
    assert.throws(() => guestStartupPolicySchema.parse({ ...x.policy, watcherIntervalMs: 999 }));
    assert.equal(guestStartupPolicySchema.parse({ ...x.policy, watcherIntervalMs: undefined }).watcherIntervalMs, undefined);
  } finally { await rm(x.directory, { recursive: true, force: true }); }
});

test('guest execution is inert until an explicit watcher start and rejects an interval-less watch', async () => {
  const x = await validPolicy(); const store = await Store.open(join(x.directory, 'store')); const actions: string[] = [];
  try {
    const clients = fakeClients(x.routing);
    const withoutStart = createGuestRuntime(store, x.policy, { clients, execution: fakeExecution(actions) });
    assert.equal(actions.length, 0);
    withoutStart.stop();

    const withoutWatch = { ...x.policy, watcherIntervalMs: undefined };
    assert.throws(() => createGuestRuntime(store, withoutWatch, { clients, execution: fakeExecution(actions), watchRequested: true }),
      (error: unknown) => error instanceof GuestStartupError && error.reason === 'GUEST_WATCH_INTERVAL_REQUIRED');

    const runtime = createGuestRuntime(store, x.policy, { clients, execution: fakeExecution(actions) });
    assert.equal(actions.length, 0);
    runtime.start();
    runtime.stop();
    assert.equal(actions.length, 0);
  } finally { await store.close(); await rm(x.directory, { recursive: true, force: true }); }
});

test('application startup and guest HTTP routes remain closed without an explicit guest policy', async () => {
  const directory = await privateTestDirectory('guest-disabled');
  let app: Awaited<ReturnType<typeof startApplication>> | undefined;
  try {
    app = await startApplication({ APP_MODE: 'regtest', DEPLOYMENT_ID: 'guest-test', DATA_DIR: directory } as NodeJS.ProcessEnv, [], {
      port: 0, reads: { liquidity: async () => ({ onchainSats: 1, incomingSats: 1 }),
        operations: async () => ({ network: 'regtest', capturedAt: new Date().toISOString(),
          core: { confirmedSats: 0, unconfirmedSats: 0 }, provider: null, alice: null, rails: [] }) },
    });
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    assert.equal((await fetch(`${base}/v1/guest/quotes/${randomUUID()}`)).status, 503);
    assert.equal(app.guestRuntime, undefined);
  } finally { await app?.close(); await rm(directory, { recursive: true, force: true }); }
});
