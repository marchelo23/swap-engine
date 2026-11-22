import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Transaction, Psbt, payments, networks } from 'bitcoinjs-lib';
import { setup, routingFixture } from './helpers.js';
import { Store } from '../src/persistence/Store.js';
import type { SecretVault } from '../src/persistence/SecretVault.js';
import { SwapCoordinator } from '../src/core/SwapCoordinator.js';
import { updateSwapRevision } from '../src/core/SwapStateMachine.js';
import { createReverseTestPlan } from '../src/core/ReverseTestPlan.js';
import { controlledRunDigest, type ControlledRunApproval } from '../src/core/ControlledReverseBackend.js';
import { createControlledReverseRuntime, createJitRuntimeExecutor } from '../src/core/ControlledReverseRuntime.js';
import { createJustInTimeReverse, type JitAuthorization } from '../src/core/JustInTimeReverse.js';
import { preparationDigest, type PreparationSpec } from '../src/core/ReversePreparation.js';
import { createControlledReadiness, persistedReadinessCustody } from '../src/core/ControlledReadiness.js';
import { parseLndInvoice } from '../src/lightning/InvoiceParser.js';
import type { PaymentStreamTransport } from '../src/lightning/LndPaymentTransport.js';
import { recoveryRoutedPaymentsPath } from '../src/lightning/LndPayerRecovery.js';

// All transports, credentials and custody below are synthetic. No sockets or real vaults.
async function fixture(sourceAmountSats?: number) {
  const f = await setup(sourceAmountSats); let store = f.store; let tip = 100;
  const invoice = 'lnbcrt' + 'a'.repeat(30);
  f.ports.createInvoice = async () => invoice;
  await new SwapCoordinator(store, f.ports).issueInvoice(f.swap.id);
  const own = payments.p2wpkh({ pubkey: f.refundKey.publicKey, network: networks.regtest });
  const previous = new Transaction(); previous.version = 2; previous.addInput(Buffer.alloc(32, 1), 0); previous.addOutput(own.output!, 100000n);
  const channelTx = new Transaction(); channelTx.version = 2; channelTx.addInput(Buffer.alloc(32, 2), 0);
  channelTx.addOutput(Buffer.concat([Buffer.from([0, 32]), Buffer.alloc(32, 3)]), 5000000n);
  const input = { txid: previous.getId(), vout: 0 };
  const plan = createReverseTestPlan(f.quote, tip, { paymentHash: f.contract.paymentHash, claimPublicKey: f.contract.claimPublicKey },
    f.contract.refundPublicKey, { claim: f.destination, refund: own.address! },
    { provider: f.contract.claimPublicKey, payer: f.contract.refundPublicKey }, routingFixture(channelTx.getId() + ':0'), 'lqwd-lab');
  const scope = { ...plan.routing, isolationId: randomUUID() };
  const approval: ControlledRunApproval = { id: randomUUID(), swapId: f.swap.id, expectedRevision: store.read().swaps[f.swap.id]!.revision,
    isolationId: scope.isolationId, scope: 'isolated-regtest-reverse', maxBlocks: 2, expiresAt: Date.now() + 60000,
    planDigest: controlledRunDigest(plan, input, f.swap.id, scope.isolationId) };
  const hashAt = (height: number) => height.toString(16).padStart(64, '0');
  const chain = () => ({ chain: 'regtest', blocks: tip, headers: tip, bestblockhash: hashAt(tip), initialblockdownload: false });
  const confirmed = new Map([previous, channelTx].map(tx => [tx.getId(), { tx, height: 99 }]));
  const mempool = new Map<string, Transaction>();
  let state: 'OPEN' | 'ACCEPTED' | 'SETTLED' = 'OPEN'; let sends = 0; let restores = 0;
  const reads: string[] = []; const mutations: string[] = [];
  let failAt = ''; let corruptSpend = false;
  let afterMutation: ((key: string) => Promise<void>) | undefined;
  let finishPayment: (() => void) | undefined;
  const node = (identity: string) => ({ identity_pubkey: identity, synced_to_chain: true, wallet_synced: true,
    chains: [{ chain: 'bitcoin', network: 'regtest' }], block_height: tip, block_hash: hashAt(tip), num_peers: 1 });
  const limits = { chan_reserve_sat: '10000', max_pending_amt_msat: '500000000', min_htlc_msat: '1000', max_accepted_htlcs: 16 };
  const channel = (peer: string, local: string, remote: string) => ({ active: true, remote_pubkey: peer,
    chan_id: plan.routing.channelId, channel_point: plan.routing.channelPoint, capacity: '5000000', local_balance: local, remote_balance: remote,
    commit_fee: '1000', unsettled_balance: '0', pending_htlcs: [], local_constraints: limits, remote_constraints: limits, zero_conf: false });
  const invoiceWire = () => ({ state, payment_request: invoice, r_hash: Buffer.from(plan.contract.paymentHash, 'hex').toString('base64'),
    value: String(plan.quote.invoiceSats), amt_paid_sat: state === 'OPEN' ? '0' : String(plan.quote.invoiceSats),
    htlcs: state === 'OPEN' ? [] : [{ state: state === 'SETTLED' ? 'SETTLED' : 'ACCEPTED', expiry_height: 210, amt_msat: String(plan.quote.invoiceSats * 1000) }] });
  const paymentWire = () => ({ payment_hash: plan.contract.paymentHash, status: state === 'SETTLED' ? 'SUCCEEDED' : 'IN_FLIGHT',
    payment_index: '1', value_sat: String(plan.quote.invoiceSats), value_msat: String(plan.quote.invoiceSats * 1000), fee_sat: '0', fee_msat: '0', failure_reason: 'FAILURE_REASON_NONE',
    ...(state === 'SETTLED' ? { payment_preimage: f.preimage } : {}), htlcs: [{ attempt_id: '1', status: state === 'SETTLED' ? 'SUCCEEDED' : 'IN_FLIGHT',
      route: { total_amt_msat: String(plan.quote.invoiceSats * 1000), total_fees_msat: '0', hops: [{ chan_id: plan.routing.channelId, pub_key: plan.providerNode,
        amt_to_forward_msat: String(plan.quote.invoiceSats * 1000), fee_msat: '0' }] } }] });
  const mutation = async (key: string, effect: () => unknown) => {
    mutations.push(key);
    const disk = JSON.parse(await readFile(join(f.directory, 'state.json'), 'utf8'));
    const runId = Object.keys(disk.controlledExecutions)[0]!;
    assert.equal(disk.controlledExecutions[runId].runtimeActions[key].status, 'INTENT', 'disk intent precedes mutation');
    const value = effect(); await afterMutation?.(key);
    if (key === failAt || (key.startsWith('broadcast:') && failAt === (mutations.filter(x => x.startsWith('broadcast:')).length === 1 ? 'funding broadcast' : 'claim broadcast')) ||
      (key.startsWith('mine:') && failAt === 'mining')) throw new Error('synthetic-lost-reply-must-not-escape');
    return value;
  };
  const bitcoin = { origin: plan.routing.bitcoinOrigin, async call<T>(method: string, params: unknown[] = [], wallet = false): Promise<T> {
    reads.push(method); let value: unknown;
    if (method === 'getblockchaininfo') value = chain();
    else if (method === 'listwallets') value = ['lqwd-lab'];
    else if (method === 'getwalletinfo') value = { walletname: 'lqwd-lab', private_keys_enabled: true, scanning: false, external_signer: false };
    else if (method === 'getaddressinfo') { assert.deepEqual(params, [plan.refundDestination]); assert.equal(wallet, true);
      value = { ismine: true, solvable: true, scriptPubKey: Buffer.from(own.output!).toString('hex') }; }
    else if (method === 'listunspent') value = [{ ...input, scriptPubKey: Buffer.from(own.output!).toString('hex'), amount: 0.001,
      confirmations: tip - 98, safe: true, spendable: true, solvable: true }];
    else if (method === 'listlockunspent') value = [];
    else if (method === 'getnetworkinfo') value = { relayfee: 0.00001 };
    else if (method === 'getmempoolinfo') value = { mempoolminfee: 0.00001 };
    else if (method === 'gettxout') {
      const found = confirmed.get(String(params[0]))!; const out = found.tx.outs[Number(params[1])]!;
      value = { bestblock: hashAt(tip), confirmations: tip - found.height + 1, value: Number(out.value) / 1e8,
        scriptPubKey: { hex: Buffer.from(out.script).toString('hex') }, coinbase: false };
    } else if (method === 'getrawtransaction') {
      const found = confirmed.get(String(params[0])); assert.ok(found, 'only confirmed synthetic transaction evidence');
      const tx = Transaction.fromHex(found.tx.toHex());
      if (corruptSpend && tx.ins[0]!.witness.length === 4) tx.ins[0]!.witness[0]![0] = tx.ins[0]!.witness[0]![0]! ^ 1;
      value = { txid: found.tx.getId(), hex: tx.toHex(), blockhash: hashAt(found.height), confirmations: tip - found.height + 1, in_active_chain: true };
    } else if (method === 'getblockheader') { const height = Number(BigInt('0x' + String(params[0]))); value = { hash: params[0], height, confirmations: tip - height + 1 }; }
    else if (method === 'getblockhash') value = hashAt(Number(params[0]));
    else if (method === 'getblock') {
      const height = Number(BigInt('0x' + String(params[0])));
      value = { hash: params[0], height, previousblockhash: hashAt(height - 1), confirmations: tip - height + 1,
        tx: [...confirmed.values()].filter(x => x.height === height).map(({ tx }) => ({ txid: tx.getId(),
          vin: tx.ins.map(i => ({ txid: Buffer.from(i.hash).reverse().toString('hex'), vout: i.index })) })) };
    } else if (method === 'testmempoolaccept') value = [{ txid: Transaction.fromHex((params[0] as string[])[0]!).getId(), allowed: true }];
    else if (method === 'walletcreatefundedpsbt') value = await mutation(method, () => {
      assert.equal(wallet, true); assert.equal(params.length, 7); assert.deepEqual(params[0], [input]); assert.equal(params[5], 2); assert.equal(params[6], 0);
      assert.deepEqual(params[3], { add_inputs: false, lockUnspents: true, changeAddress: plan.refundDestination, fee_rate: 2, replaceable: false });
      const psbt = new Psbt({ network: networks.regtest }).addInput({ hash: input.txid, index: 0, witnessUtxo: { script: own.output!, value: 100000n } })
        .addOutput({ script: f.htlc.output, value: BigInt(plan.quote.amountSats) }).addOutput({ script: own.output!, value: BigInt(99700 - plan.quote.amountSats) });
      return { psbt: psbt.toBase64() };
    });
    else if (method === 'walletprocesspsbt') value = await mutation(method, () => {
      const psbt = Psbt.fromBase64(String(params[0])); psbt.signInput(0, f.refundKey); return { psbt: psbt.toBase64() };
    });
    else if (method === 'finalizepsbt') value = await mutation(method, () => {
      const psbt = Psbt.fromBase64(String(params[0])); psbt.finalizeAllInputs(); return { complete: true, hex: psbt.extractTransaction().toHex() };
    });
    else if (method === 'sendrawtransaction') {
      const tx = Transaction.fromHex(String(params[0])); value = await mutation(`broadcast:${tx.getId()}`, () => { mempool.set(tx.getId(), tx); return tx.getId(); });
    } else if (method === 'generatetoaddress') {
      const txid = store.read().swaps[f.swap.id]!.miningIntents!.at(-1)!.txid;
      value = await mutation(`mine:${txid}`, () => {
        assert.deepEqual(params, [1, plan.refundDestination, 1000000]); tip++;
        for (const tx of mempool.values()) confirmed.set(tx.getId(), { tx, height: tip }); mempool.clear(); return [hashAt(tip)];
      });
    } else throw new Error('Unexpected synthetic Core operation: ' + method);
    return structuredClone(value) as T;
  } };
  const provider = { origin: plan.routing.providerOrigin, async call<T>(path: string): Promise<T> {
    reads.push(path); assert.ok(['/v1/getinfo', '/v1/channels'].includes(path));
    return structuredClone(path === '/v1/getinfo' ? node(plan.providerNode) : { channels: [channel(plan.payerNode, '4400000', '500000')] }) as T;
  }, async lookup(paymentHash: string) { reads.push('invoice'); assert.equal(paymentHash, plan.contract.paymentHash); return parseLndInvoice(invoiceWire()); },
  async settle(preimage: string) { assert.equal(preimage, f.preimage); return mutation('settle', () => { state = 'SETTLED'; finishPayment?.(); }); } };
  const payer = { origin: plan.routing.payerOrigin, async call<T>(path: string): Promise<T> {
    reads.push(path); let value: unknown;
    if (path === '/v1/getinfo') value = node(plan.payerNode);
    else if (path === '/v1/channels') value = { channels: [channel(plan.providerNode, '500000', '4400000')] };
    else if (path === `/v1/payreq/${invoice}`) value = { destination: plan.providerNode, payment_hash: plan.contract.paymentHash,
      num_satoshis: String(plan.quote.invoiceSats), num_msat: String(plan.quote.invoiceSats * 1000), timestamp: String(Math.floor(Date.now() / 1000)), expiry: '3600', cltv_expiry: '80' };
    else if (path === recoveryRoutedPaymentsPath) value = { payments: [paymentWire()], first_index_offset: '1', last_index_offset: '1' };
    else throw new Error('Unexpected synthetic LND operation');
    return structuredClone(value) as T;
  } };
  const transport: PaymentStreamTransport = { origin: plan.routing.payerOrigin, async stream(path, body, onPayment, signal, beforeRequest) {
    await beforeRequest?.(); signal.throwIfAborted(); assert.equal(path, '/v2/router/send');
    assert.equal((body as { fee_limit_sat: string }).fee_limit_sat, String(plan.routingFeeLimitSats));
    assert.deepEqual((body as { outgoing_chan_ids: string[] }).outgoing_chan_ids, [plan.routing.channelId]);
    assert.equal(Object.values(store.read().controlledExecutions!)[0]!.payerSend!.status, 'INTENT');
    sends++; state = 'ACCEPTED'; onPayment(paymentWire());
    return new Promise<void>((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('synthetic observation stopped')), { once: true });
      finishPayment = () => { try { assert.equal(onPayment(paymentWire()), true); resolve(); } catch (error) { reject(error); } };
    });
  } };
  const clientVault = { read: async (role: string, paymentHash: string) => {
    assert.equal(role, 'client'); assert.equal(paymentHash, plan.contract.paymentHash); restores++;
    return Buffer.from(JSON.stringify({ privateKey: Buffer.from(f.claimKey.privateKey!).toString('hex'), preimage: f.preimage }));
  } } as SecretVault;
  const deps = { bitcoin, provider, payer, paymentTransport: transport, clientVault, refundKeys: { publicKey: async () => plan.contract.refundPublicKey } };
  const runtime = (guard?: () => void) => createControlledReverseRuntime(store, plan, input, scope, approval, deps, guard);
  return { f, plan, input, scope, approval, deps, reads, mutations, runtime, sends: () => sends, restores: () => restores,
    get store() { return store; }, setFailure: (point: string) => { failAt = point; }, corruptSpend: () => { corruptSpend = true; },
    afterMutation: (fn: typeof afterMutation) => { afterMutation = fn; },
    reopen: async () => { await store.close(); store = await Store.open(f.directory); },
    cleanup: async () => { await store.close(); await rm(f.directory, { recursive: true }); } };
}

test('runtime assembly is inert, scope-bound, and inspection uses only existing read capabilities and custody', async () => {
  const x = await fixture();
  try {
    const runtime = x.runtime(); assert.equal(x.reads.length, 0); assert.equal(x.restores(), 0);
    assert.throws(() => createControlledReverseRuntime(x.store, x.plan, x.input, { ...x.scope, channelId: '67890' }, x.approval, x.deps));
    assert.throws(() => createControlledReverseRuntime(x.store, x.plan, x.input, x.scope, { ...x.approval, planDigest: 'ab'.repeat(32) }, x.deps));
    const before = x.store.read(); const result = await runtime.inspect();
    assert.equal(result.network, 'regtest'); assert.equal(result.funding.valueSats, 100000); assert.equal(x.restores(), 1);
    assert.deepEqual(x.store.read(), before); assert.deepEqual(x.mutations, []); assert.equal(x.sends(), 0);
    x.deps.bitcoin.origin = 'http://example.com';
    await assert.rejects(runtime.execute()); assert.equal(x.sends(), 0);
  } finally { await x.cleanup(); }
});

test('new exact-debit profile completes through concrete adapters with a zero routing fee limit', async () => {
  const x = await fixture(50000);
  try {
    const result = await x.runtime().execute();
    const swap = x.store.read().swaps[result.id]!;
    assert.equal(result.state, 'COMPLETED'); assert.equal(swap.quote.invoiceSats, 50000);
    assert.equal(swap.quote.serviceFeeSats, 750); assert.equal(swap.quote.amountSats - swap.quote.claimFeeSats, 48750);
    assert.equal(swap.clientPayment!.feeLimitSats, 0); assert.equal(swap.clientPayment!.feeSats, 0);
    assert.equal(x.sends(), 1);
  } finally { await x.cleanup(); }
});

test('assembled runtime completes through actual adapters with durable per-action intents and exact spender observation', async () => {
  const x = await fixture();
  try {
    const result = await x.runtime().execute(); assert.equal(result.state, 'COMPLETED'); assert.equal(x.sends(), 1); assert.equal(x.restores(), 2);
    const db = x.store.read(); const run = db.controlledExecutions![x.approval.id]!; const swap = db.swaps[x.f.swap.id]!;
    assert.equal(run.blocksRequested, 2); assert.equal(run.payerSend!.status, 'SUCCEEDED');
    assert.equal(Object.keys(run.runtimeActions!).length, 8); assert.ok(Object.values(run.runtimeActions!).every(a => a.status === 'DONE'));
    assert.equal(db.chainObservations![`${swap.lockup!.txid}:0`]!.spend!.txid, swap.claimTxid);
    assert.equal(x.mutations.filter(key => key.startsWith('mine:')).length, 2);
    assert.equal((await readFile(join(x.f.directory, 'state.json'), 'utf8')).includes(x.f.preimage), false);
    await x.reopen(); const before = x.mutations.length;
    await assert.rejects(x.runtime().execute()); assert.equal((await x.runtime().reconcile(swap.revision)).next, 'DONE');
    assert.equal(x.mutations.length, before); assert.equal(x.sends(), 1);
  } finally { await x.cleanup(); }
});

test('spent or inconsistent HTLC outpoint blocks signing and claim broadcast', async () => {
  for (const failureAt of [1, 3, 4]) {
    const x = await fixture();
    try {
      const call = x.deps.bitcoin.call.bind(x.deps.bitcoin); let checks = 0;
      x.deps.bitcoin.call = async <T>(method: string, params: unknown[] = [], wallet = false): Promise<T> => {
        const lockup = x.store.read().swaps[x.f.swap.id]?.lockup;
        if (method === 'gettxout' && lockup && params[0] === lockup.txid && ++checks === failureAt) {
          if (failureAt !== 4) return null as T;
          const coin = await call<Record<string, unknown>>(method, params, wallet);
          return { ...coin, bestblock: 'ff'.repeat(32) } as T;
        }
        return call<T>(method, params, wallet);
      };
      await assert.rejects(x.runtime().execute());
      assert.equal(checks, failureAt);
      assert.equal(x.mutations.filter(key => key.startsWith('broadcast:')).length, 1);
      assert.equal(x.mutations.includes('settle'), false);
      assert.equal(x.store.read().controlledExecutions![x.approval.id]!.status, 'UNKNOWN');
      await assert.rejects(x.runtime().execute()); assert.equal(x.sends(), 1);
    } finally { await x.cleanup(); }
  }
});

test('lost wallet, broadcast, mining and settlement replies remain one-shot across assembly and store restart', async () => {
  for (const point of ['walletcreatefundedpsbt', 'walletprocesspsbt', 'finalizepsbt', 'funding broadcast', 'claim broadcast', 'mining', 'settle']) {
    const x = await fixture();
    try {
      x.setFailure(point); await assert.rejects(x.runtime().execute(), error => !String(error).includes('synthetic-lost-reply'));
      const run = x.store.read().controlledExecutions![x.approval.id]!;
      assert.equal(run.status, 'UNKNOWN'); assert.ok(Object.values(run.runtimeActions!).some(a => a.status === 'UNKNOWN'));
      const before = [...x.mutations]; await x.reopen();
      await assert.rejects(x.runtime().execute());
      const revision = x.store.read().swaps[x.f.swap.id]!.revision;
      await x.runtime().reconcile(revision);
      assert.deepEqual(x.mutations, before); assert.equal(x.sends(), 1);
    } finally { await x.cleanup(); }
  }
});

test('a changed claim witness cannot reach settlement even when its txid and exact outpoint match', async () => {
  const x = await fixture();
  try {
    x.corruptSpend(); await assert.rejects(x.runtime().execute());
    assert.equal(x.mutations.includes('settle'), false); assert.equal(x.sends(), 1);
    await assert.rejects(x.runtime().execute()); assert.equal(x.sends(), 1);
  } finally { await x.cleanup(); }
});

test('uncertain-action cleanup preserves another actor action record', async () => {
  const x = await fixture();
  try {
    const actorAttempt = randomUUID();
    x.afterMutation(async key => {
      if (key !== 'walletcreatefundedpsbt') return;
      await x.store.transaction(db => { db.controlledExecutions![x.approval.id]!.runtimeActions![key] = { attemptId: actorAttempt, status: 'DONE' }; });
      throw new Error('changed concurrently');
    });
    await assert.rejects(x.runtime().execute());
    assert.deepEqual(x.store.read().controlledExecutions![x.approval.id]!.runtimeActions!.walletcreatefundedpsbt,
      { attemptId: actorAttempt, status: 'DONE' });
    await assert.rejects(x.runtime().execute()); assert.equal(x.mutations.filter(k => k === 'walletcreatefundedpsbt').length, 1);
  } finally { await x.cleanup(); }
});

test('a newer actor payment journal prevents further wallet signing or publication', async () => {
  const x = await fixture();
  try {
    x.afterMutation(async key => {
      if (key !== 'walletcreatefundedpsbt') return;
      const swap = x.store.read().swaps[x.f.swap.id]!;
      await updateSwapRevision(x.store, swap.id, swap.revision, s => { s.clientPayment!.status = 'FAILED'; });
    });
    await assert.rejects(x.runtime().execute());
    assert.deepEqual(x.mutations, ['walletcreatefundedpsbt']);
    assert.equal(x.store.read().swaps[x.f.swap.id]!.clientPayment!.status, 'FAILED');
    await assert.rejects(x.runtime().execute()); assert.equal(x.sends(), 1);
  } finally { await x.cleanup(); }
});

test('missing restored client custody after funding never generates replacement keys or publishes a claim', async () => {
  const x = await fixture();
  try {
    x.afterMutation(async key => {
      if (key.startsWith('mine:')) x.deps.clientVault.read = async () => { throw new Error('missing synthetic custody'); };
    });
    await assert.rejects(x.runtime().execute());
    assert.equal(x.mutations.filter(k => k.startsWith('broadcast:')).length, 1);
    assert.equal(x.mutations.includes('settle'), false);
    assert.equal(x.store.read().swaps[x.f.swap.id]!.clientClaimIntent, undefined);
  } finally { await x.cleanup(); }
});

test('JIT local binding completes retained invoice through concrete runtime, then restart reconciles without re-execution', async () => {
  const x = await fixture();
  try {
    const spec: PreparationSpec = { id: randomUUID(), isolationId: x.scope.isolationId, tipHeight: x.plan.tipHeight, wallet: 'lqwd-lab',
      providerNode: x.plan.providerNode, payerNode: x.plan.payerNode, routing: x.plan.routing,
      client: { paymentHash: x.plan.contract.paymentHash, claimPublicKey: x.plan.contract.claimPublicKey },
      refundPublicKey: x.plan.contract.refundPublicKey, claimDestination: x.plan.claimDestination,
      refundDestination: x.plan.refundDestination, input: { ...x.input, valueSats: 100000 } };
    await x.store.transaction(db => { (db.reversePreparations ??= {})[spec.id] = {
      specDigest: preparationDigest(spec), attemptId: randomUUID(), status: 'READY', swapId: x.f.swap.id, plan: x.plan,
      invoiceAttempt: { attemptId: randomUUID(), revision: 2, wireAuthorized: true } }; });
    const custody = persistedReadinessCustody(x.deps.clientVault, x.deps.refundKeys);
    const readers = { ...x.deps, custody, inspect: (id: string, plan: typeof x.plan) =>
      createControlledReadiness(x.store, id, x.scope, x.deps.bitcoin, x.deps.provider, x.deps.payer, custody)(plan, x.input) };
    // Simulates operator handoff exceeding the old quote. No native transport leaves this fixture.
    const clock = { now: () => Date.now() + 130000, monotonic: () => performance.now() };
    const review = await createJustInTimeReverse(x.store, spec, readers, undefined, undefined, clock).review();
    assert.ok(review.priorQuote.expiresAt < clock.now()); assert.equal(x.sends(), 0); assert.equal(x.mutations.length, 0);
    const auth: JitAuthorization = { id: randomUUID(), termsDigest: review.termsDigest, scope: 'isolated-regtest-one-requote-and-execute',
      issuedAt: clock.now(), startBefore: clock.now() + 300000, maxBlocks: 2, quoteLifetimeMs: 120000, executionWindowMs: 90000 };
    const result = await createJustInTimeReverse(x.store, spec, readers, auth, createJitRuntimeExecutor(x.store, x.deps), clock).run();
    assert.equal(result.state, 'COMPLETED'); assert.equal(x.sends(), 1);
    const record = x.store.read().jitExecutions![auth.id]!; assert.equal(record.status, 'COMPLETED');
    assert.equal(x.mutations.length, 8); assert.notEqual(record.plan!.quote.id, x.plan.quote.id);
    assert.equal(x.mutations.filter(key => key.startsWith('mine:')).length, 2);
    const originalInvoice = x.store.read().swaps[x.f.swap.id]!.invoice;
    await x.reopen(); const before = [...x.mutations];
    assert.throws(() => createJustInTimeReverse(x.store, spec, readers, auth, createJitRuntimeExecutor(x.store, x.deps), clock));
    const recovery = createControlledReverseRuntime(x.store, record.plan!, x.input, x.scope, record.approval!, x.deps);
    assert.equal((await recovery.reconcile(result.revision)).next, 'DONE');
    assert.deepEqual(x.mutations, before); assert.equal(x.sends(), 1);
    assert.equal(x.store.read().swaps[x.f.swap.id]!.invoice, originalInvoice);
  } finally { await x.cleanup(); }
});

test('runtime deadline fence refuses a late first payment and every later signing or publication step', async () => {
  for (const expiredAt of ['start', 'walletcreatefundedpsbt', 'finalizepsbt', 'mining']) {
    const x = await fixture();
    try {
      let expired = expiredAt === 'start'; let checks = 0;
      const runtime = x.runtime(() => { checks++; if (expired) throw Error('local deadline expired'); });
      x.afterMutation(async key => {
        if (key === expiredAt || (expiredAt === 'mining' && key.startsWith('mine:'))) expired = true;
      });
      await assert.rejects(async () => runtime.execute()); assert.ok(checks > 0);
      if (expiredAt === 'start') { assert.equal(x.sends(), 0); assert.equal(x.mutations.length, 0); }
      else { assert.equal(x.sends(), 1); assert.equal(x.mutations.includes('settle'), false);
        const final = x.mutations.at(-1)!; assert.ok(final === expiredAt || (expiredAt === 'mining' && final.startsWith('mine:'))); }
      const before = [...x.mutations]; await assert.rejects(async () => runtime.execute()); assert.deepEqual(x.mutations, before);
    } finally { await x.cleanup(); }
  }
});

test('single-use native executor shutdown fences later actions even after the initial payment was accepted', async () => {
  const x = await fixture(); try {
    const executor = createJitRuntimeExecutor(x.store, x.deps);
    const context = { plan: x.plan, input: x.input, scope: x.scope, approval: x.approval, guard: () => {}, signal: new AbortController().signal };
    x.afterMutation(async key => { if (key === 'walletcreatefundedpsbt') executor.stopClient(); });
    await assert.rejects(executor.execute(context));
    assert.deepEqual(x.mutations, ['walletcreatefundedpsbt']); assert.equal(x.sends(), 1);
    await assert.rejects(executor.execute(context)); assert.equal(x.sends(), 1);
  } finally { await x.cleanup(); }
});

test('post-mining LND synchronization is observed with bounded reads and never repeats the mining RPC', async () => {
  const x = await fixture(); try {
    for (const client of [x.deps.provider, x.deps.payer]) {
      const call = client.call.bind(client); const seen = new Set<number>();
      client.call = async <T>(path: string): Promise<T> => {
        const result = await call<Record<string, unknown>>(path);
        const height = Number(result.block_height);
        if (path === '/v1/getinfo' && height > 100 && !seen.has(height)) {
          seen.add(height); return { ...result, block_height: height - 1, wallet_synced: false } as T;
        }
        return result as T;
      };
    }
    assert.equal((await x.runtime().execute()).state, 'COMPLETED');
    assert.equal(x.mutations.filter(k => k.startsWith('mine:')).length, 2); assert.equal(x.sends(), 1);
  } finally { await x.cleanup(); }
});
