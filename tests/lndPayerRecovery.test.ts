import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { LndPayerRecovery, LndRecoveryClient, recoveryPaymentsPath, recoveryRoutedPaymentsPath, recoveryPaymentLimit } from '../src/lightning/LndPayerRecovery.js';
import { config } from '../src/config.js';
import { configuredReverseRecovery, createReverseRecovery, recoverInterruptedReverseRuns } from '../src/api/reverseRecovery.js';
import { SwapCoordinator } from '../src/core/SwapCoordinator.js';
import { updateSwapRevision } from '../src/core/SwapStateMachine.js';
import { setup, routingFixture } from './helpers.js';

// Synthetic public/test material only. No real transport or credential files are used.
const preimage = '11'.repeat(32);
const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
const payerNode = '02' + '22'.repeat(32);
const providerNode = '03' + '33'.repeat(32);
const info = () => ({ identity_pubkey: payerNode, synced_to_chain: true, wallet_synced: true,
  chains: [{ chain: 'bitcoin', network: 'regtest' }] });
const payment = () => ({ payment_hash: paymentHash, payment_index: '7', status: 'SUCCEEDED',
  value_sat: '50750', value_msat: '50750000', fee_sat: '0', fee_msat: '0',
  failure_reason: 'FAILURE_REASON_NONE', payment_preimage: preimage, htlcs: [{ preimage: 'never-project' }] });
const page = () => ({ payments: [payment()], first_index_offset: '7', last_index_offset: '7' });

function fixture(raw: unknown = page(), nodes: unknown[] = [info(), info()]) {
  const calls: string[] = [];
  let nodeIndex = 0;
  const client = { async call<T>(path: string, body?: unknown): Promise<T> {
    assert.equal(body, undefined); calls.push(path);
    if (path === '/v1/getinfo') return structuredClone(nodes[Math.min(nodeIndex++, nodes.length - 1)]) as T;
    assert.equal(path, recoveryPaymentsPath);
    if (raw instanceof Error) throw raw;
    return structuredClone(raw) as T;
  } };
  return { calls, adapter: new LndPayerRecovery(client, payerNode) };
}

test('read-only payer lookup returns only exact sanitized evidence for supported LND outcomes', async () => {
  for (const status of ['IN_FLIGHT', 'SUCCEEDED', 'FAILED'] as const) {
    const raw = page(); raw.payments[0]!.status = status;
    raw.payments[0]!.failure_reason = status === 'FAILED' ? 'FAILURE_REASON_TIMEOUT' : 'FAILURE_REASON_NONE';
    const f = fixture(raw);
    const result = await f.adapter.lookupPayment(paymentHash);
    assert.deepEqual(result, { hash: paymentHash, status, valueSats: 50750, ...(status === 'SUCCEEDED' ? { feeSats: 0 } : {}) });
    assert.deepEqual(f.calls, ['/v1/getinfo', recoveryPaymentsPath, '/v1/getinfo']);
    assert.doesNotMatch(JSON.stringify(result), /preimage|htlcs|never-project/);
    assert.equal(JSON.stringify(result).includes(preimage), false);
  }
});

test('fractional satoshi routing fees round upward and cannot evade the existing fee ceiling', async () => {
  for (const [fee_msat, fee_sat, expected] of [['1', '0', 1], ['100000', '100', 100], ['100001', '100', 101]] as const) {
    const raw = page(); Object.assign(raw.payments[0]!, { fee_msat, fee_sat });
    assert.equal((await fixture(raw).adapter.lookupPayment(paymentHash)).feeSats, expected);
  }
});

test('absent, duplicate, truncated and inconsistent payment histories cannot establish evidence', async () => {
  const duplicate = page(); duplicate.payments.push({ ...payment(), payment_index: '8' }); duplicate.last_index_offset = '8';
  const full = { payments: Array.from({ length: recoveryPaymentLimit }, (_, i) => ({ ...payment(), payment_index: String(i + 1) })),
    first_index_offset: '1', last_index_offset: String(recoveryPaymentLimit) };
  const other = page(); other.payments[0]!.payment_hash = '00'.repeat(32);
  const invalid: unknown[] = [null, {}, { payments: [], first_index_offset: '0', last_index_offset: '0' }, duplicate, full,
    other, { ...page(), first_index_offset: '0' }, { ...page(), last_index_offset: '8' },
    { ...page(), payments: [{ ...payment(), payment_index: '0' }] },
    { ...page(), payments: [{ ...payment(), payment_index: '18446744073709551616' }] }];
  for (const raw of invalid) {
    const f = fixture(raw);
    await assert.rejects(f.adapter.lookupPayment(paymentHash), /evidence unavailable or unsupported/);
    assert.equal(f.calls.filter(path => path === recoveryPaymentsPath).length, 1);
  }
});

test('malformed amounts, statuses, fees, failure reasons and success preimages fail closed without raw error leakage', async () => {
  const changes: Record<string, unknown>[] = [
    { status: 'UNKNOWN' }, { status: 'INITIATED' }, { status: 2 }, { value_sat: 50750 },
    { value_sat: '-1' }, { value_sat: '050750' }, { value_sat: '50750.0' }, { value_sat: '9007199254740992' },
    { value_msat: '50750001' }, { fee_sat: '1', fee_msat: '0' }, { fee_msat: '-1' },
    { status: 'FAILED', failure_reason: 'FAILURE_REASON_NONE' }, { failure_reason: 'FUTURE_UNKNOWN' },
    { failure_reason: 'FAILURE_REASON_TIMEOUT' }, { payment_preimage: undefined }, { payment_preimage: '00'.repeat(32) },
  ];
  for (const change of changes) {
    const raw = page(); Object.assign(raw.payments[0]!, change);
    await assert.rejects(fixture(raw).adapter.lookupPayment(paymentHash), error => {
      assert.equal((error as Error).message, 'Existing payer payment evidence unavailable or unsupported');
      assert.equal(String(error).includes(preimage), false); return true;
    });
  }
  const f = fixture(new Error(`transport contained ${preimage}`));
  await assert.rejects(f.adapter.lookupPayment(paymentHash), error => !String(error).includes(preimage));
  assert.equal(f.calls.length, 2); // No fallback, stream, payment send, or retry after failure.
});

test('payer identity and synchronized regtest chain are checked before and after lookup', async () => {
  for (const changed of [{ ...info(), identity_pubkey: providerNode }, { ...info(), synced_to_chain: false },
    { ...info(), wallet_synced: false }, { ...info(), chains: [{ chain: 'bitcoin', network: 'mainnet' }] }]) {
    for (const nodes of [[changed, info()], [info(), changed]]) {
      const f = fixture(page(), nodes);
      await assert.rejects(f.adapter.lookupPayment(paymentHash));
      assert.ok(f.calls.length <= 3);
    }
  }
  const f = fixture();
  await assert.rejects(f.adapter.lookupPayment('../unknown'));
  assert.equal(f.calls.length, 0);
});

test('recovery transport refuses unsupported operations before credentials or network access', async () => {
  const client = new LndRecoveryClient('https://127.0.0.1:8081', 'never-read-cert', 'never-read-macaroon');
  for (const path of ['/v2/router/send', '/v1/channels/transactions', '/v2/invoices/settle', '/v2/invoices/cancel',
    '/v1/payments', recoveryPaymentsPath + '&max_payments=999999', '/v1/invoice/../payments', '/v1/getinfo?extra=true']) {
    await assert.rejects(client.call(path), /READ_ONLY_RECOVERY/);
  }
  for (const path of ['/v1/getinfo', recoveryPaymentsPath, '/v1/invoice/' + paymentHash]) {
    await assert.rejects(client.call(path, {}), /READ_ONLY_RECOVERY/);
  }
  await assert.rejects(client.settle(preimage), /READ_ONLY_RECOVERY/);
  await assert.rejects(client.cancel(paymentHash), /READ_ONLY_RECOVERY/);
  await assert.rejects(client.subscribe(paymentHash, () => {}, new AbortController().signal), /READ_ONLY_RECOVERY/);
});

const environment = () => ({ ENABLE_READ_ONLY_RECOVERY: 'true', RECOVERY_PAYER_REST_URL: 'https://127.0.0.1:8081',
  RECOVERY_PAYER_TLS_CERT_PATH: '/never-read-cert', RECOVERY_PAYER_MACAROON_PATH: '/never-read-macaroon',
  RECOVERY_PAYER_NODE_PUBKEY: payerNode, RECOVERY_PROVIDER_NODE_PUBKEY: providerNode,
  BITCOIN_RPC_URL: 'http://127.0.0.1:18443', BITCOIN_COOKIE_PATH: '/never-read-cookie', BITCOIN_WALLET: 'test-wallet',
  LND_REST_URL: 'https://127.0.0.1:8080', LND_TLS_CERT_PATH: '/never-read-provider-cert',
  LND_MACAROON_PATH: '/never-read-provider-macaroon' });

test('configuration is opt-in, pins separate identities and loopback TLS, and cannot enable live execution', async () => {
  assert.equal(config({}).recovery, undefined);
  assert.equal(config({ ENABLE_READ_ONLY_RECOVERY: 'false' }).recovery, undefined);
  assert.ok(config(environment()).recovery);
  for (const key of Object.keys(environment()).filter(key => key.startsWith('RECOVERY_'))) {
    assert.throws(() => config({ ...environment(), [key]: undefined }), /configuration incomplete/);
  }
  for (const value of ['http://127.0.0.1:8081', 'https://example.com', 'https://' + 'user:password@127.0.0.1',
    'https://127.0.0.1/path', 'https://127.0.0.1?x=1', 'invalid-password-url']) {
    assert.throws(() => config({ ...environment(), RECOVERY_PAYER_REST_URL: value }), error => !String(error).includes('password'));
  }
  assert.throws(() => config({ ...environment(), RECOVERY_PAYER_NODE_PUBKEY: providerNode }));
  assert.throws(() => config({ ENABLE_READ_ONLY_RECOVERY: '1' }));
  assert.throws(() => config({ ...environment(), ENABLE_LIVE_SWAPS: 'true' }), /unavailable/);
  const f = await setup();
  try {
    assert.equal(configuredReverseRecovery(f.store, config({})), undefined);
    // Construction must not read the nonexistent paths or call any node.
    assert.ok(configuredReverseRecovery(f.store, config(environment())));
  } finally { await f.cleanup(); }
});

test('real payer adapter reconciles payment ambiguity from mocked LND evidence without resending', async () => {
  const f = await setup();
  try {
    await new SwapCoordinator(f.store, f.ports).issueInvoice(f.swap.id);
    await updateSwapRevision(f.store, f.swap.id, f.manager.get(f.swap.id)!.revision, s => {
      s.clientPayment = { hash: s.contract.paymentHash, status: 'UNKNOWN', feeLimitSats: 100 };
    });
    await recoverInterruptedReverseRuns(f.store);
    const raw = page(); Object.assign(raw.payments[0]!, { payment_hash: f.contract.paymentHash, status: 'IN_FLIGHT' });
    const payer = fixture(raw);
    const recovery = createReverseRecovery(f.store, f.ports, payer.adapter);
    const first = await recovery.reconcile(f.swap.id, f.manager.get(f.swap.id)!.revision);
    assert.equal(first.next, 'FUND');
    assert.equal((await recovery.reconcile(f.swap.id, first.revision)).revision, first.revision);
    assert.deepEqual(f.calls, { funding: 0, broadcast: 0, settle: 0 });
    assert.equal(JSON.stringify(first).includes(preimage), false);
    const unavailable = createReverseRecovery(f.store, f.ports, fixture(new Error('No payment history')).adapter);
    assert.equal((await unavailable.reconcile(f.swap.id, first.revision)).next, 'MANUAL_REVIEW');
    assert.deepEqual(f.calls, { funding: 0, broadcast: 0, settle: 0 });
  } finally { await f.cleanup(); }
});

test('controlled recovery requests hop evidence and rejects a substituted or absent approved route', async () => {
  for (const point of ['valid', 'wrong', 'missing', 'inflight missing'] as const) {
    const raw = page(); raw.payments[0]!.htlcs = [];
    const rows = [{ attempt_id: '1', status: 'SUCCEEDED', route: { total_amt_msat: '50750000', total_fees_msat: '0',
      hops: [{ chan_id: point === 'wrong' ? '67890' : '12345', pub_key: providerNode, amt_to_forward_msat: '50750000', fee_msat: '0' }] } }];
    Object.assign(raw.payments[0]!, { htlcs: ['missing', 'inflight missing'].includes(point) ? [] : rows,
      ...(point === 'inflight missing' ? { status: 'IN_FLIGHT' } : {}) });
    let lists = 0;
    const client = { async call<T>(path: string): Promise<T> {
      if (path === '/v1/getinfo') return info() as T;
      assert.equal(path, recoveryRoutedPaymentsPath); lists++; return structuredClone(raw) as T;
    } };
    const adapter = new LndPayerRecovery(client, payerNode, () => ({ routing: routingFixture(), providerNode }));
    if (point === 'valid') assert.equal((await adapter.lookupPayment(paymentHash)).status, 'SUCCEEDED');
    else await assert.rejects(adapter.lookupPayment(paymentHash), /unsupported/);
    assert.equal(lists, 1);
  }
});
