import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readinessFixture } from './readinessFixture.js';
import { provisionAccount } from '../scripts/provision-auth.js';
import { readAccounts } from '../src/auth/store.js';
import { createOwnedRuntimeFactory, ownedRuntimePolicySchema, type OwnedNativeIO } from '../src/operator/OwnedPreparationRuntime.js';
import { recoveryPaymentsPath } from '../src/lightning/LndPayerRecovery.js';
import type { Invoice } from '../src/lightning/LndClient.js';
import { Store } from '../src/persistence/Store.js';
import { sha256 } from '../src/operator/OperatorFiles.js';
import { Transaction, address, networks } from 'bitcoinjs-lib';
import { buildHtlc } from '../src/bitcoin/HtlcBuilder.js';
import { ClaimWallet } from '../src/client/ClaimWallet.js';
import { SecretVault } from '../src/persistence/SecretVault.js';

const linux = process.platform === 'linux';
async function fixture(sourceAmountSats?: number) {
  const x = await readinessFixture(); const directory = x.f.directory;
  const runs = join(directory, 'runs'); const backups = join(directory, 'backups');
  await mkdir(runs, { mode: 0o700 }); await mkdir(backups, { mode: 0o700 });
  const password = join(directory, 'synthetic-password'); await writeFile(password, 'synthetic-owned-runtime-password', { mode: 0o600 });
  const accounts = join(directory, 'accounts.json'); await provisionAccount(accounts, 'truja503', 'ADMIN', 'synthetic-owned-admin-password');
  const owner = (await readAccounts(accounts))[0]!;
  const policy = ownedRuntimePolicySchema.parse({ mode: 'regtest', ownerId: owner.id, ownerUsername: 'truja503', authStorePath: accounts, wallet: 'lqwd-lab',
    origin: 'http://127.0.0.1:3201', port: 3201, runsDirectory: runs, backupsDirectory: backups, passwordPath: password,
    providerNode: x.plan.providerNode, payerNode: x.plan.payerNode, routing: x.plan.routing, claimDestination: x.plan.claimDestination, refundDestination: x.plan.refundDestination,
    credentialPaths: { bitcoinCookiePath: '/synthetic/cookie', providerCertPath: '/synthetic/provider.cert', providerReadMacaroonPath: '/synthetic/provider.read',
      providerInvoiceMacaroonPath: '/synthetic/provider.invoices', payerCertPath: '/synthetic/payer.cert', payerReadMacaroonPath: '/synthetic/payer.read' },
    actions: { coreMode: 'existing-regtest-cookie', bitcoinActionAuthPath: '/synthetic/cookie', providerSettleMacaroonPath: '/synthetic/provider.invoices', payerSendMacaroonPath: '/synthetic/payer.router' },
    amountSats: 50000, invoiceSats: 50750, fundingFeeLimitSats: 1000, routingFeeLimitSats: 100, claimFeeSats: 500, maxBlocks: 2, maxInputSats: 1000000 });
  let exists = false; let hash = ''; let creates = 0; let actions = 0; let inspections = 0; let clocks = 0; let lost = false; let ntp = true; let owns = true; let canceled = false;
  const paymentRequest = 'lnbcrt' + 'c'.repeat(30);
  let history: unknown = { payments: [], first_index_offset: '0', last_index_offset: '0' };
  const invoiceSats = sourceAmountSats ?? 50750;
  const invoice = (): Invoice => ({ state: canceled ? 'CANCELED' : 'OPEN', r_hash: Buffer.from(hash, 'hex').toString('base64'), value: String(invoiceSats), amt_paid_sat: '0', payment_request: paymentRequest, htlcs: [] });
  const confirmed = new Map<string, { hex: string; confirmations: number }>(); const blockHashes = new Map<number, string>();
  const bitcoin = { ...x.bitcoin,
    async call<T>(method: string, params: unknown[] = [], wallet = false): Promise<T> {
      if (method === 'getblockhash' && blockHashes.has(Number(params[0]))) return blockHashes.get(Number(params[0])) as T;
      return x.bitcoin.call<T>(method, params, wallet);
    },
    confirmed: async (id: string) => { const found = confirmed.get(id); if (!found) throw Error('Unavailable archive transaction'); return found; },
    assertRegtest: async () => x.chain };
  const provider = { ...x.provider, assertRegtest: async () => x.providerInfo, lookup: async (h: string) => { assert.equal(h, hash); if (!exists) throw Error('absent'); return invoice(); } };
  const payer = { ...x.payer, assertRegtest: async () => x.payerInfo,
    async call<T>(path: string): Promise<T> {
      if (path === '/v2/wallet/addresses?account_name=default') return { account_with_addresses: [{ addresses: owns ? [{ address: policy.claimDestination, is_internal: false }] : [] }] } as T;
      if (path === '/v1/payreq/' + paymentRequest) return { ...x.decoded, payment_hash: hash, num_satoshis: String(invoiceSats), num_msat: String(invoiceSats * 1000) } as T;
      return x.payer.call(path);
    } };
  const clients = { bitcoin, provider, payer,
    invoices: { origin: policy.routing.providerOrigin, async lookup(h: string) { return exists && h === hash ? { status: 'PRESENT', invoice: invoice() } : { status: 'ABSENT' }; },
      async create(request: { hash: string; sats: number }, guard: () => Promise<void>) {
        creates++; assert.equal(request.sats, invoiceSats); await guard(); hash = request.hash; exists = true;
        const attempt = (await import('node:fs/promises')).readdir(runs); const entries = await attempt;
        const db = JSON.parse(await readFile(join(runs, entries[0]!, 'store/state.json'), 'utf8'));
        assert.equal(Object.values<{ invoiceAttempt: { wireAuthorized: boolean } }>(db.reversePreparations)[0]!.invoiceAttempt.wireAuthorized, true);
        if (lost) throw Error('synthetic-lost-invoice-response'); return { payment_request: paymentRequest };
      } },
    recoveryPayer: { origin: policy.routing.payerOrigin, async call<T>(path: string): Promise<T> {
      if (path === recoveryPaymentsPath) return structuredClone(history) as T;
      assert.equal(path, '/v1/getinfo'); return x.payerInfo as T;
    } } };
  const io: Partial<OwnedNativeIO> = { clients: () => clients as unknown as ReturnType<OwnedNativeIO['clients']>,
    clock: async () => { clocks++; if (!ntp) throw Error('synthetic-unsynchronized-clock'); },
    inspect: async () => { inspections++; return { core: { mode: 'existing-regtest-cookie', dedicatedUser: false, methods: [], authFingerprint: 'ab'.repeat(32) },
      settle: { role: 'settle', permissions: ['invoices:read', 'invoices:write'], fingerprint: 'cd'.repeat(32) },
      pay: { role: 'pay', permissions: ['offchain:read', 'offchain:write'], fingerprint: 'ef'.repeat(32) }, providerCertFingerprint: 'aa'.repeat(32), payerCertFingerprint: 'bb'.repeat(32) }; },
    probe: async () => ({ regtestIdentity: true, unlistedReadDenied: false }),
    actions: () => { actions++; throw Error('No financial assembly during prepare/restart'); },
    executor: () => { actions++; throw Error('No execution during prepare/restart'); } };
  const factory = await createOwnedRuntimeFactory(policy, { get: async () => undefined, verifyCsrf: () => false }, io);
  const entry = { ownerId: owner.id, fingerprint: 'ab'.repeat(32), attemptId: randomUUID(), createdAt: Date.now(), status: 'INTENT' as const,
    ...(sourceAmountSats === undefined ? {} : { sourceAmountSats }) };
  return { x, factory, entry, runs, policy, io, counts: () => ({ creates, actions, inspections, clocks }),
    lose: () => { lost = true; }, cancel: () => { canceled = true; }, noClock: () => { ntp = false; }, foreignAddress: () => { owns = false; },
    history: (value: unknown) => { history = value; },
    recordConfirmed: (tx: Transaction, confirmations: number) => { confirmed.set(tx.getId(), { hex: tx.toHex(), confirmations }); },
    recordBlock: (height: number, hash: string) => { blockHashes.set(height, hash); },
    cleanup: async () => { await factory.close?.(); await x.f.cleanup(); } };
}

test('owned runtime binds selected debit into durable custody and restores it without another invoice', { skip: !linux }, async () => {
  const x = await fixture(50000);
  try {
    const runtime = await x.factory.prepare('ab'.repeat(32), x.entry);
    const view = runtime.api.list(x.entry.ownerId)[0]!;
    assert.equal(view.payment.valueSats, 50000); assert.equal(view.quote.serviceFeeSats, 750); assert.equal(view.claim.netSats, 48750);
    await runtime.close();
    const restored = await x.factory.restore('ab'.repeat(32), { ...x.entry, status: 'READY', swapId: runtime.swapId });
    assert.ok(restored); assert.equal(restored.api.list(x.entry.ownerId)[0]!.payment.valueSats, 50000); assert.equal(x.counts().creates, 1);
    await restored.close();
  } finally { await x.cleanup(); }
});

test('native self-service prepares/restores encrypted custody and one invoice, authorizes review without any payer/sign/broadcast/mining assembly', { skip: !linux }, async () => {
  const x = await fixture(); try {
    const runtime = await x.factory.prepare('ab'.repeat(32), x.entry); const view = runtime.api.list(x.entry.ownerId)[0]!;
    assert.equal(view.state, 'INVOICE_CREATED'); assert.equal(view.payment.status, 'NOT_STARTED'); assert.ok(view.allowedActions.includes('EXECUTE'));
    const deadline = view.execution.approvedUntil; await runtime.authorize('repeated-explicit-review');
    assert.equal(runtime.api.list(x.entry.ownerId)[0]!.execution.approvedUntil, deadline); assert.equal(x.counts().creates, 1); assert.equal(x.counts().actions, 0);
    await runtime.close(); const restored = await x.factory.restore('ab'.repeat(32), { ...x.entry, status: 'READY', swapId: runtime.swapId });
    assert.ok(restored); assert.equal(restored.api.list(x.entry.ownerId)[0]!.allowedActions.includes('EXECUTE'), false); assert.equal(x.counts().creates, 1);
    await restored.authorize('explicit-review-after-restart'); assert.ok(restored.api.list(x.entry.ownerId)[0]!.allowedActions.includes('EXECUTE'));
    assert.equal(x.counts().actions, 0); await restored.close();
  } finally { await x.cleanup(); }
});

test('operator preflight checks the real native role/identity assembly without generating custody or invoking invoice/payment capabilities', { skip: !linux }, async () => {
  const x = await fixture(); try {
    const result = await x.factory.preflight!() as { status: string; network: string; height: number };
    assert.equal(result.status, 'REGTEST_PROFILE_CHECKED_NO_INVOICE_OR_PAYMENT'); assert.equal(result.network, 'regtest'); assert.equal(result.height, 100);
    assert.deepEqual(await readdir(x.runs), []); assert.equal(x.counts().creates, 0); assert.equal(x.counts().actions, 0);
    x.noClock(); await assert.rejects(x.factory.preflight!()); assert.equal(x.counts().creates, 0);
  } finally { await x.cleanup(); }
});

test('native lost invoice acknowledgment is lookup-recovered without duplicate creation or automatic execution authority', { skip: !linux }, async () => {
  const x = await fixture(); try {
    x.lose(); await assert.rejects(x.factory.prepare('ab'.repeat(32), x.entry)); assert.equal(x.counts().creates, 1);
    const runtime = await x.factory.restore('ab'.repeat(32), { ...x.entry, status: 'UNKNOWN' }); assert.ok(runtime);
    assert.equal(runtime.api.list(x.entry.ownerId)[0]!.payment.status, 'NOT_STARTED');
    assert.equal(runtime.api.list(x.entry.ownerId)[0]!.allowedActions.includes('EXECUTE'), false);
    await assert.rejects(x.factory.prepare('ab'.repeat(32), x.entry)); assert.equal(x.counts().creates, 1); assert.equal(x.counts().actions, 0); await runtime.close();
  } finally { await x.cleanup(); }
});

test('native untrusted clock, foreign Alice address, changed channel and insufficient directional liquidity reject before invoice creation', { skip: !linux }, async () => {
  for (const stage of ['clock', 'address', 'channel', 'liquidity']) {
    const x = await fixture(); try {
      if (stage === 'clock') x.noClock(); if (stage === 'address') x.foreignAddress();
      if (stage === 'channel') x.x.payerChannels.channels[0]!.chan_id = '999';
      if (stage === 'liquidity') x.x.payerChannels.channels[0]!.local_balance = '1000';
      await assert.rejects(x.factory.prepare('ab'.repeat(32), x.entry)); assert.equal(x.counts().creates, 0); assert.equal(x.counts().actions, 0);
    } finally { await x.cleanup(); }
  }
});

test('native policy cannot substitute mainnet, amount/fees, guest owner, external endpoints or unsafe storage', { skip: !linux }, async () => {
  const x = await fixture(); try {
    for (const patch of [{ mode: 'mainnet' }, { amountSats: 100000 }, { maxBlocks: 3 }, { routingFeeLimitSats: 10000 }, { ownerUsername: 'bad username!' },
      { routing: { ...x.policy.routing, payerOrigin: 'https://external.example' } },
      { credentialPaths: { ...x.policy.credentialPaths, providerInvoiceMacaroonPath: '/synthetic/uninspected-admin.macaroon' } },
      { port: 3202 }])
      assert.equal(ownedRuntimePolicySchema.safeParse({ ...x.policy, ...patch }).success, false);
    await assert.rejects(createOwnedRuntimeFactory({ ...x.policy, backupsDirectory: x.policy.runsDirectory }, { get: async () => undefined, verifyCsrf: () => false }, x.io));
  } finally { await x.cleanup(); }
});

test('a canceled unpaid invoice is definitively observed before its slot is released and old execution authority is revoked', { skip: !linux }, async () => {
  const x = await fixture(); try {
    const runtime = await x.factory.prepare('ab'.repeat(32), x.entry);
    assert.equal(await runtime.terminal(), undefined); x.cancel(); assert.equal(await runtime.terminal(), 'EXPIRED');
    assert.equal(runtime.api.list(x.entry.ownerId)[0]!.allowedActions.includes('EXECUTE'), false);
    await assert.rejects(runtime.authorize('review-canceled-invoice'));
    assert.equal(x.counts().creates, 1); assert.equal(x.counts().actions, 0); await runtime.close();
  } finally { await x.cleanup(); }
});

test('unsupported, inconsistent or truncated payer history cannot grant execution or release a canceled invoice reservation', { skip: !linux }, async () => {
  const row = { payment_hash: '11'.repeat(32), payment_index: '1' };
  for (const history of [{ payments: [] }, { payments: [row], first_index_offset: '1', last_index_offset: '2' },
    { payments: [row, row], first_index_offset: '1', last_index_offset: '1' },
    { payments: Array.from({ length: 100 }, (_, i) => ({ ...row, payment_index: String(i + 1) })), first_index_offset: '1', last_index_offset: '100' }]) {
    const x = await fixture(); try {
      x.history(history); await assert.rejects(x.factory.prepare('ab'.repeat(32), x.entry));
      assert.equal(x.counts().creates, 1); assert.equal(x.counts().actions, 0);
      const recovered = await x.factory.restore('ab'.repeat(32), { ...x.entry, status: 'UNKNOWN' });
      assert.ok(recovered); await assert.rejects(recovered.authorize('cannot-review-uncertain-history'));
      assert.equal(recovered.api.list(x.entry.ownerId)[0]!.allowedActions.includes('EXECUTE'), false);
      x.cancel(); await assert.rejects(recovered.terminal()); await recovered.close();
    } finally { await x.cleanup(); }
  }
});

test('verified completed legacy run remains owner-visible as read-only history without copying custody or granting execution', { skip: !linux }, async () => {
  const x = await fixture(); let historyFactory: Awaited<ReturnType<typeof createOwnedRuntimeFactory>> | undefined;
  try {
    const runtime = await x.factory.prepare('ab'.repeat(32), x.entry); await runtime.close();
    const directory = join(x.runs, x.entry.attemptId); const store = await Store.open(join(directory, 'store'));
    const contract = store.read().swaps[runtime.swapId]!.contract;
    const funding = new Transaction(); funding.version = 2; funding.addInput(Buffer.alloc(32, 9), 0);
    funding.addOutput(buildHtlc(contract).output, 50000n);
    funding.addOutput(address.toOutputScript(x.policy.refundDestination, networks.regtest), 49900n);
    const password = await readFile(x.policy.passwordPath); const vault = await SecretVault.open(join(directory, 'client-secrets'), password); password.fill(0);
    const wallet = await ClaimWallet.restore(vault, contract.paymentHash); let claim: Transaction;
    try { claim = wallet.signClaim({ contract, lockupTxHex: funding.toHex(), vout: 0, destination: x.policy.claimDestination, feeSats: 500 }); }
    finally { wallet.destroy(); vault.close(); }
    x.recordConfirmed(funding, 2); x.recordConfirmed(claim!, 1); x.recordBlock(101, 'a1'.repeat(32)); x.recordBlock(102, 'a2'.repeat(32));
    x.x.chain.blocks = x.x.chain.headers = 102; x.x.chain.bestblockhash = 'a2'.repeat(32);
    for (const info of [x.x.providerInfo, x.x.payerInfo]) { info.block_height = 102; info.block_hash = x.x.chain.bestblockhash; }
    await store.transaction(db => { const s = db.swaps[runtime.swapId]!; s.state = 'COMPLETED';
      s.clientPayment = { hash: s.contract.paymentHash, status: 'SUCCEEDED', feeLimitSats: 100, feeSats: 0 };
      s.lockup = { txid: funding.getId(), vout: 0, hex: funding.toHex() }; s.claimTxid = claim!.getId();
      // Real runner shape: CONFIRMED mining intents have no blockHash; the observer does.
      s.miningIntents = [{ txid: funding.getId(), fromHeight: 100, status: 'CONFIRMED' }, { txid: claim!.getId(), fromHeight: 101, status: 'CONFIRMED' }];
      (db.chainObservations ??= {})[`${funding.getId()}:0`] = { fromHeight: 101, height: 102, blockHash: 'a2'.repeat(32),
        spend: { txid: claim!.getId(), height: 102, blockHash: 'a2'.repeat(32) } };
    }); await store.close();
    const before = await readFile(join(directory, 'store/state.json'));
    historyFactory = await createOwnedRuntimeFactory({ ...x.policy, archives: [{ directory, specSha256: sha256(await readFile(join(directory, 'spec.json'))) }] },
      { get: async () => undefined, verifyCsrf: () => false }, x.io);
    const history = await historyFactory.history!(); assert.equal(history.length, 1);
    const view = history[0]!.api.list(x.entry.ownerId)[0]!; assert.equal(view.state, 'COMPLETED'); assert.deepEqual(view.allowedActions, []);
    const checked = await historyFactory.preflight!() as { archives: Array<{ checkpointHeight: number }> };
    assert.equal(checked.archives[0]!.checkpointHeight, 102);
    await assert.rejects(history[0]!.authorize('cannot-reopen-history')); assert.deepEqual(await readFile(join(directory, 'store/state.json')), before);
    assert.equal(x.counts().actions, 0); await historyFactory.close?.(); historyFactory = undefined;
    x.x.chain.blocks = 99;
    historyFactory = await createOwnedRuntimeFactory({ ...x.policy, archives: [{ directory, specSha256: sha256(await readFile(join(directory, 'spec.json'))) }] },
      { get: async () => undefined, verifyCsrf: () => false }, x.io);
    await assert.rejects(historyFactory.history!()); // Snapshot predates the completed run; no new cycle can be installed.
    assert.deepEqual(await readFile(join(directory, 'store/state.json')), before);
    await historyFactory.close?.(); historyFactory = undefined;
    x.x.chain.blocks = 102; x.x.chain.headers = 102;
    const checkpoints = [{ txid: funding.getId(), fromHeight: 100, status: 'CONFIRMED' as const, blockHash: 'a1'.repeat(32) },
      { txid: claim!.getId(), fromHeight: 101, status: 'CONFIRMED' as const, blockHash: 'a2'.repeat(32) }];
    const checkpointStore = await Store.open(join(directory, 'store')); await checkpointStore.transaction(db => { db.swaps[runtime.swapId]!.miningIntents = checkpoints; }); await checkpointStore.close();
    let fork = true; const clients = x.io.clients!(x.policy);
    const forkIO = { ...x.io, clients: () => ({ ...clients, bitcoin: { ...clients.bitcoin,
      call: async <T>(method: string, params: unknown[] = [], wallet = false): Promise<T> => {
        if (method === 'getblockhash') return (fork ? 'ff'.repeat(32) : checkpoints.find(c => c.fromHeight + 1 === params[0])!.blockHash) as T;
        return clients.bitcoin.call<T>(method, params, wallet);
      } } }) as unknown as ReturnType<OwnedNativeIO['clients']> };
    const archivedPolicy = { ...x.policy, archives: [{ directory, specSha256: sha256(await readFile(join(directory, 'spec.json'))) }] };
    historyFactory = await createOwnedRuntimeFactory(archivedPolicy, { get: async () => undefined, verifyCsrf: () => false }, forkIO);
    await assert.rejects(historyFactory.history!()); // Same or higher height with different checkpoints also fails closed.
    await historyFactory.close?.(); historyFactory = undefined; fork = false;
    historyFactory = await createOwnedRuntimeFactory(archivedPolicy, { get: async () => undefined, verifyCsrf: () => false }, forkIO);
    assert.equal((await historyFactory.history!()).length, 1);
    await historyFactory.close?.(); historyFactory = undefined;
    const tampered = Transaction.fromHex(claim!.toHex()); tampered.ins[0]!.witness[1] = Buffer.alloc(32);
    x.recordConfirmed(tampered, 1); // Same txid, invalid witness: checkpoint text alone is insufficient.
    historyFactory = await createOwnedRuntimeFactory(archivedPolicy, { get: async () => undefined, verifyCsrf: () => false }, forkIO);
    await assert.rejects(historyFactory.history!());
  } finally { await historyFactory?.close?.(); await x.cleanup(); }
});
