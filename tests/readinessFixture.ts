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
export async function readinessFixture() {
  const f = await setup();
  const invoice = 'lnbcrt' + 'a'.repeat(30);
  f.ports.createInvoice = async () => invoice;
  await new SwapCoordinator(f.store, f.ports).issueInvoice(f.swap.id);
  const ownAddress = payments.p2wpkh({ pubkey: f.refundKey.publicKey, network: networks.regtest }).address!;
  const ownScript = address.toOutputScript(ownAddress, networks.regtest);
  const inputTx = new Transaction(); inputTx.version = 2; inputTx.addInput(Buffer.alloc(32, 1), 0); inputTx.addOutput(ownScript, 100000n);
  const channelTx = new Transaction(); channelTx.version = 2; channelTx.addInput(Buffer.alloc(32, 2), 0);
  channelTx.addOutput(Buffer.concat([Buffer.from([0, 32]), Buffer.alloc(32, 3)]), 5000000n);
  const input = { txid: inputTx.getId(), vout: 0 };
  const plan = createReverseTestPlan(f.quote, 100, { paymentHash: f.contract.paymentHash, claimPublicKey: f.contract.claimPublicKey },
    f.contract.refundPublicKey, { claim: f.destination, refund: ownAddress },
    { provider: f.contract.claimPublicKey, payer: f.contract.refundPublicKey }, routingFixture(`${channelTx.getId()}:0`));
  const tipHash = 'cd'.repeat(32); const blockHash = 'ab'.repeat(32);
  const scope = { isolationId: randomUUID(), channelId: '12345', channelPoint: `${channelTx.getId()}:0`,
    bitcoinOrigin: 'http://127.0.0.1:18443', providerOrigin: 'https://127.0.0.1:8080', payerOrigin: 'https://127.0.0.1:8081' };
  const chain = { chain: 'regtest', blocks: 100, headers: 100, bestblockhash: tipHash, initialblockdownload: false };
  const node = (identity: string) => ({ identity_pubkey: identity, chains: [{ chain: 'bitcoin', network: 'regtest' }],
    synced_to_chain: true, wallet_synced: true, block_height: 100, block_hash: tipHash, num_peers: 1 });
  const limit = () => ({ chan_reserve_sat: '10000', max_pending_amt_msat: '500000000', min_htlc_msat: '1000', max_accepted_htlcs: 16 });
  const channel = (peer: string, local: string, remote: string) => ({ active: true, remote_pubkey: peer,
    chan_id: scope.channelId, channel_point: scope.channelPoint, capacity: '5000000', local_balance: local, remote_balance: remote,
    commit_fee: '1000', unsettled_balance: '0', pending_htlcs: [] as unknown[], local_constraints: limit(), remote_constraints: limit(), zero_conf: false });
  const providerChannels = { channels: [channel(plan.payerNode, '4400000', '500000')] };
  const payerChannels = { channels: [channel(plan.providerNode, '500000', '4400000')] };
  const providerInfo = node(plan.providerNode); const payerInfo = node(plan.payerNode);
  const decoded = { destination: plan.providerNode, payment_hash: plan.contract.paymentHash, num_satoshis: '50750', num_msat: '50750000',
    timestamp: String(Math.floor(Date.now() / 1000)), expiry: '3600', cltv_expiry: '80', description: 'not-returned' };
  const invoiceWire = { state: 'OPEN', r_hash: Buffer.from(plan.contract.paymentHash, 'hex').toString('base64'), value: '50750',
    amt_paid_sat: '0', payment_request: invoice, htlcs: [] as unknown[], r_preimage: 'not-returned' };
  const wallet = { walletname: 'lqwd-lab', private_keys_enabled: true, scanning: false, external_signer: false };
  const utxos = [{ ...input, scriptPubKey: Buffer.from(ownScript).toString('hex'), amount: 0.001,
    confirmations: 2, safe: true, spendable: true, solvable: true }];
  const locks: Array<{ txid: string; vout: number }> = [];
  const txout = { bestblock: tipHash, confirmations: 2, value: 0.001, scriptPubKey: { hex: Buffer.from(ownScript).toString('hex') }, coinbase: false };
  const channelOut = { ...txout, value: 0.05, scriptPubKey: { hex: Buffer.from(channelTx.outs[0]!.script).toString('hex') } };
  const rawTransactions = new Map([inputTx, channelTx].map(tx => [tx.getId(), {
    txid: tx.getId(), hex: tx.toHex(), blockhash: blockHash, confirmations: 2, in_active_chain: true }]));
  const relay = { relayfee: 0.00001 }; const mempool = { mempoolminfee: 0.00001 };
  const loaded = ['lqwd-lab'];
  const ownership = { ismine: true, solvable: true, scriptPubKey: Buffer.from(ownScript).toString('hex') };
  const calls: Array<{ source: string; method: string; params?: unknown[]; wallet?: boolean }> = [];
  const counts = new Map<string, number>();
  let hook: (source: string, method: string, count: number) => void = () => {};
  const record = (source: string, method: string, params?: unknown[], wallet?: boolean) => {
    const key = `${source}:${method}`; const count = (counts.get(key) ?? 0) + 1; counts.set(key, count);
    calls.push({ source, method, params, wallet }); hook(source, method, count);
  };
  const bitcoin = { origin: scope.bitcoinOrigin, async call<T>(method: string, params: unknown[] = [], walletCall = false): Promise<T> {
    record('core', method, params, walletCall);
    let result: unknown;
    if (method === 'getblockchaininfo') result = chain;
    else if (method === 'listwallets') result = loaded;
    else if (method === 'getwalletinfo') { assert.equal(walletCall, true); result = wallet; }
    else if (method === 'listunspent') { assert.equal(walletCall, true); result = utxos; }
    else if (method === 'listlockunspent') { assert.equal(walletCall, true); result = locks; }
    else if (method === 'getaddressinfo') { assert.equal(walletCall, true); assert.equal(params[0], ownAddress); result = ownership; }
    else if (method === 'getnetworkinfo') result = relay;
    else if (method === 'getmempoolinfo') result = mempool;
    else if (method === 'getrawtransaction') { assert.equal(walletCall, false); result = rawTransactions.get(String(params[0])); }
    else if (method === 'getblockheader') result = { hash: blockHash, height: 99, confirmations: 2 };
    else if (method === 'getblockhash') { assert.equal(params[0], 99); result = blockHash; }
    else if (method === 'gettxout') {
      assert.deepEqual(params, [params[0], 0, true]); result = params[0] === input.txid ? txout : channelOut;
    } else throw new Error(`Unexpected or mutating RPC ${method}`);
    return structuredClone(result) as T;
  } };
  const provider = { origin: scope.providerOrigin, async call<T>(method: string, body?: unknown): Promise<T> {
    assert.equal(body, undefined); record('provider', method);
    const result = method === '/v1/getinfo' ? providerInfo : method === '/v1/channels' ? providerChannels :
      method === `/v1/invoice/${plan.contract.paymentHash}` ? invoiceWire : undefined;
    assert.ok(result, 'Only exact provider read paths are permitted'); return structuredClone(result) as T;
  }, async lookup(hash: string) { return parseLndInvoice(await provider.call(`/v1/invoice/${hash}`)); } };
  const payer = { origin: scope.payerOrigin, async call<T>(method: string, body?: unknown): Promise<T> {
    assert.equal(body, undefined); record('payer', method);
    const result = method === '/v1/getinfo' ? payerInfo : method === '/v1/channels' ? payerChannels :
      method === `/v1/payreq/${invoice}` ? decoded : undefined;
    assert.ok(result, 'Only exact payer read paths are permitted'); return structuredClone(result) as T;
  } };
  const keys = { paymentHash: plan.contract.paymentHash, claimPublicKey: plan.contract.claimPublicKey, refundPublicKey: plan.contract.refundPublicKey };
  const custody = async (hash: string) => { record('custody', 'restore'); assert.equal(hash, keys.paymentHash); return { ...keys }; };
  const inspect = createControlledReadiness(f.store, f.swap.id, scope, bitcoin, provider, payer, custody);
  return { f, input, plan, scope, inspect, bitcoin, provider, payer, custody, chain, wallet, loaded, utxos, locks, txout, channelOut,
    relay, mempool, providerInfo, payerInfo, providerChannels, payerChannels, decoded, invoiceWire, rawTransactions, ownership, keys, calls,
    setHook: (fn: typeof hook) => { hook = fn; } };
}
