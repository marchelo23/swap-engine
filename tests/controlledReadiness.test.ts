import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Transaction, payments, address, networks } from 'bitcoinjs-lib';
import { setup, routingFixture } from './helpers.js';
import { SwapCoordinator } from '../src/core/SwapCoordinator.js';
import { updateSwapRevision } from '../src/core/SwapStateMachine.js';
import { createReverseTestPlan } from '../src/core/ReverseTestPlan.js';
import { createControlledReadiness, persistedReadinessCustody } from '../src/core/ControlledReadiness.js';
import { parseLndInvoice } from '../src/lightning/InvoiceParser.js';
import type { SecretVault } from '../src/persistence/SecretVault.js';

// Unsigned serialized fixtures, mocked active-chain evidence and public custody observations.
// These tests never call a payer, signer, wallet mutation, broadcast or miner.
import { readinessFixture as fixture } from './readinessFixture.js';

test('concrete readiness verifies exact Core/LND evidence without changing the journal or issuing mutations', async () => {
  const x = await fixture();
  try {
    const before = x.f.store.read(); const result = await x.inspect(x.plan, x.input);
    assert.deepEqual(result, { network: 'regtest', isolationId: x.scope.isolationId, providerNode: x.plan.providerNode, payerNode: x.plan.payerNode,
      tipHeight: 100, ...x.keys, funding: { ...x.input, confirmed: true, safe: true, spendable: true, valueSats: 100000 },
      decodedInvoice: { destination: x.decoded.destination, payment_hash: x.decoded.payment_hash, num_satoshis: '50750', num_msat: '50750000',
        timestamp: x.decoded.timestamp, expiry: '3600', cltv_expiry: '80' } });
    assert.deepEqual(x.f.store.read(), before);
    assert.doesNotMatch(JSON.stringify(result), /preimage|privateKey|description|not-returned/);
    assert.equal(x.calls.filter(c => c.method === 'gettxout').length, 4);
    assert.deepEqual(x.f.calls, { funding: 0, broadcast: 0, settle: 0 });
  } finally { await x.f.cleanup(); }
});

test('foreign chains, identity substitutions, unsynced tips, insufficient windows and unavailable wallets fail closed', async () => {
  const cases: Array<(x: Awaited<ReturnType<typeof fixture>>) => void> = [
    x => { x.chain.chain = 'main'; }, x => { x.chain.initialblockdownload = true; }, x => { x.chain.headers = 101; },
    x => { x.providerInfo.identity_pubkey = x.plan.payerNode; }, x => { x.payerInfo.synced_to_chain = false; },
    x => { x.payerInfo.wallet_synced = false; }, x => { x.providerInfo.block_hash = 'ef'.repeat(32); },
    x => { x.payerInfo.block_height = 99; }, x => { x.providerInfo.num_peers = 0; },
    x => { x.chain.blocks = 111; x.chain.headers = 111; }, x => { x.loaded.length = 0; },
    x => { x.wallet.walletname = 'other-wallet'; }, x => { x.wallet.private_keys_enabled = false; },
    x => { x.wallet.scanning = true; }, x => { x.wallet.external_signer = true; },
    x => { Object.assign(x.wallet, { unlocked_until: 0 }); },
  ];
  for (const change of cases) {
    const x = await fixture();
    try { change(x); const before = x.f.store.read(); await assert.rejects(x.inspect(x.plan, x.input), /readiness unverified/);
      assert.deepEqual(x.f.store.read(), before); assert.equal(x.calls.some(c => c.source === 'custody'), false);
    } finally { await x.f.cleanup(); }
  }
});

test('approved input must be wallet-owned, unlocked, exact, mature and active-chain confirmed with reserve', async () => {
  const cases: Array<(x: Awaited<ReturnType<typeof fixture>>) => void> = [
    x => { x.utxos.length = 0; }, x => { x.utxos.push({ ...x.utxos[0]! }); },
    x => { x.utxos[0]!.safe = false; }, x => { x.utxos[0]!.spendable = false; }, x => { x.utxos[0]!.solvable = false; },
    x => { x.locks.push({ ...x.input }); }, x => { x.utxos[0]!.amount = 0.0005; },
    x => { x.utxos[0]!.scriptPubKey = '0014' + '00'.repeat(20); },
    x => { x.txout.value = 0.000999999; }, x => { x.txout.bestblock = 'ef'.repeat(32); },
    x => { x.txout.confirmations = 0; }, x => { x.txout.coinbase = true; },
    x => { x.rawTransactions.get(x.input.txid)!.in_active_chain = false; },
    x => { x.rawTransactions.get(x.input.txid)!.hex = '00'; },
    x => { x.ownership.ismine = false; }, x => { x.ownership.solvable = false; },
    x => { x.ownership.scriptPubKey = '0014' + '00'.repeat(20); },
  ];
  for (const change of cases) {
    const x = await fixture();
    try { change(x); await assert.rejects(x.inspect(x.plan, x.input));
      assert.equal(x.calls.some(c => c.source === 'custody'), false);
    } finally { await x.f.cleanup(); }
  }
});

test('directional liquidity cannot use the opposite balances, another channel or unsettled/pending capacity', async () => {
  const cases: Array<(x: Awaited<ReturnType<typeof fixture>>) => void> = [
    x => { x.payerChannels.channels[0]!.local_balance = '0'; },
    x => { x.providerChannels.channels[0]!.remote_balance = '0'; },
    x => { x.payerChannels.channels[0]!.local_constraints.chan_reserve_sat = '499999'; },
    x => { x.providerChannels.channels[0]!.remote_constraints.max_pending_amt_msat = '50749000'; },
    x => { x.payerChannels.channels[0]!.remote_constraints.min_htlc_msat = '50750001'; },
    x => { x.providerChannels.channels[0]!.local_constraints.max_accepted_htlcs = 0; },
    x => { x.payerChannels.channels[0]!.pending_htlcs = [{}]; },
    x => { x.providerChannels.channels[0]!.unsettled_balance = '1'; },
    x => { x.payerChannels.channels[0]!.active = false; },
    x => { x.providerChannels.channels[0]!.remote_pubkey = x.plan.providerNode; },
    x => { x.payerChannels.channels[0]!.channel_point = 'ef'.repeat(32) + ':0'; },
    x => { x.providerChannels.channels[0]!.zero_conf = true; },
    x => { x.payerChannels.channels.push({ ...x.payerChannels.channels[0]!, chan_id: '67890' }); },
    x => { x.providerChannels.channels[0]!.local_balance = '90071992547409920000'; },
    x => { x.channelOut.value = 0.049; },
  ];
  for (const change of cases) {
    const x = await fixture();
    try { change(x); await assert.rejects(x.inspect(x.plan, x.input), /LIQUIDITY/);
      assert.equal(x.calls.some(c => c.source === 'custody'), false);
    } finally { await x.f.cleanup(); }
  }
});

test('fixed funding policy and approved claim fee reject unsupported relay or mempool fee floors', async () => {
  for (const field of ['relay', 'mempool'] as const) for (const value of [0.00002001, -1, NaN, 0.000000001]) {
    const x = await fixture();
    try {
      if (field === 'relay') x.relay.relayfee = value; else x.mempool.mempoolminfee = value;
      await assert.rejects(x.inspect(x.plan, x.input), /FEES/);
    } finally { await x.f.cleanup(); }
  }
});

test('invoice substitution and unavailable or mismatched custody cannot produce readiness', async () => {
  for (const point of ['invoice', 'decode', 'custody', 'custody error'] as const) {
    const x = await fixture();
    try {
      if (point === 'invoice') x.invoiceWire.state = 'CANCELED';
      if (point === 'decode') x.decoded.num_msat = '50750001';
      if (point === 'custody') x.keys.refundPublicKey = x.plan.contract.claimPublicKey;
      const inspect = point === 'custody error' ? createControlledReadiness(x.f.store, x.f.swap.id, x.scope, x.bitcoin, x.provider, x.payer,
        async () => { throw new Error('do-not-echo-private-material'); }) : x.inspect;
      await assert.rejects(inspect(x.plan, x.input), error => /readiness unverified/.test(String(error)) && !String(error).includes('do-not-echo'));
    } finally { await x.f.cleanup(); }
  }
});

test('tip, wallet, ownership, UTXO, channel, fee, invoice and journal changes are rejected without retry', async () => {
  for (const point of ['tip', 'wallet', 'ownership', 'utxo', 'channel', 'fee', 'invoice', 'journal'] as const) {
    const x = await fixture();
    try {
      x.setHook((source, method, count) => {
        if (point === 'tip' && source === 'core' && method === 'getblockchaininfo' && count === 6) x.chain.bestblockhash = 'ef'.repeat(32);
        if (point === 'utxo' && source === 'core' && method === 'gettxout' && count === 3) x.txout.value = 0.0009;
        if (point === 'channel' && source === 'payer' && method === '/v1/channels' && count === 2) x.payerChannels.channels[0]!.local_balance = '499999';
        if (point === 'fee' && source === 'core' && method === 'getmempoolinfo' && count === 2) x.mempool.mempoolminfee = 0.00002;
        if (point === 'wallet' && source === 'core' && method === 'getwalletinfo' && count === 2) x.wallet.scanning = true;
        if (point === 'ownership' && source === 'core' && method === 'getaddressinfo' && count === 3) x.ownership.ismine = false;
        if (point === 'invoice' && source === 'provider' && method.startsWith('/v1/invoice/') && count === 2) x.invoiceWire.state = 'CANCELED';
      });
      const inspect = point === 'journal' ? createControlledReadiness(x.f.store, x.f.swap.id, x.scope, x.bitcoin, x.provider, x.payer,
        async hash => { await updateSwapRevision(x.f.store, x.f.swap.id, x.f.manager.get(x.f.swap.id)!.revision,
          s => { s.pendingAction = 'PREPARE_LOCKUP'; }); return x.custody(hash); }) : x.inspect;
      await assert.rejects(inspect(x.plan, x.input), /CHANGED/);
      assert.ok(x.calls.length < 50);
    } finally { await x.f.cleanup(); }
  }
});

test('RPC failures are sanitized at every read stage without mutations or a second attempt', async () => {
  for (const target of ['getwalletinfo', 'getrawtransaction', 'gettxout', 'getmempoolinfo', '/v1/channels', '/v1/payreq/']) {
    const x = await fixture();
    try {
      x.setHook((_source, method) => { if (method.startsWith(target)) throw new Error('do-not-echo-secret-response'); });
      await assert.rejects(x.inspect(x.plan, x.input), error => !String(error).includes('do-not-echo'));
      assert.equal(x.calls.filter(c => c.method.startsWith(target)).length, 1);
      assert.deepEqual(x.f.calls, { funding: 0, broadcast: 0, settle: 0 });
    } finally { await x.f.cleanup(); }
  }
});

test('scope endpoints and existing uncertain execution cannot be substituted by a readiness request', async () => {
  const x = await fixture();
  try {
    assert.throws(() => createControlledReadiness(x.f.store, x.f.swap.id, { ...x.scope, payerOrigin: x.scope.providerOrigin },
      x.bitcoin, x.provider, x.payer, x.custody), /endpoints/);
    assert.equal(x.calls.length, 0);
    for (const routing of [{ ...x.plan.routing, channelId: '67890' },
      { ...x.plan.routing, channelPoint: 'ab'.repeat(32) + ':0' },
      { ...x.plan.routing, payerOrigin: 'https://127.0.0.1:8082' }]) {
      await assert.rejects(x.inspect({ ...x.plan, routing }, x.input), /PLAN/);
      assert.equal(x.calls.length, 0);
    }
    x.payer.origin = 'https://127.0.0.1:8082';
    await assert.rejects(x.inspect(x.plan, x.input), /PLAN/);
    assert.equal(x.calls.length, 0);
    x.payer.origin = x.scope.payerOrigin;
    await x.f.store.transaction(db => { db.controlledExecutions = { [randomUUID()]: {
      swapId: x.f.swap.id, planDigest: 'ab'.repeat(32), isolationId: x.scope.isolationId, status: 'UNKNOWN', blocksRequested: 0 } }; });
    await assert.rejects(x.inspect(x.plan, x.input), /PLAN/);
    assert.equal(x.calls.length, 0);
  } finally { await x.f.cleanup(); }
});

test('persisted custody uses restore/read operations and returns public identities only', async () => {
  const f = await setup();
  try {
    let reads = 0;
    const vault = { read: async (kind: string, hash: string) => {
      assert.equal(kind, 'client'); assert.equal(hash, f.contract.paymentHash); reads++;
      return Buffer.from(JSON.stringify({ privateKey: Buffer.from(f.claimKey.privateKey!).toString('hex'), preimage: f.preimage }));
    } } as unknown as SecretVault;
    const inspect = persistedReadinessCustody(vault, { publicKey: async hash => {
      assert.equal(hash, f.contract.paymentHash); return f.contract.refundPublicKey;
    } });
    const keys = await inspect(f.contract.paymentHash);
    assert.deepEqual(keys, { paymentHash: f.contract.paymentHash, claimPublicKey: f.contract.claimPublicKey, refundPublicKey: f.contract.refundPublicKey });
    assert.equal(reads, 1); assert.equal(JSON.stringify(keys).includes(f.preimage), false);
    await assert.rejects(persistedReadinessCustody(vault, { publicKey: async () => { throw new Error('do-not-echo'); } })(f.contract.paymentHash),
      error => String(error).includes('Persisted custody identity unavailable') && !String(error).includes('do-not-echo'));
  } finally { await f.cleanup(); }
});

test('extra custody fields and invalid endpoint details cannot escape the public readiness boundary', async () => {
  const x = await fixture();
  try {
    const inspect = createControlledReadiness(x.f.store, x.f.swap.id, x.scope, x.bitcoin, x.provider, x.payer,
      async () => ({ ...x.keys, preimage: 'do-not-project', privateKey: 'do-not-project' }));
    assert.equal(JSON.stringify(await inspect(x.plan, x.input)).includes('do-not-project'), false);
    assert.throws(() => createControlledReadiness(x.f.store, x.f.swap.id, { ...x.scope, payerOrigin: 'invalid-sensitive-origin' },
      x.bitcoin, x.provider, x.payer, x.custody), error => !String(error).includes('sensitive-origin'));
  } finally { await x.f.cleanup(); }
});
