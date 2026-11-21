import { transition, reconcileTransition, updateSwapRevision } from './SwapStateMachine.js';
import { terminal, type Swap, type SwapState, type ReversePaymentStatus, type ReverseReconciliation, type ReverseReconciledState } from './SwapTypes.js';
import type { Store } from '../persistence/Store.js';
import type { Invoice } from '../lightning/LndClient.js';
import { HoldInvoiceManager } from '../lightning/HoldInvoiceManager.js';
import { verifyHtlcSpend } from '../bitcoin/SpendEvidence.js';
import { buildHtlc } from '../bitcoin/HtlcBuilder.js';
import { Transaction, address, networks } from 'bitcoinjs-lib';

/** Adapters must independently verify consensus evidence. Never expose these events over HTTP. */
export interface SwapPorts {
  assertRegtest(): Promise<void>;
  invoice(hash: string): Promise<Invoice>;
  createInvoice(swap: Swap): Promise<string>;
  prepareLockup(swap: Swap): Promise<NonNullable<Swap['lockup']>>;
  broadcast(hex: string): Promise<string>;
  settle(preimage: string): Promise<unknown>;
  cancel(hash: string): Promise<unknown>;
  tip(): Promise<number>;
  confirmed(txid: string): Promise<{ hex: string; confirmations: number }>;
}

export class SwapCoordinator {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private store: Store, private ports: SwapPorts) {}
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn); this.queue = result.catch(() => {}); return result;
  }
  private get(id: string): Swap {
    const swap = this.store.read().swaps[id]; if (!swap) throw new Error('Swap missing'); return swap;
  }
  private assertRevision(id: string, revision: number) {
    if (this.get(id).revision !== revision) throw new Error('Stale swap revision; reconcile again');
  }
  private async externalAction<T>(id: string, revision: number, action: () => Promise<T>): Promise<T> {
    this.assertRevision(id, revision);
    try { return await action(); }
    catch (error) {
      if (this.get(id).revision === revision) await this.update(id, s => { transition(s, 'MANUAL_REVIEW'); }, revision);
      throw error;
    }
  }
  private assertInvoiceRequest(swap: Swap, invoice: Invoice) {
    if (!swap.invoice || invoice.payment_request !== swap.invoice) throw new Error('Invoice request identity changed');
  }
  private update(id: string, fn: (swap: Swap) => void, revision = this.get(id).revision) {
    return updateSwapRevision(this.store, id, revision, fn);
  }
  private move(id: string, state: SwapState) { return this.update(id, s => { transition(s, state); }); }
  async issueInvoice(id: string): Promise<Swap> {
    return this.exclusive(async () => {
      let swap = this.get(id);
      if (swap.state !== 'QUOTED') return swap;
      if (swap.pendingAction) return this.move(id, 'MANUAL_REVIEW');
      await this.update(id, s => { s.pendingAction = 'CREATE_INVOICE'; });
      // Unknown remote outcome leaves a durable intent; never create a second invoice blindly.
      await this.ports.assertRegtest();
      const invoice = await this.ports.createInvoice(swap);
      return this.update(id, s => { s.invoice = invoice; delete s.pendingAction; transition(s, 'INVOICE_CREATED'); });
    });
  }
  async fundAccepted(id: string, expectedRevision?: number): Promise<Swap> {
    return this.exclusive(async () => {
      let swap = this.get(id);
      if (expectedRevision !== undefined && swap.revision !== expectedRevision) throw new Error('Stale swap revision; reconcile again');
      if (!['INVOICE_CREATED', 'INVOICE_ACCEPTED'].includes(swap.state)) return swap;
      if (swap.pendingAction) return this.move(id, 'MANUAL_REVIEW');
      const invoice = await this.ports.invoice(swap.contract.paymentHash);
      this.assertInvoiceRequest(swap, invoice);
      new HoldInvoiceManager({ lookup: this.ports.invoice, settle: this.ports.settle, cancel: this.ports.cancel })
        .assertAccepted(invoice, swap.contract.paymentHash, swap.quote.invoiceSats, swap.contract.timeoutHeight, 40);
      if (await this.ports.tip() > swap.contract.timeoutHeight - 10) throw new Error('Insufficient on-chain claim window');
      swap = await this.update(id, s => { transition(s, 'INVOICE_ACCEPTED'); s.pendingAction = 'PREPARE_LOCKUP'; }, swap.revision);
      await this.ports.assertRegtest();
      this.assertRevision(id, swap.revision);
      const lockup = await this.externalAction(id, swap.revision, () => this.ports.prepareLockup(swap));
      const funding = Transaction.fromHex(lockup.hex);
      const output = funding.outs[lockup.vout];
      if (funding.getId() !== lockup.txid || !Number.isInteger(lockup.vout) || lockup.vout < 0 || !output ||
        output.value !== BigInt(swap.quote.amountSats) || !Buffer.from(output.script).equals(buildHtlc(swap.contract).output)) {
        return this.move(id, 'MANUAL_REVIEW');
      }
      swap = await this.update(id, s => { s.lockup = lockup; s.pendingAction = 'BROADCAST_LOCKUP'; }, swap.revision);
      // Funding might be slow: recheck both deadlines immediately before broadcast.
      const beforeBroadcast = await this.ports.invoice(swap.contract.paymentHash);
      this.assertInvoiceRequest(swap, beforeBroadcast);
      new HoldInvoiceManager({ lookup: this.ports.invoice, settle: this.ports.settle, cancel: this.ports.cancel })
        .assertAccepted(beforeBroadcast, swap.contract.paymentHash, swap.quote.invoiceSats, swap.contract.timeoutHeight, 40);
      if (await this.ports.tip() > swap.contract.timeoutHeight - 10) return this.move(id, 'MANUAL_REVIEW');
      await this.ports.assertRegtest();
      this.assertRevision(id, swap.revision);
      const txid = await this.externalAction(id, swap.revision, () => this.ports.broadcast(lockup.hex));
      if (txid !== lockup.txid) return this.move(id, 'MANUAL_REVIEW');
      return this.update(id, s => { delete s.pendingAction; transition(s, 'LOCKUP_BROADCAST'); }, swap.revision);
    });
  }
  async confirmLockup(id: string) {
    return this.exclusive(async () => {
      const swap = this.get(id);
      if (swap.state !== 'LOCKUP_BROADCAST' || !swap.lockup) return swap;
      const tx = await this.ports.confirmed(swap.lockup.txid);
      if (!Number.isSafeInteger(tx.confirmations) || tx.confirmations < 1) return swap;
      if (tx.hex !== swap.lockup.hex) return this.move(id, 'MANUAL_REVIEW');
      return this.update(id, s => { transition(s, 'LOCKUP_CONFIRMED'); }, swap.revision);
    });
  }
  async observeClaim(id: string, txid: string, expectedRevision?: number) {
    return this.exclusive(async () => {
      let swap = this.get(id);
      if (expectedRevision !== undefined && swap.revision !== expectedRevision) throw new Error('Stale swap revision; reconcile again');
      if (!['LOCKUP_CONFIRMED', 'REFUND_PENDING', 'CLAIM_DETECTED'].includes(swap.state) || !swap.lockup) return swap;
      if (swap.pendingAction) return this.move(id, 'MANUAL_REVIEW');
      if (swap.claimTxid && swap.claimTxid !== txid) return this.move(id, 'MANUAL_REVIEW');
      const tx = await this.ports.confirmed(txid);
      if (!Number.isSafeInteger(tx.confirmations) || tx.confirmations < 1) return swap;
      const evidence = verifyHtlcSpend(tx.hex, txid, swap.lockup.hex, swap.lockup.vout, swap.contract);
      if (evidence.kind !== 'claim') throw new Error('Not a verified claim');
      swap = await this.update(id, s => { s.claimTxid = txid; s.pendingAction = 'SETTLE'; transition(s, 'CLAIM_DETECTED'); }, swap.revision);
      const manager = new HoldInvoiceManager({ lookup: async h => {
        const invoice = await this.ports.invoice(h); this.assertInvoiceRequest(swap, invoice); return invoice;
      }, settle: async p => {
        // Revalidate consensus immediately before revealing the secret to LND.
        const current = await this.ports.confirmed(txid);
        if (!Number.isSafeInteger(current.confirmations) || current.confirmations < 1) throw new Error('Claim confirmation lost');
        const checked = verifyHtlcSpend(current.hex, txid, swap.lockup!.hex, swap.lockup!.vout, swap.contract);
        if (checked.kind !== 'claim' || checked.preimage !== p) throw new Error('Claim evidence changed');
        await this.ports.assertRegtest();
        this.assertRevision(id, swap.revision);
        return this.externalAction(id, swap.revision, () => this.ports.settle(p));
      }, cancel: h => this.ports.cancel(h) });
      if (!(await manager.settleVerified(swap.contract.paymentHash, evidence.preimage, swap.quote.invoiceSats))) return this.update(id, s => { transition(s, 'MANUAL_REVIEW'); }, swap.revision);
      return this.update(id, s => { delete s.pendingAction; transition(s, 'LIGHTNING_SETTLED'); }, swap.revision);
    });
  }
  async complete(id: string) {
    return this.exclusive(async () => {
      const swap = this.get(id);
      if (swap.state !== 'LIGHTNING_SETTLED' || !swap.claimTxid) return swap;
      if (swap.clientPayment && swap.clientPayment.status !== 'SUCCEEDED') return this.move(id, 'MANUAL_REVIEW');
      const tx = await this.ports.confirmed(swap.claimTxid);
      if (!Number.isSafeInteger(tx.confirmations) || tx.confirmations < 1 || !swap.lockup) return this.move(id, 'MANUAL_REVIEW');
      if (verifyHtlcSpend(tx.hex, swap.claimTxid, swap.lockup.hex, swap.lockup.vout, swap.contract).kind !== 'claim') return this.move(id, 'MANUAL_REVIEW');
      // This path only verifies a lookup; it never initiates settlement.
      const observed = new HoldInvoiceManager({ lookup: h => this.ports.invoice(h), settle: p => this.ports.settle(p), cancel: h => this.ports.cancel(h) });
      const invoice = await this.ports.invoice(swap.contract.paymentHash);
      try { this.assertInvoiceRequest(swap, invoice); observed.assertSettled(invoice, swap.contract.paymentHash, swap.quote.invoiceSats); }
      catch { return this.move(id, 'MANUAL_REVIEW'); }
      const final = await this.ports.confirmed(swap.claimTxid);
      if (!Number.isSafeInteger(final.confirmations) || final.confirmations < 1 || final.hex !== tx.hex) return this.move(id, 'MANUAL_REVIEW');
      return this.update(id, s => { transition(s, 'COMPLETED'); }, swap.revision);
    });
  }
  async expireUnfunded(id: string) {
    return this.exclusive(async () => {
      const swap = this.get(id);
      if (!['QUOTED', 'INVOICE_CREATED', 'INVOICE_ACCEPTED'].includes(swap.state) || swap.lockup || swap.pendingAction) throw new Error('Cannot expire a funded or uncertain swap');
      if (Date.now() < swap.quote.expiresAt) throw new Error('Swap not expired');
      if (swap.state !== 'QUOTED') {
        await this.update(id, s => { s.pendingAction = 'CANCEL_INVOICE'; });
        await this.ports.assertRegtest();
        await this.ports.cancel(swap.contract.paymentHash);
        new HoldInvoiceManager({ lookup: h => this.ports.invoice(h), settle: p => this.ports.settle(p), cancel: h => this.ports.cancel(h) })
          .assertCanceled(await this.ports.invoice(swap.contract.paymentHash), swap.contract.paymentHash, swap.quote.invoiceSats);
        await this.update(id, s => { delete s.pendingAction; });
      }
      return this.move(id, 'EXPIRED');
    });
  }
  async markRefundPending(id: string) {
    return this.exclusive(async () => {
      const swap = this.get(id);
      if (!['LOCKUP_BROADCAST', 'LOCKUP_CONFIRMED', 'REFUND_PENDING'].includes(swap.state)) return swap;
      if (await this.ports.tip() < swap.contract.timeoutHeight) throw new Error('Refund not available');
      return this.move(id, 'REFUND_PENDING');
    });
  }
  /** Observe a confirmed refund, reconcile cancellation, and recheck chain evidence. */
  async observeRefund(id: string, txid: string) {
    return this.exclusive(async () => {
      const swap = this.get(id);
      if (!['LOCKUP_BROADCAST', 'LOCKUP_CONFIRMED', 'REFUND_PENDING'].includes(swap.state) || !swap.lockup) return swap;
      if (swap.pendingAction || (swap.refundTxid && swap.refundTxid !== txid)) return this.move(id, 'MANUAL_REVIEW');
      const verify = async () => {
        const tx = await this.ports.confirmed(txid);
        if (!Number.isSafeInteger(tx.confirmations) || tx.confirmations < 1 ||
          verifyHtlcSpend(tx.hex, txid, swap.lockup!.hex, swap.lockup!.vout, swap.contract).kind !== 'refund') throw new Error('Refund not confirmed and verified');
      };
      await verify();
      await this.update(id, s => { s.refundTxid = txid; transition(s, 'REFUND_PENDING'); });
      const invoice = await this.ports.invoice(swap.contract.paymentHash);
      if (invoice.r_hash !== Buffer.from(swap.contract.paymentHash, 'hex').toString('base64') || invoice.state === 'SETTLED') return this.move(id, 'MANUAL_REVIEW');
      if (invoice.state !== 'CANCELED') {
        if (!['OPEN', 'ACCEPTED'].includes(invoice.state)) return this.move(id, 'MANUAL_REVIEW');
        await this.update(id, s => { s.pendingAction = 'CANCEL_INVOICE'; });
        await this.ports.assertRegtest();
        await this.ports.cancel(swap.contract.paymentHash);
      }
      const after = await this.ports.invoice(swap.contract.paymentHash);
      try { new HoldInvoiceManager({ lookup: h => this.ports.invoice(h), settle: p => this.ports.settle(p), cancel: h => this.ports.cancel(h) })
        .assertCanceled(after, swap.contract.paymentHash, swap.quote.invoiceSats); }
      catch { return this.move(id, 'MANUAL_REVIEW'); }
      try { await verify(); } catch { return this.move(id, 'MANUAL_REVIEW'); }
      return this.update(id, s => { delete s.pendingAction; transition(s, 'REFUNDED'); });
    });
  }
  /** Periodic/restart audit only. Missing evidence retains funds for manual review. */
  async auditEvidence(id: string) {
    return this.exclusive(async () => {
      const swap = this.get(id);
      if (!swap.lockup || ['FAILED', 'EXPIRED', 'MANUAL_REVIEW'].includes(swap.state)) return swap;
      try {
        const funding = await this.ports.confirmed(swap.lockup.txid);
        if (!Number.isSafeInteger(funding.confirmations) || funding.confirmations < 1 || funding.hex !== swap.lockup.hex) throw new Error('Funding evidence lost');
        for (const [txid, kind] of [[swap.claimTxid, 'claim'], [swap.refundTxid, 'refund']] as const) {
          if (!txid) continue;
          const tx = await this.ports.confirmed(txid);
          if (!Number.isSafeInteger(tx.confirmations) || tx.confirmations < 1 || verifyHtlcSpend(tx.hex, txid, swap.lockup.hex, swap.lockup.vout, swap.contract).kind !== kind) throw new Error('Spend evidence lost');
        }
        const invoice = await this.ports.invoice(swap.contract.paymentHash);
        if (invoice.r_hash !== Buffer.from(swap.contract.paymentHash, 'hex').toString('base64') ||
          (swap.state === 'COMPLETED' && invoice.state !== 'SETTLED') || (swap.state === 'REFUNDED' && invoice.state !== 'CANCELED')) throw new Error('Invoice evidence changed');
        const observed = new HoldInvoiceManager({ lookup: h => this.ports.invoice(h), settle: p => this.ports.settle(p), cancel: h => this.ports.cancel(h) });
        if (swap.state === 'COMPLETED') observed.assertSettled(invoice, swap.contract.paymentHash, swap.quote.invoiceSats);
        if (swap.state === 'REFUNDED') observed.assertCanceled(invoice, swap.contract.paymentHash, swap.quote.invoiceSats);
        return swap;
      } catch { return this.move(id, 'MANUAL_REVIEW'); }
    });
  }
  /** Read-only external reconciliation. Lookup must query the existing payment by hash, never send it.
   * No raw transaction witness or payment response is written to the journal.
   * A missing/unconfirmed transaction is uncertainty, never permission to rebroadcast or mine.
   */
  async reconcileReverse(id: string, expectedRevision: number,
    lookupPayment: (hash: string) => Promise<ReversePaymentStatus>): Promise<ReverseReconciliation> {
    return this.exclusive(async () => {
      const swap = this.get(id);
      if (swap.revision !== expectedRevision) throw new Error('Stale swap revision; reconcile again');
      let next: ReverseReconciliation['next'] = 'MANUAL_REVIEW';
      let state: ReverseReconciledState = 'MANUAL_REVIEW';
      let payment: ReversePaymentStatus | undefined;
      const checkedTransactions = new Map<string, string>();
      const confirmed = async (txid: string) => {
        const tx = await this.ports.confirmed(txid);
        if (!Number.isSafeInteger(tx.confirmations) || tx.confirmations < 1 || Transaction.fromHex(tx.hex).getId() !== txid) throw new Error('Active-chain evidence missing');
        checkedTransactions.set(txid, tx.hex);
        return tx;
      };
      try {
        await this.ports.assertRegtest();
        if (!swap.clientPayment || !swap.invoice || ['FAILED', 'EXPIRED'].includes(swap.state) ||
          swap.clientPayment.hash !== swap.contract.paymentHash || !Number.isSafeInteger(swap.clientPayment.feeLimitSats) || swap.clientPayment.feeLimitSats < 0) throw new Error('Payment context missing');
        payment = await lookupPayment(swap.contract.paymentHash);
        if (payment.hash !== swap.contract.paymentHash || payment.valueSats !== swap.quote.invoiceSats ||
          !['IN_FLIGHT', 'SUCCEEDED', 'FAILED'].includes(payment.status) ||
          (payment.status === 'SUCCEEDED' && (!Number.isSafeInteger(payment.feeSats) || payment.feeSats! < 0 || payment.feeSats! > swap.clientPayment.feeLimitSats))) throw new Error('Payment evidence invalid');
        const invoice = await this.ports.invoice(swap.contract.paymentHash);
        const manager = new HoldInvoiceManager({ lookup: h => this.ports.invoice(h), settle: p => this.ports.settle(p), cancel: h => this.ports.cancel(h) });
        if (invoice.payment_request !== swap.invoice || invoice.r_hash !== Buffer.from(swap.contract.paymentHash, 'hex').toString('base64') || invoice.value !== String(swap.quote.invoiceSats)) throw new Error('Invoice identity changed');
        if (invoice.state === 'SETTLED') {
          manager.assertSettled(invoice, swap.contract.paymentHash, swap.quote.invoiceSats);
          if (payment.status !== 'SUCCEEDED') throw new Error('Payer settlement not observed');
        } else if (invoice.state === 'ACCEPTED') {
          manager.assertAccepted(invoice, swap.contract.paymentHash, swap.quote.invoiceSats, swap.contract.timeoutHeight, 40);
          if (payment.status !== 'IN_FLIGHT') throw new Error('Payer not in flight');
        } else if (invoice.state === 'CANCELED') {
          manager.assertCanceled(invoice, swap.contract.paymentHash, swap.quote.invoiceSats);
          if (payment.status !== 'FAILED') throw new Error('Payer failure not observed');
        } else throw new Error('Payment outcome remains uncertain');
        if (swap.miningIntents?.some(i => i.status === 'INTENT')) throw new Error('Mining outcome remains uncertain');
        if (swap.pendingAction && !['BROADCAST_LOCKUP', 'SETTLE', 'CANCEL_INVOICE', 'BROADCAST_REFUND'].includes(swap.pendingAction)) throw new Error('External action remains uncertain');
        if (!swap.lockup) {
          if (!['INVOICE_CREATED', 'INVOICE_ACCEPTED', 'MANUAL_REVIEW'].includes(swap.state) || swap.fundingIntent || swap.pendingAction || swap.clientClaimIntent || swap.claimTxid || swap.refundTxid || invoice.state !== 'ACCEPTED') throw new Error('Funding outcome remains uncertain');
          const tip = await this.ports.tip();
          if (!Number.isSafeInteger(tip) || tip < 0 || tip > swap.contract.timeoutHeight - 10) throw new Error('Claim window insufficient');
          state = 'INVOICE_ACCEPTED'; next = 'FUND';
        } else {
          const funding = await confirmed(swap.lockup.txid);
          const tx = Transaction.fromHex(funding.hex); const output = tx.outs[swap.lockup.vout];
          if (funding.hex !== swap.lockup.hex || !Number.isSafeInteger(swap.lockup.vout) || swap.lockup.vout < 0 || !output ||
            output.value !== BigInt(swap.quote.amountSats) || !Buffer.from(output.script).equals(buildHtlc(swap.contract).output)) throw new Error('Exact funding output missing');
          if (swap.fundingIntent && (swap.fundingIntent.fundingTxid !== swap.lockup.txid || swap.fundingIntent.fundingVout !== swap.lockup.vout || swap.fundingIntent.signedHex !== funding.hex ||
            tx.ins.filter(input => Buffer.from(input.hash).reverse().toString('hex') === swap.fundingIntent!.txid && input.index === swap.fundingIntent!.vout).length !== 1)) throw new Error('Funding intent differs from exact transaction');
          const claimTxid = swap.clientClaimIntent?.txid ?? swap.claimTxid;
          if (swap.claimTxid && claimTxid !== swap.claimTxid) throw new Error('Claim identity changed');
          if (claimTxid && swap.refundTxid) throw new Error('Conflicting spend intents');
          if (claimTxid) {
            const claim = await confirmed(claimTxid);
            if (verifyHtlcSpend(claim.hex, claimTxid, funding.hex, swap.lockup.vout, swap.contract).kind !== 'claim') throw new Error('Exact claim witness missing');
            if (swap.clientClaimIntent) {
              const intent = swap.clientClaimIntent; const spend = Transaction.fromHex(claim.hex);
              if (intent.feeSats !== swap.quote.claimFeeSats || spend.outs.length !== 1 || spend.outs[0]!.value !== BigInt(swap.quote.amountSats - intent.feeSats) ||
                !Buffer.from(spend.outs[0]!.script).equals(address.toOutputScript(intent.destination, networks.regtest))) throw new Error('Claim budget changed');
            }
            if (invoice.state === 'SETTLED') { state = 'COMPLETED'; next = 'DONE'; }
            else {
              if (invoice.state !== 'ACCEPTED' || swap.pendingAction === 'SETTLE' || (swap.pendingAction && swap.pendingAction !== 'BROADCAST_LOCKUP')) throw new Error('Settlement outcome remains uncertain');
              state = 'CLAIM_DETECTED'; next = 'SETTLE';
            }
          } else if (swap.refundTxid) {
            const refund = await confirmed(swap.refundTxid);
            if (verifyHtlcSpend(refund.hex, swap.refundTxid, funding.hex, swap.lockup.vout, swap.contract).kind !== 'refund' || invoice.state !== 'CANCELED') throw new Error('Refund/cancellation evidence missing');
            state = 'REFUNDED'; next = 'DONE';
          } else {
            if (invoice.state !== 'ACCEPTED' || (swap.pendingAction && swap.pendingAction !== 'BROADCAST_LOCKUP')) throw new Error('Spend outcome remains uncertain');
            const tip = await this.ports.tip();
            if (!Number.isSafeInteger(tip) || tip < 0 || tip > swap.contract.timeoutHeight - 10) throw new Error('Claim window insufficient');
            state = 'LOCKUP_CONFIRMED'; next = 'CLAIM';
          }
        }
        // Recheck after all other remote lookups; an earlier confirmation is not a finality guarantee.
        for (const [txid, hex] of checkedTransactions) {
          const fresh = await this.ports.confirmed(txid);
          if (!Number.isSafeInteger(fresh.confirmations) || fresh.confirmations < 1 || fresh.hex !== hex) throw new Error('Chain evidence changed');
        }
        if (['COMPLETED', 'REFUNDED'].includes(swap.state) && state !== swap.state) throw new Error('Terminal evidence lost');
      } catch {
        state = 'MANUAL_REVIEW'; next = 'MANUAL_REVIEW';
      }
      const result = await this.update(id, s => {
        // Also fence legacy adapters that have not yet adopted revisioned journal writes.
        if (JSON.stringify(s) !== JSON.stringify(swap)) throw new Error('Swap changed during reconciliation');
        if (next !== 'MANUAL_REVIEW') {
          s.clientPayment!.status = payment!.status;
          if (payment!.status === 'SUCCEEDED') s.clientPayment!.feeSats = payment!.feeSats;
          if (s.clientClaimIntent) { s.clientClaimIntent.status = 'BROADCAST'; s.claimTxid = s.clientClaimIntent.txid; }
          delete s.pendingAction;
        }
        if (!['FAILED', 'EXPIRED'].includes(s.state)) reconcileTransition(s, state);
      }, expectedRevision);
      return { swap: result, next };
    });
  }
  /** Safe offline fallback: payment-only interruptions also require explicit reconciliation. */
  async recover(): Promise<void> {
    await this.store.transaction(db => {
      for (const swap of Object.values(db.swaps)) {
        if (terminal.has(swap.state)) continue;
        if (Object.values(db.controlledExecutions ?? {}).some(run => run.swapId === swap.id && run.status !== 'COMPLETED') ||
          swap.clientPayment || swap.clientClaimIntent || swap.miningIntents?.length || swap.pendingAction || ['LOCKUP_BROADCAST', 'LOCKUP_CONFIRMED', 'CLAIM_DETECTED', 'LIGHTNING_SETTLED', 'REFUND_PENDING'].includes(swap.state)) transition(swap, 'MANUAL_REVIEW');
      }
    });
  }
}
