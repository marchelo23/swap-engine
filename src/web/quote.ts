import { api, quoteTotals, type ArkQuote, type Quote } from './api.js';
import { mountCubes } from './cubes.js';
import { arkRoute, canQuote, defaultPair, isArkOnchainPair, railLabel, type Pair } from './rails.js';
import { details, get, integer, message, sats, text } from './ui.js';

export function mountQuote(prepare?: (stillVisible: () => boolean, amountSats: number) => Promise<void>) {
  const form = get<HTMLFormElement>('quote-form');
  const amount = get<HTMLInputElement>('amount');
  const action = get<HTMLButtonElement>('swap-action');
  const dialog = get<HTMLDialogElement>('review-dialog');
  const startButton = dialog.querySelector<HTMLButtonElement>('button[type="button"]')!;
  let successNotice = false;
  const status = (message: string) => text('quote-status', successNotice ? '¡Swap exitoso!' : message);
  const numbers = ['service', 'claim', 'cost', 'received-preview'];
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  for (const type of ['copy', 'cut']) form.addEventListener(type, event => event.preventDefault());
  let pair = defaultPair;
  let aligned = true;
  let visible = false;
  let controlled: boolean | 'unavailable' | null = null;
  let csrf: string | undefined;
  let canPrepare = false; let preparing = false;
  let revision = 0;
  let quote: Quote | ArkQuote | undefined;
  let pending: { controller: AbortController; work: Promise<Quote | ArkQuote | undefined> } | undefined;
  let debounce: number | undefined;
  let expiry: number | undefined;
  let submittingArk = false;
  let executedArkSwapId: string | undefined;

  startButton.addEventListener('click', async () => {
    const route = arkRoute(pair);
    if (!route || !quote || submittingArk || executedArkSwapId || !csrf || get('mode').dataset.mode !== 'regtest') return;
    if (quote.expiresAt <= Date.now()) {
      startButton.disabled = true;
      text('execution-status', 'Quote expired · Close review and press Swap for a fresh quote.');
      return;
    }
    submittingArk = true;
    startButton.disabled = true;
    window.clearTimeout(expiry);
    text('execution-status', 'Submitting regtest Ark swap…');
    try {
      const key = crypto.randomUUID();
      const result = await api.arkSwap(quote.id, route, quote.amountSats, key, csrf);
      executedArkSwapId = result.id;
      details(get('review-details'), [
        ['Route', railLabel[pair.send] + ' → ' + railLabel[pair.receive]],
        ['Method', result.method === 'boarding' ? 'Boarding (On-chain → Ark VTXO)' : 'Cooperative offboarding (Ark VTXO → On-chain)'],
        ['Status', result.status],
        ['Swap ID', result.id],
        ['Quote principal', sats(result.quote.amountSats)],
        ['Service fee', sats(result.quote.serviceFeeSats)],
        ['Estimated batch commitment fee', sats(result.quote.claimFeeSats)],
        ['Input outpoint', result.inputOutpoint],
        ['Destination', result.destination],
        ['Commitment txid', result.commitmentTxid ?? 'Pending batch round'],
        ['Net receipt', sats(result.quote.netSats)],
      ]);
      text('execution-status', result.status === 'SUBMITTED' || result.status === 'CONFIRMED'
        ? '¡Swap Ark regtest enviado!'
        : `Ark swap status: ${result.status}`);
      status('¡Swap exitoso!');
    } catch (error) {
      text('execution-status', message(error));
      startButton.disabled = false;
    } finally {
      submittingArk = false;
    }
  });

  function invalidate() {
    revision++;
    pending?.controller.abort();
    pending = undefined;
    window.clearTimeout(debounce);
    window.clearTimeout(expiry);
    quote = undefined;
    executedArkSwapId = undefined;
    delete form.dataset.loading;
    if (dialog.open) dialog.close();
    for (const id of numbers) text(id, '—');
  }

  function isArkRoute() {
    return isArkOnchainPair(pair);
  }

  function principal() {
    const value = Number(amount.value);
    const controlledBounds = controlled === true && !isArkRoute();
    if (/^\d+$/.test(amount.value) && value >= (controlledBounds ? 11_000 : 10_000) && value <= (controlledBounds ? 50_000 : 1_000_000)) return value;
    return undefined;
  }

  function animateValues(values: string[]) {
    numbers.forEach((id, index) => {
      const element = get(id);
      element.textContent = values[index]!;
      if (motion.matches) return;
      element.getAnimations().forEach(animation => animation.cancel());
      element.animate([{ opacity: .35, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }], {
        duration: 210, easing: 'ease-out',
      });
    });
  }

  function load(value: number) {
    if (pending) return pending.work;
    const active = new AbortController();
    const version = revision;
    const route = arkRoute(pair);
    form.dataset.loading = 'true';
    status('Quoting route…');
    const request = route
      ? api.arkQuote(route, value, active.signal, csrf)
      : api.quote(value, active.signal, csrf);
    const work = request.then(result => {
      if (version !== revision) return;
      const totals = quoteTotals(result, value, Date.now(), !route && controlled === true);
      quote = result;
      animateValues([sats(result.serviceFeeSats), sats(result.claimFeeSats), sats(totals.lost), integer(totals.received)]);
      if (route) {
        action.disabled = !aligned || !canQuote(pair);
        status(route === 'onchain-to-ark'
          ? 'Ark boarding quote ready · regtest only'
          : 'Ark cooperative offboard quote ready · regtest only');
      } else {
        if (controlled === true) action.disabled = preparing || !aligned || !canQuote(pair) || !canPrepare;
        status(controlled === true ? 'Quote ready · review before swapping' : 'Quote ready · execution off');
      }
      expiry = window.setTimeout(() => {
        invalidate();
        status('Quote expired · press Swap');
      }, Math.min(Math.max(0, result.expiresAt - Date.now()), 2_147_483_647));
      return result;
    }).catch(error => {
      if (version === revision) status(message(error));
      return undefined;
    }).finally(() => {
      if (pending?.controller === active) {
        pending = undefined;
        delete form.dataset.loading;
      }
    });
    pending = { controller: active, work };
    return work;
  }

  function schedule(delay: number) {
    if (!visible) return;
    const value = principal();
    if (value === undefined) amount.setAttribute('aria-invalid', 'true'); else amount.removeAttribute('aria-invalid');
    if (aligned && (pair.send === 'ark' || pair.receive === 'ark') && !isArkOnchainPair(pair)) {
      action.disabled = true;
      successNotice = false;
      status('Solo regtest · swaps no disponibles');
      return;
    }
    if (aligned && isArkOnchainPair(pair)) {
      text('amount-help', '10,000–1,000,000 sats');
      action.disabled = !aligned || !canQuote(pair) || value === undefined;
      if (value === undefined) { status('Enter 10,000–1,000,000 sats'); return; }
      if (!quote) {
        status('Updating quote…');
        debounce = window.setTimeout(() => void load(value), delay);
      }
      return;
    }
    text('amount-help', controlled === true ? '11,000–50,000 sats' : '10,000–1,000,000 sats');
    if (controlled !== false) {
      action.disabled = preparing || controlled !== true || !aligned || !canQuote(pair) || (canPrepare && (!value || !quote || quote.invoiceSats !== value));
      if (controlled === true && canPrepare && aligned && canQuote(pair) && value !== undefined && !quote && !preparing) {
        status('Updating quote…'); debounce = window.setTimeout(() => void load(value), delay);
      } else status(controlled === true ? preparing ? 'Preparing your regtest swap for review…' : value === undefined ? 'Enter 11,000–50,000 sats' : canPrepare ? 'Quote ready · review before swapping' : 'Review a prepared swap.'
        : controlled === 'unavailable' ? 'Quote service unavailable.' : 'Checking quote availability…');
      return;
    }
    action.disabled = !aligned || !canQuote(pair) || value === undefined;
    if (!aligned) { status('Aligning rails…'); return; }
    if (!canQuote(pair)) { status('Route unavailable'); return; }
    if (value === undefined) { status('Enter 10,000–1,000,000 sats'); return; }
    status('Updating quote…');
    debounce = window.setTimeout(() => void load(value), delay);
  }

  mountCubes(() => {
    aligned = false;
    invalidate();
    schedule(0);
  }, finalPair => {
    pair = finalPair;
    aligned = true;
    schedule(0);
  });

  amount.addEventListener('input', () => {
    successNotice = false;
    invalidate();
    schedule(290);
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    successNotice = false;
    const route = arkRoute(pair);
    if (!route && controlled === true) {
      if (preparing) return;
      if (canPrepare && prepare && !preparing && aligned && canQuote(pair)) {
        const version = revision; const active = () => visible && version === revision && controlled === true;
        let failure: string | undefined;
        preparing = true; schedule(0);
        try { const value = principal(); if (!value || !quote || quote.invoiceSats !== value) throw new Error('Refresh the quote before continuing.'); await prepare(active, value); }
        catch (error) { failure = error instanceof Error ? error.message : 'Preparation uncertain. Check existing status.'; }
        finally { preparing = false; if (visible) { schedule(0); if (active() && failure) status(failure); } }
        return;
      }
      if (aligned && canQuote(pair)) location.hash = 'track';
      return;
    }
    const value = principal();
    if ((!route && controlled !== false) || !aligned || !canQuote(pair) || value === undefined || dialog.open) return;
    window.clearTimeout(debounce);
    if (quote && (quote.expiresAt <= Date.now() || executedArkSwapId)) invalidate();
    const version = revision;
    const current = quote ?? await load(value);
    if (!current || version !== revision || dialog.open || get('swap').hidden) return;
    const now = Date.now();
    if (current.expiresAt <= now) {
      invalidate();
      status('Quote expired · press Swap');
      return;
    }
    const totals = quoteTotals(current, value, now);
    if (route) {
      const boarding = route === 'onchain-to-ark';
      details(get('review-details'), [
        ['Route', railLabel[pair.send] + ' → ' + railLabel[pair.receive]],
        ['Method', boarding ? 'Boarding (On-chain → Ark VTXO)' : 'Cooperative offboarding (Ark VTXO → On-chain)'],
        ['Network', 'Bitcoin regtest'],
        ['Quote principal', sats(current.amountSats)],
        ['Operator fee', sats(current.serviceFeeSats)],
        ['Estimated batch commitment fee', sats(current.claimFeeSats)],
        [boarding ? 'Total on-chain funding' : 'Total Ark VTXO debit', sats(current.invoiceSats)],
        [boarding ? 'Estimated Ark VTXO credit' : 'Estimated on-chain payout', sats(totals.received)],
        ['Estimated cost', sats(totals.lost)],
      ]);
      const mode = get('mode').dataset.mode;
      const canExecuteArk = mode === 'regtest' && Boolean(csrf);
      startButton.disabled = !canExecuteArk;
      text('execution-status', canExecuteArk
        ? 'Regtest Ark adapter ready · Press Start swap to submit.'
        : mode === 'regtest'
          ? 'Regtest Ark adapter · Sign in at Account to execute swap.'
          : 'Simulation · Execution disabled (regtest only).');
      dialog.showModal();
      return;
    }
    startButton.disabled = true;
    details(get('review-details'), [
      ['Route', railLabel[pair.send] + ' → ' + railLabel[pair.receive]],
      ['Quote principal', sats(current.amountSats)],
      ['Service fee', sats(current.serviceFeeSats)],
      ['Estimated network claim fee', sats(current.claimFeeSats)],
      ['Lightning routing fee', 'Unknown'],
      ['Total Lightning payment', sats(current.invoiceSats)],
      ['Estimated on-chain receipt', sats(totals.received)],
      ['Estimated cost', sats(totals.lost)],
    ]);
    const mode = get('mode').dataset.mode;
    text('execution-status', mode === 'simulation'
      ? 'Simulation · Execution disabled.'
      : mode === 'regtest' ? 'Regtest not ready · Execution disabled.' : 'Execution unavailable.');
    dialog.showModal();
  });

  return {
    setVisible(next: boolean) {
      if (visible === next) return;
      visible = next;
      if (!visible) {
        if (!quote) invalidate();
        return;
      }
      try {
        if (sessionStorage.getItem('swap-engine.success-notice')) {
          sessionStorage.removeItem('swap-engine.success-notice');
          successNotice = true;
        }
      } catch { /* The completed swap remains available in transaction history. */ }
      if (quote && quote.expiresAt > Date.now()) { if (successNotice) status(''); return; }
      invalidate();
      schedule(0);
    },
    setContext(configured: boolean | 'unavailable' | null, csrfToken?: string, preparationAvailable = false) {
      if (controlled === configured && csrf === csrfToken && canPrepare === preparationAvailable) return;
      controlled = configured;
      csrf = csrfToken;
      canPrepare = preparationAvailable;
      amount.readOnly = false;
      text('amount-help', configured === true ? '11,000–50,000 sats' : '10,000–1,000,000 sats');
      invalidate();
      schedule(0);
    },
  };
}
