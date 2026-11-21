import { randomBytes, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { Transaction, payments, networks } from 'bitcoinjs-lib';
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

async function fixture(options: { failAfterCreate?: boolean; noBroadcast?: boolean; broadcastFails?: boolean; tip?: number } = {}) {
  const f = await setup(); const runsDirectory = await privateTestDirectory('guest-runs'); const routing = routingFixture();
  let tip = options.tip ?? 100; let invoiceState: Invoice['state'] = 'OPEN'; let calls = 0; let broadcasts = 0; let lockCalls = 0;
  const ledger = new Map<string, { hex: string; confirmations: number }>();
  const invoice = (): Invoice => ({ state: invoiceState, r_hash: Buffer.from(f.contract.paymentHash, 'hex').toString('base64'),
    value: String(GUEST_INVOICE_SATS), amt_paid_sat: invoiceState === 'SETTLED' ? String(GUEST_INVOICE_SATS) : '0', payment_request: invoiceText,
    htlcs: invoiceState === 'ACCEPTED' ? [{ state: 'ACCEPTED', expiration_height: 210, amt_msat: String(GUEST_INVOICE_SATS * 1000) }] : [] });
  const clients: GuestReverseClients = {
    bitcoin: { origin: routing.bitcoinOrigin, call: async () => { throw new Error('unexpected Core call'); },
      confirmed: async txid => ledger.get(txid) ?? { hex: '', confirmations: 0 } },
    provider: { origin: routing.providerOrigin, call: async () => { throw new Error('unexpected provider call'); },
      assertRegtest: async () => ({ chains: [{ chain: 'bitcoin', network: 'regtest' }], synced_to_chain: true }) },
    payer: { origin: routing.payerOrigin, call: async () => { throw new Error('unexpected payer call'); },
      assertRegtest: async () => ({ chains: [{ chain: 'bitcoin', network: 'regtest' }], synced_to_chain: true }) },
    invoices: { origin: routing.providerOrigin, create: async () => { throw new Error('unexpected invoice create'); },
      lookup: async () => ({ status: 'PRESENT' as const, invoice: invoice() }) },
    tip: async () => tip, now: () => 1000,
  };
  const preparation: GuestPreparationFactory = (store, spec) => ({ async prepare() {
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
    refundDestination: f.destination, funding: { txid: 'ab'.repeat(32), vout: 0, valueSats: 100000 },
    runsDirectory };
  const service = new GuestReverse(f.store, policy, clients, { preparation,
    broadcast: options.noBroadcast ? undefined : broadcast, pauseFile: join(runsDirectory, 'pause.json'),
    lock: async work => { lockCalls++; return work(); } });
  const token = randomBytes(32).toString('base64url'); const auth = `Bearer ${token}`;
  const quote = await service.quote(auth, 'guest-quote-key', { destination: f.destination, amountSats: GUEST_INVOICE_SATS,
    paymentHash: f.contract.paymentHash, claimPublicKey: f.contract.claimPublicKey });
  return { f, service, quote, auth, token, runsDirectory, ledger,
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
  let expectedRevision: number; let claim: Transaction; let amountSats: number;
  try {
    const swap = run.read().swaps[prepared.swapId]!; amountSats = swap.quote.amountSats;
    const built = lockupAndClaim(x, amountSats, { destination: options.destination,
      feeSats: options.feeSats ?? swap.quote.claimFeeSats, lockupSeed: options.lockupSeed });
    claim = built.claim;
    await run.transaction(db => { const current = db.swaps[swap.id]!; current.lockup = { txid: built.lockup.getId(), hex: built.lockup.toHex(), vout: 0 };
      current.state = 'LOCKUP_CONFIRMED'; current.revision++; });
    expectedRevision = run.read().swaps[prepared.swapId]!.revision;
  } finally { await run.close(); }
  x.setInvoice('ACCEPTED');
  return { prepared, claim: claim!, expectedRevision: expectedRevision!, amountSats: amountSats! };
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

test('client-signed claim is bound to the exact outpoint/destination/fee and broadcasts once', async () => {
  const x = await fixture(); try {
    const seeded = await seedClaim(x);
    const result = await x.service.submitClaim(x.quote.id, x.auth, 'claim-key',
      { signedClaimHex: seeded.claim.toHex(), expectedRevision: seeded.expectedRevision }) as any;
    assert.equal(result.status, 'CLAIM_BROADCAST_PENDING_CONFIRMATION'); assert.equal(result.claimTxid, seeded.claim.getId());
    assert.equal(x.broadcasts(), 1); assert.equal(x.lockCalls(), 1);
    const replay = await x.service.submitClaim(x.quote.id, x.auth, 'claim-key',
      { signedClaimHex: seeded.claim.toHex(), expectedRevision: seeded.expectedRevision }) as any;
    assert.equal(replay.claimTxid, seeded.claim.getId()); assert.equal(x.broadcasts(), 1);
    await assert.rejects(x.service.submitClaim(x.quote.id, x.auth, 'other-key',
      { signedClaimHex: seeded.claim.toHex(), expectedRevision: seeded.expectedRevision }),
      (error: unknown) => error instanceof GuestReverseError && error.code === 'GUEST_CLAIM_CONFLICT');
    assert.equal(x.broadcasts(), 1);
  } finally { await x.cleanup(); }
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
