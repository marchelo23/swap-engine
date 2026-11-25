import type { Environment } from '../core/RailContract.js';
import { api, quoteTotals, type ArkQuote, type ArkSwapPayload, type ArkSwapStatus, type Quote } from './api.js';
import { arkProgress, arkStatusLabel } from './arkStatus.js';
import { mountCubes } from './cubes.js';
import { arkRoute, canQuote, defaultPair, isArkOnchainPair, railLabel, unsupportedRoute, type Pair } from './rails.js';
import { details, get, integer, message, sats, text } from './ui.js';

const outpointPattern = /^[a-f0-9]{64}:(0|[1-9][0-9]{0,8})$/;
const regtestBech32Pattern = /^bcrt1[0-9a-z]{8,90}$/;
const regtestArkPattern = /^tark1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{20,140}$/;

type GuestFlow = { begin(amountSats: number, active: () => boolean): Promise<void>; cancel(): void };

export function mountQuote(prepare?: (stillVisible: () => boolean, quote: Quote, destination?: string) => Promise<void>, guestFlow?: GuestFlow,
  recordQuote?: (pair: Pair, quote: Quote) => void) {
  const form = get<HTMLFormElement>('quote-form');
  const amount = get<HTMLInputElement>('amount');
  const action = get<HTMLButtonElement>('swap-action');
  const dialog = get<HTMLDialogElement>('review-dialog');
  const startButton = dialog.querySelector<HTMLButtonElement>('button[type="button"]')!;
  const arkFields = get('ark-execution-fields');
  const arkBoardingFields = get('ark-boarding-fields');
  const arkOffboardFields = get('ark-offboard-fields');
  const arkWallet = get<HTMLSelectElement>('ark-wallet');
  const arkFundingOutpoint = get<HTMLInputElement>('ark-funding-outpoint');
  const arkRecipientAddress = get<HTMLInputElement>('ark-recipient-address');
  const arkVtxoOutpoint = get<HTMLInputElement>('ark-vtxo-outpoint');
  const arkDestinationAddress = get<HTMLInputElement>('ark-destination-address');
  let successNotice = false;
  const status = (message: string) => text('quote-status', successNotice ? '¡Swap exitoso!' : message);
  const numbers = ['service', 'claim', 'cost', 'received-preview', 'quote-debit'];
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  for (const type of ['copy', 'cut']) form.addEventListener(type, event => event.preventDefault());
  let pair = defaultPair;
  let aligned = true;
  let visible = false;
  let controlled: boolean | 'unavailable' | null = null;
  let admin = false;
  let maxSourceAmount = 50_000;
  let ownedDestination: string | undefined;
  let csrf: string | undefined;
  let canPrepare = false; let preparing = false;
  let hasPreparedSwap = false;
  let guestConfigured = false; let guestAvailable = false;
  let revision = 0;
  let quote: Quote | ArkQuote | undefined;
  let pending: { controller: AbortController; work: Promise<Quote | ArkQuote | undefined> } | undefined;
  let debounce: number | undefined;
  let expiry: number | undefined;
  let submittingArk = false;
  let arkExecutionAllowed: boolean | null | 'unavailable' | 'quotes-only' = null;
  let arkEnvironment: Environment | null | undefined = null;
  let executedArkSwapId: string | undefined;
  let arkIdempotency: { fingerprint: string; key: string } | undefined;
  let arkStatusTimer: number | undefined;
  let arkStatusController: AbortController | undefined;

  function canExecuteArk() {
    return (arkEnvironment === 'regtest' || arkEnvironment === 'ark-regtest') && Boolean(csrf) && arkExecutionAllowed === true;
  }

  function arkReadiness() {
    if (canExecuteArk()) return 'Regtest execution available';
    if (arkEnvironment === null) return 'Checking Ark environment…';
    if (arkEnvironment === undefined) return 'Ark environment unavailable';
    if (arkEnvironment === 'simulation') return 'Simulation · execution disabled';
    if (arkEnvironment !== 'regtest' && arkEnvironment !== 'ark-regtest') return 'Ark execution requires regtest';
    if (!csrf) return 'Sign in to check Ark execution';
    if (arkExecutionAllowed === null) return 'Checking Ark execution…';
    if (arkExecutionAllowed === 'quotes-only') return 'Ark regtest · quotes only';
    return arkExecutionAllowed === 'unavailable' ? 'Ark readiness unavailable' : 'Ark execution unavailable for this account';
  }

  function showArkQuoteStatus() {
    if (!executedArkSwapId) status(arkReadiness());
  }

  function setFieldValidity(input: HTMLInputElement, valid: boolean) {
    if (input.value.trim().length > 0 && !valid) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }

  function clearArkFields() {
    arkFields.hidden = true;
    arkBoardingFields.hidden = true;
    arkOffboardFields.hidden = true;
    arkWallet.value = 'alice';
    arkFundingOutpoint.value = '';
    arkRecipientAddress.value = '';
    arkVtxoOutpoint.value = '';
    arkDestinationAddress.value = '';
    for (const input of [arkFundingOutpoint, arkRecipientAddress, arkVtxoOutpoint, arkDestinationAddress]) {
      input.removeAttribute('aria-invalid');
    }
    arkIdempotency = undefined;
  }

  function buildArkPayload(): { payload: ArkSwapPayload } | { error: string } | undefined {
    const route = arkRoute(pair);
    if (!route || !quote || !canExecuteArk() || !csrf) return undefined;
    if (route === 'onchain-to-ark') {
      const wallet = arkWallet.value === 'bob' ? 'bob' : 'alice';
      const fundingOutpoint = arkFundingOutpoint.value.trim();
      const recipientArkAddress = arkRecipientAddress.value.trim();
      const validOutpoint = outpointPattern.test(fundingOutpoint);
      const validRecipient = !recipientArkAddress || regtestArkPattern.test(recipientArkAddress);
      setFieldValidity(arkFundingOutpoint, validOutpoint);
      setFieldValidity(arkRecipientAddress, validRecipient);
      if (!validOutpoint) return { error: 'Enter a valid funding outpoint (64-hex txid:vout).' };
      if (!validRecipient) return { error: 'Recipient Ark address must be a valid regtest tark1... address.' };
      return {
        payload: {
          quoteId: quote.id,
          route,
          wallet,
          fundingOutpoint,
          ...(recipientArkAddress ? { recipientArkAddress } : {}),
          amountSats: quote.amountSats,
        },
      };
    }
    const vtxoOutpoint = arkVtxoOutpoint.value.trim();
    const destinationAddress = arkDestinationAddress.value.trim();
    const validVtxo = outpointPattern.test(vtxoOutpoint);
    const validDest = regtestBech32Pattern.test(destinationAddress);
    setFieldValidity(arkVtxoOutpoint, validVtxo);
    setFieldValidity(arkDestinationAddress, validDest);
    if (!validVtxo) return { error: 'Enter a valid VTXO outpoint (64-hex txid:vout).' };
    if (!validDest) return { error: 'Destination address must be a valid regtest bcrt1... address.' };
    return {
      payload: {
        quoteId: quote.id,
        route,
        vtxoOutpoint,
        destinationAddress,
        amountSats: quote.amountSats,
      },
    };
  }

  function updateArkExecutionState() {
    if (!dialog.open || submittingArk || executedArkSwapId) return;
    const route = arkRoute(pair);
    if (!route || !quote) return;
    if (!canExecuteArk()) {
      arkFields.hidden = true;
      startButton.disabled = true;
      text('execution-status', arkReadiness());
      return;
    }
    arkFields.hidden = false;
    arkBoardingFields.hidden = route !== 'onchain-to-ark';
    arkOffboardFields.hidden = route !== 'ark-to-onchain';
    if (quote.expiresAt <= Date.now()) {
      startButton.disabled = true;
      text('execution-status', 'Quote expired · Close review and press Swap for a fresh quote.');
      return;
    }
    const built = buildArkPayload();
    if (!built) {
      startButton.disabled = true;
      return;
    }
    if ('error' in built) {
      startButton.disabled = true;
      text('execution-status', built.error);
      return;
    }
    startButton.disabled = false;
    text('execution-status', 'Regtest Ark inputs valid · Press Start swap to submit.');
  }

  for (const el of [arkWallet, arkFundingOutpoint, arkRecipientAddress, arkVtxoOutpoint, arkDestinationAddress]) {
    el.addEventListener('input', updateArkExecutionState);
    el.addEventListener('change', updateArkExecutionState);
  }

  function stopArkStatus() {
    window.clearTimeout(arkStatusTimer);
    arkStatusController?.abort();
    arkStatusController = undefined;
  }

  function showArkResult(result: ArkSwapStatus) {
    const progress = arkProgress(result);
    const label = arkStatusLabel(result);
    details(get('review-details'), [
      ['Route', railLabel[pair.send] + ' → ' + railLabel[pair.receive]],
      ['Method', result.method === 'boarding' ? 'Boarding (On-chain → Ark VTXO)' : 'Cooperative offboarding (Ark VTXO → On-chain)'],
      ['Status', label],
      ['Swap ID', result.id],
      ['Quoted debit', sats(result.quote.invoiceSats)],
      ['Service fee', sats(result.quote.serviceFeeSats)],
      ['Estimated batch commitment fee', sats(result.quote.claimFeeSats)],
      ['Input outpoint', result.inputOutpoint],
      ['Destination', result.destination],
      ['Commitment txid', result.commitmentTxid ?? 'Unavailable'],
      ['Estimated net receipt', sats(result.quote.netSats)],
    ]);
    const notice = progress === 'uncertain' ? `${label}. Reconcile the original outpoint before retrying.` : label;
    text('execution-status', notice);
    status(label);
  }

  function trackArkResult(result: ArkSwapStatus) {
    if (!dialog.open || arkProgress(result) !== 'pending') return;
    const version = revision;
    const controller = new AbortController();
    arkStatusController = controller;
    const poll = async () => {
      try {
        const current = await api.arkSwapStatus(result.id, controller.signal);
        if (controller.signal.aborted || !dialog.open || version !== revision) return;
        if (current.id !== result.id || current.quote.id !== result.quote.id || current.route !== result.route) {
          throw new Error('Ark status record mismatch.');
        }
        if (current.updatedAt >= result.updatedAt) {
          const changed = current.status !== result.status || current.commitmentTxid !== result.commitmentTxid;
          if (changed) showArkResult(current);
          else text('execution-status', arkStatusLabel(current));
          result = current;
        }
      } catch {
        if (!controller.signal.aborted && dialog.open && version === revision) {
          text('execution-status', `${arkStatusLabel(result)} · latest status unavailable`);
        }
      }
      if (!controller.signal.aborted && dialog.open && version === revision && arkProgress(result) === 'pending') {
        arkStatusTimer = window.setTimeout(() => void poll(), 5_000);
      }
    };
    arkStatusTimer = window.setTimeout(() => void poll(), 2_000);
  }

  dialog.addEventListener('close', () => {
    stopArkStatus();
    clearArkFields();
  });

  startButton.addEventListener('click', async () => {
    const route = arkRoute(pair);
    if (!route || !quote || submittingArk || executedArkSwapId || !csrf || !canExecuteArk()) return;
    if (quote.expiresAt <= Date.now()) {
      startButton.disabled = true;
      text('execution-status', 'Quote expired · Close review and press Swap for a fresh quote.');
      return;
    }
    const built = buildArkPayload();
    if (!built || 'error' in built) {
      startButton.disabled = true;
      if (built && 'error' in built) text('execution-status', built.error);
      return;
    }
    const fingerprint = JSON.stringify(built.payload);
    if (!arkIdempotency || arkIdempotency.fingerprint !== fingerprint) {
      arkIdempotency = { fingerprint, key: crypto.randomUUID() };
    }
    successNotice = false;
    submittingArk = true;
    startButton.disabled = true;
    window.clearTimeout(expiry);
    const version = revision;
    text('execution-status', 'Submitting regtest Ark swap…');
    try {
      const result = await api.arkSwap(built.payload, arkIdempotency.key, csrf);
      if (version !== revision) return;
      if (result.route !== route || result.quote.id !== built.payload.quoteId) throw new Error('Ark swap record mismatch. Check account history.');
      executedArkSwapId = result.id;
      arkFields.hidden = true;
      showArkResult(result);
      trackArkResult(result);
    } catch (error) {
      if (version === revision && dialog.open) {
        text('execution-status', message(error));
        startButton.disabled = !canExecuteArk();
      }
    } finally {
      submittingArk = false;
    }
  });

  function invalidate() {
    guestFlow?.cancel();
    stopArkStatus();
    revision++;
    pending?.controller.abort();
    pending = undefined;
    window.clearTimeout(debounce);
    window.clearTimeout(expiry);
    quote = undefined;
    executedArkSwapId = undefined;
    clearArkFields();
    delete form.dataset.loading;
    if (dialog.open) dialog.close();
    for (const id of numbers) text(id, '—');
  }

  function guestRoute() {
    if (admin) return false;
    const guestOnly = !csrf || controlled === false || controlled === 'unavailable'
      || (controlled === true && !canPrepare && !hasPreparedSwap);
    return guestOnly && pair.send === 'lightning' && pair.receive === 'onchain';
  }

  function isArkRoute() {
    return isArkOnchainPair(pair);
  }

  function principal() {
    const value = Number(amount.value);
    const controlledBounds = (controlled === true || (guestRoute() && guestAvailable)) && !isArkRoute();
    const maximum = controlled === true ? maxSourceAmount : 50_000;
    if (/^\d+$/.test(amount.value) && value >= (controlledBounds ? 11_000 : 10_000) && value <= (controlledBounds ? maximum : 1_000_000)) return value;
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
    const guestEstimate = guestRoute() && guestAvailable;
    form.dataset.loading = 'true';
    status('Quoting route…');
    const request = route
      ? api.arkQuote(route, value, active.signal, csrf)
      : guestEstimate ? api.guestEstimate(value, active.signal) : api.quote(value, active.signal, csrf);
    const work = request.then(result => {
      if (version !== revision) return;
      if (route && (!('route' in result) || result.route !== route)) throw new Error('Backend returned a different Ark route.');
      const totals = quoteTotals(result, value);
      quote = result;
      animateValues([sats(result.serviceFeeSats), sats(result.claimFeeSats), sats(totals.lost),
        integer(totals.received), sats(result.invoiceSats)]);
      if (route) {
        action.disabled = !aligned || !canQuote(pair);
        showArkQuoteStatus();
      } else if (guestEstimate) {
        status('Guest recovery required before the invoice is shown.');
      } else if (admin && controlled !== true) {
        status('Authenticated swap service unavailable for this account.');
      } else {
        if (controlled === true) action.disabled = preparing || !aligned || !canQuote(pair) || !canPrepare;
        status(controlled === true ? (admin ? 'Quote ready · SWAP starts execution' : 'Quote ready · review before swapping') : 'Quote ready · execution off');
      }
      expiry = window.setTimeout(() => {
        invalidate();
        if (visible) schedule(0);
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
    if (!aligned || !canQuote(pair)) {
      action.disabled = true;
      status(aligned ? unsupportedRoute(pair) : 'Aligning rails…');
      return;
    }
    if (aligned && isArkOnchainPair(pair)) {
      text('amount-help', '10,000–1,000,000 sats');
      action.disabled = !aligned || !canQuote(pair) || value === undefined;
      if (value === undefined) { status('Enter 10,000–1,000,000 sats'); return; }
      if (!quote) {
        status('Updating quote…');
        debounce = window.setTimeout(() => void load(value), delay);
      } else showArkQuoteStatus();
      return;
    }
    const ownedRange = '11,000–' + integer(maxSourceAmount) + ' sats';
    text('amount-help', controlled === true ? ownedRange : guestRoute() && guestAvailable ? '11,000–50,000 sats' : '10,000–1,000,000 sats');
    if (admin && pair.send === 'lightning' && pair.receive === 'onchain' && controlled !== null && controlled !== true) {
      action.disabled = true;
      status('Authenticated swap service unavailable for this account.');
      if (value !== undefined && !quote) debounce = window.setTimeout(() => void load(value), delay);
      return;
    }
    if (guestRoute() && guestConfigured && !guestAvailable) {
      action.disabled = true;
      status('Guest watcher unavailable · no invoice will be created.');
      return;
    }
    if (guestRoute() && guestAvailable) {
      action.disabled = preparing || !aligned || !canQuote(pair) || value === undefined;
      if (value === undefined) amount.setAttribute('aria-invalid', 'true'); else amount.removeAttribute('aria-invalid');
      if (value === undefined) { status('Enter 11,000–50,000 sats'); return; }
      status(preparing ? 'Opening guest recovery…' : 'Guest recovery required before the invoice is shown.');
      if (!quote && !preparing) debounce = window.setTimeout(() => void load(value), delay);
      return;
    }
    if (controlled !== false) {
      if (controlled !== true) {
        action.disabled = true;
        status(controlled === 'unavailable' ? 'Quote service unavailable.' : 'Checking quote availability…');
        return;
      }
      if (!canPrepare) {
        action.disabled = !hasPreparedSwap;
        status(hasPreparedSwap ? 'Review a prepared swap.' : 'No prepared swaps available.');
        return;
      }
      action.disabled = preparing || value === undefined;
      if (preparing) status(admin ? 'Preparing and executing your regtest swap…' : 'Preparing your regtest swap for review…');
      else if (value === undefined) status('Enter ' + ownedRange);
      else if (!quote) {
        status('Updating quote…'); debounce = window.setTimeout(() => void load(value), delay);
      } else status(admin ? 'Quote ready · SWAP starts execution' : 'Quote ready · review before swapping');
      return;
    }
    action.disabled = !aligned || !canQuote(pair) || value === undefined;
    if (value === undefined) { status('Enter 10,000–1,000,000 sats'); return; }
    status('Updating quote…');
    debounce = window.setTimeout(() => void load(value), delay);
  }

  mountCubes(() => {
    aligned = false;
    successNotice = false;
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
    if (admin && pair.send === 'lightning' && pair.receive === 'onchain' && controlled !== true) return;
    if (guestRoute() && guestAvailable) {
      if (preparing || !guestFlow) return;
      const value = principal();
      if (!aligned || !canQuote(pair) || value === undefined || dialog.open) return;
      const version = revision; const active = () => visible && version === revision && guestAvailable && !get('swap').hidden;
      let failure: string | undefined;
      preparing = true; schedule(0);
      try { await guestFlow.begin(value, active); }
      catch (error) { failure = error instanceof Error ? error.message : 'Guest preparation is unavailable.'; }
      finally { preparing = false; if (visible) { schedule(0); if (active() && failure) status(failure); } }
      return;
    }
    if (!route && controlled === true) {
      if (preparing) return;
      if (canPrepare && prepare && !preparing && aligned && canQuote(pair)) {
        const version = revision; const active = () => visible && version === revision && controlled === true;
        let failure: string | undefined;
        const value = principal();
        if (value === undefined) return;
        preparing = true;
        action.disabled = true;
        window.clearTimeout(debounce);
        window.clearTimeout(expiry);
        try {
          const current = quote && quote.expiresAt > Date.now() ? quote : await load(value);
          if (!active()) return;
          if (!current || current.invoiceSats !== value || current.expiresAt <= Date.now()) throw new Error('A current quote for this amount is required. Press Swap to retry.');
          window.clearTimeout(expiry);
          status(admin ? 'Preparing and executing your regtest swap…' : 'Preparing your regtest swap for review…');
          await prepare(active, current, ownedDestination);
        }
        catch (error) { failure = error instanceof Error ? error.message : 'Preparation uncertain. Check existing status.'; }
        finally {
          preparing = false;
          if (active() && failure) { action.disabled = false; status(failure); }
          else if (visible) schedule(0);
        }
        return;
      }
      if (aligned && canQuote(pair) && hasPreparedSwap) location.hash = 'track';
      return;
    }
    const value = principal();
    if ((!route && controlled !== false) || !aligned || !canQuote(pair) || value === undefined || dialog.open || submittingArk) return;
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
    if (csrf) recordQuote?.(pair, current);
    if (route) {
      const boarding = route === 'onchain-to-ark';
      details(get('review-details'), [
        ['Route', railLabel[pair.send] + ' → ' + railLabel[pair.receive]],
        ['Method', boarding ? 'Boarding (On-chain → Ark VTXO)' : 'Cooperative offboarding (Ark VTXO → On-chain)'],
        ['Network', 'Bitcoin regtest'],
        ['Amount to send', sats(current.invoiceSats)],
        ['Operator fee', sats(current.serviceFeeSats)],
        ['Estimated batch commitment fee', sats(current.claimFeeSats)],
        [boarding ? 'Estimated Ark VTXO credit' : 'Estimated on-chain payout', sats(totals.received)],
        ['Estimated cost', sats(totals.lost)],
      ]);
      clearArkFields();
      startButton.disabled = true;
      dialog.showModal();
      updateArkExecutionState();
      return;
    }
    clearArkFields();
    startButton.disabled = true;
    details(get('review-details'), [
      ['Route', railLabel[pair.send] + ' → ' + railLabel[pair.receive]],
      ['Amount to send', sats(value)],
      ['Service fee', sats(current.serviceFeeSats)],
      ['Estimated network claim fee', sats(current.claimFeeSats)],
      ['Lightning routing fee', 'Unknown'],
      ['Lightning invoice amount', sats(current.invoiceSats)],
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
    noticeCompletion() { successNotice = true; },
    setVisible(next: boolean) {
      if (visible === next) return;
      visible = next;
      if (!visible) {
        guestFlow?.cancel();
        if (!quote) invalidate();
        return;
      }
      if (quote && quote.expiresAt > Date.now()) { if (successNotice) status(''); return; }
      invalidate();
      schedule(0);
    },
    setArkEnvironment(environment: Environment | undefined) {
      arkEnvironment = environment;
      if (visible && aligned && isArkRoute() && quote) showArkQuoteStatus();
      updateArkExecutionState();
    },
    setArkExecutionAllowed(allowed: typeof arkExecutionAllowed) {
      arkExecutionAllowed = allowed;
      if (visible && aligned && isArkRoute() && quote) showArkQuoteStatus();
      updateArkExecutionState();
    },
    setContext(configured: boolean | 'unavailable' | null, csrfToken?: string, preparationAvailable = false,
      preparedSwapAvailable = false, isAdmin = false, maximum = 50_000, destination?: string) {
      if (controlled === configured && csrf === csrfToken && canPrepare === preparationAvailable &&
        hasPreparedSwap === preparedSwapAvailable && admin === isAdmin && maxSourceAmount === maximum && ownedDestination === destination) return;
      const sessionChanged = csrf !== csrfToken;
      if (sessionChanged) successNotice = false;
      controlled = configured;
      csrf = csrfToken;
      admin = isAdmin;
      maxSourceAmount = maximum;
      ownedDestination = destination;
      canPrepare = preparationAvailable;
      hasPreparedSwap = preparedSwapAvailable;
      amount.readOnly = false;
      if (!sessionChanged && isArkRoute()) return;
      invalidate();
      schedule(0);
    },
    setGuestContext(configured: boolean, watching: boolean) {
      const available = configured && watching;
      if (guestConfigured === configured && guestAvailable === available) return;
      guestConfigured = configured;
      guestAvailable = available;
      if (!guestRoute()) return;
      invalidate();
      schedule(0);
    },
  };
}
