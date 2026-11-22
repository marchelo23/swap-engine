import { api, type Session, type ReverseAvailability, type OwnedPreparation } from './api.js';

/** Persist admission/review keys before POST. Network uncertainty retains the same
 * attempt across reload; this module has no payment/execution API call. */
export async function prepareForReview(owner: Session, available: ReverseAvailability, amountSats: number): Promise<string> {
  if (owner.user.role !== 'ADMIN' || !available.preparationAvailable) throw new Error('Preparation unavailable for this account.');
  const name = `swap-engine.preparation.${owner.user.id}`;
  type Saved = { key: string; id?: string; amountSats?: number; reviewKey?: string; reviewState?: 'INTENT' | 'CONFIRMED'; reviewedUntil?: number };
  const save = (value: Saved) => { localStorage.setItem(name, JSON.stringify(value)); return value; };
  const raw = localStorage.getItem(name); let saved: Saved | undefined;
  if (raw !== null) {
    const value = JSON.parse(raw) as Saved;
    if (!value || !/^[A-Za-z0-9_-]{8,128}$/.test(value.key) || (value.id && !/^[a-f0-9]{64}$/.test(value.id)) ||
      (value.reviewKey && !/^[A-Za-z0-9_-]{8,128}$/.test(value.reviewKey))) throw new Error('Saved preparation differs. Review existing status.');
    saved = value;
  }
  const signal = new AbortController().signal;
  let result: OwnedPreparation | undefined;
  let finishedId: string | undefined;
  if (saved?.id) result = await api.preparation(saved.id, signal);
  if (result && ['COMPLETED', 'EXPIRED', 'REJECTED'].includes(result.status)) { finishedId = result.id; saved = undefined; result = undefined; }
  const active = available.preparations?.find(p => p.id !== finishedId && !['COMPLETED', 'EXPIRED', 'REJECTED'].includes(p.status));
  // A second tab/device adopts the existing attempt instead of minting another invoice.
  if (!result && active) {
    saved = save({ key: crypto.randomUUID(), id: active.id }); result = await api.preparation(active.id, signal);
    if (['COMPLETED', 'EXPIRED', 'REJECTED'].includes(result.status)) { saved = undefined; result = undefined; }
  }
  if (!result) {
    saved ??= save({ key: crypto.randomUUID(), amountSats });
    if (saved.amountSats !== amountSats) throw new Error('A previous preparation has different terms. Review it before continuing.');
    result = await api.prepare(saved.key, owner.csrfToken, amountSats);
    saved = save({ ...saved, id: result.id });
  }
  for (let attempts = 0; result.status === 'INTENT' && attempts < 30; attempts++) {
    await new Promise(resolve => window.setTimeout(resolve, 1000)); result = await api.preparation(result.id, signal);
  }
  if (result.status === 'REJECTED') throw new Error('Regtest prerequisites unavailable. No invoice preparation was started. Refresh status before another explicit SWAP attempt.');
  if (result.status !== 'READY' || !result.swapId) throw new Error('Preparation needs reconciliation. The existing attempt is retained; no new invoice was requested.');
  const swap = await api.ownedSwap(result.swapId, signal);
  if (swap.payment.valueSats !== amountSats) throw new Error('An existing preparation has a different amount. Review it before continuing.');
  if (swap.execution.status !== 'NOT_STARTED') return swap.id;
  if (!swap.execution.approvedUntil || swap.execution.approvedUntil <= Date.now()) {
    // A fresh explicit SWAP click may review the SAME unused invoice after expiry.
    // Never reuse a successful review key to extend its authority.
    if (!saved?.reviewKey || saved.reviewState === 'CONFIRMED') saved = save({ ...saved!, reviewKey: crypto.randomUUID(), reviewState: 'INTENT' });
    await api.reviewPreparation(result.id, saved.reviewKey!, owner.csrfToken);
  }
  const verified = await api.ownedSwap(result.swapId, signal);
  if (saved?.reviewKey && verified.allowedActions.includes('EXECUTE') && verified.execution.approvedUntil && verified.execution.approvedUntil > Date.now())
    save({ ...saved, reviewState: 'CONFIRMED', reviewedUntil: verified.execution.approvedUntil });
  return result.swapId;
}
