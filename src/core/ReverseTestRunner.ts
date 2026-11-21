import { Transaction, address, networks } from 'bitcoinjs-lib';
import type { Store } from '../persistence/Store.js';
import type { Swap, ReversePaymentStatus } from './SwapTypes.js';
import { SwapCoordinator, type SwapPorts } from './SwapCoordinator.js';
import { transition, updateSwapRevision, SwapRevisionConflict } from './SwapStateMachine.js';
import { verifyHtlcSpend } from '../bitcoin/SpendEvidence.js';

export type PaymentEvidence = { hash: string; status: 'SUCCEEDED'; valueSats: number; feeSats: number };
export interface ReverseTestControls {
  claimDestination: string;
  routingFeeLimitSats?: 0 | 100;
  startPayment(swap: Swap): Promise<{ result: Promise<PaymentEvidence>; stopClient(): void }>;
  waitAccepted(swap: Swap): Promise<void>;
  mineFor(txid: string): Promise<void>;
  signClaim(swap: Swap): Promise<Transaction>;
  broadcastClaim(hex: string): Promise<string>;
  findClaim(swap: Swap): Promise<string>;
}

/** Separate capability so reconciliation cannot accidentally start a second payment. */
export interface ReverseReconcileControls {
  lookupPayment(hash: string): Promise<ReversePaymentStatus>;
}

export async function reconcileControlledReverse(store: Store, ports: SwapPorts, controls: ReverseReconcileControls,
  id: string, expectedRevision: number) {
  return new SwapCoordinator(store, ports).reconcileReverse(id, expectedRevision, hash => controls.lookupPayment(hash));
}

function checkClaim(claim: Transaction, swap: Swap, destination: string) {
  if (!swap.lockup || verifyHtlcSpend(claim.toHex(), claim.getId(), swap.lockup.hex, swap.lockup.vout, swap.contract).kind !== 'claim') throw new Error('Client claim verification failed');
  const expectedOutput = address.toOutputScript(destination, networks.regtest);
  if (claim.outs.length !== 1 || claim.outs[0]!.value !== BigInt(swap.quote.amountSats - swap.quote.claimFeeSats) ||
    !Buffer.from(claim.outs[0]!.script).equals(expectedOutput)) throw new Error('Claim differs from approved destination or fee');
}

/** Execute one newly authorized stage after fresh reconciliation. Never sends payment, retries an
 * existing broadcast/settlement, or mines. Call again with the returned revision after observation.
 */
export async function resumeControlledReverse(store: Store, ports: SwapPorts,
  controls: ReverseReconcileControls & Pick<ReverseTestControls, 'claimDestination' | 'signClaim' | 'broadcastClaim'>,
  id: string, expectedRevision: number): Promise<Swap> {
  const coordinator = new SwapCoordinator(store, ports);
  const report = await coordinator.reconcileReverse(id, expectedRevision, hash => controls.lookupPayment(hash));
  let swap = report.swap;
  try {
    if (report.next === 'FUND') return await coordinator.fundAccepted(id, swap.revision);
    if (report.next === 'SETTLE') return await coordinator.observeClaim(id, swap.claimTxid!, swap.revision);
    if (report.next !== 'CLAIM') return swap;
    const claim = await controls.signClaim(swap);
    checkClaim(claim, swap, controls.claimDestination);
    // Signing may take time. Recheck invoice and active-chain funding before journaling a broadcast.
    const fresh = await coordinator.reconcileReverse(id, swap.revision, hash => controls.lookupPayment(hash));
    swap = fresh.swap;
    if (fresh.next !== 'CLAIM') return swap;
    swap = await updateSwapRevision(store, id, swap.revision, s => {
      s.clientClaimIntent = { txid: claim.getId(), destination: controls.claimDestination, feeSats: s.quote.claimFeeSats, status: 'INTENT' };
    });
    await ports.assertRegtest();
    if (store.read().swaps[id]!.revision !== swap.revision) throw new Error('Stale swap revision; reconcile again');
    if (await controls.broadcastClaim(claim.toHex()) !== claim.getId()) throw new Error('Claim RPC identity mismatch');
    return await updateSwapRevision(store, id, swap.revision, s => { s.clientClaimIntent!.status = 'BROADCAST'; });
  } catch (error) {
    // Do not overwrite a newer reconciliation or another actor's journal.
    if (store.read().swaps[id]!.revision === swap.revision) await updateSwapRevision(store, id, swap.revision, s => {
      if (s.clientClaimIntent?.status === 'INTENT') s.clientClaimIntent.status = 'UNKNOWN';
      transition(s, 'MANUAL_REVIEW');
    });
    throw error;
  }
}

/** One approved happy-path run. Ambiguous/failed runs stop with durable context. */
export async function runControlledReverse(store: Store, ports: SwapPorts, controls: ReverseTestControls, id: string) {
  const initial = store.read().swaps[id];
  if (!initial || initial.state !== 'INVOICE_CREATED' || !initial.invoice || initial.pendingAction || initial.clientPayment || initial.lockup || initial.fundingIntent) {
    throw new Error('Run has existing/uncertain actions; reconcile instead of retrying payment or funding');
  }
  await ports.assertRegtest();
  // Refuse expired/canceled, already-held or substituted invoices before starting
  // a payer client or writing a payment intent. A prior invoice-create RPC is
  // not evidence that the invoice remains payable now.
  const invoice = await ports.invoice(initial.contract.paymentHash);
  if (invoice.state !== 'OPEN' || invoice.r_hash !== Buffer.from(initial.contract.paymentHash, 'hex').toString('base64') ||
    invoice.value !== String(initial.quote.invoiceSats) || invoice.amt_paid_sat !== '0' ||
    invoice.payment_request !== initial.invoice || invoice.htlcs?.some(h => h.state === 'ACCEPTED' || h.state === 'SETTLED')) {
    throw new Error('Invoice is not the exact unpaid open invoice; reconcile before payment');
  }
  const tip = await ports.tip();
  if (!Number.isSafeInteger(tip) || tip < 0 || tip > initial.contract.timeoutHeight - 10) throw new Error('Insufficient on-chain claim window before payment');
  const feeLimitSats = controls.routingFeeLimitSats ?? 100;
  let owned = await updateSwapRevision(store, id, initial.revision, s => { s.clientPayment = { hash: initial.contract.paymentHash, status: 'INTENT', feeLimitSats }; });
  const journal = async (fn: (swap: Swap) => void) => { owned = await updateSwapRevision(store, id, owned.revision, fn); return owned; };
  const mine = async (txid: string) => {
    const fromHeight = await ports.tip();
    if (!Number.isSafeInteger(fromHeight) || fromHeight < 0) throw new Error('Invalid mining start height');
    await journal(s => { (s.miningIntents ??= []).push({ txid, fromHeight, status: 'INTENT' }); });
    await controls.mineFor(txid);
    const evidence = await ports.confirmed(txid);
    if (!Number.isSafeInteger(evidence.confirmations) || evidence.confirmations < 1 || Transaction.fromHex(evidence.hex).getId() !== txid) throw new Error('Mining confirmation unverified');
    await journal(s => { s.miningIntents!.at(-1)!.status = 'CONFIRMED'; });
  };
  let payment: Awaited<ReturnType<ReverseTestControls['startPayment']>> | undefined;
  let payerFailed = false;
  const requirePayerObservation = () => { if (payerFailed) throw new Error('Payer outcome uncertain; reconcile existing payment'); };
  const coordinator = new SwapCoordinator(store, { assertRegtest: () => ports.assertRegtest(), invoice: hash => ports.invoice(hash),
    tip: () => ports.tip(), confirmed: txid => ports.confirmed(txid), createInvoice: swap => ports.createInvoice(swap),
    prepareLockup: swap => { requirePayerObservation(); return ports.prepareLockup(swap); },
    broadcast: hex => { requirePayerObservation(); return ports.broadcast(hex); },
    // Once a claim is public, settlement still uses exact confirmed claim/held-invoice evidence.
    settle: preimage => ports.settle(preimage), cancel: hash => ports.cancel(hash) });
  try {
    payment = await controls.startPayment(initial);
    void payment.result.catch(() => { payerFailed = true; }); // Never continue funding after known observation failure.
    await controls.waitAccepted(initial);
    requirePayerObservation();
    await journal(s => { s.clientPayment!.status = 'IN_FLIGHT'; });
    const funded = await coordinator.fundAccepted(id, owned.revision); owned = funded;
    if (!funded.lockup || funded.state !== 'LOCKUP_BROADCAST') throw new Error('Funding outcome unverified');
    await mine(funded.lockup.txid);
    const confirmed = await coordinator.confirmLockup(id); owned = confirmed;
    if (confirmed.state !== 'LOCKUP_CONFIRMED') throw new Error('Funding confirmation unverified');
    requirePayerObservation();
    const claim = await controls.signClaim(confirmed);
    checkClaim(claim, confirmed, controls.claimDestination);
    await journal(s => { s.clientClaimIntent = { txid: claim.getId(), destination: controls.claimDestination, feeSats: confirmed.quote.claimFeeSats, status: 'INTENT' }; });
    requirePayerObservation();
    const txid = await controls.broadcastClaim(claim.toHex());
    if (txid !== claim.getId()) throw new Error('Claim RPC identity mismatch');
    await journal(s => { s.clientClaimIntent!.status = 'BROADCAST'; });
    await mine(txid);
    if (await controls.findClaim(store.read().swaps[id]!) !== txid) throw new Error('Observed spend is not the client claim');
    owned = await coordinator.observeClaim(id, txid, owned.revision);
    if (store.read().swaps[id]!.state !== 'LIGHTNING_SETTLED') throw new Error('Provider settlement not observed');
    const paid = await payment.result;
    if (paid.status !== 'SUCCEEDED' || paid.hash !== initial.contract.paymentHash || paid.valueSats !== initial.quote.invoiceSats ||
      !Number.isSafeInteger(paid.feeSats) || paid.feeSats < 0 || paid.feeSats > feeLimitSats) throw new Error('Payer completion evidence invalid');
    await journal(s => { const p = s.clientPayment!; p.status = 'SUCCEEDED'; p.feeSats = paid.feeSats; });
    const complete = await coordinator.complete(id);
    if (complete.state !== 'COMPLETED') throw new Error('Final confirmation/settlement evidence missing');
    return complete;
  } catch (error) {
    // Client shutdown is best effort; it cannot suppress durable failure handling.
    try { payment?.stopClient(); } catch { /* Preserve the original uncertain outcome. */ }
    try {
      // Only abandon the exact journal this invocation last committed/received.
      // A newer coordinator intent or actor update must be reconciled as it stands.
      await updateSwapRevision(store, id, owned.revision, swap => {
        // Also fence legacy adapters that changed the snapshot without bumping revision.
        if (JSON.stringify(swap) !== JSON.stringify(owned)) throw new SwapRevisionConflict();
        if (['COMPLETED', 'REFUNDED', 'FAILED', 'EXPIRED'].includes(swap.state)) return;
        if (swap.clientPayment && swap.clientPayment.status !== 'SUCCEEDED') swap.clientPayment.status = 'UNKNOWN';
        if (swap.clientClaimIntent?.status === 'INTENT') swap.clientClaimIntent.status = 'UNKNOWN';
        transition(swap, 'MANUAL_REVIEW');
      });
    } catch (cleanupError) {
      // Never adopt the current revision and retry cleanup after losing ownership.
      if (!(cleanupError instanceof SwapRevisionConflict)) throw cleanupError;
    }
    throw error;
  }
}
