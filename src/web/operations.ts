import { api, type OperationsBalances } from './api.js';
import type { RailBalanceEntry } from '../core/RailContract.js';
import { get, sats, text } from './ui.js';

const onchain = ['core', 'alice'] as const;
const maxFreshAge = 60_000;
const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
const format = (value: number | null | undefined, entry?: RailBalanceEntry) =>
  value == null ? entry?.status === 'unknown' ? 'Unknown' : 'Unavailable' : sats(value);

function renderPile(id: string, fill: number | null, loading: boolean, occupied: number | null = null) {
  const pile = get(id);
  pile.dataset.state = loading ? 'loading' : fill === null ? 'unavailable' : 'known';
  pile.toggleAttribute('data-capacity', occupied !== null);
  if (fill === null) pile.style.removeProperty('--wallet-fill');
  else pile.style.setProperty('--wallet-fill', fill + '%');
  if (occupied === null) pile.style.removeProperty('--wallet-occupied');
  else pile.style.setProperty('--wallet-occupied', occupied + '%');
}

export function mountOperationsBalances() {
  const refresh = get<HTMLButtonElement>('balance-refresh');
  const chart = get('balance-piles');
  const snapshotTime = get<HTMLTimeElement>('balance-time');
  let active = false;
  let pending: AbortController | undefined;
  let staleTimer: number | undefined;

  function showAge(capturedAt: string) {
    const age = Date.now() - Date.parse(capturedAt);
    if (age >= maxFreshAge) {
      chart.dataset.stale = '';
      text('balance-status', 'Regtest snapshot · at least 1 minute old');
    } else {
      text('balance-status', 'Regtest snapshot');
      staleTimer = window.setTimeout(() => showAge(capturedAt), Math.min(maxFreshAge - age, 2_147_483_647));
    }
  }

  function render(snapshot?: OperationsBalances, loading = false) {
    window.clearTimeout(staleTimer);
    delete chart.dataset.stale;
    const onchainEntries = snapshot?.rails.filter(entry => entry.rail === 'onchain') ?? [];
    const wallets = onchain.map(account => {
      const entry = onchainEntries.find(item => item.account === account);
      return { account, entry, wallet: entry?.status === 'unavailable' ? null : entry?.balances };
    });
    const maxConfirmed = Math.max(0, ...wallets.map(({ wallet }) => wallet?.confirmedSats ?? 0));
    for (const { account, entry, wallet } of wallets) {
      const confirmed = wallet?.confirmedSats;
      renderPile(account + '-pile', confirmed == null ? null : maxConfirmed > 0 ? 100 * (confirmed / maxConfirmed) : 0, loading);
      text(account + '-confirmed', format(confirmed, entry));
      text(account + '-unconfirmed', format(wallet?.unconfirmedSats, entry));
    }
    const lightningEntries = snapshot?.rails.filter(entry => entry.rail === 'lightning') ?? [];
    for (const account of ['provider', 'alice'] as const) {
      const entry = lightningEntries.find(item => item.account === account);
      const { localSats, remoteSats, capacitySats } = (entry?.status === 'unavailable' ? null : entry?.balances) ?? {};
      let fill: number | null = null;
      let occupied: number | null = null;
      if (capacitySats != null && localSats != null && remoteSats != null && remoteSats <= capacitySats - localSats) {
        fill = capacitySats === 0 ? 0 : 100 * localSats / capacitySats;
        if (capacitySats > 0) occupied = 100 * (localSats + remoteSats) / capacitySats;
      }
      renderPile(account + '-lightning-pile', fill, loading, occupied);
      text(account + '-local', format(localSats, entry));
      text(account + '-remote', format(remoteSats, entry));
      text(account + '-capacity', format(capacitySats, entry));
    }
    snapshotTime.hidden = !snapshot;
    snapshotTime.dateTime = snapshot?.capturedAt ?? '';
    snapshotTime.textContent = snapshot ? date.format(new Date(snapshot.capturedAt)) : '';
    if (snapshot) showAge(snapshot.capturedAt);
  }

  async function load() {
    if (!active || pending) return;
    const controller = new AbortController();
    pending = controller;
    refresh.disabled = true;
    render(undefined, true);
    text('balance-status', 'Loading balances…');
    try {
      const snapshot = await api.operationsBalances(controller.signal);
      if (pending !== controller) return;
      render(snapshot);
    } catch {
      if (pending === controller) {
        render();
        text('balance-status', 'Balance snapshot unavailable.');
      }
    } finally {
      if (pending === controller) {
        pending = undefined;
        refresh.disabled = false;
      }
    }
  }

  refresh.addEventListener('click', () => void load());

  return (enabled: boolean) => {
    if (active === enabled) return;
    active = enabled;
    if (active) {
      void load();
    } else {
      pending?.abort();
      pending = undefined;
      refresh.disabled = false;
      render();
      text('balance-status', 'Balance snapshot unavailable.');
    }
  };
}
