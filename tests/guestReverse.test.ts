import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { Transaction, address, payments, networks } from 'bitcoinjs-lib';
import { setup, privateTestDirectory, routingFixture } from './helpers.js';
import { GuestReverse, GuestReverseError, type GuestPreparationFactory, type GuestReverseClients } from '../src/guest/GuestReverse.js';
import { SwapManager } from '../src/core/SwapManager.js';
import { createReverseTestPlan } from '../src/core/ReverseTestPlan.js';
import { preparationDigest } from '../src/core/ReversePreparation.js';
import { buildHtlc } from '../src/bitcoin/HtlcBuilder.js';
import { createClaim } from '../src/bitcoin/ClaimManager.js';
import { Store } from '../src/persistence/Store.js';
import { createApi } from '../src/api/server.js';
import type { Invoice } from '../src/lightning/LndClient.js';

const GUEST_INVOICE_SATS = 50000;
const invoiceText = 'lnbcrt' + 'c'.repeat(30);

async function fixture(options: { failAfterCreate?: boolean; noBroadcast?: boolean; broadcastFails?: boolean;
  tip?: number; pauseFile?: string; walletFunding?: boolean;
  beforeInvoice?: (spec: any, pauseFile: string) => Promise<void> } = {}) {
  const f = await setup(); const runsDirectory = await privateTestDirectory('guest-runs'); const routing = routingFixture();
  const pauseFile = options.pauseFile ?? join(runsDirectory, 'pause.json');
  let tip = options.tip ?? 100; let invoiceState: Invoice['state'] = 'OPEN'; let calls = 0; let broadcasts = 0; let lockCalls = 0;
  const ledger = new Map<string, { hex: string; confirmations: number }>();
  const inventory: Array<{ txid: string; vout: number; amount: number; confirmations: number;
    safe: boolean; spendable: boolean; solvable: boolean; scriptPubKey: string }> = [];
  const invoice = (): Invoice => ({ state: invoiceState, r_hash: Buffer.from(f.contract.paymentHash, 'hex').toString('base64'),
    value: String(GUEST_INVOICE_SATS), amt_paid_sat: invoiceState === 'SETTLED' ? String(GUEST_INVOICE_SATS) : '0', payment_request: invoiceText,
    htlcs: invoiceState === 'ACCEPTED' ? [{ state: 'ACCEPTED', expiration_height: 210, amt_msat: String(GUEST_INVOICE_SATS * 1000) }] : [] });
  const clients: GuestReverseClients = {
    bitcoin: { origin: routing.bitcoinOrigin, call: async (method, params) => {
      if (method === 'getblockchaininfo') return { chain: 'regtest', initialblockdownload: false, blocks: tip,
        bestblockhash: '11'.repeat(32) } as any;
      if (method === 'listunspent') return inventory as any;
      if (method === 'listlockunspent') return [] as any;
      if (method === 'gettxout') { const [txid, vout] = (params ?? []) as [string, number];
        const entry = ledger.get(txid); if (!entry || entry.confirmations < 1) return null as any;
        const tx = Transaction.fromHex(entry.hex); const output = tx.outs[vout]; if (!output) return null as any;
        return { bestblock: '11'.repeat(32), confirmations: entry.confirmations, coinbase: false, value: Number(output.value) / 1e8,
          scriptPubKey: { hex: Buffer.from(output.script).toString('hex') } } as any;
      }
      throw new Error('unexpected Core call');
    }, confirmed: async txid => ledger.get(txid) ?? { hex: '', confirmations: 0 } },
    provider: { origin: routing.providerOrigin, call: async () => { throw new Error('unexpected provider call'); },
      assertRegtest: async () => ({ chains: [{ chain: 'bitcoin', network: 'regtest' }], synced_to_chain: true }) },
    payer: { origin: routing.payerOrigin, call: async () => { throw new Error('unexpected payer call'); },
      assertRegtest: async () => ({ chains: [{ chain: 'bitcoin', network: 'regtest' }], synced_to_chain: true }) },
    invoices: { origin: routing.providerOrigin, create: async () => { throw new Error('unexpected invoice create'); },
      lookup: async () => ({ status: 'PRESENT' as const, invoice: invoice() }) },
    tip: async () => tip, now: () => 1000,
  };
  const preparation: GuestPreparationFactory = (store, spec) => ({ async prepare() {
    if (options.beforeInvoice) await options.beforeInvoice(spec, pauseFile);
    calls++;
    const manager = new SwapManager(store);
    const quote = await manager.quoteInvoice(spec.sourceAmountSats!, 1000);
    const plan = createReverseTestPlan(quote, spec.tipHeight, spec.client, spec.refundPublicKey,
      { claim: spec.claimDestination, refund: spec.refundDestination }, { provider: spec.providerNode, payer: spec.payerNode }, spec.routing);
    const swap = await manager.create(quote.id, `guest-${spec.id}`, plan.contract, spec.tipHeight,
      { onchainSats: 1000000, incomingSats: 1000000 }, 1000);
    await store.transaction(db => {
      const current = db.swaps[swap.id]!; current.invoice = invoiceText; current.state = 'INVOICE_CREATED';
      current.pendingAction = undefined; current.revision++;
      (db.reversePreparations ??= {})[spec.id] = { specDigest: preparationDigest(spec), attemptId: 'synthetic', status: 'READY',
        plan, swapId: swap.id, invoiceAttempt: { attemptId: 'synthetic', revision: current.revision, wireAuthorized: true } };
    });
    if (options.failAfterCreate) throw new Error('synthetic lost invoice reply');
    return { plan, swapId: swap.id, invoice: invoiceText, invoiceExpiresAt: 1000 + 3_600_000 };
  } });
  const broadcast = async (hex: string) => {
    broadcasts++; if (options.broadcastFails) throw new Error('synthetic lost broadcast reply');
    return Transaction.fromHex(hex).getId();
  };
  const policy = { mode: 'regtest' as const, isolationId: randomUUID(), providerNode: '02' + '11'.repeat(32),
    payerNode: '03' + '22'.repeat(32), routing, refundPublicKey: f.contract.refundPublicKey,
    refundDestination: f.destination, funding: options.walletFunding ? { mode: 'wallet' } : { txid: 'ab'.repeat(32), vout: 0, valueSats: 100000 },
    runsDirectory };
  const service = new GuestReverse(f.store, policy, clients, { preparation,
    broadcast: options.noBroadcast ? undefined : broadcast, pauseFile,
    lock: async work => { lockCalls++; return work(); } });
  const token = randomBytes(32).toString('base64url'); const auth = `Bearer ${token}`;
  const quote = await service.quote(auth, 'guest-quote-key', { destination: f.destination, amountSats: GUEST_INVOICE_SATS,
    paymentHash: f.contract.paymentHash, claimPublicKey: f.contract.claimPublicKey });
  return { f, service, quote, auth, token, runsDirectory, ledger, clients, pauseFile, inventory,
    prepare: (key = 'guest-prepare-key', commitment = 'ab'.repeat(32)) => service.prepare(quote.id, auth, key, { recoveryCommitment: commitment }),
    setInvoice: (state: Invoice['state']) => { invoiceState = state; }, setTip: (value: number) => { tip = value; },
    calls: () => calls, broadcasts: () => broadcasts, lockCalls: () => lockCalls,
    cleanup: async () => { await f.cleanup(); await rm(runsDirectory, { recursive: true, force: true }); } };
}

function lockupAndClaim(x: Awaited<ReturnType<typeof fixture>>, amountSats: number,
  options: { destination?: string; feeSats?: number; lockupSeed?: Buffer } = {}) {
  const htlc = buildHtlc(x.f.contract);
  const lockup = new Transaction(); lockup.version = 2;
  lockup.addInput(options.lockupSeed ?? randomBytes(32), 0); lockup.addOutput(htlc.output, BigInt(amountSats));
  const claim = createClaim({ contract: x.f.contract, lockupTxHex: lockup.toHex(), vout: 0,
    destination: options.destination ?? x.f.destination, feeSats: options.feeSats ?? 500, privateKey: x.f.claimKey.privateKey! }, x.f.preimage);
  return { lockup, claim };
}

async function seedClaim(x: Awaited<ReturnType<typeof fixture>>,
  options: { destination?: string; feeSats?: number; lockupSeed?: Buffer } = {}) {
  const prepared = await x.prepare() as any;
  const run = await Store.open(join(x.runsDirectory, x.quote.id));
  let expectedRevision: number; let claim: Transaction; let amountSats: number; let lockup: Transaction;
  try {
    const swap = run.read().swaps[prepared.swapId]!; amountSats = swap.quote.amountSats;
    const built = lockupAndClaim(x, amountSats, { destination: options.destination,
      feeSats: options.feeSats ?? swap.quote.claimFeeSats, lockupSeed: options.lockupSeed });
    claim = built.claim; lockup = built.lockup;
    await run.transaction(db => { const current = db.swaps[swap.id]!; current.lockup = { txid: built.lockup.getId(), hex: built.lockup.toHex(), vout: 0 };
      current.state = 'LOCKUP_CONFIRMED'; current.revision++; });
    expectedRevision = run.read().swaps[prepared.swapId]!.revision;
  } finally { await run.close(); }
  x.ledger.set(lockup.getId(), { hex: lockup.toHex(), confirmations: 1 });
  x.setInvoice('ACCEPTED');
  return { prepared, claim: claim!, lockup: lockup!, expectedRevision: expectedRevision!, amountSats: amountSats! };
}

test('guest prepare needs the capability and a recovery commitment, then creates one invoice without client secrets', async () => {
  const x = await fixture(); try {
    await assert.rejects(x.service.prepare(x.quote.id, `Bearer ${randomBytes(32).toString('base64url')}`, 'bad-token', { recoveryCommitment: 'ab'.repeat(32) }),
      (error: unknown) => error instanceof GuestReverseError && error.status === 404);
    await assert.rejects(x.service.prepare(x.quote.id, x.auth, 'no-commitment', {}));
    const prepared = await x.prepare() as any;
    assert.equal(prepared.status, 'INVOICE_CREATED'); assert.equal(prepared.invoice, invoiceText);
    assert.equal(prepared.timeoutHeight, 130); assert.ok(prepared.htlcAddress.startsWith('bcrt1'));
    assert.equal(prepared.recoveryCommitment, 'ab'.repeat(32)); assert.equal(x.calls(), 1);
    const stored = JSON.stringify(x.f.store.read());
    assert.equal(stored.includes(x.token), false); assert.equal(stored.includes(x.f.preimage), false);
    assert.equal(stored.includes(Buffer.from(x.f.claimKey.privateKey!).toString('hex')), false);
    const replay = await x.prepare() as any;
    assert.equal(replay.invoice, prepared.invoice); assert.equal(x.calls(), 1);
    await assert.rejects(x.prepare('other-key'), (error: unknown) =>
      error instanceof GuestReverseError && error.code === 'GUEST_PREPARE_CONFLICT');
    assert.equal(x.calls(), 1);
  } finally { await x.cleanup(); }
});

test('an uncertain invoice RPC retains one attempt and never retries or creates a second invoice', async () => {
  const x = await fixture({ failAfterCreate: true }); try {
    await assert.rejects(x.prepare(), (error: unknown) =>
      error instanceof GuestReverseError && error.code === 'GUEST_PREPARATION_UNCERTAIN');
    assert.equal(x.calls(), 1); assert.equal(x.f.store.read().guestSwaps![x.quote.id]!.status, 'PREPARATION_UNKNOWN');
    const paused = JSON.parse(await readFile(x.pauseFile, 'utf8'));
    assert.equal(paused.activeSwapPolicy.swaps[x.quote.id].state, 'PREPARING');
    await assert.rejects(x.prepare(), (error: unknown) =>
      error instanceof GuestReverseError && error.code === 'GUEST_PREPARATION_UNCERTAIN');
    await assert.rejects(x.prepare('new-key-123'), (error: unknown) =>
      error instanceof GuestReverseError && error.code === 'GUEST_PREPARE_CONFLICT');
    assert.equal(x.calls(), 1);
    const run = await Store.open(join(x.runsDirectory, x.quote.id));
    try { assert.equal(Object.keys(run.read().swaps).length, 1); } finally { await run.close(); }
  } finally { await x.cleanup(); }
});

test('ACCEPTED is never SETTLED and COMPLETED requires a confirmed exact claim plus a settled invoice', async () => {
  const x = await fixture(); try {
    const prepared = await x.prepare() as any; x.setInvoice('ACCEPTED');
    assert.equal((await x.service.status(x.quote.id, x.auth) as any).status, 'PAYMENT_ACCEPTED_NOT_SETTLED');
    x.setInvoice('SETTLED');
    assert.equal((await x.service.status(x.quote.id, x.auth) as any).status, 'MANUAL_REVIEW');
    const run = await Store.open(join(x.runsDirectory, x.quote.id));
    let claimId: string; let claimHex: string;
    try {
      const swap = run.read().swaps[prepared.swapId]!;
      const { lockup, claim } = lockupAndClaim(x, swap.quote.amountSats, { feeSats: swap.quote.claimFeeSats });
      claimId = claim.getId(); claimHex = claim.toHex();
      await run.transaction(db => { const current = db.swaps[swap.id]!; current.lockup = { txid: lockup.getId(), hex: lockup.toHex(), vout: 0 };
        current.claimTxid = claimId; current.state = 'COMPLETED'; current.revision++; });
    } finally { await run.close(); }
    x.ledger.set(claimId, { hex: claimHex, confirmations: 1 });
    const complete = await x.service.status(x.quote.id, x.auth) as any;
    assert.equal(complete.status, 'COMPLETED'); assert.equal(complete.claimTxid, claimId);
  } finally { await x.cleanup(); }
});

test('status exposes revision and only validated confirmed lockup evidence for local signing', async () => {
  const x = await fixture(); try {
    const seeded = await seedClaim(x);
    const confirmed = await x.service.status(x.quote.id, x.auth) as any;
    assert.equal(confirmed.revision, seeded.expectedRevision);
    assert.equal(confirmed.fundingTxid, seeded.lockup.getId());
    assert.equal(confirmed.fundingVout, 0); assert.equal(confirmed.fundingConfirmations, 1);
    assert.equal(confirmed.lockupHex, seeded.lockup.toHex()); assert.equal(confirmed.fundingValueSats, seeded.amountSats);
    x.ledger.get(seeded.lockup.getId())!.confirmations = 0;
    const unconfirmed = await x.service.status(x.quote.id, x.auth) as any;
    assert.equal(unconfirmed.fundingVout, null); assert.equal(unconfirmed.lockupHex, null);
    assert.equal(unconfirmed.fundingConfirmations, null);
  } finally { await x.cleanup(); }
});

test('client-signed claim is bound to the exact outpoint/destination/fee and broadcasts once', async () => {
  const x = await fixture(); try {
    const seeded = await seedClaim(x); const before = x.lockCalls();
    const result = await x.service.submitClaim(x.quote.id, x.auth, 'claim-key',
      { signedClaimHex: seeded.claim.toHex(), expectedRevision: seeded.expectedRevision }) as any;
    assert.equal(result.status, 'CLAIM_BROADCAST_PENDING_CONFIRMATION'); assert.equal(result.claimTxid, seeded.claim.getId());
    assert.equal(x.broadcasts(), 1); assert.equal(x.lockCalls(), before + 1);
    const run = await Store.open(join(x.runsDirectory, x.quote.id));
    try { const disk = run.read().swaps[seeded.prepared.swapId]!;
      assert.equal(disk.claimTxid, seeded.claim.getId()); assert.equal(disk.clientClaimIntent?.status, 'BROADCAST'); }
    finally { await run.close(); }
    const replay = await x.service.submitClaim(x.quote.id, x.auth, 'claim-key',
      { signedClaimHex: seeded.claim.toHex(), expectedRevision: seeded.expectedRevision }) as any;
    assert.equal(replay.claimTxid, seeded.claim.getId()); assert.equal(x.broadcasts(), 1);
    await assert.rejects(x.service.submitClaim(x.quote.id, x.auth, 'other-key',
      { signedClaimHex: seeded.claim.toHex(), expectedRevision: seeded.expectedRevision }),
      (error: unknown) => error instanceof GuestReverseError && error.code === 'GUEST_CLAIM_CONFLICT');
    assert.equal(x.broadcasts(), 1);
  } finally { await x.cleanup(); }
});

test('claim broadcast requires fresh confirmed exact funding and an unspent outpoint', async () => {
  for (const change of ['unconfirmed', 'changed', 'principal', 'script', 'spent'] as const) {
    const x = await fixture(); try {
      const seeded = await seedClaim(x);
      if (change === 'unconfirmed') x.ledger.get(seeded.lockup.getId())!.confirmations = 0;
      if (change === 'changed') x.ledger.get(seeded.lockup.getId())!.hex = x.f.tx.toHex();
      if (change === 'principal') { const tx = Transaction.fromHex(seeded.lockup.toHex()); tx.outs[0]!.value = 1n;
        x.ledger.set(seeded.lockup.getId(), { hex: tx.toHex(), confirmations: 1 }); }
      if (change === 'script') { const tx = Transaction.fromHex(seeded.lockup.toHex()); tx.outs[0]!.script = Buffer.from('00');
        x.ledger.set(seeded.lockup.getId(), { hex: tx.toHex(), confirmations: 1 }); }
      if (change === 'spent') { const original = x.clients.bitcoin.call;
        x.clients.bitcoin.call = async (method, params) => method === 'gettxout' ? null as any : original(method, params); }
      await assert.rejects(x.service.submitClaim(x.quote.id, x.auth, `claim-${change}`,
        { signedClaimHex: seeded.claim.toHex(), expectedRevision: seeded.expectedRevision }),
        (error: unknown) => error instanceof GuestReverseError && error.code === 'GUEST_CLAIM_UNCERTAIN');
      assert.equal(x.broadcasts(), 0);
    } finally { await x.cleanup(); }
  }
});

test('claim verification fails closed on destination, fee, outpoint or CLTV deadline before broadcasting', async () => {
  for (const change of ['destination', 'fee', 'outpoint', 'deadline'] as const) {
    const x = await fixture(); try {
      const options = change === 'destination'
        ? { destination: payments.p2wpkh({ pubkey: x.f.refundKey.publicKey, network: networks.regtest }).address! }
        : change === 'fee' ? { feeSats: 501 } : {};
      const seeded = await seedClaim(x, options); if (change === 'deadline') x.setTip(121);
      // For the outpoint case the swap lockup stays valid while the claim spends a different one.
      const wrong = change === 'outpoint'
        ? lockupAndClaim(x, seeded.amountSats, { feeSats: 500, lockupSeed: randomBytes(32) }).claim
        : seeded.claim;
      await assert.rejects(x.service.submitClaim(x.quote.id, x.auth, `claim-${change}`,
        { signedClaimHex: wrong.toHex(), expectedRevision: seeded.expectedRevision }),
        (error: unknown) => error instanceof GuestReverseError &&
          error.code === (change === 'deadline' ? 'GUEST_CLTV_WINDOW_CLOSED' : 'GUEST_CLAIM_INVALID'));
      assert.equal(x.broadcasts(), 0);
    } finally { await x.cleanup(); }
  }
});

test('a lost claim broadcast stays UNKNOWN and is never retried', async () => {
  const x = await fixture({ broadcastFails: true }); try {
    const seeded = await seedClaim(x);
    for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(x.service.submitClaim(x.quote.id, x.auth, 'lost-claim-key',
      { signedClaimHex: seeded.claim.toHex(), expectedRevision: seeded.expectedRevision }),
      (error: unknown) => error instanceof GuestReverseError && error.code === 'GUEST_CLAIM_UNCERTAIN');
    assert.equal(x.broadcasts(), 1);
    const run = await Store.open(join(x.runsDirectory, x.quote.id));
    try { assert.equal(run.read().swaps[seeded.prepared.swapId]!.clientClaimIntent!.status, 'UNKNOWN'); } finally { await run.close(); }
  } finally { await x.cleanup(); }
});

test('claim broadcast stays closed without a configured broadcaster', async () => {
  const x = await fixture({ noBroadcast: true }); try {
    const seeded = await seedClaim(x);
    await assert.rejects(x.service.submitClaim(x.quote.id, x.auth, 'claim-key',
      { signedClaimHex: seeded.claim.toHex(), expectedRevision: seeded.expectedRevision }),
      (error: unknown) => error instanceof GuestReverseError && error.code === 'GUEST_BROADCAST_NOT_CONFIGURED');
  } finally { await x.cleanup(); }
});

test('guest reverse HTTP routes are capability/origin bound and do not expose the capability or preimage', async () => {
  const x = await fixture(); try {
    const server = createApi(x.f.manager, async () => ({ onchainSats: 1000000, incomingSats: 1000000 }), undefined, 'regtest', { guestReverse: x.service });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const token = randomBytes(32).toString('base64url'); const authorization = `Bearer ${token}`;
      const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + path, { method: 'POST',
        headers: { origin: base, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
      const quoteResponse = await post('/v1/guest/quotes', { destination: x.f.destination, amountSats: GUEST_INVOICE_SATS,
        paymentHash: x.f.contract.paymentHash, claimPublicKey: x.f.contract.claimPublicKey },
        { authorization, 'idempotency-key': 'api-quote-key' });
      assert.equal(quoteResponse.status, 201); const quote = await quoteResponse.json() as any;
      const prepared = await post(`/v1/guest/quotes/${quote.id}/prepare`, { recoveryCommitment: 'cd'.repeat(32) },
        { authorization, 'idempotency-key': 'api-prepare-key' });
      assert.equal(prepared.status, 201);
      const status = await (await fetch(base + `/v1/guest/quotes/${quote.id}`, { headers: { authorization } })).json() as any;
      assert.equal(status.status, 'INVOICE_CREATED');
      assert.equal(JSON.stringify(status).includes(token), false); assert.equal(JSON.stringify(status).includes(x.f.preimage), false);
      assert.equal((await fetch(base + `/v1/guest/quotes/${quote.id}`)).status, 404);
      assert.equal((await fetch(base + `/v1/guest/quotes/${quote.id}?token=leak`, { headers: { authorization } })).status, 403);
      assert.equal((await post(`/v1/guest/quotes/${quote.id}/prepare`, { recoveryCommitment: 'cd'.repeat(32) },
        { authorization, 'idempotency-key': 'api-prepare-key', origin: 'https://evil.invalid' })).status, 403);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  } finally { await x.cleanup(); }
});

test('a durable PREPARING pause exists before the invoice and is updated with the real deadline', async () => {
  let observed: any;
  const x = await fixture({ beforeInvoice: async (spec, file) => {
    observed = { id: spec.id, value: JSON.parse(await readFile(file, 'utf8')) };
  } });
  try {
    const prepared = await x.prepare() as any;
    assert.ok(observed.value.activeSwapPolicy.swaps[observed.id]);
    assert.equal(observed.value.activeSwapPolicy.swaps[observed.id].state, 'PREPARING');
    const after = JSON.parse(await readFile(x.pauseFile, 'utf8'));
    assert.equal(after.activeSwapPolicy.swaps[x.quote.id].state, 'INVOICE_CREATED');
    assert.equal(after.activeSwapPolicy.swaps[x.quote.id].timeoutHeight, 130);
    assert.equal(typeof prepared.invoice, 'string');
  } finally { await x.cleanup(); }
});

test('a pause-file failure blocks the invoice before any preparation', async () => {
  const dir = await privateTestDirectory('guest-pause-fail'); const pauseFile = join(dir, 'pause-dir');
  await mkdir(pauseFile, { recursive: true });
  const x = await fixture({ pauseFile });
  try {
    await assert.rejects(x.prepare(), (error: unknown) =>
      error instanceof GuestReverseError && error.code === 'GUEST_PREPARATION_UNCERTAIN');
    assert.equal(x.calls(), 0);
    assert.equal(x.f.store.read().guestSwaps![x.quote.id]!.status, 'PREPARATION_UNKNOWN');
  } finally { await x.cleanup(); await rm(dir, { recursive: true, force: true }); }
});

test('the shared funding outpoint is reserved atomically across guest admissions', async () => {
  const x = await fixture(); try {
    await x.prepare();
    const token2 = randomBytes(32).toString('base64url'); const auth2 = `Bearer ${token2}`;
    const quote2 = await x.service.quote(auth2, 'guest-quote-key-2', { destination: x.f.destination,
      amountSats: GUEST_INVOICE_SATS, paymentHash: x.f.contract.paymentHash, claimPublicKey: x.f.contract.claimPublicKey });
    const calls = x.calls();
    await assert.rejects(x.service.prepare(quote2.id, auth2, 'guest-prepare-key-2', { recoveryCommitment: 'cd'.repeat(32) }),
      (error: unknown) => error instanceof GuestReverseError && error.code === 'GUEST_FUNDING_INPUT_BUSY');
    assert.equal(x.calls(), calls);
  } finally { await x.cleanup(); }
});

test('wallet funding skips spent and reserved inputs and prepares another swap without changing policy', async () => {
  const inputs: string[] = [];
  const x = await fixture({ walletFunding: true, beforeInvoice: async spec => { inputs.push(spec.input.txid); } });
  try {
    const addCoin = (valueSats: number) => {
      const tx = new Transaction();
      tx.addInput(randomBytes(32), 0);
      const script = address.toOutputScript(x.f.destination, networks.regtest);
      tx.addOutput(script, BigInt(valueSats));
      const txid = tx.getId();
      x.inventory.push({ txid, vout: 0, amount: valueSats / 1e8, confirmations: 1,
        safe: true, spendable: true, solvable: true, scriptPubKey: Buffer.from(script).toString('hex') });
      x.ledger.set(txid, { hex: tx.toHex(), confirmations: 1 });
      return txid;
    };
    await assert.rejects(x.prepare(), (error: unknown) =>
      error instanceof GuestReverseError && error.code === 'GUEST_FUNDING_UNAVAILABLE');
    assert.equal(x.f.store.read().guestSwaps?.[x.quote.id], undefined);
    const first = addCoin(61000);
    const second = addCoin(62000);
    const third = addCoin(63000);
    await x.prepare();
    const prepared = x.f.store.read().guestSwaps?.[x.quote.id];
    assert.equal(prepared?.funding?.txid, first);
    assert.ok(prepared?.swapId);
    const prepareNext = async () => {
      const auth = `Bearer ${randomBytes(32).toString('base64url')}`;
      const quote = await x.service.quote(auth, 'another-guest-key', { destination: x.f.destination,
        amountSats: GUEST_INVOICE_SATS, paymentHash: randomBytes(32).toString('hex'), claimPublicKey: x.f.contract.claimPublicKey });
      await x.service.prepare(quote.id, auth, 'another-prepare-key', { recoveryCommitment: 'cd'.repeat(32) });
    };
    await prepareNext();
    const run = await Store.open(join(x.runsDirectory, x.quote.id));
    try { await run.transaction(db => { db.swaps[prepared.swapId!]!.state = 'COMPLETED'; }); }
    finally { await run.close(); }
    await x.service.runOnce();
    x.ledger.delete(first); // The wallet inventory can still contain a stale view of a spent coin.
    await prepareNext();
    assert.deepEqual(inputs, [first, second, third]);
    assert.equal(x.f.store.read().guestFundingReservations?.[`${first}:0`]?.status, 'RELEASED');
  } finally { await x.cleanup(); }
});
