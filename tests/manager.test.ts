import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setup, fixture } from './helpers.js';
import { Store } from '../src/persistence/Store.js';
import { SwapManager } from '../src/core/SwapManager.js';
import { LEGACY_ECONOMICS } from '../src/core/Economics.js';
import { available } from '../src/liquidity/LiquidityManager.js';

test('duplicate request returns same operation; conflicts and hash reuse fail', async () => {
  const f = await setup(); try {
    const same = await f.manager.create(f.quote.id, 'request-1234', f.contract, 100, { onchainSats: 0, incomingSats: 0 });
    assert.equal(same.id, f.swap.id);
    await assert.rejects(f.manager.create(f.quote.id, 'request-1234', { ...f.contract, timeoutHeight: 131 }, 100, { onchainSats: 1e6, incomingSats: 1e6 }), /conflict/);
    const quote = await f.manager.quote(50_000);
    await assert.rejects(f.manager.create(quote.id, 'different-key', f.contract, 100, { onchainSats: 1e6, incomingSats: 1e6 }), /hash already used/);
  } finally { await f.cleanup(); }
});
test('quotes expire, cannot be reused, and enforce amount limits', async () => {
  const f = await setup(); try {
    for (const amount of [9999, 1_000_001, 1.5, NaN]) await assert.rejects(f.manager.quote(amount));
    const quote = await f.manager.quote(50_000, 1);
    await assert.rejects(f.manager.create(quote.id, 'expired-key', fixture().contract, 100, { onchainSats: 1e6, incomingSats: 1e6 }), /expired/);
    await assert.rejects(f.manager.create(f.quote.id, 'reuse-quote', fixture().contract, 100, { onchainSats: 1e6, incomingSats: 1e6 }), /consumed/);
  } finally { await f.cleanup(); }
});
test('insufficient chain and incoming liquidity include active reservations', async () => {
  const f = await setup(); try {
    const quote = await f.manager.quote(50_000);
    await assert.rejects(f.manager.create(quote.id, 'short-onchain', fixture().contract, 100, { onchainSats: 70_000, incomingSats: 1e6 }), /on-chain liquidity/);
    await assert.rejects(f.manager.create(quote.id, 'short-incoming', fixture().contract, 100, { onchainSats: 1e6, incomingSats: 60_000 }), /incoming Lightning/);
    const free = available(f.store.read(), { onchainSats: 1e6, incomingSats: 1e6 });
    assert.equal(free.onchainSats, 939_000); assert.equal(free.incomingSats, 1e6 - f.quote.invoiceSats);
  } finally { await f.cleanup(); }
});
test('concurrent creates cannot reserve the same available budget', async () => {
  const f = await setup(); try {
    const q1 = await f.manager.quote(50_000); const q2 = await f.manager.quote(50_000);
    const balances = { onchainSats: 120_000, incomingSats: 1e6 };
    const results = await Promise.allSettled([
      f.manager.create(q1.id, 'parallel-one', fixture().contract, 100, balances),
      f.manager.create(q2.id, 'parallel-two', fixture().contract, 100, balances),
    ]);
    assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  } finally { await f.cleanup(); }
});
test('single instance lock refuses a second writer', async () => {
  const f = await setup(); try { await assert.rejects(Store.open(f.directory), /EEXIST/); } finally { await f.cleanup(); }
});
test('failed transaction rolls back memory and subsequent transaction works', async () => {
  const f = await setup(); try {
    await assert.rejects(f.store.transaction(db => { delete db.swaps[f.swap.id]; throw new Error('rollback'); }));
    assert(f.manager.get(f.swap.id));
    await f.manager.quote(60_000); assert.equal(Object.keys(f.store.read().quotes).length, 2);
  } finally { await f.cleanup(); }
});
test('corrupt database fails closed without deleting state', async () => {
  await mkdir('data/tests', { recursive: true });
  const directory = await mkdtemp(join(process.cwd(), 'data', 'tests', 'corrupt-'));
  try { await writeFile(join(directory, 'state.json'), 'broken'); await assert.rejects(Store.open(directory)); }
  finally { await rm(directory, { recursive: true, force: true }); }
});
test('strict timeout validation rejects unsafe claim windows', async () => {
  const f = await setup(); try {
    for (const timeoutHeight of [100, 119, 141]) {
      const quote = await f.manager.quote(50_000);
      await assert.rejects(f.manager.create(quote.id, 'timeout-test', { ...fixture().contract, timeoutHeight }, 100, { onchainSats: 1e6, incomingSats: 1e6 }), /20..40/);
    }
  } finally { await f.cleanup(); }
});

test('configured quote economics are applied without changing legacy defaults', async () => {
  const f = await setup(); try {
    const policy = structuredClone(LEGACY_ECONOMICS);
    policy.quote.minAmountSats = 20_000; policy.quote.maxAmountSats = 60_000; policy.quote.ttlMs = 180_000;
    policy.quote.serviceFeeBaseSats = 700; policy.quote.serviceFeeBps = 100;
    const manager = new SwapManager(f.store, policy);
    await assert.rejects(manager.quote(19_999)); await assert.rejects(manager.quote(60_001));
    const quote = await manager.quote(50_000, 1);
    assert.equal(quote.serviceFeeSats, 1_200); assert.equal(quote.expiresAt, 180_001);
    assert.equal(quote.fundingReserveSats, 1_000); assert.equal(quote.claimFeeSats, 500);
    const legacy = new SwapManager(f.store).quote(50_000, 1);
    assert.equal((await legacy).expiresAt, 120_001);
  } finally { await f.cleanup(); }
});