import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture as contractFixture, routingFixture, privateTestDirectory } from './helpers.js';
import { Store } from '../src/persistence/Store.js';
import { updateSwapRevision } from '../src/core/SwapStateMachine.js';
import { createReversePreparation, preparationDigest, type PreparationSpec, type PreparationAdapters, type PreparationApproval } from '../src/core/ReversePreparation.js';
import { controlledRunDigest, createControlledReverseBackend } from '../src/core/ControlledReverseBackend.js';
import type { Invoice } from '../src/lightning/LndClient.js';

export async function preparationFixture(sourceAmountSats?: number) {
  const f = contractFixture();
  const directory = await privateTestDirectory('preparation');
  let store = await Store.open(directory); let clock = Date.now(); let exists = false; let calls = 0; let posts = 0; let inspections = 0;
  const spec: PreparationSpec = { id: randomUUID(), isolationId: randomUUID(), tipHeight: 100,
    providerNode: f.contract.claimPublicKey, payerNode: f.contract.refundPublicKey, routing: routingFixture(),
    client: { paymentHash: f.contract.paymentHash, claimPublicKey: f.contract.claimPublicKey }, refundPublicKey: f.contract.refundPublicKey,
    claimDestination: f.destination, refundDestination: f.destination, input: { txid: 'ab'.repeat(32), vout: 0, valueSats: 100000 },
    ...(sourceAmountSats === undefined ? {} : { sourceAmountSats }) };
  const approval: PreparationApproval = { id: spec.id, scope: 'isolated-regtest-invoice-only', specDigest: preparationDigest(spec), expiresAt: clock + 120000 };
  const info = (identity: string) => ({ identity_pubkey: identity, synced_to_chain: true, wallet_synced: true, chains: [{ chain: 'bitcoin', network: 'regtest' }] });
  const pInfo = info(spec.providerNode); const aInfo = info(spec.payerNode);
  const channel = (peer: string) => ({ chan_id: spec.routing.channelId, channel_point: spec.routing.channelPoint, active: true, remote_pubkey: peer, zero_conf: false,
    local_balance: '1000000', remote_balance: '1000000', commit_fee: '100', unsettled_balance: '0', pending_htlcs: [],
    local_constraints: { chan_reserve_sat: '10000' }, remote_constraints: { chan_reserve_sat: '10000' } });
  const pChannels = { channels: [channel(spec.payerNode)] }; const aChannels = { channels: [channel(spec.providerNode)] };
  const chain = { chain: 'regtest', blocks: 100, initialblockdownload: false };
  const paymentRequest = 'lnbcrt' + 'a'.repeat(30);
  const invoiceSats = sourceAmountSats ?? 50750;
  const decoded = { destination: spec.providerNode, payment_hash: spec.client.paymentHash, num_satoshis: String(invoiceSats), num_msat: String(invoiceSats * 1000),
    timestamp: String(Math.floor(clock / 1000)), expiry: '3600', cltv_expiry: '80' };
  const invoice: Invoice = { state: 'OPEN', r_hash: Buffer.from(spec.client.paymentHash, 'hex').toString('base64'),
    value: String(invoiceSats), amt_paid_sat: '0', payment_request: paymentRequest, htlcs: [] };
  const keys = { paymentHash: spec.client.paymentHash, claimPublicKey: spec.client.claimPublicKey, refundPublicKey: spec.refundPublicKey };
  let credentialHook: () => Promise<void> = async () => {};
  let replyHook: () => Promise<void> = async () => {};
  let inspectHook: (result: Awaited<ReturnType<PreparationAdapters['inspect']>>) => Promise<void> = async () => {};
  let beforeWireHook: () => Promise<void> = async () => {};
  let response = paymentRequest;
  let lost = false; let skipGuard = false; let duplicateGuard = false;
  const reads: string[] = [];
  const provider = { origin: spec.routing.providerOrigin, assertRegtest: async () => pInfo,
    async call<T>(path: string): Promise<T> { reads.push(path); assert.ok(['/v1/getinfo', '/v1/channels'].includes(path)); return structuredClone(path === '/v1/getinfo' ? pInfo : pChannels) as T; },
    async lookup(hash: string) { assert.equal(hash, spec.client.paymentHash); reads.push('invoice'); if (!exists) throw Error('synthetic-not-found-do-not-echo'); return structuredClone(invoice); } };
  const payer = { origin: spec.routing.payerOrigin, assertRegtest: async () => aInfo,
    async call<T>(path: string): Promise<T> { reads.push(path); if (path === '/v1/getinfo') return structuredClone(aInfo) as T;
      if (path === '/v1/channels') return structuredClone(aChannels) as T;
      assert.equal(path, '/v1/payreq/' + paymentRequest); return structuredClone(decoded) as T; } };
  const bitcoin = { origin: spec.routing.bitcoinOrigin,
    async call<T>(method: string): Promise<T> { assert.equal(method, 'getblockchaininfo'); reads.push(method); return structuredClone(chain) as T; },
    confirmed: async () => { throw Error('must not observe chain before real inspector adapter'); } };
  const adapters: PreparationAdapters = { bitcoin, provider, payer, custody: async () => structuredClone(keys), now: () => clock,
    invoiceStatus: async () => exists ? 'PRESENT' : 'ABSENT',
    async inspect(swapId, plan, supplied) {
      inspections++; assert.equal(swapId, record().swapId); assert.deepEqual(supplied, spec);
      assert.equal(store.read().swaps[swapId]!.state, 'INVOICE_CREATED');
      const result = { network: 'regtest' as const, isolationId: spec.isolationId, providerNode: spec.providerNode, payerNode: spec.payerNode,
        tipHeight: 100, ...keys, funding: { ...spec.input, confirmed: true, safe: true, spendable: true }, decodedInvoice: structuredClone(decoded) };
      await inspectHook(result); return result;
    },
    async createInvoice(request, beforeRequest) {
      calls++; assert.deepEqual(request, { hash: spec.client.paymentHash, sats: invoiceSats, expirySeconds: 3600, cltvDelta: 80 });
      let disk = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
      assert.equal(disk.reversePreparations[spec.id].invoiceAttempt.wireAuthorized, false);
      await credentialHook(); await beforeWireHook();
      if (!skipGuard) await beforeRequest();
      if (duplicateGuard) await beforeRequest();
      if (!skipGuard) {
        disk = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
        assert.equal(disk.reversePreparations[spec.id].invoiceAttempt.wireAuthorized, true);
        const swap = disk.swaps[disk.reversePreparations[spec.id].swapId]; assert.equal(swap.pendingAction, 'CREATE_INVOICE');
        assert.deepEqual(swap.quote, disk.reversePreparations[spec.id].plan.quote);
        posts++; exists = true;
      }
      await replyHook();
      if (lost) throw Error('synthetic-lost-reply-do-not-echo');
      return { payment_request: response };
    },
  };
  const record = () => store.read().reversePreparations![spec.id]!;
  const harness = (a: PreparationApproval | undefined = approval) => createReversePreparation(store, spec, adapters, a);
  return { directory, spec, approval, adapters, provider, payer, bitcoin, pInfo, aInfo, pChannels, aChannels, chain, decoded, invoice, keys, reads, harness, record,
    get store() { return store; }, calls: () => calls, posts: () => posts, inspections: () => inspections,
    lose: () => { lost = true; }, badResponse: (value: string) => { response = value; }, omitGuard: () => { skipGuard = true; }, repeatGuard: () => { duplicateGuard = true; },
    credentials: (fn: typeof credentialHook) => { credentialHook = fn; }, reply: (fn: typeof replyHook) => { replyHook = fn; },
    inspect: (fn: typeof inspectHook) => { inspectHook = fn; }, wire: (fn: typeof beforeWireHook) => { beforeWireHook = fn; },
    setTime: (time: number) => { clock = time; },
    reopen: async () => { await store.close(); store = await Store.open(directory); },
    cleanup: async () => { await store.close(); await rm(directory, { recursive: true }); } };
}
