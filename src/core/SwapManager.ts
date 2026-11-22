import { randomUUID } from 'node:crypto';
import { buildHtlc, sha256, type Contract } from '../bitcoin/HtlcBuilder.js';
import { assertLiquidity, type Balances } from '../liquidity/LiquidityManager.js';
import { Store } from '../persistence/Store.js';
import { transition } from './SwapStateMachine.js';
import type { Quote, Swap } from './SwapTypes.js';
import { LEGACY_ECONOMICS, type EconomicsConfig, type InvoiceEconomics } from './Economics.js';

/** User-specified Lightning debit, bounded by the existing controlled regtest profile. */
export function invoiceBudget(invoiceSats: number, policy: InvoiceEconomics = LEGACY_ECONOMICS.invoice) {
  if (!Number.isSafeInteger(invoiceSats) || invoiceSats < policy.minSats || invoiceSats > policy.maxSats)
    throw new Error('Amount must be ' + policy.minSats + '..' + policy.maxSats + ' sats');
  const serviceFeeSats = policy.serviceFeeBaseSats + Math.ceil(invoiceSats / policy.serviceFeeDivisor);
  return { amountSats: invoiceSats - serviceFeeSats, serviceFeeSats, invoiceSats,
    fundingReserveSats: policy.fundingReserveSats, claimFeeSats: policy.claimFeeSats };
}

export class SwapManager {
  constructor(readonly store: Store, readonly economics: EconomicsConfig = LEGACY_ECONOMICS) {}
  async quote(amountSats: number, now = Date.now()): Promise<Quote> {
    const policy = this.economics.quote;
    if (!Number.isSafeInteger(amountSats) || amountSats < policy.minAmountSats || amountSats > policy.maxAmountSats)
      throw new Error('Amount must be ' + policy.minAmountSats + '..' + policy.maxAmountSats + ' sats');
    const serviceFeeSats = policy.serviceFeeBaseSats + Math.ceil(amountSats * policy.serviceFeeBps / 10_000);
    const quote = { id: randomUUID(), amountSats, serviceFeeSats, invoiceSats: amountSats + serviceFeeSats,
      fundingReserveSats: policy.fundingReserveSats, claimFeeSats: policy.claimFeeSats, expiresAt: now + policy.ttlMs };
    return this.store.transaction(db => {
      for (const [id, q] of Object.entries(db.quotes)) if (q.expiresAt < now) delete db.quotes[id];
      db.quotes[quote.id] = quote; return quote;
    });
  }
  async quoteInvoice(invoiceSats: number, now = Date.now()): Promise<Quote> {
    const quote = { id: randomUUID(), ...invoiceBudget(invoiceSats, this.economics.invoice), expiresAt: now + this.economics.invoice.ttlMs };
    return this.store.transaction(db => {
      for (const [id, q] of Object.entries(db.quotes)) if (q.expiresAt < now) delete db.quotes[id];
      db.quotes[quote.id] = quote; return quote;
    });
  }
  async create(quoteId: string, idempotencyKey: string, contract: Contract, tip: number, balances: Balances, now = Date.now()): Promise<Swap> {
    buildHtlc(contract);
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(idempotencyKey)) throw new Error('Invalid idempotency key');
    const fingerprint = sha256(Buffer.from(JSON.stringify({ quoteId, paymentHash: contract.paymentHash, claimPublicKey: contract.claimPublicKey, refundPublicKey: contract.refundPublicKey, timeoutHeight: contract.timeoutHeight }))).toString('hex');
    return this.store.transaction(db => {
      const previous = Object.values(db.swaps).find(s => s.idempotencyKey === idempotencyKey);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new Error('Idempotency key conflict');
        return previous;
      }
      const quote = db.quotes[quoteId];
      if (!quote || quote.expiresAt <= now) throw new Error('Quote expired or missing');
      if (Object.values(db.swaps).some(s => s.quote.id === quoteId)) throw new Error('Quote already consumed');
      if (Object.values(db.swaps).some(s => s.contract.paymentHash === contract.paymentHash)) throw new Error('Payment hash already used');
      if (!Number.isSafeInteger(tip) || tip < 0 || contract.timeoutHeight < tip + 20 || contract.timeoutHeight > tip + 40) throw new Error('Refund height must be 20..40 blocks ahead');
      assertLiquidity(db, balances, quote.amountSats, quote.invoiceSats, quote.fundingReserveSats);
      const swap: Swap = { id: randomUUID(), idempotencyKey, fingerprint, quote, contract, state: 'CREATED', revision: 0, createdAt: now, updatedAt: now, history: [{ state: 'CREATED', at: now }] };
      transition(swap, 'QUOTED', now);
      db.swaps[swap.id] = swap;
      return swap;
    });
  }
  get(id: string) { return this.store.read().swaps[id]; }
}
