import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OperationsBalancesResponse } from '../src/api/schemas.js';
import { collectLiquidBalances, type LiquidBalanceReader, type LiquidBalanceSource } from '../src/liquid/LiquidBalances.js';
import { collectOperationsBalances } from '../src/operations/Balances.js';

const policy = 'b2e15d0d7a0c94e4e2ce0fe6e8691b9e451377f6e46e8045a86f7c4b5d4f0f23';
const parent = '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206';
const genesis = '209577bda6bf4b5804bd46f8621580dd6d4e8bfa2d190e1c50e932492baca07d';
const wallet = 'lqwd-liquid-ops';
const txid = 'a'.repeat(64);

type Call = { method: string; params: unknown[]; wallet: boolean };

function fixture(overrides: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const responses: Record<string, unknown> = {
    getblockchaininfo: { chain: 'elementsregtest', blocks: 2, bestblockhash: 'b'.repeat(64),
      initialblockdownload: false },
    getblockhash: genesis,
    getsidechaininfo: { pegged_asset: policy, parent_blockhash: parent },
    getwalletinfo: { walletname: wallet },
    listunspent: [
      { txid, vout: 1, asset: policy, amount: 21, confirmations: 1, spendable: true, safe: true,
        scriptPubKey: '51' },
      { txid, vout: 2, asset: policy, amount: 0.0005, confirmations: 0, spendable: false, safe: false,
        scriptPubKey: '51' },
    ],
    ...overrides,
  };
  const reader: LiquidBalanceReader = {
    origin: 'http://127.0.0.1:7052',
    async call<T>(method: string, params: unknown[] = [], walletCall = false): Promise<T> {
      calls.push({ method, params, wallet: walletCall });
      const response = responses[method];
      if (response === undefined) throw new Error(`Unexpected Elements RPC method: ${method}`);
      if (response instanceof Error) throw response;
      return response as T;
    },
  };
  return { reader, calls };
}

function source(reader: LiquidBalanceReader, overrides: Partial<LiquidBalanceSource> = {}): LiquidBalanceSource {
  return { reader, chainName: 'elementsregtest', policyAsset: policy, genesisHash: genesis,
    parentGenesisHash: parent, wallet, assetEvidence: 'confirmed-wallet-and-coinbase', ...overrides };
}

test('Liquid wallet balances are read from the configured asset only', async () => {
  const { reader, calls } = fixture();
  const snapshot = await collectLiquidBalances(source(reader));
  assert.deepEqual(snapshot, {
    wallet, chain: 'elementsregtest', height: 2, genesisHash: genesis, assetId: policy,
    confirmedBaseUnits: 2_100_000_000, unconfirmedBaseUnits: 50_000, spendableBaseUnits: 2_100_000_000,
    utxoCount: 2, assetEvidence: 'confirmed-wallet-and-coinbase', feePolicyVerified: false, readOnly: true,
  });
  assert.deepEqual(calls.map(call => call.method), [
    'getblockchaininfo', 'getblockhash', 'getsidechaininfo', 'getwalletinfo', 'listunspent', 'getblockchaininfo',
  ]);
  assert.deepEqual(calls.at(-2), { method: 'listunspent', wallet: true,
    params: [0, 9_999_999, [], true, { asset: policy }] });
});

test('Liquid balances fail closed on chain, genesis, wallet, parent, asset and amount mismatches', async () => {
  for (const overrides of [
    { getblockchaininfo: { chain: 'liquidv1', blocks: 2, bestblockhash: 'b'.repeat(64), initialblockdownload: false } },
    { getblockhash: 'ef'.repeat(32) },
    { getwalletinfo: { walletname: 'other' } },
    { getsidechaininfo: { pegged_asset: policy, parent_blockhash: 'ef'.repeat(32) } },
    { getsidechaininfo: { pegged_asset: 'ef'.repeat(32), parent_blockhash: parent } },
  ]) {
    const { reader } = fixture(overrides);
    await assert.rejects(collectLiquidBalances(source(reader)));
  }
  const otherAsset = fixture({ listunspent: [{ txid, vout: 1, asset: 'ef'.repeat(32), amount: 1,
    confirmations: 1, spendable: true, scriptPubKey: '51' }] });
  await assert.rejects(collectLiquidBalances(source(otherAsset.reader)), /LIQUID_UNEXPECTED_ASSET/);
  const unsafeAmount = fixture({ listunspent: [{ txid, vout: 1, asset: policy, amount: 1e20,
    confirmations: 1, spendable: true, scriptPubKey: '51' }] });
  await assert.rejects(collectLiquidBalances(source(unsafeAmount.reader)), /LIQUID_AMOUNT_INVALID/);
});

test('An empty Liquid wallet reports zeroes instead of fabricated balances', async () => {
  const { reader } = fixture({ listunspent: [] });
  const snapshot = await collectLiquidBalances(source(reader, { assetEvidence: undefined }));
  assert.equal(snapshot.confirmedBaseUnits, 0);
  assert.equal(snapshot.unconfirmedBaseUnits, 0);
  assert.equal(snapshot.spendableBaseUnits, 0);
  assert.equal(snapshot.utxoCount, 0);
  assert.equal(snapshot.assetEvidence, 'not-collected');
});

test('operations balances carry the real Liquid snapshot and a dedicated rail entry', async () => {
  const { reader } = fixture();
  const report = await collectOperationsBalances({ bitcoin: null, provider: null, alice: null,
    liquid: source(reader) }, new Date('2026-11-23T08:00:00.000Z'));
  assert.equal(report.liquid?.assetId, policy);
  assert.equal(report.liquid?.confirmedBaseUnits, 2_100_000_000);
  const entry = report.rails.find(item => item.rail === 'liquid');
  assert.deepEqual(entry, { rail: 'liquid', account: 'operator', status: 'available', reason: null,
    balances: { assetId: policy, confirmedBaseUnits: 2_100_000_000, unconfirmedBaseUnits: 50_000,
      spendableBaseUnits: 2_100_000_000, utxoCount: 2 } });
  OperationsBalancesResponse.parse(report);
});

test('a failing Liquid reader is unavailable without leaking RPC text', async () => {
  const { reader } = fixture({ getblockchaininfo: new Error('do not print /private/cookie') });
  const report = await collectOperationsBalances({ bitcoin: null, provider: null, alice: null,
    liquid: source(reader) }, new Date('2026-11-23T08:00:00.000Z'));
  assert.equal(report.liquid, undefined);
  assert.equal(report.rails.find(item => item.rail === 'liquid')?.status, 'unavailable');
  assert.equal(JSON.stringify(report).includes('/private/cookie'), false);
  OperationsBalancesResponse.parse(report);
});
