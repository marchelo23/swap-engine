import { api, type OperationsBalances } from './api.js';
import { get, sats, text } from './ui.js';

const onchain = ['core', 'alice'] as const;
const maxFreshAge = 60_000;
const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
const format = (value: number | bigint | null | undefined) => value == null ? 'Unavailable' : sats(value);

function renderPile(id: string, fill: number | null, loading: boolean, showRemote = false) {
  const pile = get(id);
  pile.dataset.state = loading ? 'loading' : fill === null ? 'unavailable' : 'known';
  pile.toggleAttribute('data-capacity', showRemote);
  if (fill === null) pile.style.removeProperty('--wallet-fill');
  else pile.style.setProperty('--wallet-fill', fill + '%');
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
    const maxConfirmed = Math.max(0, ...onchain.map(node => snapshot?.[node]?.confirmedSats ?? 0));
    for (const node of onchain) {
      const wallet = snapshot?.[node];
      const confirmed = wallet?.confirmedSats;
      renderPile(node + '-pile', confirmed == null ? null : maxConfirmed > 0 ? 100 * (confirmed / maxConfirmed) : 0, loading);
      text(node + '-confirmed', format(confirmed));
      text(node + '-unconfirmed', format(wallet?.unconfirmedSats));
    }
    for (const node of ['provider', 'alice'] as const) {
      const local = snapshot?.[node]?.localSats;
      const remote = snapshot?.[node]?.remoteSats;
      const capacity = local == null || remote == null ? null : BigInt(local) + BigInt(remote);
      const fill = capacity === null ? null : capacity === 0n ? 0 : 100 * ((local ?? 0) / Number(capacity));
      renderPile(node + '-lightning-pile', fill, loading, capacity !== null && capacity > 0n);
      text(node + '-local', format(local));
      text(node + '-remote', format(remote));
      text(node + '-capacity', format(capacity));
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
