import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BitcoinConfirmationLookup, type ConfirmationRpc } from '../src/bitcoin/BitcoinConfirmationLookup.js';
import { BitcoinRpcClient } from '../src/bitcoin/BitcoinRpcClient.js';
import type { SwapPorts } from '../src/core/SwapCoordinator.js';

// Static synthetic serialized fixture, not generated/signed/broadcast by these tests.
// Core consensus acceptance is mocked, not established by this fixture.
const hex = '02000000010000000000000000000000000000000000000000000000000000000000000000ffffffff00ffffffff010100000000000000015100000000';
const txid = '642e0e763397e6e6c9233f4c34c4da5e1e134ad780670ad252fecbabf94bc2da';
const blockHash = 'ab'.repeat(32);
const tipHash = 'cd'.repeat(32);
const otherHash = 'ef'.repeat(32);
type Step = { method: string; params: unknown[]; result?: unknown; error?: Error };

function steps(): Step[] {
  const info = { chain: 'regtest', blocks: 101, bestblockhash: tipHash };
  const tx = { txid, hex, blockhash: blockHash, confirmations: 2 };
  return [
    { method: 'getblockchaininfo', params: [], result: { ...info } },
    { method: 'getrawtransaction', params: [txid, true], result: { ...tx } },
    { method: 'getrawtransaction', params: [txid, true, blockHash], result: { ...tx, in_active_chain: true } },
    { method: 'getblockheader', params: [blockHash, true], result: { hash: blockHash, height: 100, confirmations: 2 } },
    { method: 'getblockhash', params: [100], result: blockHash },
    { method: 'getblockchaininfo', params: [], result: { ...info } },
  ];
}

function fixture(script = steps()) {
  let cursor = 0;
  const rpc: ConfirmationRpc = {
    async call<T>(method: string, params: unknown[] = []): Promise<T> {
      const step = script[cursor++];
      assert.ok(step, `Unexpected RPC ${method}`);
      assert.equal(method, step.method);
      assert.deepEqual(params, step.params);
      if (step.error) throw step.error;
      return structuredClone(step.result) as T;
    },
  };
  return { rpc, lookup: new BitcoinConfirmationLookup(rpc), calls: () => cursor };
}

test('confirmation lookup resolves block and returns only exact active-chain evidence', async () => {
  const f = fixture();
  const port: Pick<SwapPorts, 'confirmed'> = f.lookup;
  assert.deepEqual(await port.confirmed(txid), { hex, confirmations: 2 });
  assert.equal(f.calls(), 6);
});

test('BitcoinRpcClient exposes the port and verifies block hints without credentials or wallet RPC', async () => {
  const f = fixture();
  class MockClient extends BitcoinRpcClient {
    constructor(private readonly transport: ConfirmationRpc) {
      super('http://127.0.0.1:18443', 'never-read-cookie', 'test-wallet');
    }
    override call<T>(method: string, params: unknown[] = [], wallet = false): Promise<T> {
      assert.equal(wallet, false);
      return this.transport.call<T>(method, params);
    }
  }
  const client = new MockClient(f.rpc);
  const confirmed: SwapPorts['confirmed'] = client.confirmed.bind(client);
  assert.deepEqual(await confirmed(txid), { hex, confirmations: 2 });
  const script = steps(); script.splice(1, 1);
  const hinted = fixture(script);
  const hints = new MockClient(hinted.rpc);
  assert.deepEqual(await hints.confirmedTransaction(txid, blockHash), { hex, confirmations: 2 });
  assert.equal(hinted.calls(), 5);
});

test('invalid txids and block hints fail before any RPC', async () => {
  const f = fixture();
  for (const id of ['', 'a'.repeat(63), 'g'.repeat(64), txid.toUpperCase()]) {
    await assert.rejects(f.lookup.confirmed(id));
  }
  await assert.rejects(f.lookup.confirmed(txid, 'bad'));
  assert.equal(f.calls(), 0);
});

test('mainnet, other chains and malformed chain snapshots fail before transaction lookup', async () => {
  for (const info of [null, {}, { chain: 'main', blocks: 101, bestblockhash: tipHash },
    { chain: 'signet', blocks: 101, bestblockhash: tipHash },
    { chain: 'regtest', blocks: -1, bestblockhash: tipHash },
    { chain: 'regtest', blocks: 1.5, bestblockhash: tipHash },
    { chain: 'regtest', blocks: Number.MAX_SAFE_INTEGER + 1, bestblockhash: tipHash },
    { chain: 'regtest', blocks: 101, bestblockhash: 'bad' }]) {
    const script = steps(); script[0]!.result = info;
    const f = fixture(script);
    await assert.rejects(f.lookup.confirmed(txid));
    assert.equal(f.calls(), 1);
  }
});

test('unknown transactions, missing indexes, pruned data and RPC failures never yield evidence', async () => {
  // Fail at every stage, including the final chain check; do not retry or use stale results.
  for (let index = 0; index < 6; index++) {
    const script = steps();
    const error = new Error(index === 1 ? 'Bitcoin RPC getrawtransaction error -5' : 'RPC unavailable');
    script[index]!.error = error;
    const f = fixture(script);
    await assert.rejects(f.lookup.confirmed(txid), value => value === error);
    assert.equal(f.calls(), index + 1);
  }
});

test('mempool presence and malformed transaction responses are not confirmation', async () => {
  for (const index of [1, 2]) {
    const baseline = steps()[index]!.result as Record<string, unknown>;
    const invalid = [null, {}, { ...baseline, blockhash: undefined }, { ...baseline, blockhash: 'bad' },
      ...[undefined, 0, -1, 0.5, '2', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(confirmations => ({ ...baseline, confirmations })),
      { ...baseline, txid: otherHash },
      // Returned metadata can match while the bytes belong to another txid.
      { ...baseline, hex: hex.slice(0, -8) + '01000000' },
      { ...baseline, hex: 'zz' }, { ...baseline, hex: '00' },
      { ...baseline, hex: hex + '00' },
    ];
    if (index === 2) invalid.push({ ...baseline, in_active_chain: false },
      { ...baseline, in_active_chain: undefined }, { ...baseline, in_active_chain: 'true' },
      { ...baseline, blockhash: otherHash });
    for (const response of invalid) {
      const script = steps(); script[index]!.result = response;
      const f = fixture(script);
      await assert.rejects(f.lookup.confirmed(txid));
      assert.equal(f.calls(), index + 1);
    }
  }
});

test('disconnected headers and inconsistent heights/confirmations are rejected', async () => {
  const baseline = steps()[3]!.result as Record<string, unknown>;
  for (const header of [null, {}, { ...baseline, hash: otherHash },
    ...[-1, 0, 1.5, '2', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 3].map(confirmations => ({ ...baseline, confirmations })),
    ...[-1, 0.5, 102, Number.MAX_SAFE_INTEGER + 1, 99].map(height => ({ ...baseline, height }))]) {
    const script = steps(); script[3]!.result = header;
    const f = fixture(script);
    await assert.rejects(f.lookup.confirmed(txid));
    assert.equal(f.calls(), 4);
  }
});

test('reorg between discovery and block lookup rejects inactive transaction evidence', async () => {
  const script = steps();
  script[2]!.result = { txid, hex, blockhash: blockHash, confirmations: 0, in_active_chain: false };
  const f = fixture(script);
  await assert.rejects(f.lookup.confirmed(txid));
  assert.equal(f.calls(), 3);
});

test('reorg after transaction verification rejects changed active block at its height', async () => {
  const script = steps(); script[4]!.result = otherHash;
  const f = fixture(script);
  await assert.rejects(f.lookup.confirmed(txid), /no longer in active chain/);
  assert.equal(f.calls(), 5);
});

test('changed tip, even at the same height, and malformed final snapshots are rejected', async () => {
  for (const info of [null, {}, { chain: 'main', blocks: 101, bestblockhash: tipHash },
    { chain: 'regtest', blocks: 101, bestblockhash: otherHash },
    { chain: 'regtest', blocks: 102, bestblockhash: otherHash },
    { chain: 'regtest', blocks: 102, bestblockhash: tipHash }]) {
    const script = steps(); script[5]!.result = info;
    const f = fixture(script);
    await assert.rejects(f.lookup.confirmed(txid));
    assert.equal(f.calls(), 6);
  }
});

test('each call fetches fresh confirmation evidence rather than caching a prior success', async () => {
  const script = [...steps(), ...steps()];
  script[8]!.result = { txid, hex, blockhash: blockHash, confirmations: 0, in_active_chain: false };
  const f = fixture(script);
  await f.lookup.confirmed(txid);
  await assert.rejects(f.lookup.confirmed(txid));
  assert.equal(f.calls(), 9);
});
