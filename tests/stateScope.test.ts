import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertStateScope } from '../src/environment/StateScope.js';

const scope = { environment: 'regtest', deploymentId: 'lab-a', genesisHash: 'ab'.repeat(32), wallet: 'wallet-a' };

test('state scope binds a journal to one deployment/chain/wallet and rejects mismatches', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'swap-scope-'));
  try {
    await assertStateScope(directory, scope);
    assert.deepEqual(JSON.parse(await readFile(join(directory, '.environment.json'), 'utf8')), { version: 2, ...scope });
    await writeFile(join(directory, 'state.json'), '{"schema":1,"quotes":{},"swaps":{}}');
    const before = await readFile(join(directory, 'state.json'), 'utf8');
    await assertStateScope(directory, scope);
    await assert.rejects(assertStateScope(directory, { ...scope, deploymentId: 'lab-b' }), /STATE_SCOPE_MISMATCH/);
    await assert.rejects(assertStateScope(directory, { ...scope, wallet: 'wallet-b' }), /STATE_SCOPE_MISMATCH/);
    await assert.rejects(assertStateScope(directory, { ...scope, bitcoinOrigin: 'http://127.0.0.1:18444' }), /STATE_SCOPE_MISMATCH/);
    await assert.rejects(assertStateScope(directory, { ...scope, providerNode: '02' + '22'.repeat(32) }), /STATE_SCOPE_MISMATCH/);
    assert.equal(await readFile(join(directory, 'state.json'), 'utf8'), before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('competing scopes cannot overwrite the winning marker and simulation cannot open a regtest journal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'swap-scope-race-'));
  try {
    const second = { ...scope, deploymentId: 'lab-b' };
    const results = await Promise.allSettled([assertStateScope(directory, scope), assertStateScope(directory, second)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    const winner = JSON.parse(await readFile(join(directory, '.environment.json'), 'utf8'));
    assert.ok([scope.deploymentId, second.deploymentId].includes(winner.deploymentId));

    await writeFile(join(directory, 'state.json'), '{"schema":1,"quotes":{},"swaps":{}}');
    const simulation = { environment: 'simulation', deploymentId: 'simulation', genesisHash: null, wallet: '' };
    await assert.rejects(assertStateScope(directory, simulation), /STATE_SCOPE_MISMATCH/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('legacy journals require explicit offline-regtest migration before any reuse', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'swap-scope-legacy-'));
  try {
    await writeFile(join(directory, 'state.json'), '{"schema":1,"quotes":{},"swaps":{}}');
    const original = await readFile(join(directory, 'state.json'), 'utf8');
    await assert.rejects(assertStateScope(directory, scope), /STATE_SCOPE_MIGRATION_REQUIRED/);
    assert.equal(await readFile(join(directory, 'state.json'), 'utf8'), original);
    await assert.rejects(assertStateScope(directory, { ...scope, environment: 'mainnet' },
      { allowLegacyOfflineMigration: true }), /STATE_SCOPE_MIGRATION_REGTEST_ONLY/);
    await assertStateScope(directory, scope, { allowLegacyOfflineMigration: true });
    assert.equal(await readFile(join(directory, 'state.json'), 'utf8'), original);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
