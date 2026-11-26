import { api, type ForwardStatus, type Session } from './api.js';
import { details, get, sats, text } from './ui.js';

export function mountForward() {
  const controls = get('forward-controls');
  const form = get<HTMLFormElement>('forward-admission');
  const invoice = get<HTMLInputElement>('forward-invoice');
  const amount = get<HTMLInputElement>('forward-amount');
  const picker = get<HTMLSelectElement>('forward-picker');
  const txid = get<HTMLInputElement>('forward-txid');
  const vout = get<HTMLInputElement>('forward-vout');
  const execute = get<HTMLButtonElement>('forward-execute');
  const recover = get<HTMLButtonElement>('forward-recover');
  const notice = (value: string) => text('forward-status', value);
  let session: Session | null = null;
  let visible = false;
  let epoch = 0;
  let busy = false;
  let verified: { status: ForwardStatus; point: string } | undefined;
  const point = () => {
    const index = vout.valueAsNumber;
    return /^[a-f0-9]{64}$/.test(txid.value) && Number.isInteger(index) && index >= 0 && index <= 0xffffffff
      ? { txid: txid.value, vout: index } : undefined;
  };
  function buttons() {
    const status = verified?.status;
    execute.disabled = busy || !status || status.state !== 'AWAITING_DEPOSIT' || status.expiresAt <= Date.now()
      || (status.confirmations ?? 0) < status.requiredConfirmations || verified?.point !== JSON.stringify(point());
    recover.disabled = busy || (status?.state !== 'UNKNOWN' && status?.state !== 'INTENT');
    picker.disabled = busy;
  }
  function render(status?: ForwardStatus) {
    txid.readOnly = vout.readOnly = Boolean(status?.outpoint);
    if (status?.outpoint) {
      txid.value = status.outpoint.txid;
      vout.value = String(status.outpoint.vout);
    }
    get('forward-deposit').hidden = !status;
    verified = status ? { status, point: JSON.stringify(point()) ?? '' } : undefined;
    details(get('forward-evidence'), status ? [
      ['State', status.state],
      ['Lightning invoice', status.invoice],
      ['Invoice amount', sats(status.invoiceSats)],
      ['Exclusive deposit address', status.address],
      ['Exact deposit amount', sats(status.depositSats)],
      ['Confirmations', status.confirmations === null ? `Not verified (requires ${status.requiredConfirmations})`
        : `${status.confirmations} / ${status.requiredConfirmations}`],
      ['Payment deadline', new Date(status.expiresAt).toLocaleString()],
    ] : []);
    buttons();
  }
  async function run(work: (owner: Session, current: () => boolean) => Promise<void>) {
    const owner = session;
    if (!owner || !visible || busy) return;
    const version = epoch;
    const current = () => version === epoch;
    busy = true;
    buttons();
    try { await work(owner, current); }
    catch { if (current()) { render(); notice('Request not confirmed. Refresh the owned status before taking further action.'); } }
    finally { if (current()) { busy = false; buttons(); } }
  }
  async function load(id: string, current: () => boolean) {
    const candidate = point();
    const status = await api.forwardStatus(id, candidate);
    if (!current()) return;
    if (status.id !== id) throw new Error('Unexpected forward ID');
    // Inputs can change during a read. Only enable Pay for the exact inspected candidate.
    render(status);
    if (!status.outpoint && verified) verified.point = JSON.stringify(candidate) ?? '';
    buttons();
    notice({
      SUCCEEDED: 'Lightning payment verified by the backend.',
      UNKNOWN: 'Payment must be checked without resending.',
      INTENT: 'Payment intent recorded. Check the payment without resending.',
      EXPIRED: 'Reservation expired. Do not send a deposit.',
      AWAITING_DEPOSIT: 'Only fund the exact regtest amount. Enter the transaction output and refresh to check confirmations.',
    }[status.state]);
  }
  async function list(current: () => boolean, selected?: string) {
    const { ids } = await api.forwardList();
    if (!current()) return;
    picker.replaceChildren(...ids.map(id => new Option(id, id)));
    if (selected && ids.includes(selected)) picker.value = selected;
    if (picker.value) await load(picker.value, current);
    else notice('No forward swaps belong to this account.');
  }
  function reset() {
    epoch++;
    busy = false;
    controls.hidden = true;
    form.reset();
    picker.replaceChildren();
    txid.value = vout.value = '';
    render();
    notice('Sign in to check forward availability.');
    if (session && visible) void run(async (_owner, current) => {
      const available = await api.forwardAvailability().catch(() => undefined);
      if (!available) {
        if (current()) notice('Forward availability could not be verified. Do not send funds.');
        return;
      }
      if (!available.executionAvailable) {
        if (current()) notice('Bitcoin on-chain → Lightning execution unavailable for this account.');
        return;
      }
      if (!current()) return;
      controls.hidden = false;
      await list(current);
    });
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    const paymentRequest = invoice.value.trim();
    const invoiceSats = amount.valueAsNumber;
    void run(async (owner, current) => {
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(paymentRequest));
      const key = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
      if (!current()) return;
      const { id } = await api.forwardAdmit(owner.csrfToken, paymentRequest, invoiceSats, key);
      if (!current()) return;
      form.reset();
      txid.value = vout.value = '';
      await list(current, id);
    });
  });
  const refresh = () => void run(async (_owner, current) => { if (picker.value) await load(picker.value, current); });
  picker.addEventListener('change', () => { txid.value = vout.value = ''; render(); refresh(); });
  get('forward-refresh').addEventListener('click', refresh);
  txid.addEventListener('input', buttons);
  vout.addEventListener('input', buttons);
  function action(recovery: boolean) {
    if ((recovery ? recover : execute).disabled || !verified) return;
    const id = verified.status.id;
    const candidate = recovery ? undefined : point();
    if (!recovery && !candidate) return;
    void run(async (owner, current) => {
      try { await api.forwardAction(owner.csrfToken, id, candidate); }
      catch { /* Only a fresh owned status can confirm the outcome. */ }
      if (current()) await load(id, current);
    });
  }
  execute.addEventListener('click', () => action(false));
  recover.addEventListener('click', () => action(true));
  return {
    setSession(next: Session | null) { if (session !== next) { session = next; reset(); } },
    setVisible(next: boolean) { if (visible !== next) { visible = next; reset(); } },
  };
}
