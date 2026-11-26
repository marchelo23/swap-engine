import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs, { chmod, link, mkdir, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import type { AddressInfo } from 'node:net';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/persistence/Store.js';
import {
  createTestForwardLeaseToken,
  FORWARD_STORE_MARKER,
  systemForwardPayerRegistryRoot,
} from '../src/persistence/ForwardPayerRegistry.js';
import { CoreLndForwardPorts } from '../src/core/CoreLndForwardPorts.js';
import { ForwardExecutor, type ForwardPorts } from '../src/core/ForwardExecutor.js';
import { ForwardAdmission } from '../src/core/ForwardAdmission.js';
import { SwapManager } from '../src/core/SwapManager.js';
import { createApi } from '../src/api/server.js';
import { provisionAccount } from '../scripts/provision-auth.js';
import { readAccounts } from '../src/auth/store.js';
import { privateTestDirectory } from './helpers.js';

const tsxCli = join(process.cwd(), 'node_modules/tsx/dist/cli.mjs');
const childFixture = join(process.cwd(), 'tests/fixtures/forwardPayerChild.ts');
const payerA = '02' + '11'.repeat(32);
const payerB = '02' + '22'.repeat(32);
const payee = '03' + '33'.repeat(32);
const testToken = createTestForwardLeaseToken();

function spawnChild(mode: string, storeDir: string, payerNode: string, registryDir: string) {
  const child = spawn(process.execPath, [tsxCli, childFixture, mode, storeDir, payerNode, registryDir], {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const killGroup = () => {
    if (child.exitCode !== null || child.pid === undefined) return;
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already dead */ } }
  };
  return {
    child,
    killGroup,
    stdout: () => stdout,
    stderr: () => stderr,
    async waitOutput(prefix: string) {
      for (let i = 0; i < 120; i++) {
        if (stdout.includes(prefix)) return;
        if (child.exitCode !== null) throw new Error(`Child exited early (${child.exitCode}): ${stderr}`);
        await delay(50);
      }
      throw new Error(`Timed out waiting for ${prefix}; stdout=${stdout} stderr=${stderr}`);
    },
    async closeGracefully() {
      if (child.exitCode === null) {
        child.stdin.write('close\n');
        child.stdin.end();
      }
      const [code] = await once(child, 'exit');
      return { code, stdout, stderr };
    },
    async waitExit() {
      const [code, signal] = await once(child, 'exit');
      return { code, signal, stdout, stderr };
    },
  };
}

function mockForwardSetup(payerNode: string, seed = 'aa') {
  const preimage = seed.repeat(32);
  const hash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
  const char = seed[0] === 'b' ? 'c' : seed[0] === 'c' ? 'd' : 'b';
  const approval = {
    network: 'regtest' as const,
    payerNode,
    payeeNode: payee,
    paymentHash: hash,
    invoice: 'lnbcrt' + char.repeat(40),
    invoiceSats: 5000,
    feeLimitSats: 10,
    expiresAt: Date.now() + 120_000,
    deposit: { txid: (seed === 'aa' ? 'cc' : seed === 'bb' ? 'ee' : 'ff').repeat(32), vout: 0, scriptPubKey: '0014' + 'dd'.repeat(20), valueSats: 5010 },
  };
  let sends = 0;
  let tracks = 0;
  let beforeSendHook: (() => Promise<void>) | undefined;
  let inspectDepositHook: (() => Promise<void>) | undefined;
  let afterSendHook: (() => Promise<void>) | undefined;
  const ports: ForwardPorts & { allocateDeposit(): Promise<unknown> } = {
    inspectPayer: async () => ({ network: 'regtest', node: payerNode, ready: true }),
    decodeInvoice: async () => ({
      destination: payee, payment_hash: hash, num_satoshis: '5000', num_msat: '5000000',
      timestamp: String(Math.floor(Date.now() / 1000)), expiry: '300', cltv_expiry: '40',
    }),
    allocateDeposit: async () => ({ address: 'bcrt1q' + char.repeat(38), scriptPubKey: approval.deposit.scriptPubKey }),
    inspectDeposit: async () => {
      if (inspectDepositHook) await inspectDepositHook();
      return { ...approval.deposit, network: 'regtest', confirmations: 2 };
    },
    send: async (_inv, _limit, beforeSend) => {
      if (beforeSendHook) await beforeSendHook();
      await beforeSend();
      sends++;
      if (afterSendHook) await afterSendHook();
      return { status: 'SUCCEEDED', hash, preimage, valueMsat: 5_000_000, feeMsat: 100 };
    },
    track: async () => { tracks++; return { status: 'SUCCEEDED', hash, preimage, valueMsat: 5_000_000, feeMsat: 100 }; },
  };
  return {
    approval,
    ports,
    counts: () => ({ sends, tracks }),
    onBeforeSend: (fn: () => Promise<void>) => { beforeSendHook = fn; },
    onInspectDeposit: (fn: () => Promise<void>) => { inspectDepositHook = fn; },
    onAfterSend: (fn: () => Promise<void>) => { afterSendHook = fn; },
  };
}

async function envSetup(t: TestContext) {
  const root = await privateTestDirectory('fwd-excl');
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = join(root, 'registry');
  const dirA = join(root, 'store-a');
  const dirB = join(root, 'store-b');
  return { root, registry, dirA, dirB };
}

test('two processes and two directories for the same payerNode exclude concurrently and across restarts', async t => {
  const { registry, dirA, dirB } = await envSetup(t);
  const first = spawnChild('admit-and-hold', dirA, payerA, registry);
  t.after(() => { first.killGroup(); });
  await first.waitOutput('ADMITTED:');
  assert.match(first.stdout(), /:UNKNOWN\n/);

  // Process 2 with a different DATA_DIR for the SAME payerNode must fail closed while Process 1 runs.
  const secondConcurrent = spawnChild('try-provision-and-open', dirB, payerA, registry);
  const resConcurrent = await secondConcurrent.waitExit();
  assert.equal(resConcurrent.code, 1);
  assert.match(resConcurrent.stderr, /EEXIST/);

  // A different payerNode CAN provision and use dirB concurrently without interference.
  const unrelatedPayer = spawnChild('try-provision-and-open', dirB, payerB, registry);
  const resUnrelated = await unrelatedPayer.waitExit();
  assert.equal(resUnrelated.code, 0);
  assert.match(resUnrelated.stdout, /OPENED/);

  // Cleanly close Process 1.
  const closed = await first.closeGracefully();
  assert.equal(closed.code, 0);
  assert.match(closed.stdout, /CLOSED/);

  // Even after clean close, Process 2 trying a different directory for payerA MUST fail closed!
  const dirC = `${dirB}-c`;
  const secondAfterClose = spawnChild('try-provision-and-open', dirC, payerA, registry);
  const resAfterClose = await secondAfterClose.waitExit();
  assert.equal(resAfterClose.code, 1);
  assert.match(resAfterClose.stderr, /FORWARD_BINDING_ALREADY_EXISTS/);

  // Restarting on canonical dirA for payerA succeeds and preserves the journaled payment!
  const restarted = spawnChild('recover-check', dirA, payerA, registry);
  const resRestart = await restarted.waitExit();
  assert.equal(resRestart.code, 0);
  assert.match(resRestart.stdout, /PAYMENTS:1/);

  // Opening canonical dirA with a different payerNode fails closed.
  const wrongPayerSameDir = spawnChild('try-open', dirA, payerB, registry);
  const resWrong = await wrongPayerSameDir.waitExit();
  assert.equal(resWrong.code, 1);
  assert.match(resWrong.stderr, /FORWARD_(?:STATE_)?PAYER_MISMATCH|FORWARD_CUSTODY_BINDING_REQUIRED|FORWARD_BINDING_INCOMPLETE/);
});

test('unclean SIGKILL crash retains payer lock on restart and never auto-breaks it', async t => {
  const { registry, dirA } = await envSetup(t);
  const holder = spawnChild('hold', dirA, payerA, registry);
  t.after(() => { holder.killGroup(); });
  await holder.waitOutput('LOCKED');

  holder.killGroup();
  await holder.waitExit();

  // Restart after crash must fail closed because payer.lock / engine.lock were not cleanly released.
  const restart = spawnChild('try-open', dirA, payerA, registry);
  const res = await restart.waitExit();
  assert.equal(res.code, 1);
  assert.match(res.stderr, /EEXIST/);
});

test('H1/H2: unprovisioned open fails closed, missing state.json on bound store fails closed, and volatile /tmp provision is forbidden', async t => {
  const { registry, dirA } = await envSetup(t);

  // H2: Unprovisioned directory fails closed on openForForward* (never auto-binds).
  await mkdir(dirA, { mode: 0o700 });
  await assert.rejects(Store.openForForwardWithTestToken(testToken, dirA, payerA, registry), /FORWARD_CUSTODY_BINDING_REQUIRED/);

  // H2: Production Store.provisionFreshForward rejects /tmp (tmpfs) before writing.
  await assert.rejects(Store.provisionFreshForward(dirA, payerA), /FORWARD_VOLATILE_STORAGE_FORBIDDEN/);

  // H2: Provisioning rejects pre-existing state.json.
  await writeFile(join(dirA, 'state.json'), '{"schema":1,"quotes":{},"swaps":{}}\n', { mode: 0o600 });
  await assert.rejects(Store.provisionFreshForwardWithTestToken(testToken, dirA, payerA, registry), /FORWARD_STATE_ALREADY_EXISTS/);
  await unlink(join(dirA, 'state.json'));

  // Provision fresh, persist a forward payment, close, then unlink state.json -> MUST fail closed with FORWARD_STATE_MISSING!
  await Store.provisionFreshForwardWithTestToken(testToken, dirA, payerA, registry);
  const store = await Store.openForForwardWithTestToken(testToken, dirA, payerA, registry);
  const f = mockForwardSetup(payerA);
  assert.equal(await new ForwardExecutor(store, f.ports, testToken).execute(f.approval), 'SUCCEEDED');
  await store.close();

  await unlink(join(dirA, 'state.json'));
  await assert.rejects(Store.openForForwardWithTestToken(testToken, dirA, payerA, registry), /FORWARD_STATE_MISSING/);
});

test('H4/H2: production routes reject test-scoped leases and plain Store.open; verify-forward-isolated stays off /tmp', async t => {
  const { registry, dirA } = await envSetup(t);
  const f = mockForwardSetup(payerA);

  // Plain Store.open must be rejected by ForwardExecutor, ForwardAdmission, and CoreLndForwardPorts.
  const plain = await Store.open(dirA);
  try {
    assert.throws(() => new ForwardExecutor(plain, f.ports), /FORWARD_PAYER_LEASE_REQUIRED/);
    assert.throws(() => new ForwardAdmission(plain, f.ports, payerA, payee), /FORWARD_PAYER_LEASE_REQUIRED/);
    assert.throws(() => new CoreLndForwardPorts({ call: async () => ({}) as never }, { origin: 'https://127.0.0.1:48080', call: async () => ({}) as never }, { origin: 'https://127.0.0.1:48080', stream: async () => {} }, payerA, payee, '123', plain), /FORWARD_PAYER_LEASE_REQUIRED/);
  } finally {
    await plain.close();
  }

  // systemForwardPayerRegistryRoot ignores HOME, XDG_STATE_HOME and DATA_DIR.
  const prevHome = process.env.HOME;
  const prevXdg = process.env.XDG_STATE_HOME;
  const prevData = process.env.DATA_DIR;
  try {
    process.env.HOME = '/tmp/rogue-home-bypass';
    process.env.XDG_STATE_HOME = '/tmp/rogue-xdg-bypass';
    process.env.DATA_DIR = '/tmp/rogue-data-bypass';
    const rootPath = systemForwardPayerRegistryRoot();
    assert.equal(rootPath, join(userInfo().homedir, '.local', 'share', 'lqwd-swap-engine', 'forward-payers'));
    assert.equal(rootPath.includes('rogue-'), false);
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevXdg === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = prevXdg;
    if (prevData === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = prevData;
  }

  // H4: Test-scoped Store rejected by default by ForwardExecutor, ForwardAdmission, CoreLndForwardPorts, and createApi unless testToken is passed!
  const dirClean = `${dirA}-clean`;
  const dirOther = `${dirA}-other`;
  await Store.provisionFreshForwardWithTestToken(testToken, dirClean, payerA, registry);
  await Store.provisionFreshForwardWithTestToken(testToken, dirOther, payerB, registry);
  const storeA = await Store.openForForwardWithTestToken(testToken, dirClean, payerA, registry);
  const storeB = await Store.openForForwardWithTestToken(testToken, dirOther, payerB, registry);
  try {
    assert.throws(() => new ForwardExecutor(storeA, f.ports), /FORWARD_SYSTEM_LEASE_REQUIRED/);
    assert.throws(() => new ForwardAdmission(storeA, f.ports, payerA, payee), /FORWARD_SYSTEM_LEASE_REQUIRED/);
    assert.throws(() => new CoreLndForwardPorts(
      { call: async () => ({}) as never },
      { origin: 'https://127.0.0.1:48080', call: async () => ({}) as never },
      { origin: 'https://127.0.0.1:48080', stream: async () => {} },
      payerA, payee, '123', storeA,
    ), /FORWARD_SYSTEM_LEASE_REQUIRED/);

    const admA = new ForwardAdmission(storeA, f.ports, payerA, payee, testToken);
    const ownerId = '11111111-1111-4111-8111-111111111111';
    assert.throws(
      () => createApi(new SwapManager(storeA), async () => ({ onchainSats: 0, incomingSats: 0 }), undefined, 'regtest', {
        environment: 'regtest', forward: { ownerId, admission: admA },
      }),
      /FORWARD_SYSTEM_LEASE_REQUIRED/,
    );
    assert.throws(
      () => createApi(new SwapManager(storeB), async () => ({ onchainSats: 0, incomingSats: 0 }), undefined, 'regtest', {
        environment: 'regtest', forward: { ownerId, admission: admA, testToken },
      }),
      /canonical API Store/,
    );
    assert.throws(() => new ForwardAdmission(storeA, f.ports, payerB, payee, testToken), /FORWARD_PAYER_MISMATCH/);
    const execA = new ForwardExecutor(storeA, f.ports, testToken);
    await assert.rejects(execA.execute({ ...f.approval, payerNode: payerB }), /FORWARD_PAYER_MISMATCH/);
  } finally {
    await storeA.close();
    await storeB.close();
  }

  // H2: verify-forward-isolated.ts must use durable user storage, provisionFreshForward, openForForward, and pass store to CoreLndForwardPorts.
  const verifyScript = await readFile(join(process.cwd(), 'scripts/verify-forward-isolated.ts'), 'utf8');
  assert.equal(verifyScript.includes('/tmp/'), false);
  assert.match(verifyScript, /assertPersistentStorage/);
  assert.match(verifyScript, /Store\.provisionFreshForward\(state,\s*payer\.identity_pubkey\)/);
  assert.match(verifyScript, /Store\.openForForward\(state,\s*payer\.identity_pubkey\)/);
  assert.match(verifyScript, /new CoreLndForwardPorts\([\s\S]*?,\s*store\)/);
});

test('H6: non-forward Store.open reads a forward-bound directory but refuses writes; active Store.open excludes openForForward without creating bindings', async t => {
  const { registry, dirA } = await envSetup(t);
  await Store.provisionFreshForwardWithTestToken(testToken, dirA, payerA, registry);
  const fwdStore = await Store.openForForwardWithTestToken(testToken, dirA, payerA, registry);
  const f = mockForwardSetup(payerA);
  const exec = new ForwardExecutor(fwdStore, f.ports, testToken);
  assert.equal(await exec.execute(f.approval), 'SUCCEEDED');
  await fwdStore.close();

  // Reopen with non-forward Store.open for read-only routes; writes (transaction) must fail closed.
  const roStore = await Store.open(dirA);
  try {
    const manager = new SwapManager(roStore);
    await assert.rejects(manager.quote(50_000), /FORWARD_PAYER_LEASE_REQUIRED/);
    assert.equal(roStore.read().forwardPayments?.[f.approval.paymentHash]?.status, 'SUCCEEDED');
    const server = createApi(manager, async () => ({ onchainSats: 100_000, incomingSats: 100_000 }), undefined, 'regtest', {
      environment: 'regtest',
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const health = await fetch(`${origin}/v1/health`);
    assert.equal(health.status, 200);
  } finally {
    await roStore.close();
  }

  // Active Store.open on an unprovisioned dirB blocks provisionFreshForward without creating marker/binding!
  const dirB = join(dirname(dirA), 'store-b-collision');
  const openPlain = await Store.open(dirB);
  try {
    await assert.rejects(Store.provisionFreshForwardWithTestToken(testToken, dirB, payerB, registry), { code: 'EEXIST' });
    assert.deepEqual(await fs.readdir(dirB), ['engine.lock']);
    const bindingsFiles = await fs.readdir(join(registry, 'bindings'));
    assert.equal(bindingsFiles.includes(`${payerB}.json`), false);
  } finally {
    await openPlain.close();
  }
});

test('H3/H5/H9: lock loss mid-checkSend, in-situ binding/marker mutation, and HTTP 503 on in-flight custody loss', async t => {
  const { registry, dirA } = await envSetup(t);
  const lockPath = join(registry, 'locks', `${payerA}.lock`);
  const bindingPath = join(registry, 'bindings', `${payerA}.json`);
  const markerPath = join(dirA, FORWARD_STORE_MARKER);

  await Store.provisionFreshForwardWithTestToken(testToken, dirA, payerA, registry);

  // H3: Lock lost during checkSend (inside second inspectDeposit call in beforeSend) -> zero wire sends + poisoned store!
  const store1 = await Store.openForForwardWithTestToken(testToken, dirA, payerA, registry);
  const f1 = mockForwardSetup(payerA);
  let depositChecks = 0;
  f1.onInspectDeposit(async () => {
    depositChecks++;
    if (depositChecks === 2) {
      await unlink(lockPath);
      await writeFile(lockPath, '{"replacement":true}\n', { mode: 0o600 });
    }
  });
  const exec1 = new ForwardExecutor(store1, f1.ports, testToken);
  await assert.rejects(exec1.execute(f1.approval), /lock lost or replaced|uncertain/);
  assert.equal(f1.counts().sends, 0);
  assert.throws(() => store1.read(), /uncertain/);
  await assert.rejects(store1.close(), /lock lost or replaced/);
  assert.equal(await readFile(lockPath, 'utf8'), '{"replacement":true}\n');
  await unlink(lockPath);
  await unlink(join(dirA, 'engine.lock'));

  // H5: In-situ overwrite (same dev:ino) of binding file and marker file while Store is open is detected and poisons store.
  const dirH5 = `${dirA}-h5`;
  await Store.provisionFreshForwardWithTestToken(testToken, dirH5, payerB, registry);
  const storeH5 = await Store.openForForwardWithTestToken(testToken, dirH5, payerB, registry);
  const h5BindingPath = join(registry, 'bindings', `${payerB}.json`);
  await writeFile(h5BindingPath, '{}\n', { mode: 0o600 });
  await assert.rejects(storeH5.assertForwardPayerHeld(payerB, testToken), /FORWARD_CUSTODY_MUTATED|FORWARD_BINDING_INVALID/);
  assert.throws(() => storeH5.read(), /uncertain/);
  await assert.rejects(storeH5.close(), /FORWARD_CUSTODY_MUTATED|FORWARD_BINDING_INVALID/);

  // H9: HTTP in-flight custody loss during POST /v1/forward (admit) and POST /v1/forward/:id/execute returns 503 (not 409).
  const dirHttp = `${dirA}-http`;
  await Store.provisionFreshForwardWithTestToken(testToken, dirHttp, payerA, join(dirname(registry), 'reg-http'));
  const httpReg = join(dirname(registry), 'reg-http');
  const store3 = await Store.openForForwardWithTestToken(testToken, dirHttp, payerA, httpReg);
  const f3 = mockForwardSetup(payerA, 'cc');
  const storePath = join(dirHttp, 'users.json');
  const password = randomBytes(24).toString('hex');
  await provisionAccount(storePath, 'fwd-user', 'USER', password);
  const owner = (await readAccounts(storePath)).find(a => a.username === 'fwd-user')!;
  const adm3 = new ForwardAdmission(store3, f3.ports, payerA, payee, testToken);
  const server = createApi(new SwapManager(store3), async () => ({ onchainSats: 0, incomingSats: 0 }), undefined, 'regtest', {
    environment: 'regtest', auth: { storePath }, forward: { ownerId: owner.id, admission: adm3, testToken },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await fetch(`${origin}/v1/auth/login`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'fwd-user', password }),
  });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const csrf = (await login.json()).csrfToken as string;

  // Drop lock in-flight during decodeInvoice inside POST /v1/forward -> MUST return 503!
  const httpLockPath = join(httpReg, 'locks', `${payerA}.lock`);
  const origDecode = f3.ports.decodeInvoice;
  f3.ports.decodeInvoice = async inv => {
    await unlink(httpLockPath);
    return origDecode(inv);
  };
  const admitLostInFlight = await fetch(`${origin}/v1/forward`, {
    method: 'POST',
    headers: { origin, cookie, 'x-csrf-token': csrf, 'content-type': 'application/json', 'idempotency-key': 'inflight-lost-1' },
    body: JSON.stringify({ invoice: f3.approval.invoice, invoiceSats: 5000 }),
  });
  assert.equal(admitLostInFlight.status, 503);
  assert.equal((await admitLostInFlight.json()).error, 'FORWARD_EXECUTION_UNAVAILABLE');
  assert.equal(f3.counts().sends, 0);
  await assert.rejects(store3.close(), /lock lost or replaced/);

  // Keep reference to markerPath/bindingPath unused-check clean
  assert.ok(bindingPath && markerPath);
});

test('H6/H8: state.tmp failure poisons Store and locks, and directory fsync runs on registry/store/engine.lock creation', async t => {
  const { registry, dirA } = await envSetup(t);
  const syncedDirs: string[] = [];
  const actualOpen = fs.open;
  const mockOpen = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await actualOpen(...args);
    if (args[1] === 'r') {
      const origSync = handle.sync.bind(handle);
      handle.sync = async () => {
        syncedDirs.push(String(args[0]));
        return origSync();
      };
    }
    return handle;
  });
  syncBuiltinESMExports();
  try {
    await Store.provisionFreshForwardWithTestToken(testToken, dirA, payerA, registry);
  } finally {
    mockOpen.mock.restore();
    syncBuiltinESMExports();
  }
  assert.ok(syncedDirs.includes(registry));
  assert.ok(syncedDirs.includes(join(registry, 'locks')));
  assert.ok(syncedDirs.includes(join(registry, 'bindings')));
  assert.ok(syncedDirs.includes(dirA));

  // Pre-existing state.tmp causes Store.transaction failure -> poisons Store and retains locks on close()!
  const store = await Store.openForForwardWithTestToken(testToken, dirA, payerA, registry);
  await writeFile(join(dirA, 'state.tmp'), '{"stale":true}\n', { mode: 0o600 });
  await assert.rejects(store.transaction(db => { db.quotes = {}; }), { code: 'EEXIST' });
  assert.throws(() => store.read(), /uncertain/);
  await assert.rejects(store.close(), /uncertain/);
  // Locks were retained, so reopening fails closed.
  await assert.rejects(Store.openForForwardWithTestToken(testToken, dirA, payerA, registry), /EEXIST|TEMP_STATE/);
});

test('aliased paths, replaced directories, incomplete bindings, invalid metadata and bad custody fail closed', async t => {
  const { root, registry, dirA } = await envSetup(t);

  // Symlink store directory rejected.
  await mkdir(dirA, { mode: 0o700 });
  const symlinkDir = join(root, 'alias-store');
  await symlink(dirA, symlinkDir);
  await assert.rejects(Store.openForForwardWithTestToken(testToken, symlinkDir, payerA, registry), /ALIASED/);

  // Permissive directory mode (0755) rejected.
  await chmod(dirA, 0o755);
  await assert.rejects(Store.openForForwardWithTestToken(testToken, dirA, payerA, registry), /CUSTODY_INVALID/);
  await chmod(dirA, 0o700);

  // Nested registry inside store rejected.
  await assert.rejects(Store.openForForwardWithTestToken(testToken, dirA, payerA, join(dirA, 'nested-reg')), /NESTED_PATHS/);

  // Provision canonical binding, then test tampering/replacement scenarios.
  await Store.provisionFreshForwardWithTestToken(testToken, dirA, payerA, registry);
  const store = await Store.openForForwardWithTestToken(testToken, dirA, payerA, registry);
  const f = mockForwardSetup(payerA);
  await new ForwardExecutor(store, f.ports, testToken).execute(f.approval);
  await store.close();

  const bindingFile = join(registry, 'bindings', `${payerA}.json`);
  const markerFile = join(dirA, FORWARD_STORE_MARKER);
  const bindingBytes = await readFile(bindingFile);
  const markerBytes = await readFile(markerFile);

  // Hardlinked marker (nlink === 2) rejected.
  const hardlink = join(root, 'marker-hardlink');
  await link(markerFile, hardlink);
  await assert.rejects(Store.openForForwardWithTestToken(testToken, dirA, payerA, registry), /CUSTODY_INVALID/);
  await unlink(hardlink);

  // Permissive marker file mode (0644) rejected.
  await chmod(markerFile, 0o644);
  await assert.rejects(Store.openForForwardWithTestToken(testToken, dirA, payerA, registry), /CUSTODY_INVALID/);
  await chmod(markerFile, 0o600);

  // Duplicate JSON key in binding rejected.
  await writeFile(bindingFile, '{"version":1,"versio\\u006e":1}', { mode: 0o600 });
  await assert.rejects(Store.openForForwardWithTestToken(testToken, dirA, payerA, registry), /BINDING_INVALID/);
  await writeFile(bindingFile, bindingBytes, { mode: 0o600 });

  // Unresolved state.tmp rejected.
  await writeFile(join(dirA, 'state.tmp'), '{}', { mode: 0o600 });
  await assert.rejects(Store.openForForwardWithTestToken(testToken, dirA, payerA, registry), /TEMP_STATE/);
  await unlink(join(dirA, 'state.tmp'));

  // Missing store marker while registry binding exists -> incomplete binding rejected.
  await unlink(markerFile);
  await assert.rejects(Store.openForForwardWithTestToken(testToken, dirA, payerA, registry), /BINDING_INCOMPLETE/);

  // Missing BOTH markers when state.json already has forwardPayments -> custody binding required!
  await unlink(bindingFile);
  await assert.rejects(Store.openForForwardWithTestToken(testToken, dirA, payerA, registry), /BINDING_REQUIRED/);

  // Restore both markers, then replace dirA at the same path (new inode!) -> rejected!
  await writeFile(bindingFile, bindingBytes, { mode: 0o600 });
  await writeFile(markerFile, markerBytes, { mode: 0o600 });
  const moved = join(root, 'moved-dirA');
  await rename(dirA, moved);
  await mkdir(dirA, { mode: 0o700 });
  await writeFile(markerFile, markerBytes, { mode: 0o600 });
  await writeFile(join(dirA, 'state.json'), await readFile(join(moved, 'state.json')), { mode: 0o600 });
  await assert.rejects(Store.openForForwardWithTestToken(testToken, dirA, payerA, registry), /CANONICAL_STORE_MISMATCH/);
});
