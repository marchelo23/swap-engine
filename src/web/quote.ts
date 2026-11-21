import { api, quoteTotals, type Quote } from './api.js';
import { mountCubes } from './cubes.js';
import { canQuote, defaultPair, railLabel, type Pair } from './rails.js';
import { details, get, integer, message, sats, text } from './ui.js';

export function mountQuote(prepare?: (stillVisible: () => boolean, amountSats: number) => Promise<void>) {
  const form = get<HTMLFormElement>('quote-form');
  const amount = get<HTMLInputElement>('amount');
  const action = get<HTMLButtonElement>('swap-action');
  const dialog = get<HTMLDialogElement>('review-dialog');
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
  let quote: Quote | undefined;
  let pending: { controller: AbortController; work: Promise<Quote | undefined> } | undefined;
  let debounce: number | undefined;
  let expiry: number | undefined;

  function invalidate() {
    revision++;
    pending?.controller.abort();
    pending = undefined;
    window.clearTimeout(debounce);
    window.clearTimeout(expiry);
    quote = undefined;
    delete form.dataset.loading;
    if (dialog.open) dialog.close();
    for (const id of numbers) text(id, '—');
  }

  function principal() {
    const value = Number(amount.value);
    if (/^\d+$/.test(amount.value) && value >= (controlled === true ? 11_000 : 10_000) && value <= (controlled === true ? 50_000 : 1_000_000)) return value;
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
    form.dataset.loading = 'true';
    status('Quoting route…');
    const work = api.quote(value, active.signal, csrf).then(result => {
      if (version !== revision) return;
      const totals = quoteTotals(result, value, Date.now(), controlled === true);
      quote = result;
      animateValues([sats(result.serviceFeeSats), sats(result.claimFeeSats), sats(totals.lost), integer(totals.received)]);
      if (controlled === true) action.disabled = preparing || !aligned || !canQuote(pair) || !canPrepare;
      status(controlled === true ? 'Quote ready · review before swapping' : 'Quote ready · execution off');
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
    if (aligned && (pair.send === 'ark' || pair.receive === 'ark')) {
      action.disabled = true;
      successNotice = false;
      status('Solo regtest · swaps no disponibles');
      return;
    }
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
    if (controlled === true) {
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
    if (controlled !== false || !aligned || !canQuote(pair) || value === undefined || dialog.open) return;
    window.clearTimeout(debounce);
    if (quote && quote.expiresAt <= Date.now()) invalidate();
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
