import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateTestDirectory } from './helpers.js';
import { updateActiveSwapPause } from '../src/mining/ActiveSwapPolicy.js';

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
