import type { ArkSwapStatus } from './api.js';

export function arkProgress(swap: ArkSwapStatus) {
  if (swap.status === 'CONFIRMED' && /^[a-f0-9]{64}$/.test(swap.commitmentTxid ?? '')) return 'confirmed';
  if (swap.status === 'REJECTED') return 'rejected';
  if (swap.status === 'UNCERTAIN' || swap.status === 'CONFIRMED') return 'uncertain';
  return 'pending';
}

export function arkStatusLabel(swap: ArkSwapStatus) {
  const operation = swap.route === 'onchain-to-ark' ? 'Boarding' : 'Offboarding';
  const progress = arkProgress(swap);
  return `${operation} · ${progress === 'pending' ? 'pending confirmation' : progress}`;
}
