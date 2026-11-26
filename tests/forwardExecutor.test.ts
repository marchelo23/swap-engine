import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ForwardExecutor, type ForwardPorts } from '../src/core/ForwardExecutor.js';
import { ForwardAdmission } from '../src/core/ForwardAdmission.js';
import { Store } from '../src/persistence/Store.js';

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'forward-journal-'));
  let store = await Store.open(directory);
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  const preimage = '99'.repeat(32);
  const hash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
  const a = { network: 'regtest' as const, payerNode: '02' + 'aa'.repeat(32), payeeNode: '03' + 'bb'.repeat(32),
    paymentHash: hash, invoice: 'lnbcrt' + 'a'.repeat(40), invoiceSats: 5000, feeLimitSats: 10,
    expiresAt: Date.now() + 120_000, deposit: { txid: 'cc'.repeat(32), vout: 1,
      scriptPubKey: '0014' + 'dd'.repeat(20), valueSats: 5010 } };
  const success = { status: 'SUCCEEDED', hash, preimage, valueMsat: 5_000_000, feeMsat: 1000 };
  const counts = { sends: 0, tracks: 0 };
  let confirms = 2;
  let outcome: unknown = success;
  let disconnect = false;
  const ports: ForwardPorts = {
    inspectPayer: async () => ({ network: 'regtest', node: a.payerNode, ready: true }),
    decodeInvoice: async () => ({ destination: a.payeeNode, payment_hash: hash, num_satoshis: '5000', num_msat: '5000000',
      timestamp: String(Math.floor(Date.now() / 1000)), expiry: '300', cltv_expiry: '40' }),
    inspectDeposit: async () => ({ ...a.deposit, network: 'regtest', confirmations: confirms }),
    send: async (_invoice, _limit, beforeSend) => {
      assert.equal(store.read().forwardPayments?.[hash]?.status, 'INTENT');
      await beforeSend();
      counts.sends++;
      if (disconnect) throw new Error('response lost');
      return outcome;
    },
    track: async queried => { assert.equal(queried, hash); counts.tracks++; return outcome; },
  };
  return { a, ports, success, counts, executor: () => new ForwardExecutor(store, ports), snapshot: () => store.read(),
    service: (allocateDeposit: () => Promise<unknown>) => new ForwardAdmission(store, {
      ...ports, allocateDeposit,
    }, a.payerNode, a.payeeNode),
    async reopen() { await store.close(); store = await Store.open(directory); },
    disconnect: () => { disconnect = true; }, confirmations: (n: number) => { confirms = n; },
    outcome: (value: unknown) => { outcome = value; } };
}

test('admission validates invoice amount before allocation and durably reserves invoice and script by owner', async t => {
  const f = await setup(t);
  let allocated = 0;
  const allocate = async () => {
    allocated++;
    return { address: 'bcrt1q' + 'a'.repeat(38), scriptPubKey: f.a.deposit.scriptPubKey };
  };
  await assert.rejects(f.service(allocate).admit('alice', f.a.invoice, 4999), /differs/);
  assert.equal(allocated, 0);
  const concurrent = await Promise.allSettled(['alice', 'bob'].map(owner => f.service(allocate).admit(owner, f.a.invoice, 5000)));
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
  const [id] = Object.keys(f.snapshot().forwardAdmissions!);
  const owner = f.snapshot().forwardAdmissions![id!]!.owner;
  await f.reopen();
  await assert.rejects(f.service(allocate).execute(owner === 'alice' ? 'bob' : 'alice', id!, f.a.deposit), /not found/);
  f.ports.decodeInvoice = async () => ({ destination: f.a.payeeNode, payment_hash: 'ef'.repeat(32), num_satoshis: '5000',
    num_msat: '5000000', timestamp: String(Math.floor(Date.now() / 1000)), expiry: '300', cltv_expiry: '40' });
  await assert.rejects(f.service(allocate).admit('charlie', f.a.invoice, 5000), /already reserved/);
  await assert.rejects(f.service(allocate).execute(owner, id!, f.a.deposit), /does not match/);
  assert.equal(f.snapshot().forwardAdmissions![id!]!.outpoint, undefined);
  assert.deepEqual(f.counts, { sends: 0, tracks: 0 });
});

test('owner recovers a lost forward settlement from the same bound outpoint without another send', async t => {
  const f = await setup(t);
  const correctValue = 5100;
  const inspect = f.ports.inspectDeposit;
  f.ports.inspectDeposit = async (txid, vout) => ({ ...await inspect(txid, vout) as object, txid, vout, valueSats: correctValue });
  const allocate = async () => ({ address: 'bcrt1q' + 'a'.repeat(38), scriptPubKey: f.a.deposit.scriptPubKey });
  const a = await f.service(allocate).admit('alice', f.a.invoice, 5000);
  assert.equal(a.depositSats, correctValue);
  f.disconnect();
  assert.equal(await f.service(allocate).execute('alice', a.id, f.a.deposit), 'UNKNOWN');
  await f.reopen();
  await assert.rejects(f.service(allocate).recover('bob', a.id), /not found/);
  await assert.rejects(f.service(allocate).execute('alice', a.id, { ...f.a.deposit, vout: 2 }), /another outpoint/);
  await assert.rejects(f.service(allocate).execute('alice', a.id, f.a.deposit), /already journaled/);
  assert.equal(await f.service(allocate).recover('alice', a.id), 'SUCCEEDED');
  assert.deepEqual(f.counts, { sends: 1, tracks: 1 });
});

test('concurrent forward requests send only once and cannot reuse a deposit', async t => {
  const f = await setup(t);
  const results = await Promise.allSettled([f.executor().execute(f.a), f.executor().execute(f.a)]);
  assert.equal(results.filter(r => r.status === 'fulfilled' && r.value === 'SUCCEEDED').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  const decode = f.ports.decodeInvoice;
  const differentHash = 'ef'.repeat(32);
  f.ports.decodeInvoice = async invoice => ({ ...await decode(invoice) as object, payment_hash: differentHash });
  await assert.rejects(f.executor().execute({ ...f.a, paymentHash: differentHash }), /already journaled/);
  assert.deepEqual(f.counts, { sends: 1, tracks: 0 });
  assert.doesNotMatch(JSON.stringify(f.snapshot()), new RegExp(f.success.preimage));
});

test('lost response is recovered after reopen using lookup only, including missing and invalid evidence', async t => {
  const f = await setup(t);
  f.disconnect();
  assert.equal(await f.executor().execute(f.a), 'UNKNOWN');
  await f.reopen();
  await assert.rejects(f.executor().execute(f.a), /already journaled/);
  await assert.rejects(f.executor().recover({ ...f.a, feeLimitSats: 9 }), /No matching/);
  for (const evidence of [undefined, { ...f.success, feeMsat: 10_001 }, { ...f.success, preimage: '00'.repeat(32) }]) {
    f.outcome(evidence);
    assert.equal(await f.executor().recover(f.a), 'UNKNOWN');
  }
  f.outcome(f.success);
  assert.equal(await f.executor().recover(f.a), 'SUCCEEDED');
  assert.equal(await f.executor().recover(f.a), 'SUCCEEDED');
  assert.deepEqual(f.counts, { sends: 1, tracks: 4 });
});

test('confirmation loss after durable intent prevents sending and cannot reopen the intent', async t => {
  const f = await setup(t);
  const send = f.ports.send;
  f.ports.send = (...args) => { f.confirmations(1); return send(...args); };
  assert.equal(await f.executor().execute(f.a), 'UNKNOWN');
  f.confirmations(2);
  await assert.rejects(f.executor().execute(f.a), /already journaled/);
  assert.deepEqual(f.counts, { sends: 0, tracks: 0 });
});

test('a different payer cannot send or reconcile a forward payment', async t => {
  const f = await setup(t);
  const original = f.ports.inspectPayer;
  const wrong = async () => ({ network: 'regtest', node: f.a.payeeNode, ready: true });
  f.ports.inspectPayer = wrong;
  await assert.rejects(f.executor().execute(f.a), /identity mismatch/);
  assert.equal(f.snapshot().forwardPayments, undefined);
  f.ports.inspectPayer = original;
  f.disconnect();
  assert.equal(await f.executor().execute(f.a), 'UNKNOWN');
  f.ports.inspectPayer = wrong;
  assert.equal(await f.executor().recover(f.a), 'UNKNOWN');
  assert.deepEqual(f.counts, { sends: 1, tracks: 0 });
});
