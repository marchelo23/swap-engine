import { api, type ArkSwapStatus, type OwnedPreparation, type OwnedSwap, type Quote, type Session } from './api.js';
import { arkProgress } from './arkStatus.js';
import { describeSwapState } from '../ui/swapStatus.js';
import type { SwapState } from '../core/SwapTypes.js';
import { railLabel, type Pair } from './rails.js';
import { details, get, integer, sats, text } from './ui.js';

const statuses = ['Quoted', 'Pending', 'Confirmed', 'Failed', 'Expired', 'Refunded', 'Needs review'] as const;
type Status = typeof statuses[number];
type Entry = { id: string; route: string; status: Status; quoteId?: string; fields: [string, string][] };
type QuoteEntry = { route: string; quote: Quote };
const reverseRoute = 'Lightning → On-chain';
const reverseStates: Partial<Record<SwapState, Status>> = { COMPLETED: 'Confirmed', FAILED: 'Failed', EXPIRED: 'Expired', REFUNDED: 'Refunded',
  QUOTED: 'Quoted', MANUAL_REVIEW: 'Needs review' };

function financials(quote: Quote, net = quote.amountSats - quote.claimFeeSats, invoice = true): Entry['fields'] {
  return [[invoice ? 'Lightning invoice' : 'Quoted debit', sats(quote.invoiceSats)],
    ['Service fee', sats(quote.serviceFeeSats)], ['Estimated claim or network fee', sats(quote.claimFeeSats)],
    ['Estimated net receipt', sats(net)]];
}

function reverseEntry(swap: OwnedSwap): Entry {
  const status = reverseStates[swap.state]
    ?? (swap.execution.status === 'RECONCILIATION_REQUIRED' ? 'Needs review' : 'Pending');
  return { id: swap.id, quoteId: swap.quote.id, route: reverseRoute, status, fields: [
    ['Swap ID', swap.id], ['Backend state', describeSwapState(swap.state).label],
    ['Lightning sent', swap.payment.status === 'SUCCEEDED' ? sats(swap.payment.valueSats) : 'Unconfirmed'],
    ...financials(swap.quote, swap.claim.netSats),
    ['Actual routing fee', swap.payment.feeSats === null ? 'Unknown' : sats(swap.payment.feeSats)],
  ] };
}

function preparationEntry(attempt: OwnedPreparation): Entry {
  const status = { INTENT: 'Pending', READY: 'Pending', UNKNOWN: 'Needs review', COMPLETED: 'Confirmed',
    EXPIRED: 'Expired', REJECTED: 'Failed' } as const;
  return { id: attempt.id, route: reverseRoute, status: status[attempt.status], fields: [
    ['Preparation ID', attempt.id], ['Backend state', attempt.status],
  ] };
}

function arkEntry(swap: ArkSwapStatus): Entry {
  const status = { pending: 'Pending', confirmed: 'Confirmed', rejected: 'Failed', uncertain: 'Needs review' } as const;
  return { id: swap.id, quoteId: swap.quote.id, route: swap.route === 'onchain-to-ark' ? 'On-chain → Ark' : 'Ark → On-chain',
    status: status[arkProgress(swap)], fields: [
      ['Swap ID', swap.id], ['Method', swap.method === 'boarding' ? 'Boarding' : 'Cooperative offboarding'],
      ['Backend state', swap.status], ...financials(swap.quote, swap.quote.netSats, false),
      ['Commitment TXID', swap.commitmentTxid ?? 'Unavailable'],
    ] };
}

export function accountEntries(owned: OwnedSwap[], preparations: OwnedPreparation[], ark: ArkSwapStatus[], quotes: QuoteEntry[], now: number) {
  const swaps = new Map<string, OwnedSwap>();
  for (const swap of owned) {
    if ((swaps.get(swap.id)?.revision ?? -1) < swap.revision) swaps.set(swap.id, swap);
  }
  const arkSwaps = new Map<string, ArkSwapStatus>();
  for (const swap of ark) {
    if ((arkSwaps.get(swap.id)?.updatedAt ?? -1) < swap.updatedAt) arkSwaps.set(swap.id, swap);
  }
  const entries = [...[...swaps.values()].map(reverseEntry), ...[...arkSwaps.values()].map(arkEntry)];
  const quoteIds = new Set(entries.map(entry => `${entry.route}:${entry.quoteId}`));
  for (const attempt of new Map(preparations.map(item => [item.id, item])).values()) {
    if (!attempt.swapId || !swaps.has(attempt.swapId)) entries.push(preparationEntry(attempt));
  }
  for (const { route, quote } of quotes) {
    const key = `${route}:${quote.id}`;
    if (quoteIds.has(key)) continue;
    quoteIds.add(key);
    entries.push({ id: quote.id, route, status: quote.expiresAt > now ? 'Quoted' : 'Expired', fields: [
      ['Quote ID', quote.id], ['Scope', 'Reviewed in this session'], ...financials(quote, undefined, route === reverseRoute),
    ] });
  }
  return entries;
}

export function mountAccountHistory() {
  const list = get('account-history-list');
  const routeFilter = get<HTMLSelectElement>('account-history-route');
  const stateFilter = get<HTMLSelectElement>('account-history-state');
  stateFilter.append(...statuses.map(status => new Option(status, status)));
  let session: Session | null = null;
  let controller: AbortController | undefined;
  let quoteExpiry: number | undefined;
  let owned: OwnedSwap[] = []; let preparations: OwnedPreparation[] = []; let ark: ArkSwapStatus[] = [];
  let missing: string[] = [];
  const quotes = new Map<string, QuoteEntry>();

  function render() {
    window.clearTimeout(quoteExpiry);
    const now = Date.now();
    const recent = [...quotes.values()].reverse();
    const entries = accountEntries(owned, preparations, ark, recent, now);
    const nextExpiry = Math.min(...recent.map(({ quote }) => quote.expiresAt).filter(expiry => expiry > now));
    if (Number.isFinite(nextExpiry)) quoteExpiry = window.setTimeout(render, Math.min(nextExpiry - now, 2_147_483_647));
    text('account-history-tag', missing.length ? 'PARTIAL' : 'PRIVATE');
    text('account-history-status', missing.length ? `History unavailable for ${missing.join(' and ')}.` : 'Swaps and attempts belonging to this account.');
    const shown = entries.filter(entry => (!routeFilter.value || entry.route === routeFilter.value) && (!stateFilter.value || stateFilter.value === entry.status));
    const counts: Record<string, number> = {
      'active': entries.filter(entry => entry.status === 'Pending').length,
      'completed': entries.filter(entry => entry.status === 'Confirmed').length,
      'failed': entries.filter(entry => entry.status === 'Failed').length,
      'expired': entries.filter(entry => entry.status === 'Expired').length,
      'refunded': entries.filter(entry => entry.status === 'Refunded').length,
    };
    for (const [id, count] of Object.entries(counts)) text(`account-${id}-swaps`, missing.length === 2 && !count ? '—' : integer(count));
    text('account-history-results', shown.length ? `${integer(shown.length)} ${shown.length === 1 ? 'record' : 'records'}` : 'No matching records.');
    list.replaceChildren(...shown.map(entry => {
      const item = document.createElement('li'); item.className = 'tx-card';
      const head = document.createElement('div'); head.className = 'tx-head';
      const route = document.createElement('span'); route.className = 'tx-route'; route.textContent = entry.route;
      const badge = document.createElement('span'); badge.className = 'tag'; badge.textContent = entry.status;
      const evidence = document.createElement('dl'); evidence.className = 'details'; details(evidence, entry.fields);
      head.append(route, badge); item.append(head, evidence); return item;
    }));
    list.hidden = shown.length === 0;
  }

  for (const filter of [routeFilter, stateFilter]) filter.addEventListener('change', render);

  return {
    setSession(next: Session | null) {
      if (session === next) return;
      controller?.abort(); controller = undefined;
      window.clearTimeout(quoteExpiry);
      session = next; owned = []; preparations = []; ark = []; missing = [];
      quotes.clear(); routeFilter.value = ''; stateFilter.value = '';
      list.replaceChildren(); list.hidden = true;
      text('account-history-status', 'Checking private history…');
      text('account-history-tag', 'PRIVATE');
      text('account-history-results', '');
      for (const id of ['active', 'completed', 'failed', 'expired', 'refunded']) text(`account-${id}-swaps`, '—');
    },
    record(pair: Pair, quote: Quote) {
      if (!session) return;
      const route = `${railLabel[pair.send]} → ${railLabel[pair.receive]}`;
      quotes.set(`${route}:${quote.id}`, { route, quote });
    },
    async refresh() {
      if (!session) return;
      controller?.abort();
      const read = new AbortController(); controller = read;
      const reverse = async () => {
        const available = await api.reverseAvailability(read.signal);
        if (!available.controlledReverseConfigured) throw new Error('Owner-scoped reverse history unavailable');
        const ids = new Set(available.preparedSwapIds);
        const swaps = ids.size ? await api.ownedSwaps(read.signal).then(result => result.swaps.filter(swap => ids.has(swap.id)), () => undefined) : [];
        return { swaps, preparations: available.preparations ?? [] };
      };
      const [reverseResult, arkResult] = await Promise.allSettled([reverse(), api.arkSwaps(read.signal)]);
      if (controller !== read || read.signal.aborted) return;
      missing = [];
      if (reverseResult.status === 'fulfilled') {
        owned = reverseResult.value.swaps ?? []; preparations = reverseResult.value.preparations;
        if (!reverseResult.value.swaps) missing.push('Lightning → On-chain swaps');
      } else { owned = []; preparations = []; missing.push('Lightning → On-chain'); }
      if (arkResult.status === 'fulfilled') ark = arkResult.value.swaps;
      else { ark = []; missing.push('Ark ↔ Bitcoin'); }
      render();
    },
  };
}
