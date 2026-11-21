import { terminal, type Swap, type SwapState, type ReverseReconciledState } from './SwapTypes.js';
import type { Store } from '../persistence/Store.js';

export class SwapRevisionConflict extends Error {
  constructor() { super('Stale swap revision; reconcile again'); this.name = 'SwapRevisionConflict'; }
}

/** Compare-and-swap all journal mutations, including intents that do not change state. */
export function updateSwapRevision(store: Store, id: string, expectedRevision: number, fn: (swap: Swap) => void) {
  return store.transaction(db => {
    const swap = db.swaps[id];
    if (!swap || swap.revision !== expectedRevision) throw new SwapRevisionConflict();
    const before = JSON.stringify(swap);
    fn(swap);
    if (JSON.stringify(swap) !== before && swap.revision === expectedRevision) { swap.revision++; swap.updatedAt = Date.now(); }
    return swap;
  });
}

/** Only the evidence reconciler may leave MANUAL_REVIEW; normal transitions stay closed. */
export function reconcileTransition(swap: Swap, next: ReverseReconciledState) {
  if (swap.state === next) return;
  if (['FAILED', 'EXPIRED'].includes(swap.state)) throw new Error('Cannot resume released swap');
  if (terminal.has(swap.state) && next !== 'MANUAL_REVIEW') throw new Error('Cannot replace terminal evidence');
  if (next !== 'MANUAL_REVIEW') {
    if (!swap.clientPayment || !swap.invoice || swap.pendingAction) throw new Error('Reconciliation context missing');
    if (next === 'INVOICE_ACCEPTED' && (swap.lockup || swap.fundingIntent || swap.clientPayment.status !== 'IN_FLIGHT')) throw new Error('Unsafe funding resume');
    if (next !== 'INVOICE_ACCEPTED' && !swap.lockup) throw new Error('Reconciliation funding missing');
    if (['CLAIM_DETECTED', 'COMPLETED'].includes(next) && !swap.claimTxid) throw new Error('Reconciliation claim missing');
    if (next === 'COMPLETED' && swap.clientPayment.status !== 'SUCCEEDED') throw new Error('Payer settlement missing');
    if (next === 'REFUNDED' && (!swap.refundTxid || swap.clientPayment.status !== 'FAILED')) throw new Error('Refund context missing');
  }
  swap.state = next; swap.revision++; swap.updatedAt = Date.now();
  swap.history.push({ state: next, at: swap.updatedAt });
}

const allowed: Record<SwapState, SwapState[]> = {
  CREATED: ['QUOTED', 'FAILED'], QUOTED: ['INVOICE_CREATED', 'EXPIRED', 'FAILED'],
  INVOICE_CREATED: ['INVOICE_ACCEPTED', 'EXPIRED', 'FAILED'],
  INVOICE_ACCEPTED: ['LOCKUP_BROADCAST', 'EXPIRED', 'FAILED'],
  LOCKUP_BROADCAST: ['LOCKUP_CONFIRMED', 'REFUND_PENDING'],
  LOCKUP_CONFIRMED: ['CLAIM_DETECTED', 'REFUND_PENDING'],
  CLAIM_DETECTED: ['LIGHTNING_SETTLED'], LIGHTNING_SETTLED: ['COMPLETED'],
  REFUND_PENDING: ['REFUNDED', 'CLAIM_DETECTED'], MANUAL_REVIEW: [],
  COMPLETED: [], EXPIRED: [], REFUNDED: [], FAILED: [],
};
export function transition(swap: Swap, next: SwapState, now = Date.now()): boolean {
  if (swap.state === next) return false;
  if (['FAILED', 'EXPIRED'].includes(next) && (swap.lockup || swap.pendingAction)) throw new Error('Cannot release a funded or uncertain swap');
  const evidenceLost = ['COMPLETED', 'REFUNDED'].includes(swap.state) && next === 'MANUAL_REVIEW';
  if ((terminal.has(swap.state) && !evidenceLost) || (!allowed[swap.state].includes(next) && next !== 'MANUAL_REVIEW')) throw new Error(`Illegal transition ${swap.state} -> ${next}`);
  swap.state = next; swap.revision++; swap.updatedAt = now; swap.history.push({ state: next, at: now });
  return true;
}
