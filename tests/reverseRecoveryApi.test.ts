import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setup } from './helpers.js';
import { Store } from '../src/persistence/Store.js';
import { SwapCoordinator } from '../src/core/SwapCoordinator.js';
import { updateSwapRevision } from '../src/core/SwapStateMachine.js';
import { createReverseRecovery, recoverInterruptedReverseRuns } from '../src/api/reverseRecovery.js';
import { createOperatorApi as createApi } from '../src/api/operatorServer.js';
import type { ReversePaymentStatus } from '../src/core/SwapTypes.js';

async function fixture(configured = true) {
  const f = await setup();
  await new SwapCoordinator(f.store, f.ports).issueInvoice(f.swap.id);
  await updateSwapRevision(f.store, f.swap.id, f.manager.get(f.swap.id)!.revision, s => {
    s.clientPayment = { hash: f.contract.paymentHash, status: 'UNKNOWN', feeLimitSats: 100 };
  });
  await recoverInterruptedReverseRuns(f.store);
  let lookups = 0;
  let payer: ReversePaymentStatus = { hash: f.contract.paymentHash, status: 'IN_FLIGHT', valueSats: f.quote.invoiceSats };
  const recovery = createReverseRecovery(f.store, f.ports, {
    lookupPayment: async hash => { assert.equal(hash, f.contract.paymentHash); lookups++; return payer; },
  });
  const server = createApi(f.manager, async () => ({ onchainSats: 1e6, incomingSats: 1e6 }), undefined,
    configured ? recovery : undefined);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (input: unknown, id = f.swap.id) => fetch(`${url}/v1/swaps/${id}/reconcile`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  });
  return { f, url, post, recovery, lookups: () => lookups,
    payer: (patch: Partial<ReversePaymentStatus>) => { payer = { ...payer, ...patch }; },
    get: () => f.manager.get(f.swap.id)!,
    stop: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

test('reconciliation is disabled by default and live creation stays disabled even with recovery configured', async () => {
  for (const configured of [false, true]) {
    const x = await fixture(configured);
    try {
      const before = x.f.store.read();
      if (!configured) {
        const response = await x.post({ expectedRevision: x.get().revision });
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), { error: 'RECONCILIATION_NOT_CONFIGURED' });
      }
      const response = await fetch(`${x.url}/v1/swaps/reverse`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'api-recovery-gate' },
        body: JSON.stringify({ quoteId: x.f.quote.id, paymentHash: x.f.contract.paymentHash, claimPublicKey: x.f.contract.claimPublicKey }),
      });
      assert.equal(response.status, 503);
      assert.match((await response.json()).error, /LIVE_SWAPS_DISABLED/);
      assert.deepEqual(x.f.store.read(), before);
      assert.equal(x.lookups(), 0);
    } finally { await x.stop(); await x.f.cleanup(); }
  }
});

test('HTTP reconciliation uses existing payer evidence, projects public fields, and never executes the suggested next action', async () => {
  const x = await fixture();
  try {
    const revision = await (await fetch(`${x.url}/v1/swaps/${x.f.swap.id}/revision`)).json();
    assert.deepEqual(revision, { id: x.f.swap.id, revision: x.get().revision });
    const response = await x.post({ expectedRevision: revision.revision });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result, { id: x.f.swap.id, state: 'INVOICE_ACCEPTED', revision: x.get().revision, next: 'FUND' });
    assert.equal(x.lookups(), 1);
    assert.deepEqual(x.f.calls, { funding: 0, broadcast: 0, settle: 0 });
    const encoded = JSON.stringify(result);
    for (const value of [x.f.preimage, x.f.swap.idempotencyKey, 'clientPayment', 'fundingIntent', 'privateKey']) {
      assert.equal(encoded.includes(value), false);
    }
    const disk = JSON.parse(await readFile(join(x.f.directory, 'state.json'), 'utf8'));
    assert.equal(disk.swaps[x.f.swap.id].revision, result.revision);
  } finally { await x.stop(); await x.f.cleanup(); }
});

test('stale and concurrent HTTP revisions cannot replay reconciliation; unchanged evidence is idempotent', async () => {
  const x = await fixture();
  try {
    const expectedRevision = x.get().revision;
    const responses = await Promise.all([x.post({ expectedRevision }), x.post({ expectedRevision })]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    const conflict = responses.find(response => response.status === 409)!;
    assert.deepEqual(await conflict.json(), { error: 'STALE_SWAP_REVISION' });
    assert.equal(x.lookups(), 1);
    const reconciled = x.get();
    assert.equal((await x.post({ expectedRevision })).status, 409);
    assert.equal(x.lookups(), 1);
    const repeated = await x.post({ expectedRevision: reconciled.revision });
    assert.equal(repeated.status, 200);
    assert.equal((await repeated.json()).revision, reconciled.revision);
    assert.deepEqual(x.get(), reconciled);
    assert.deepEqual(x.f.calls, { funding: 0, broadcast: 0, settle: 0 });
  } finally { await x.stop(); await x.f.cleanup(); }
});

test('HTTP cannot supply payer/chain evidence or request resume, signing, settlement or mining', async () => {
  const x = await fixture();
  try {
    const before = x.f.store.read();
    for (const input of [{}, { expectedRevision: -1 }, { expectedRevision: 1.5 },
      { expectedRevision: Number.MAX_SAFE_INTEGER + 1 }, { expectedRevision: '1' },
      ...['payer', 'preimage', 'claimTxid', 'confirmed', 'resume', 'mine'].map(key => ({ expectedRevision: x.get().revision, [key]: true }))]) {
      assert.equal((await x.post(input)).status, 400);
    }
    assert.equal((await x.post({ expectedRevision: 0 }, '00000000-0000-4000-8000-000000000000')).status, 404);
    for (const action of ['resume', 'pay', 'claim', 'settle', 'mine']) {
      assert.equal((await fetch(`${x.url}/v1/swaps/${x.f.swap.id}/${action}`, { method: 'POST' })).status, 404);
    }
    assert.equal(x.lookups(), 0);
    assert.deepEqual(x.f.store.read(), before);
  } finally { await x.stop(); await x.f.cleanup(); }
});

test('unknown payer evidence and interrupted mining remain manual and retain the entire journal', async () => {
  for (const point of ['payer', 'mining'] as const) {
    const x = await fixture();
    try {
      if (point === 'payer') x.payer({ status: 'UNKNOWN' });
      else await updateSwapRevision(x.f.store, x.f.swap.id, x.get().revision, s => {
        s.miningIntents = [{ txid: 'ab'.repeat(32), fromHeight: 100, status: 'INTENT' }];
      });
      const before = x.get();
      const response = await x.post({ expectedRevision: before.revision });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).next, 'MANUAL_REVIEW');
      assert.deepEqual(x.get(), before);
      assert.deepEqual(x.f.calls, { funding: 0, broadcast: 0, settle: 0 });
    } finally { await x.stop(); await x.f.cleanup(); }
  }
});

test('startup fallback survives a store reopen, preserves uncertain intents, and is idempotent without RPC capabilities', async () => {
  const f = await setup();
  let store = f.store;
  try {
    await updateSwapRevision(store, f.swap.id, f.manager.get(f.swap.id)!.revision, s => {
      s.clientPayment = { hash: s.contract.paymentHash, status: 'INTENT', feeLimitSats: 100 };
      s.pendingAction = 'PREPARE_LOCKUP';
    });
    await store.close(); store = await Store.open(f.directory);
    await recoverInterruptedReverseRuns(store);
    const recovered = store.read();
    assert.equal(recovered.swaps[f.swap.id]!.state, 'MANUAL_REVIEW');
    assert.equal(recovered.swaps[f.swap.id]!.pendingAction, 'PREPARE_LOCKUP');
    assert.equal(recovered.swaps[f.swap.id]!.clientPayment!.status, 'INTENT');
    await recoverInterruptedReverseRuns(store);
    assert.deepEqual(store.read(), recovered);
  } finally { await store.close(); await rm(f.directory, { recursive: true }); }
});
