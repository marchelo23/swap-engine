import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateTestDirectory } from './helpers.js';
import { MiningLockBusyError, withMiningLock } from '../src/mining/MiningLock.js';

const linux = process.platform === 'linux';

async function miner(lockFile: string) {
  const child = spawn('flock', ['-n', lockFile, 'sh', '-c', "printf 'mined\\n'"], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', chunk => { output += chunk.toString(); }); child.stderr.resume();
  const [code] = await once(child, 'exit');
  return { code, output };
}

async function startFlockHolder(lockFile: string): Promise<ChildProcess> {
  const child = spawn('flock', ['-n', lockFile, 'sleep', '30'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  child.stdout.resume(); child.stderr.resume();
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw new Error('flock holder exited before acquiring');
    try { await withMiningLock(async () => {}, { lockFile }); }
    catch (error) { if (error instanceof MiningLockBusyError) return child; throw error; }
    await delay(50);
  }
  throw new Error('flock holder did not acquire');
}

function waitExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return once(child, 'exit').then(() => {});
}

async function stopHolder(child: ChildProcess) {
  if (child.exitCode !== null || child.pid === undefined) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  await waitExit(child).catch(() => {});
}

async function waitUntilFree(lockFile: string) {
  for (let attempt = 0; attempt < 80; attempt++) {
    let ran = false;
    try { await withMiningLock(async () => { ran = true; }, { lockFile }); }
    catch (error) { if (!(error instanceof MiningLockBusyError)) throw error; }
    if (ran) return;
    await delay(50);
  }
  throw new Error('kernel lock was not released');
}

test('timer and on-demand style mining cannot acquire the lock while execution holds it', { skip: !linux }, async () => {
  const directory = await privateTestDirectory('mining-lock'); const lockFile = join(directory, 'miner.lock');
  try {
    await withMiningLock(async () => {
      for (const mode of ['--once', '--on-demand']) {
        const result = await miner(lockFile);
        assert.notEqual(result.code, 0, `${mode} miner acquired a held lock`);
        assert.equal(result.output.includes('mined'), false);
      }
    }, { lockFile });
    const free = await miner(lockFile); assert.equal(free.code, 0); assert.ok(free.output.includes('mined'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the acquisition helper exits before the work and the descriptor keeps the flock', { skip: !linux }, async () => {
  const directory = await privateTestDirectory('mining-lock'); const lockFile = join(directory, 'miner.lock');
  try {
    const handle = await open(lockFile, 'a+', 0o600);
    try {
      const helper = spawn('flock', ['-n', '3'], { stdio: ['ignore', 'ignore', 'ignore', handle.fd] });
      const [code] = await once(helper, 'exit');
      assert.equal(code, 0); assert.notEqual(helper.exitCode, null);
      const blocked = await miner(lockFile);
      assert.notEqual(blocked.code, 0); assert.equal(blocked.output.includes('mined'), false);
    } finally { await handle.close(); }
    const free = await miner(lockFile); assert.equal(free.code, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('execution cannot proceed while a miner holds the lock, then recovers after crash', { skip: !linux }, async () => {
  const directory = await privateTestDirectory('mining-lock'); const lockFile = join(directory, 'miner.lock');
  const holder = await startFlockHolder(lockFile);
  try {
    let ran = false;
    await assert.rejects(withMiningLock(async () => { ran = true; }, { lockFile }),
      (error: unknown) => error instanceof MiningLockBusyError);
    assert.equal(ran, false);
  } finally { await stopHolder(holder); }
  try {
    let ran = false; await withMiningLock(async () => { ran = true; }, { lockFile }); assert.equal(ran, true);
    const free = await miner(lockFile); assert.equal(free.code, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a crashed execution process releases the kernel lock for the miner and next check', { skip: !linux }, async () => {
  const directory = await privateTestDirectory('mining-lock'); const lockFile = join(directory, 'miner.lock');
  try {
    const child = spawn(process.execPath, [join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'),
      join(process.cwd(), 'tests/fixtures/holdMiningLock.ts'), lockFile], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let ready = ''; child.stdout.on('data', chunk => { ready += chunk.toString(); }); child.stderr.resume();
    for (let attempt = 0; attempt < 100 && !ready.includes('locked'); attempt++) await delay(50);
    assert.ok(ready.includes('locked'), 'holder did not signal the acquired lock');
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    await waitExit(child).catch(() => {});
    await waitUntilFree(lockFile);
    const free = await miner(lockFile); assert.equal(free.code, 0); assert.ok(free.output.includes('mined'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
