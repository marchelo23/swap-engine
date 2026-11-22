import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateTestDirectory, setup } from './helpers.js';
import { MiningPauseCoordinator, markActiveSwap, ownedActiveSwaps, updateActiveSwapPause,
  validateOnDemandAuthorization } from '../src/mining/ActiveSwapPolicy.js';
import { MiningLockBusyError } from '../src/mining/MiningLock.js';
import { Store } from '../src/persistence/Store.js';

test('active-swap pause records multiple deadlines, preserves operator pauses and clears atomically', async () => {
  const directory = await privateTestDirectory('active-pause'); const file = join(directory, 'pause.json');
  try {
    const a = { id: 'a'.repeat(36), state: 'INVOICE_ACCEPTED', timeoutHeight: 130, updatedAt: 1 };
    const b = { id: 'b'.repeat(36), state: 'LOCKUP_CONFIRMED', timeoutHeight: 135, updatedAt: 2 };
    await updateActiveSwapPause(file, [a, b]);
    const value = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(value.reason, 'active-swap_2_earliest_130');
    assert.deepEqual(value.activeSwapPolicy.swaps, { [a.id]: a, [b.id]: b });
    await updateActiveSwapPause(file, [b]);
    const one = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(one.reason, 'active-swap_1_earliest_135');
    await writeFile(file, JSON.stringify({ pausedAt: '2026-01-01T00:00:00Z', reason: 'operator' }));
    await updateActiveSwapPause(file, [b]);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { pausedAt: '2026-01-01T00:00:00Z', reason: 'operator' });
    await updateActiveSwapPause(file, []);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { pausedAt: '2026-01-01T00:00:00Z', reason: 'operator' });
    await writeFile(file, JSON.stringify({ pausedAt: '2026-01-01T00:00:00Z',
      reason: 'active-swap_1_earliest_135', activeSwapPolicy: { version: 1, swaps: { [b.id]: b } } }));
    await updateActiveSwapPause(file, []);
    await assert.rejects(readFile(file), { code: 'ENOENT' });
    await writeFile(file, '{not-json');
    await updateActiveSwapPause(file, [b]);
    assert.equal(await readFile(file, 'utf8'), '{not-json');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('markActiveSwap merges pending markers and never overwrites operator or malformed state', async () => {
  const directory = await privateTestDirectory('active-mark'); const file = join(directory, 'pause.json');
  try {
    const a = { id: 'a'.repeat(36), state: 'PREPARING', timeoutHeight: 0, updatedAt: 1 };
    const b = { id: 'b'.repeat(36), state: 'LOCKUP_CONFIRMED', timeoutHeight: 135, updatedAt: 2 };
    await markActiveSwap(file, a); await markActiveSwap(file, b);
    assert.equal(Object.keys(JSON.parse(await readFile(file, 'utf8')).activeSwapPolicy.swaps).length, 2);
    await writeFile(file, JSON.stringify({ pausedAt: '2026-01-01T00:00:00Z', reason: 'operator' }));
    await markActiveSwap(file, { ...a, updatedAt: 3 });
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { pausedAt: '2026-01-01T00:00:00Z', reason: 'operator' });
    await writeFile(file, '{bad');
    await markActiveSwap(file, b);
    assert.equal(await readFile(file, 'utf8'), '{bad');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('coordinator preserves the marker on uncertainty and lock contention, and restart recomputes it', async () => {
  const directory = await privateTestDirectory('active-coordinator'); const file = join(directory, 'pause.json');
  try {
    const a = { id: 'a'.repeat(36), state: 'INVOICE_ACCEPTED', timeoutHeight: 130, updatedAt: 1 };
    await new MiningPauseCoordinator(file, async work => work(), [async () => [a]]).reconcile();
    assert.equal(Object.keys(JSON.parse(await readFile(file, 'utf8')).activeSwapPolicy.swaps).length, 1);
    await new MiningPauseCoordinator(file, async work => work(), [async () => { throw new Error('rpc'); }]).reconcile();
    const uncertain = JSON.parse(await readFile(file, 'utf8'));
    assert.ok((Object.values(uncertain.activeSwapPolicy.swaps) as any[]).some(entry => entry.state === 'UNKNOWN'));
    const before = await readFile(file, 'utf8');
    await assert.rejects(new MiningPauseCoordinator(file, async () => { throw new MiningLockBusyError(); },
      [async () => []]).reconcile(), (error: unknown) => error instanceof MiningLockBusyError);
    assert.equal(await readFile(file, 'utf8'), before);
    await new MiningPauseCoordinator(file, async work => work(), [async () => []]).reconcile();
    await assert.rejects(readFile(file), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('on-demand authorization is explicit, expiring and deadline-aware', async () => {
  const directory = await privateTestDirectory('active-auth'); const pauseFile = join(directory, 'pause.json');
  const authFile = join(directory, 'auth.json');
  try {
    const active = { id: 'a'.repeat(36), state: 'LOCKUP_CONFIRMED', timeoutHeight: 130, updatedAt: 1 };
    await updateActiveSwapPause(pauseFile, [active]);
    assert.deepEqual(await validateOnDemandAuthorization(pauseFile, authFile, 1000), { allowed: false, reason: 'authorization-missing' });
    await writeFile(authFile, JSON.stringify({ issuedAt: 900, expiresAt: 2000, maxHeight: 130, reason: 'operator check' }));
    assert.deepEqual(await validateOnDemandAuthorization(pauseFile, authFile, 1000), { allowed: false, reason: 'deadline-window-too-small' });
    await writeFile(authFile, JSON.stringify({ issuedAt: 900, expiresAt: 2000, maxHeight: 110, reason: 'operator check' }));
    assert.deepEqual(await validateOnDemandAuthorization(pauseFile, authFile, 1000), { allowed: true, reason: 'authorized' });
    await writeFile(authFile, JSON.stringify({ issuedAt: 900, expiresAt: 1000, maxHeight: 110, reason: 'operator check' }));
    assert.deepEqual(await validateOnDemandAuthorization(pauseFile, authFile, 1000), { allowed: false, reason: 'authorization-expired' });
    await writeFile(pauseFile, JSON.stringify({ pausedAt: '2026-01-01T00:00:00Z', reason: 'operator' }));
    assert.deepEqual(await validateOnDemandAuthorization(pauseFile, authFile, 1000), { allowed: true, reason: 'no-active-swaps' });
    await writeFile(pauseFile, '{bad');
    assert.deepEqual(await validateOnDemandAuthorization(pauseFile, authFile, 1000), { allowed: false, reason: 'pause-malformed' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('owned scanner includes funded runs and ignores terminal swaps', async () => {
  const f = await setup(); const directory = await privateTestDirectory('owned-scan');
  try {
    const store = await Store.open(join(directory, 'attempt', 'store'));
    try {
      await store.transaction(db => { db.swaps[f.swap.id] = { ...structuredClone(f.swap), state: 'LOCKUP_CONFIRMED',
        lockup: { txid: 'ab'.repeat(32), hex: f.tx.toHex(), vout: 0 } }; });
    } finally { await store.close(); }
    const active = await ownedActiveSwaps(directory, target => Store.open(target));
    assert.equal(active.some(swap => swap.id === f.swap.id), true);
    const reopened = await Store.open(join(directory, 'attempt', 'store'));
    try { await reopened.transaction(db => { db.swaps[f.swap.id]!.state = 'COMPLETED'; }); } finally { await reopened.close(); }
    const terminal = await ownedActiveSwaps(directory, target => Store.open(target));
    assert.equal(terminal.some(swap => swap.id === f.swap.id), false);
  } finally { await f.cleanup(); await rm(directory, { recursive: true, force: true }); }
});
