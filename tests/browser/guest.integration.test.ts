import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { Transaction, payments, networks } from 'bitcoinjs-lib';
import { chromium, type Page } from 'playwright';
import { createApi } from '../../src/api/server.js';
import { GuestAdmission } from '../../src/guest/GuestAdmission.js';
import { GuestReverseError } from '../../src/guest/GuestReverse.js';
import { verifyHtlcSpend } from '../../src/bitcoin/SpendEvidence.js';
import { buildHtlc } from '../../src/bitcoin/HtlcBuilder.js';
import { setup } from '../helpers.js';

const evidence = 'dist/web-verification';
const invoiceText = 'lnbcrt' + '1'.repeat(80);

async function guestBackend(watching = true) {
  const f = await setup(); const admission = new GuestAdmission(f.store);
  let prepared: { id: string; swapId: string; contract: any; htlc: any; lockup: Transaction;
    commitment: string; funded: boolean; completed: boolean; claimTxid?: string } | undefined;
  let statusReads = 0;
  const status = (advance = false) => {
    const id = prepared?.id; if (!id) throw new GuestReverseError(409, 'GUEST_INVOICE_NOT_READY');
    if (advance && prepared && !prepared.completed) { prepared.funded = true; statusReads++; }
    const row = f.store.read().guestAdmissions![id]!; const terms = row.terms;
    return { id, status: prepared!.completed ? 'COMPLETED' : prepared!.funded ? 'FUNDED_AWAITING_CLAIM' : 'INVOICE_CREATED',
      network: 'regtest' as const, destination: terms.destination, paymentHash: terms.paymentHash,
      claimPublicKey: terms.claimPublicKey, refundPublicKey: prepared!.contract.refundPublicKey,
      amountSats: terms.amountSats, invoiceSats: terms.invoiceSats, serviceFeeSats: terms.serviceFeeSats,
      claimFeeSats: terms.claimFeeSats, fundingReserveSats: terms.fundingReserveSats, expiresAt: row.expiresAt,
      recoveryCommitment: prepared!.commitment, swapId: prepared!.swapId, invoice: invoiceText,
      invoiceExpiresAt: Date.now() + 3_600_000, invoiceState: prepared!.completed ? 'SETTLED' : prepared!.funded ? 'ACCEPTED' : 'OPEN',
      swapState: prepared!.completed ? 'COMPLETED' : prepared!.funded ? 'LOCKUP_CONFIRMED' : 'INVOICE_CREATED',
      revision: prepared!.completed ? 8 : 7, fundingTxid: prepared!.funded || prepared!.completed ? prepared!.lockup.getId() : null,
      fundingVout: prepared!.funded || prepared!.completed ? 0 : null,
      fundingConfirmations: prepared!.funded || prepared!.completed ? 1 : null,
      fundingValueSats: prepared!.funded || prepared!.completed ? terms.amountSats : null,
      lockupHex: prepared!.funded || prepared!.completed ? prepared!.lockup.toHex() : null,
      claimTxid: prepared!.claimTxid ?? null, timeoutHeight: prepared!.contract.timeoutHeight,
      htlcAddress: prepared!.htlc.address, witnessScript: prepared!.htlc.witnessScript.toString('hex'),
      claimIntent: prepared!.claimTxid ? { txid: prepared!.claimTxid, status: 'BROADCAST', feeSats: terms.claimFeeSats } : null,
      recovery: { commitment: prepared!.commitment, serverStoresClientSecrets: false,
        requiredBeforePayment: [] } };
  };
  const service = {
    admission,
    get watching() { return watching; },
    async prepare(id: string, authorization: string | undefined, _key: string, raw: any) {
      const view = admission.status(id, authorization);
      if (!view) throw new GuestReverseError(404, 'GUEST_NOT_FOUND');
      if (!/^[a-f0-9]{64}$/.test(raw?.recoveryCommitment ?? '')) throw new GuestReverseError(400, 'GUEST_PREPARE_INVALID');
      const terms = f.store.read().guestAdmissions![id]!.terms;
      const contract = { paymentHash: terms.paymentHash, claimPublicKey: terms.claimPublicKey,
        refundPublicKey: f.contract.refundPublicKey, timeoutHeight: 130 };
      const htlc = buildHtlc(contract); const lockup = new Transaction(); lockup.version = 2;
      lockup.addInput(randomBytes(32), 0); lockup.addOutput(htlc.output, BigInt(terms.amountSats));
      prepared = { id, swapId: randomUUID(), contract, htlc, lockup, commitment: raw.recoveryCommitment,
        funded: false, completed: false };
      return status(false);
    },
    async status(id: string, authorization: string | undefined) {
      if (!admission.status(id, authorization)) throw new GuestReverseError(404, 'GUEST_NOT_FOUND');
      return status(true);
    },
    async submitClaim(id: string, authorization: string | undefined, _key: string, raw: any) {
      if (!admission.status(id, authorization) || !prepared || prepared.id !== id)
        throw new GuestReverseError(404, 'GUEST_NOT_FOUND');
      if (raw.expectedRevision !== 7) throw new GuestReverseError(409, 'GUEST_CLAIM_NOT_READY');
      const tx = Transaction.fromHex(raw.signedClaimHex);
      const evidenceValue = verifyHtlcSpend(raw.signedClaimHex, tx.getId(), prepared.lockup.toHex(), 0, prepared.contract);
      if (evidenceValue.kind !== 'claim' || tx.outs.length !== 1 ||
        tx.outs[0]!.value !== BigInt(f.store.read().guestAdmissions![id]!.terms.amountSats - 500) ||
        !Buffer.from(tx.outs[0]!.script).equals(payments.p2wpkh({ pubkey: Buffer.from(prepared.contract.claimPublicKey, 'hex'),
          network: networks.regtest }).output!)) throw new GuestReverseError(409, 'GUEST_CLAIM_INVALID');
      prepared.completed = true; prepared.claimTxid = tx.getId();
      return { id, status: 'CLAIM_BROADCAST_PENDING_CONFIRMATION', network: 'regtest' as const,
        swapId: prepared.swapId, claimTxid: tx.getId(), revision: 8,
        invoiceState: 'ACCEPTED_NOT_SETTLED', recoveryCommitment: prepared.commitment };
    },
    claims: () => prepared?.claimTxid, statusReads: () => statusReads,
  };
  return { f, service, admission };
}

async function serve(backend: Awaited<ReturnType<typeof guestBackend>>) {
  const server = createApi(backend.f.manager, async () => ({ onchainSats: 1_000_000, incomingSats: 1_000_000 }),
    undefined, 'regtest', { guestReverse: backend.service as any });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
async function pageFor(base: string, browser: Awaited<ReturnType<typeof chromium.launch>>) {
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  await page.route('**/v1/auth/session', route => route.fulfill({ status: 401, json: {} }));
  await page.goto(base);
  return page;
}

test('fresh browser profile exports and restores recovery before invoice, then signs the exact confirmed claim', async context => {
  const backend = await guestBackend(true); const app = await serve(backend);
  context.after(() => new Promise<void>(resolve => app.server.close(() => resolve())));
  context.after(backend.f.cleanup);
  const browser = await chromium.launch({ channel: process.env.WEB_TEST_BROWSER_CHANNEL });
  context.after(() => browser.close());
  const page = await pageFor(app.base, browser);
  await page.waitForFunction(() => !document.getElementById('swap-action')?.hasAttribute('disabled'));
  assert.equal(await page.locator('#quote-form .cube-unit').count(), 3);
  assert.equal(await page.locator('form#quote-form').count(), 1);
  await page.getByRole('button', { name: 'SWAP', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Guest swap recovery' });
  await dialog.waitFor();
  const passphrase = 'correct horse battery staple';
  await page.locator('#guest-passphrase').fill(passphrase);
  await page.locator('#guest-passphrase-confirm').fill(passphrase);
  await page.getByRole('button', { name: 'Create invoice' }).click();
  await page.locator('#guest-export-text').waitFor();
  assert.ok((await page.locator('#guest-export-text').inputValue()).includes('"ciphertext"'));
  assert.equal(await page.locator('#guest-payment').isVisible(), false);
  await page.getByRole('button', { name: 'Download encrypted recovery' }).click();
  await page.locator('#guest-restore-passphrase').fill(passphrase);
  await page.getByRole('button', { name: 'Verify restore' }).click();
  await page.locator('#guest-payment').waitFor();
  assert.match(await page.locator('#guest-invoice').inputValue(), /^lnbcrt/);
  const claim = page.getByRole('button', { name: 'Claim funds' });
  await claim.waitFor({ timeout: 10_000 });
  await claim.click();
  await page.getByText('Guest swap completed. The resulting claim is confirmed and the invoice is settled.').waitFor();
  assert.match(backend.service.claims()!, /^[a-f0-9]{64}$/);
  assert.equal(await page.locator('form#quote-form').count(), 1);
  assert.equal(await page.locator('#guest-dialog').count(), 1);
});

test('guest startup fails closed when the watcher is unavailable', async context => {
  const backend = await guestBackend(false); const app = await serve(backend);
  context.after(() => new Promise<void>(resolve => app.server.close(() => resolve())));
  context.after(backend.f.cleanup);
  const browser = await chromium.launch({ channel: process.env.WEB_TEST_BROWSER_CHANNEL });
  context.after(() => browser.close());
  const page = await pageFor(app.base, browser);
  let guestQuotes = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/v1/guest/quotes') guestQuotes++; });
  await page.getByText('Guest watcher unavailable · no invoice will be created.').waitFor();
  assert.equal(await page.getByRole('button', { name: 'SWAP', exact: true }).isDisabled(), true);
  assert.equal(guestQuotes, 0);
});
