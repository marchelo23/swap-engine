import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, chmod, lstat, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readinessFixture } from './readinessFixture.js';
import { Store } from '../src/persistence/Store.js';
import { SecretVault } from '../src/persistence/SecretVault.js';
import { preparationDigest, type PreparationSpec } from '../src/core/ReversePreparation.js';
import { BitcoinConfirmationLookup } from '../src/bitcoin/BitcoinConfirmationLookup.js';
import { sha256 } from '../src/operator/OperatorFiles.js';
import { verifyCustodyBackup } from '../src/operator/CustodyBackup.js';
import { coreActionMethods, type ActionInspection } from '../src/operator/NativeActionCredentials.js';
import { runOperatorCLI, type OperatorIO } from '../scripts/run-controlled-reverse.js';
import { createOperatorApi as createApi } from '../src/api/operatorServer.js';
import { SwapManager } from '../src/core/SwapManager.js';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

const linux = process.platform === 'linux'; const password = 'synthetic-operator-backup-passphrase';
async function lifecycleFixture() {
  const x = await readinessFixture(); const directory = join(x.f.directory, 'operator'); const backupDirectory = join(x.f.directory, 'backup');
  await mkdir(directory, { mode: 0o700 }); await mkdir(backupDirectory, { mode: 0o700 });
  const spec: PreparationSpec = { id: randomUUID(), isolationId: x.scope.isolationId, tipHeight: 100, wallet: 'lqwd-lab', providerNode: x.plan.providerNode,
    payerNode: x.plan.payerNode, routing: x.plan.routing, client: { paymentHash: x.keys.paymentHash, claimPublicKey: x.keys.claimPublicKey },
    refundPublicKey: x.keys.refundPublicKey, claimDestination: x.plan.claimDestination, refundDestination: x.plan.refundDestination,
    input: { ...x.input, valueSats: 100000 } };
  const client = await SecretVault.open(join(directory, 'client-secrets'), Buffer.from(password));
  const refund = await SecretVault.open(join(directory, 'provider-refund-keys'), Buffer.from(password));
  try { const material = Buffer.from(JSON.stringify({ privateKey: Buffer.from(x.f.claimKey.privateKey!).toString('hex'), preimage: x.f.preimage }));
    try { await client.create('client', spec.client.paymentHash, material); } finally { material.fill(0); }
    await refund.create('refund', spec.client.paymentHash, x.f.refundKey.privateKey!);
  } finally { client.close(); refund.close(); }
  for (const [dir, role] of [['client-secrets', 'client'], ['provider-refund-keys', 'refund']] as const) {
    await mkdir(join(backupDirectory, dir), { mode: 0o700 });
    await copyFile(join(directory, dir, `${role}-${spec.client.paymentHash}.vault`), join(backupDirectory, dir, `${role}-${spec.client.paymentHash}.vault`));
  }
  const store = await Store.open(join(directory, 'store'));
  await store.transaction(db => { Object.assign(db, x.f.store.read());
    (db.reversePreparations ??= {})[spec.id] = { specDigest: preparationDigest(spec), attemptId: randomUUID(), status: 'READY',
      plan: x.plan, swapId: x.f.swap.id, invoiceAttempt: { attemptId: randomUUID(), revision: 2, wireAuthorized: true } }; }); await store.close();
  const paths = { bitcoinCookiePath: join(directory, 'read.cookie'), providerCertPath: join(directory, 'ca.cert'),
    providerReadMacaroonPath: join(directory, 'read.macaroon'), payerCertPath: join(directory, 'ca.cert'), payerReadMacaroonPath: join(directory, 'read.macaroon') };
  const actions = { bitcoinActionAuthPath: join(directory, 'action.auth'), bitcoinConfigPath: join(directory, 'bitcoin.conf'), bitcoinPidPath: join(directory, 'pid'),
    providerSettleMacaroonPath: join(directory, 'settle.macaroon'), payerSendMacaroonPath: join(directory, 'pay.macaroon') };
  const specHash = sha256(Buffer.from(JSON.stringify(spec))); const backup = { directory: backupDirectory, specSha256: specHash, failureDomain: 'operator-reviewed-independent' as const };
  const actionHash = sha256(Buffer.from(JSON.stringify(actions))); const backupHash = sha256(Buffer.from(JSON.stringify(backup)));
  for (const [name, data] of [['spec.json', spec], ['credential-paths.json', paths], ['action-credential-paths.json', actions], ['custody-backup.json', backup]] as const)
    await writeFile(join(directory, name), JSON.stringify(data), { mode: 0o600, flag: 'wx' });
  let passwordReads = 0; let actionInspections = 0; let executions = 0; let lost = false;
  const inspected: ActionInspection = { core: { mode: 'dedicated-whitelist', dedicatedUser: true, methods: [...coreActionMethods], authFingerprint: 'ab'.repeat(32), configFingerprint: 'cd'.repeat(32), pid: '123', startTicks: '100' },
    settle: { role: 'settle', permissions: ['invoices:read', 'invoices:write'], fingerprint: '12'.repeat(32) },
    pay: { role: 'pay', permissions: ['offchain:read', 'offchain:write'], fingerprint: '34'.repeat(32) },
    providerCertFingerprint: '56'.repeat(32), payerCertFingerprint: '78'.repeat(32) };
  const info = async () => ({ chains: [{ chain: 'bitcoin', network: 'regtest' }], synced_to_chain: true });
  const policy = { wallet: spec.wallet, genesisHash: '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206',
    bitcoinOrigin: spec.routing.bitcoinOrigin, providerOrigin: spec.routing.providerOrigin, payerOrigin: spec.routing.payerOrigin,
    providerNode: spec.providerNode, payerNode: spec.payerNode, bitcoinCookiePath: paths.bitcoinCookiePath,
    providerCertPath: paths.providerCertPath, providerReadMacaroonPath: paths.providerReadMacaroonPath,
    payerCertPath: paths.payerCertPath, payerReadMacaroonPath: paths.payerReadMacaroonPath };
  const io: Partial<OperatorIO> = { policy, password: () => { passwordReads++; return Buffer.from(password); },
    clients: () => ({ bitcoin: { ...x.bitcoin, assertRegtest: async () => x.chain, confirmed: id => new BitcoinConfirmationLookup(x.bitcoin).confirmed(id) },
      provider: { ...x.provider, assertRegtest: info }, payer: { ...x.payer, assertRegtest: info },
      recoveryPayer: { ...x.payer, call: async <T>(path: string): Promise<T> => path.includes('/v1/payments?')
        ? { payments: [], first_index_offset: '0', last_index_offset: '0' } as T : x.payer.call<T>(path) },
      invoices: { origin: spec.routing.providerOrigin, lookup: async hash => ({ status: 'PRESENT' as const, invoice: await x.provider.lookup(hash) }) } }),
    inspectActions: async () => { actionInspections++; return inspected; },
    probeCore: async () => ({ regtestIdentity: true, unlistedReadDenied: true }),
    executor: current => ({ async execute(context) {
      executions++; context.guard(); assert.deepEqual(context.input, x.input); assert.equal(context.plan.quote.invoiceSats, 50750);
      assert.equal(context.plan.fundingFeeLimitSats, 1000); assert.equal(context.plan.quote.claimFeeSats, 500);
      const disk = JSON.parse(await readFile(join(directory, 'store/state.json'), 'utf8'));
      assert.equal(Object.values(disk.jitExecutions).length, 1);
      assert.equal((Object.values(disk.jitExecutions)[0] as { status: string }).status, 'EXECUTING');
      if (lost) throw Error('lost synthetic payment result');
      await current.transaction(db => { const swap = db.swaps[x.f.swap.id]!; swap.state = 'COMPLETED'; swap.revision++;
        (db.controlledExecutions ??= {})[context.approval.id] = { swapId: swap.id, planDigest: context.approval.planDigest,
          isolationId: spec.isolationId, status: 'COMPLETED', blocksRequested: 2 }; });
      return { id: x.f.swap.id, state: 'COMPLETED', revision: current.read().swaps[x.f.swap.id]!.revision };
    }, stopClient() {} }) };
  const args = (mode: 'review' | 'check' | 'execute' | 'reconcile', tail: string[] = []) => [
    ({ review: '--review-jit-only', check: '--check-runtime-only', execute: '--execute-jit', reconcile: '--reconcile-only' })[mode],
    '--run-dir', directory, '--spec-sha256', specHash,
    ...(['check', 'execute'].includes(mode) ? ['--action-config-sha256', actionHash, '--backup-config-sha256', backupHash] : []), ...tail];
  const authorize = async () => {
    const review = await runOperatorCLI(args('review'), io) as { termsDigest: string };
    const auth = { specSha256: specHash, actionConfigSha256: actionHash, backupConfigSha256: backupHash,
      authorization: { id: randomUUID(), termsDigest: review.termsDigest, scope: 'isolated-regtest-one-requote-and-execute',
        issuedAt: Date.now(), startBefore: Date.now() + 300000, maxBlocks: 2, quoteLifetimeMs: 120000, executionWindowMs: 90000 } };
    const bytes = Buffer.from(JSON.stringify(auth)); await writeFile(join(directory, 'jit-authorization.json'), bytes, { mode: 0o600, flag: 'wx' });
    return { auth, args: args('execute', ['--authorization-sha256', sha256(bytes)]) };
  };
  return { x, directory, backupDirectory, spec, backup, args, io, authorize, inspected,
    passwordReads: () => passwordReads, actionInspections: () => actionInspections, executions: () => executions,
    lose: () => { lost = true; }, db: async () => JSON.parse(await readFile(join(directory, 'store/state.json'), 'utf8')),
    unlocked: () => assert.rejects(lstat(join(directory, 'store/engine.lock')), { code: 'ENOENT' }), cleanup: x.f.cleanup };
}

test('Linux native loader reviews and checks restored backup without action authority or state changes', { skip: !linux }, async () => {
  const f = await lifecycleFixture(); try {
    const before = await readFile(join(f.directory, 'store/state.json'));
    const review = await runOperatorCLI(f.args('review'), f.io) as { executionApproved: boolean };
    assert.equal(review.executionApproved, false); assert.equal(f.actionInspections(), 0);
    const check = await runOperatorCLI(f.args('check'), f.io) as { status: string; restored: { restored: boolean } };
    assert.equal(check.status, 'RUNTIME_CHECKED_NOT_AUTHORIZED'); assert.equal(check.restored.restored, true);
    assert.deepEqual(await readFile(join(f.directory, 'store/state.json')), before); assert.equal(f.executions(), 0); await f.unlocked();
    assert.equal(JSON.stringify(check).includes(f.x.f.preimage), false); assert.equal(JSON.stringify(check).includes(password), false);
  } finally { await f.cleanup(); }
});

test('native loader exact execution requires all approved hashes and an independently restored encrypted copy, then refuses restart', { skip: !linux }, async () => {
  const f = await lifecycleFixture(); try {
    const authority = await f.authorize(); const result = await runOperatorCLI(authority.args, f.io) as { state: string };
    assert.equal(result.state, 'COMPLETED'); assert.equal(f.executions(), 1); await f.unlocked();
    await assert.rejects(runOperatorCLI(authority.args, f.io)); assert.equal(f.executions(), 1); await f.unlocked();
  } finally { await f.cleanup(); }
});

test('native loader rejects unsafe files, mismatched hashes, stale authority and corrupt or colocated backups before any execution', { skip: !linux }, async () => {
  for (const point of ['mode', 'hash', 'expired', 'backup', 'colocated']) {
    const f = await lifecycleFixture(); try {
      const authority = await f.authorize(); const passwords = f.passwordReads();
      if (point === 'mode') await chmod(join(f.directory, 'jit-authorization.json'), 0o644);
      if (point === 'hash') authority.args[10] = '00'.repeat(32);
      if (point === 'expired') { const bytes = Buffer.from(JSON.stringify({ ...authority.auth, authorization: { ...authority.auth.authorization, issuedAt: 1, startBefore: 2 } }));
        await writeFile(join(f.directory, 'jit-authorization.json'), bytes); authority.args[10] = sha256(bytes); }
      if (point === 'backup') await writeFile(join(f.backupDirectory, 'client-secrets', `client-${f.spec.client.paymentHash}.vault`), 'corrupt');
      if (point === 'colocated') { const bytes = Buffer.from(JSON.stringify({ ...f.backup, directory: f.directory }));
        await writeFile(join(f.directory, 'custody-backup.json'), bytes); authority.args[8] = sha256(bytes); }
      await assert.rejects(runOperatorCLI(authority.args, f.io)); assert.equal(f.executions(), 0); await f.unlocked();
      if (['mode', 'hash', 'expired', 'colocated'].includes(point)) assert.equal(f.passwordReads(), passwords);
    } finally { await f.cleanup(); }
  }
});

test('unknown native execution can only reconcile using read credentials and never needs password or action inspection', { skip: !linux }, async () => {
  const f = await lifecycleFixture(); try {
    const authority = await f.authorize(); f.lose(); await assert.rejects(runOperatorCLI(authority.args, f.io));
    const db = await f.db(); assert.equal(db.jitExecutions[authority.auth.authorization.id].status, 'UNKNOWN');
    const passwords = f.passwordReads(); const inspections = f.actionInspections();
    const result = await runOperatorCLI(f.args('reconcile', ['--jit-id', authority.auth.authorization.id, '--expected-revision', String(db.swaps[f.x.f.swap.id].revision)]), f.io) as { next: string };
    assert.equal(result.next, 'MANUAL_REVIEW'); assert.equal(f.passwordReads(), passwords); assert.equal(f.actionInspections(), inspections);
    assert.equal(f.executions(), 1); await assert.rejects(runOperatorCLI(authority.args, f.io)); assert.equal(f.executions(), 1);
  } finally { await f.cleanup(); }
});

test('encrypted backup restoration rejects wrong passwords and authentication damage without rewriting custody', { skip: !linux }, async () => {
  const f = await lifecycleFixture(); try {
    const path = join(f.backupDirectory, 'client-secrets', `client-${f.spec.client.paymentHash}.vault`); const before = await readFile(path);
    await assert.rejects(verifyCustodyBackup(f.directory, f.spec, f.backup, Buffer.from('wrong-synthetic-password')));
    assert.deepEqual(await readFile(path), before);
    const result = await verifyCustodyBackup(f.directory, f.spec, f.backup, Buffer.from(password)); assert.equal(result.restored, true);
    assert.equal(result.physicalIndependence, 'OPERATOR_ASSERTION_NOT_AUTOMATICALLY_PROVEN');
    assert.equal((await verifyCustodyBackup(f.directory, f.spec, { ...f.backup, failureDomain: 'isolated-regtest-local-restorable' }, Buffer.from(password))).physicalIndependence,
      'LOCAL_REGTEST_COPY_SAME_FAILURE_DOMAIN');
    assert.deepEqual(await readFile(path), before);
  } finally { await f.cleanup(); }
});

test('canceled retained invoice cannot be revived by native review, readiness or a fresh operator authorization', { skip: !linux }, async () => {
  const f = await lifecycleFixture(); try {
    const authority = await f.authorize(); const before = await f.db(); f.x.invoiceWire.state = 'CANCELED';
    await assert.rejects(runOperatorCLI(f.args('review'), f.io));
    await assert.rejects(runOperatorCLI(f.args('check'), f.io));
    await assert.rejects(runOperatorCLI(authority.args, f.io));
    assert.equal(f.executions(), 0); assert.deepEqual(await f.db(), before); await f.unlocked();
  } finally { await f.cleanup(); }
});

test('operator shutdown retains the single-writer lock until a timed-out executor finishes uncertainty journaling', { skip: !linux }, async t => {
  const f = await lifecycleFixture(); try {
    const authority = await f.authorize(); t.mock.timers.enable({ apis: ['setTimeout'] });
    let entered!: () => void; let journaled!: () => void; let release!: () => void; let settled = false;
    const ready = new Promise<void>(resolve => { entered = resolve; }); const persisted = new Promise<void>(resolve => { journaled = resolve; });
    const finish = new Promise<void>(resolve => { release = resolve; });
    f.io.executor = current => {
      const transaction = current.transaction.bind(current);
      t.mock.method(current, 'transaction', async (fn: Parameters<typeof transaction>[0]) => {
        const result = await transaction(fn);
        if (current.read().jitExecutions?.[authority.auth.authorization.id]?.status === 'UNKNOWN') journaled(); return result;
      });
      return { async execute(context) {
        context.guard(); entered(); await finish;
        await current.transaction(db => { db.swaps[f.x.f.swap.id]!.clientPayment = {
          hash: f.spec.client.paymentHash, status: 'UNKNOWN', feeLimitSats: 100 }; });
        throw Error('late uncertainty journal completed');
      }, stopClient() {} };
    };
    const pending = runOperatorCLI(authority.args, f.io); void pending.then(() => { settled = true; }, () => { settled = true; });
    await ready; t.mock.timers.tick(90001); await persisted; await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false); await assert.rejects(Store.open(join(f.directory, 'store')), { code: 'EEXIST' });
    release(); await assert.rejects(pending); await f.unlocked();
    const reopened = await Store.open(join(f.directory, 'store'));
    try { assert.equal(reopened.read().swaps[f.x.f.swap.id]!.clientPayment!.status, 'UNKNOWN'); }
    finally { await reopened.close(); }
  } finally { await f.cleanup(); }
});

test('native owner handoff uses existing sessions, exact JIT approval and read-only restart without duplicate execution', { skip: !linux }, async () => {
  const f = await lifecycleFixture(); try {
    const authority = await f.authorize(); const origin = 'http://localhost:3000';
    const ui = Buffer.from(JSON.stringify({ ownerId: 'alice', origin, port: 12345 }));
    await writeFile(join(f.directory, 'ui-access.json'), ui, { mode: 0o600, flag: 'wx' });
    const args = ['--serve-jit', ...authority.args.slice(1), '--ui-config-sha256', sha256(ui)];
    const passwords = f.passwordReads(); await assert.rejects(runOperatorCLI(args, f.io));
    assert.equal(f.passwordReads(), passwords); assert.equal(f.executions(), 0);
    const session = { account: { id: 'alice', role: 'USER' } };
    f.io.sessions = { get: async req => req.headers.cookie === 'swap_session=synthetic' ? session : undefined,
      verifyCsrf: req => req.headers.origin === origin && req.headers['x-csrf-token'] === 'synthetic-csrf' };
    let statusOnly = false;
    f.io.serve = async (store, owned) => {
      const server = createApi(new SwapManager(store), async () => { throw Error('No global balances'); }, undefined, undefined, undefined, owned);
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const headers = { cookie: 'swap_session=synthetic', origin, 'x-csrf-token': 'synthetic-csrf', 'content-type': 'application/json', 'idempotency-key': 'native-ui-click' };
      try {
        const status = await (await fetch(url + `/v1/swaps/${f.x.f.swap.id}`, { headers })).json();
        assert.equal(status.allowedActions.includes('EXECUTE'), !statusOnly);
        if (!statusOnly) {
          const path = url + '/v1/swaps/reverse'; const data = JSON.stringify({ preparedSwapId: status.id, expectedRevision: status.revision });
          const first = await fetch(path, { method: 'POST', headers, body: data }); assert.equal(first.status, 200);
          const receipt = await first.json(); assert.equal(receipt.result.state, 'COMPLETED');
          assert.deepEqual(await (await fetch(path, { method: 'POST', headers, body: data })).json(), receipt);
        } else assert.equal(status.execution.status, 'COMPLETED');
      } finally { await new Promise<void>(r => server.close(() => r())); await owned.drain(); }
      return { status: 'TEST_GATEWAY_STOPPED' };
    };
    await runOperatorCLI(args, f.io); assert.equal(f.executions(), 1); await f.unlocked();
    const reads = f.passwordReads(); const inspections = f.actionInspections(); statusOnly = true;
    await runOperatorCLI(['--serve-status-only', ...f.args('review').slice(1), '--ui-config-sha256', sha256(ui)], f.io);
    assert.equal(f.passwordReads(), reads); assert.equal(f.actionInspections(), inspections); assert.equal(f.executions(), 1); await f.unlocked();
    await assert.rejects(runOperatorCLI(args, f.io)); assert.equal(f.executions(), 1);
  } finally { await f.cleanup(); }
});
