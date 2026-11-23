import { api, ApiResponseError, type OwnedOperation, type OwnedSwap, type Quote, type ReverseAvailability, type Session } from './api.js';
import { describeSwapState } from '../ui/swapStatus.js';
import { details, get, sats, text } from './ui.js';

type Action = 'execute' | 'reconcile';
type Preparation = boolean | 'unavailable';
const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const deadline = (value: number | null) =>
  value === null || !Number.isFinite(new Date(value).getTime()) ? 'Unavailable' : date.format(value);
const fee = (value: number | null) => value === null ? 'Unknown' : sats(value);

function durableIntent(owner: Session, swap: OwnedSwap, kind: Action) {
  const name = ['swap-engine.prepared', owner.user.id, swap.id, kind, kind === 'reconcile' ? swap.revision : 'once'].join('.');
  const payload = kind === 'execute'
    ? { preparedSwapId: swap.id, expectedRevision: swap.revision }
    : { expectedRevision: swap.revision };
  const previous = localStorage.getItem(name);
  if (previous !== null) {
    const saved = JSON.parse(previous) as { key?: unknown; body?: unknown } | null;
    if (!saved || typeof saved.key !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(saved.key)
      || JSON.stringify(saved.body) !== JSON.stringify(payload)) {
      throw new Error('A previous request differs from this revision. Refresh its status before continuing.');
    }
    return saved.key;
  }
  const key = crypto.randomUUID();
  localStorage.setItem(name, JSON.stringify({ key, body: payload }));
  return key;
}

function outcome(result: OwnedOperation, kind: Action) {
  if (result.status === 'RUNNING') return 'Request in progress. Check the owned swap status.';
  if (result.status === 'RECONCILIATION_REQUIRED') return 'Result uncertain. Check recovery evidence when available.';
  if (kind === 'execute') return 'Execution reported success. The owned status below is authoritative.';
  const guidance = {
    FUND: 'Evidence reviewed. Funding requires operator review.',
    CLAIM: 'Evidence reviewed. Claiming requires operator review.',
    SETTLE: 'Evidence reviewed. Settlement requires operator review.',
    DONE: 'Recovery evidence is complete.',
    MANUAL_REVIEW: 'Recovery requires manual operator review.',
  };
  return result.result.next ? guidance[result.result.next] : 'Recovery evidence refreshed.';
}

function errorStatus(error: unknown) {
  if (!(error instanceof ApiResponseError)) return 'Result uncertain. Refresh the swap status before retrying.';
  if (error.status === 401 || error.status === 403) return 'Session or permissions could not be verified. Sign in again.';
  if (error.status === 404) return 'This prepared swap is no longer accessible.';
  if (error.status === 409) return 'Swap changed or an operation is already reserved. Review the latest status.';
  return 'The server did not confirm the request. Check the swap status.';
}

export function mountOwnedReverse(onConfigured: (configured: Preparation, availability?: ReverseAvailability) => void, onCompleted: () => void) {
  const picker = get<HTMLSelectElement>('prepared-swap');
  const refreshButton = get<HTMLButtonElement>('owned-refresh');
  const reviewButton = get<HTMLButtonElement>('owned-review');
  const reconcileButton = get<HTMLButtonElement>('owned-reconcile');
  const confirmButton = get<HTMLButtonElement>('owned-confirm');
  const dialog = get<HTMLDialogElement>('owned-review-dialog');
  const status = (value: string) => text('owned-status', value);
  let session: Session | null = null;
  let current: OwnedSwap | undefined;
  let capability: ReverseAvailability | undefined;
  let requests: AbortController | undefined;
  let reviewed: OwnedSwap | undefined;
  let visible = false;
  let configured = false;
  let loading = false;
  let working = false;
  let poll: number | undefined;
  let viewEpoch = 0;

  function completedReturn(swap: OwnedSwap, available: ReverseAvailability) {
    const owner = session;
    if (!owner || !visible || available.preparationAvailable !== true || swap.state !== 'COMPLETED' ||
      swap.execution.status !== 'COMPLETED' || swap.payment.status !== 'SUCCEEDED' || !swap.funding.txid || !swap.claim.txid) return;
    const executionKey = `swap-engine.prepared.${owner.user.id}.${swap.id}.execute.once`;
    const preparationKey = `swap-engine.preparation.${owner.user.id}`;
    try {
      const raw = localStorage.getItem(preparationKey); const saved = raw ? JSON.parse(raw) as { id?: string } : undefined;
      const prep = available.preparations?.find(p => p.swapId === swap.id);
      const matchesPreparation = !!prep && saved?.id === prep.id;
      if (!matchesPreparation && localStorage.getItem(executionKey) === null) return;
      // Retain public evidence before selective cleanup. Other owners/attempts/recovery keys survive.
      const evidenceKey = `swap-engine.completed.${owner.user.id}.${swap.id}`;
      const evidence = JSON.stringify({ id: swap.id, revision: swap.revision, state: swap.state,
        payment: swap.payment, funding: swap.funding, claim: swap.claim, claimDestination: swap.claimDestination });
      localStorage.setItem(evidenceKey, evidence);
      if (localStorage.getItem(evidenceKey) !== evidence) return;
      localStorage.removeItem(executionKey); if (matchesPreparation) localStorage.removeItem(preparationKey);
      onCompleted();
      location.hash = 'swap';
    } catch { /* Keep the verified history visible when browser storage cannot preserve it. */ }
  }

  function permitted(kind: Action, swap?: OwnedSwap, availability?: ReverseAvailability) {
    if (!availability?.controlledReverseConfigured || !swap || !availability.preparedSwapIds.includes(swap.id)) return false;
    if (kind === 'reconcile') return availability.recoveryAvailable && swap.allowedActions.includes('RECONCILE');
    const quote = swap.quote;
    return availability.executionAvailable && swap.allowedActions.includes('EXECUTE') && swap.execution.approvedUntil !== null
      && quote.invoiceSats === quote.amountSats + quote.serviceFeeSats && swap.payment.valueSats === quote.invoiceSats
      && swap.claim.feeSats === quote.claimFeeSats && swap.claim.netSats === quote.amountSats - quote.claimFeeSats;
  }

  function actions() {
    const busy = loading || working;
    picker.disabled = refreshButton.disabled = busy;
    reviewButton.disabled = busy || !permitted('execute', current, capability);
    reconcileButton.disabled = busy || !permitted('reconcile', current, capability);
    confirmButton.disabled = busy || !reviewed || reviewButton.disabled;
  }

  function render(swap?: OwnedSwap) {
    current = swap;
    details(get('owned-evidence'), swap ? [
      ['Swap ID', swap.id],
      ['Status', describeSwapState(swap.state).label],
      ['Execution', swap.execution.status.replaceAll('_', ' ')],
      ['Payment status', swap.payment.status.replaceAll('_', ' ')],
      ['Lightning invoice amount', sats(swap.payment.valueSats)],
      ['Service fee', sats(swap.quote.serviceFeeSats)],
      ['Estimated claim fee', sats(swap.claim.feeSats)],
      ['Funding transaction', swap.funding.txid ?? 'Unavailable'],
      ['Funding fee', fee(swap.funding.feeSats)],
      ['Claim transaction', swap.claim.txid ?? 'Unavailable'],
      ['Actual routing fee', fee(swap.payment.feeSats)],
      ['Destination', swap.claimDestination],
      ['Estimated net receipt', sats(swap.claim.netSats)],
    ] : []);
    actions();
  }

  function closeReview() {
    reviewed = undefined;
    if (dialog.open) dialog.close();
    actions();
  }

  function cancelReads() {
    window.clearTimeout(poll);
    requests?.abort();
    requests = undefined;
    loading = false;
  }

  async function refresh(id = picker.value, notice?: string) {
    const owner = session;
    if (!owner || working) return;
    cancelReads();
    const controller = new AbortController();
    requests = controller;
    loading = true;
    capability = undefined;
    actions();
    if (visible) status(notice ?? 'Checking prepared swaps…');
    try {
      const available = await api.reverseAvailability(controller.signal);
      if (requests !== controller) return;
      capability = available;
      configured = available.controlledReverseConfigured;
      onConfigured(configured, available);
      if (!visible) return;
      if (!available.controlledReverseConfigured) {
        get('owned-controls').hidden = true;
        text('owned-tag', 'UNAVAILABLE');
        render();
        status(notice ?? 'Prepared swap service is unavailable.');
        return;
      }
      const { swaps } = await api.ownedSwaps(controller.signal);
      if (requests !== controller) return;
      const owned = swaps.filter(swap => available.preparedSwapIds.includes(swap.id));
      const selected = owned.find(swap => swap.id === id) ?? owned[0];
      picker.replaceChildren(...owned.map(swap => new Option(swap.id, swap.id)));
      get('owned-controls').hidden = !selected;
      text('owned-tag', 'REGTEST');
      if (!selected) {
        render();
        status(notice ?? 'No prepared swaps belong to this account.');
        return;
      }
      picker.value = selected.id;
      const latest = await api.ownedSwap(selected.id, controller.signal);
      if (requests !== controller) return;
      if (latest.id !== selected.id) throw new Error('Unexpected swap ID');
      render(latest);
      completedReturn(latest, available);
      status(notice ?? (permitted('execute', latest, available)
        ? 'Prepared swap available for review.'
        : 'Swap status only. Execution unavailable.'));
      if (latest.execution.status === 'RUNNING') poll = window.setTimeout(() => void refresh(latest.id), 3000);
    } catch (error) {
      if (requests !== controller) return;
      if (!configured) onConfigured(error instanceof ApiResponseError && [403, 404].includes(error.status) ? false : 'unavailable');
      if (!visible) return;
      get('owned-controls').hidden = true;
      text('owned-tag', 'UNAVAILABLE');
      render();
      const unavailable = error instanceof ApiResponseError && error.status === 401
        ? 'Sign in again to view prepared swaps.' : 'Prepared swap service is unavailable.';
      status(notice ? notice + ' ' + unavailable : unavailable);
    } finally {
      if (requests === controller) {
        requests = undefined;
        loading = false;
        actions();
      }
    }
  }

  async function perform(kind: Action, selected: OwnedSwap) {
    const owner = session;
    const epoch = viewEpoch;
    if (working || loading || !owner || !visible || !permitted(kind, selected, capability)) return;
    closeReview();
    cancelReads();
    working = true;
    actions();
    status(kind === 'execute' ? 'Rechecking approval before submission…' : 'Rechecking status before reconciliation…');
    let notice: string | undefined;
    let submitted = false;
    try {
      const check = new AbortController();
      requests = check;
      const [available, latest] = await Promise.all([
        api.reverseAvailability(check.signal), api.ownedSwap(selected.id, check.signal),
      ]);
      if (session !== owner || requests !== check || !visible) {
        notice = undefined;
      } else if (latest.id !== selected.id || latest.revision !== selected.revision
        || !permitted(kind, latest, available) || (kind === 'execute' && (
          latest.claimDestination !== selected.claimDestination
          || latest.execution.approvedUntil !== selected.execution.approvedUntil
          || JSON.stringify(latest.quote) !== JSON.stringify(selected.quote)
          || JSON.stringify(latest.claim) !== JSON.stringify(selected.claim)
          || JSON.stringify(latest.payment) !== JSON.stringify(selected.payment)
        ))) {
        notice = 'Swap terms or authorization changed. Review the latest status.';
      } else {
        let key: string;
        try {
          key = durableIntent(owner, latest, kind);
        } catch {
          status('Could not safely persist or reuse the request. Refresh status before continuing.');
          return;
        }
        status(kind === 'execute' ? 'Submitting prepared swap…' : 'Checking recovery evidence…');
        submitted = true;
        const result = await api.reverseAction(latest.id, latest.revision, key, owner.csrfToken, kind);
        if (result.status === 'SUCCEEDED' && result.result.id !== latest.id) throw new Error('Unexpected swap ID');
        notice = outcome(result, kind);
      }
    } catch (error) {
      notice = submitted || (error instanceof ApiResponseError && [401, 403, 404].includes(error.status))
        ? errorStatus(error) : 'Could not verify current authorization. No operation was submitted.';
    } finally {
      working = false;
      actions();
    }
    if (viewEpoch === epoch && session === owner && visible) await refresh(selected.id, notice);
    else if (viewEpoch === epoch && session && visible) await refresh();
  }

  picker.addEventListener('change', () => {
    closeReview();
    render();
    void refresh(picker.value);
  });
  refreshButton.addEventListener('click', () => void refresh());
  reviewButton.addEventListener('click', () => {
    if (working || loading || !current || !permitted('execute', current, capability)) return;
    const swap = current;
    const q = swap.quote;
    reviewed = swap;
    details(get('owned-review-details'), [
      ['Network', 'Bitcoin Regtest'],
      ['Route', 'Lightning → On-chain'],
      ['Prepared swap', swap.id],
      ['Destination', swap.claimDestination],
      ['Amount to send', sats(swap.payment.valueSats)],
      ['Lightning invoice amount', sats(q.invoiceSats)],
      ['Service fee', sats(q.serviceFeeSats)],
      ['Estimated claim fee', sats(swap.claim.feeSats)],
      ['Regtest confirmations', 'Up to 2 blocks'],
      ['Actual routing fee', fee(swap.payment.feeSats)],
      ['Estimated net receipt', sats(swap.claim.netSats)],
      ['Prepared quote expiry', deadline(q.expiresAt)],
      ['Execution approval deadline', deadline(swap.execution.approvedUntil)],
    ]);
    actions();
    dialog.showModal();
  });
  confirmButton.addEventListener('click', () => { if (reviewed) void perform('execute', reviewed); });
  reconcileButton.addEventListener('click', () => { if (current) void perform('reconcile', current); });
  dialog.addEventListener('close', () => { if (!dialog.open) { reviewed = undefined; actions(); } });

  return {
    async executePrepared(owner: Session, id: string, quoted: Quote, destination: string | undefined, active: () => boolean) {
      if (owner.user.role !== 'ADMIN' || session !== owner || !active()) return;
      const signal = new AbortController().signal;
      const [available, swap] = await Promise.all([api.reverseAvailability(signal), api.ownedSwap(id, signal)]);
      if (session !== owner || !active()) return;
      if (swap.id !== id) throw new Error('Unexpected prepared swap ID.');
      if (swap.execution.status !== 'NOT_STARTED') return 'Check the existing execution status.';
      const quote = swap.quote;
      if (!permitted('execute', swap, available) || !swap.execution.approvedUntil ||
        (destination !== undefined && (swap.claimDestination !== destination || available.claimDestination !== destination)) ||
        Math.min(quoted.expiresAt, quote.expiresAt, swap.execution.approvedUntil) <= Date.now() ||
        quote.invoiceSats !== quoted.invoiceSats || quote.amountSats !== quoted.amountSats ||
        quote.serviceFeeSats !== quoted.serviceFeeSats || quote.claimFeeSats !== quoted.claimFeeSats ||
        quote.fundingReserveSats !== quoted.fundingReserveSats)
        return 'Execution terms or authorization changed. Review the prepared swap before continuing.';
      const key = durableIntent(owner, swap, 'execute');
      try {
        const result = await api.reverseAction(id, swap.revision, key, owner.csrfToken, 'execute');
        if (result.status === 'SUCCEEDED' && result.result.id !== id) throw new Error('Unexpected swap ID.');
        return outcome(result, 'execute');
      } catch (error) {
        return errorStatus(error);
      }
    },
    async showPrepared(id: string, notice?: string) {
      visible = true;
      await refresh(id, notice);
    },
    async reviewPrepared(id: string) {
      visible = true; const epoch = viewEpoch; await refresh(id);
      if (visible && epoch === viewEpoch && !get('track').hidden && current?.id === id && permitted('execute', current, capability)) reviewButton.click();
    },
    setSession(next: Session | null) {
      if (session === next) return;
      cancelReads();
      closeReview();
      session = next;
      refreshButton.hidden = !next;
      configured = false;
      capability = undefined;
      picker.replaceChildren();
      get('owned-controls').hidden = true;
      text('owned-tag', 'UNAVAILABLE');
      render();
      if (!session) onConfigured(false);
      status('Transaction status requires verified swap ownership.');
      if (session) void refresh();
    },
    setVisible(next: boolean) {
      if (visible === next) return;
      viewEpoch++;
      visible = next;
      if (visible) void refresh();
      else {
        cancelReads();
        closeReview();
      }
    },
  };
}
