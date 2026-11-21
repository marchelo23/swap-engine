import { address, payments, networks } from 'bitcoinjs-lib';
import { api, ApiResponseError, type GuestQuote, type GuestStatus } from './api.js';
import {
  createGuestRecoveryBundle, createGuestRecoverySecrets, decryptGuestRecovery, encryptGuestRecovery,
  generateGuestRecoveryIdentity, parseEncryptedRecovery, recoveryCommitment, serializeEncryptedRecovery,
  type EncryptedGuestRecovery, type GuestRecoveryBundle, type GuestRecoveryIdentity, type GuestRecoverySecrets,
} from '../client/GuestRecovery.js';
import { signGuestClaim } from '../client/GuestClaim.js';
import { details, get, sats, text } from './ui.js';

export type GuestInvoicePresentation = { invoice: string; invoiceSats: number; invoiceExpiresAt: number | null };
export type GuestPresentation = {
  /** Optional on-chain BTC destination supplied by the guest UI. If present it
   * must be a regtest bech32 address; otherwise a recovery-key destination is used. */
  readDestination?: () => string | undefined;
  /** Receives the BOLT11 only after recovery restore verification and watcher
   * readiness. Null clears the presentation when the flow closes. */
  showInvoice?: (value: GuestInvoicePresentation | null) => void;
  showStatus?: (message: string) => void;
};

type Flow = {
  epoch: number; identity: GuestRecoveryIdentity; amountSats: number; quote?: GuestQuote; quoteKey: string;
  secrets?: GuestRecoverySecrets; prepareKey: string; passphrase?: string; status?: GuestStatus;
  bundle?: GuestRecoveryBundle; envelope?: EncryptedGuestRecovery; exported: boolean; verified: boolean;
  poll?: number; controller?: AbortController; claimKey?: string; claimRevision?: number; uncertain?: boolean;
  active: () => boolean;
};

const terminal = new Set(['COMPLETED', 'EXPIRED', 'REFUNDED', 'FAILED', 'MANUAL_REVIEW', 'PREPARATION_UNKNOWN', 'UNKNOWN']);
const hex = /^[a-f0-9]{64}$/;
function bytes(value: string) { return Uint8Array.from(value.match(/../g) ?? [], part => Number.parseInt(part, 16)); }
function statusText(status: GuestStatus) {
  if (status.status === 'COMPLETED' || status.swapState === 'COMPLETED') return 'Guest swap completed.';
  if (status.status === 'CLAIM_BROADCAST_PENDING_CONFIRMATION') return 'Claim broadcast. Waiting for confirmation and settlement.';
  if (status.status === 'PAYMENT_ACCEPTED_NOT_SETTLED') return 'Invoice accepted. Waiting for the watcher to confirm the on-chain funding.';
  if (status.status === 'FUNDED_AWAITING_CLAIM') return 'Funding confirmed. Sign the claim locally when you are ready.';
  if (status.status === 'INVOICE_CREATED') return 'Waiting for payment and confirmed funding.';
  if (status.status === 'MANUAL_REVIEW' || status.status === 'UNKNOWN' || status.status === 'PREPARATION_UNKNOWN')
    return 'Manual review required. No claim was submitted and nothing will be retried.';
  if (terminal.has(status.status)) return 'This guest swap is closed. No further action is available.';
  return 'Guest status updated.';
}
function canClaim(status: GuestStatus) {
  return status.status === 'FUNDED_AWAITING_CLAIM' && status.invoiceState === 'ACCEPTED' &&
    !!status.fundingTxid && hex.test(status.fundingTxid) && Number.isSafeInteger(status.fundingVout) &&
    Number.isSafeInteger(status.fundingConfirmations) && status.fundingConfirmations! >= 1 &&
    typeof status.lockupHex === 'string' && Number.isSafeInteger(status.revision);
}
function sameFunding(a: GuestStatus, b: GuestStatus) {
  return a.id === b.id && a.paymentHash === b.paymentHash && a.claimPublicKey === b.claimPublicKey &&
    (a.invoice === undefined || a.invoice === b.invoice) && a.revision === b.revision && a.fundingTxid === b.fundingTxid &&
    a.fundingVout === b.fundingVout && a.lockupHex === b.lockupHex && a.invoiceState === b.invoiceState;
}
function validStatus(flow: Flow, status: GuestStatus) {
  const quote = flow.quote;
  if (!quote) throw new Error('Guest quote is not ready.');
  if (status.id !== quote.id || status.paymentHash !== flow.identity.paymentHash ||
    status.claimPublicKey !== flow.identity.claimPublicKey ||
    (flow.status?.invoice !== undefined && status.invoice !== undefined && status.invoice !== flow.status.invoice) ||
    status.amountSats !== quote.amountSats || status.invoiceSats !== quote.invoiceSats ||
    status.claimFeeSats !== quote.claimFeeSats) throw new Error('Guest status changed identity or terms.');
  return status;
}

export function mountGuest(presentation: GuestPresentation = {}) {
  const dialog = get<HTMLDialogElement>('guest-dialog');
  const form = get<HTMLFormElement>('guest-recovery-form');
  const passphrase = get<HTMLInputElement>('guest-passphrase');
  const confirmation = get<HTMLInputElement>('guest-passphrase-confirm');
  const restorePassphrase = get<HTMLInputElement>('guest-restore-passphrase');
  const prepareButton = get<HTMLButtonElement>('guest-prepare');
  const exportSection = get<HTMLElement>('guest-export');
  const exportText = get<HTMLTextAreaElement>('guest-export-text');
  const verifyButton = get<HTMLButtonElement>('guest-verify');
  const downloadButton = get<HTMLButtonElement>('guest-download');
  const copyButton = get<HTMLButtonElement>('guest-copy');
  const paymentSection = get<HTMLElement>('guest-payment');
  const invoice = get<HTMLTextAreaElement>('guest-invoice');
  const claimButton = get<HTMLButtonElement>('guest-claim');
  const copyInvoiceButton = get<HTMLButtonElement>('guest-copy-invoice');
  let flow: Flow | undefined;
  let epoch = 0;
  let configured = false;
  let watching = false;

  function setStatus(messageText: string) { text('guest-status', messageText); presentation.showStatus?.(messageText); }
  function setExportStatus(messageText: string) { text('guest-export-status', messageText); presentation.showStatus?.(messageText); }
  function setPaymentStatus(messageText: string) { text('guest-payment-status', messageText); presentation.showStatus?.(messageText); }
  function stopPolling(current: Flow) {
    window.clearTimeout(current.poll); current.poll = undefined;
    current.controller?.abort(); current.controller = undefined;
  }
  function close() {
    epoch++;
    if (flow) { stopPolling(flow); flow = undefined; }
    presentation.showInvoice?.(null);
    passphrase.value = ''; confirmation.value = ''; restorePassphrase.value = ''; exportText.value = ''; invoice.value = '';
    if (dialog.open) dialog.close();
    form.hidden = false; exportSection.hidden = true; paymentSection.hidden = true;
    claimButton.hidden = true; claimButton.disabled = true; verifyButton.disabled = true;
    prepareButton.disabled = false;
  }
  function render(current: Flow) {
    const status = current.status;
    if (!status) return;
    setPaymentStatus(statusText(status));
    if (status.status === 'COMPLETED' || status.swapState === 'COMPLETED') {
      stopPolling(current); claimButton.hidden = true; claimButton.disabled = true;
      setPaymentStatus('Guest swap completed. The resulting claim is confirmed and the invoice is settled.');
      return;
    }
    const claimable = canClaim(status);
    claimButton.hidden = !claimable;
    claimButton.disabled = !claimable || current.uncertain === true;
    if (terminal.has(status.status)) {
      stopPolling(current); claimButton.hidden = true; claimButton.disabled = true;
    }
  }
  async function poll(current: Flow) {
    if (flow !== current || !current.verified || !dialog.open) return;
    window.clearTimeout(current.poll);
    const controller = new AbortController(); current.controller = controller;
    const quote = current.quote;
    if (!quote) return;
    try {
      const status = validStatus(current, await api.guestStatus(quote.id, current.identity.capabilityToken, controller.signal));
      if (flow !== current) return;
      current.status = status; render(current);
      if (!terminal.has(status.status) && status.swapState !== 'COMPLETED')
        current.poll = window.setTimeout(() => void poll(current), 3000);
    } catch (error) {
      if (flow !== current || !dialog.open) return;
      if (error instanceof ApiResponseError && [401, 403, 404].includes(error.status)) {
        setPaymentStatus('Guest status could not be authenticated. No claim was submitted.');
        claimButton.hidden = true; claimButton.disabled = true; return;
      }
      setPaymentStatus('Guest status is unavailable. Retrying without submitting a claim.');
      current.poll = window.setTimeout(() => void poll(current), 5000);
    }
  }
  async function begin(amountSats: number, active: () => boolean) {
    if (!configured || !watching) throw new Error('Guest watcher unavailable. No invoice was created.');
    const availability = await api.guestAvailability();
    if (!availability.configured || !availability.watching) throw new Error('Guest watcher unavailable. No invoice was created.');
    const identity = await generateGuestRecoveryIdentity();
    if (!active()) return;
    close();
    const current: Flow = { epoch: ++epoch, identity, amountSats, quoteKey: crypto.randomUUID(),
      prepareKey: crypto.randomUUID(), exported: false, verified: false, active };
    flow = current;
    details(get('guest-details'), [
      ['Network', 'Bitcoin Regtest'],
      ['Quote principal', sats(amountSats)],
      ['On-chain destination', presentation.readDestination ? 'Use the destination field in this dialog' : 'Derived from the recovery key'],
      ['Recovery export', 'Required before the payable invoice is shown'],
    ]);
    form.hidden = false; exportSection.hidden = true; paymentSection.hidden = true; prepareButton.disabled = false;
    setStatus('Enter the destination and a recovery passphrase. The server never receives the passphrase.');
    dialog.showModal();
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const current = flow;
    if (!current || prepareButton.disabled) return;
    if (passphrase.value.length < 8 || passphrase.value !== confirmation.value) {
      setStatus('Use the same passphrase in both fields (at least 8 characters).'); return;
    }
    prepareButton.disabled = true;
    try {
      const availability = await api.guestAvailability();
      if (!availability.configured || !availability.watching) throw new Error('Guest watcher unavailable. No invoice was created.');
      const supplied = presentation.readDestination?.();
      const destination = (supplied?.trim().toLowerCase() ??
        payments.p2wpkh({ pubkey: bytes(current.identity.claimPublicKey), network: networks.regtest }).address ?? '');
      if (!/^bcrt1[0-9a-z]{20,}$/.test(destination)) throw new Error('Enter a valid regtest on-chain destination.');
      address.toOutputScript(destination, networks.regtest);
      if (!current.active()) return;
      if (!current.quote) {
        setStatus('Creating the guest quote…');
        const quote = await api.guestQuote(current.identity, destination, current.amountSats, current.quoteKey);
        if (!current.active()) return;
        if (quote.destination !== destination || quote.paymentHash !== current.identity.paymentHash ||
          quote.claimPublicKey !== current.identity.claimPublicKey || quote.invoiceSats !== current.amountSats ||
          quote.amountSats + quote.serviceFeeSats !== quote.invoiceSats)
          throw new Error('Guest quote changed identity, destination or amount.');
        current.quote = quote;
        details(get('guest-details'), [
          ['Network', 'Bitcoin Regtest'], ['Destination', quote.destination],
          ['Quote principal', sats(quote.amountSats)], ['Lightning invoice', sats(quote.invoiceSats)],
          ['Service fee', sats(quote.serviceFeeSats)], ['Claim fee', sats(quote.claimFeeSats)],
          ['Recovery export', 'Required before the payable invoice is shown'],
        ]);
      } else if (current.quote.destination !== destination) throw new Error('Destination changed after the quote was created.');
      const secrets = await createGuestRecoverySecrets(current.identity, current.quote);
      const preInvoice = await encryptGuestRecovery(secrets, passphrase.value);
      const commitment = await recoveryCommitment(preInvoice);
      setStatus('Creating the hold invoice and validating the recovery commitment…');
      const status = validStatus(current, await api.guestPrepare(current.quote.id, current.identity.capabilityToken,
        commitment, current.prepareKey));
      if (status.status !== 'INVOICE_CREATED' || !status.swapId || !status.refundPublicKey || !status.timeoutHeight ||
        !status.htlcAddress || !status.witnessScript || !status.invoice) {
        current.uncertain = true;
        setStatus('Invoice preparation is not confirmed. No payable invoice will be shown.');
        return;
      }
      const bundle = await createGuestRecoveryBundle(secrets, { swapId: status.swapId,
        refundPublicKey: status.refundPublicKey, timeoutHeight: status.timeoutHeight,
        htlcAddress: status.htlcAddress, witnessScript: status.witnessScript });
      const envelope = await encryptGuestRecovery(bundle, passphrase.value);
      current.secrets = secrets; current.status = status; current.bundle = bundle; current.envelope = envelope;
      current.passphrase = passphrase.value;
      exportText.value = serializeEncryptedRecovery(envelope);
      form.hidden = true; exportSection.hidden = false; verifyButton.disabled = true;
      setExportStatus('Download or copy this encrypted recovery file, then re-enter the passphrase to verify a restore.');
    } catch (error) {
      current.uncertain = true;
      setStatus(error instanceof Error ? error.message : 'Guest preparation is uncertain. Do not retry.');
    } finally {
      prepareButton.disabled = current.uncertain === true;
    }
  });
  downloadButton.addEventListener('click', () => {
    const current = flow; const quote = current?.quote; if (!current?.envelope || !quote) return;
    const blob = new Blob([exportText.value], { type: 'application/json' });
    const href = URL.createObjectURL(blob); const link = document.createElement('a');
    link.href = href; link.download = `guest-recovery-${quote.id}.json`; link.click();
    URL.revokeObjectURL(href); current.exported = true; verifyButton.disabled = false;
    setExportStatus('Encrypted recovery downloaded. Re-enter the passphrase and verify the restore.');
  });
  copyButton.addEventListener('click', async () => {
    const current = flow; if (!current?.envelope) return;
    try {
      await navigator.clipboard.writeText(exportText.value);
      current.exported = true; verifyButton.disabled = false;
      setExportStatus('Encrypted recovery copied. Re-enter the passphrase and verify the restore.');
    } catch { setExportStatus('Copy is unavailable. Download the encrypted recovery instead.'); }
  });
  verifyButton.addEventListener('click', async () => {
    const current = flow;
    if (!current?.bundle || !current.envelope || !current.exported || restorePassphrase.value.length < 8) {
      setExportStatus('Download the encrypted file and re-enter its passphrase before verifying.'); return;
    }
    try {
      const envelope = parseEncryptedRecovery(exportText.value);
      const restored = await decryptGuestRecovery(envelope, restorePassphrase.value);
      if (!('refundPublicKey' in restored) || restored.swapId !== current.bundle.swapId ||
        restored.paymentHash !== current.bundle.paymentHash || restored.claimPublicKey !== current.bundle.claimPublicKey ||
        restored.htlcAddress !== current.bundle.htlcAddress || restored.witnessScript !== current.bundle.witnessScript)
        throw new Error('Recovery restore does not match this guest swap.');
      const availability = await api.guestAvailability();
      if (!availability.configured || !availability.watching)
        throw new Error('Guest watcher unavailable. The payable invoice was not shown.');
      if (!current.active()) return;
      current.verified = true; restorePassphrase.value = '';
      exportSection.hidden = true; paymentSection.hidden = false;
      invoice.value = current.status!.invoice!;
      presentation.showInvoice?.({ invoice: invoice.value, invoiceSats: current.quote!.invoiceSats,
        invoiceExpiresAt: current.status!.invoiceExpiresAt ?? null });
      setPaymentStatus('Recovery verified. Pay the BOLT11 invoice with a regtest wallet.');
      void poll(current);
    } catch (error) {
      setExportStatus(error instanceof Error ? error.message : 'Recovery restore verification failed.');
    }
  });
  claimButton.addEventListener('click', async () => {
    const current = flow; const quote = current?.quote;
    if (!current?.bundle || !quote || !current.status || !canClaim(current.status) || current.uncertain) return;
    claimButton.disabled = true;
    try {
      const availability = await api.guestAvailability();
      if (!availability.configured || !availability.watching) throw new Error('Guest watcher unavailable. No claim was submitted.');
      const fresh = validStatus(current, await api.guestStatus(quote.id, current.identity.capabilityToken));
      if (!sameFunding(current.status, fresh) || !canClaim(fresh)) {
        current.status = fresh; render(current);
        setPaymentStatus('Funding evidence changed. No claim was submitted; review the latest status.');
        return;
      }
      const revision = fresh.revision; const fundingVout = fresh.fundingVout;
      if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || typeof fundingVout !== 'number' ||
        !Number.isSafeInteger(fundingVout) || typeof fresh.fundingTxid !== 'string' || typeof fresh.lockupHex !== 'string')
        throw new Error('Guest funding evidence has no safe revision.');
      if (current.claimRevision !== revision) { current.claimRevision = revision; current.claimKey = crypto.randomUUID(); }
      const claim = await signGuestClaim(current.bundle, fresh.lockupHex, fresh.fundingTxid, fundingVout);
      setPaymentStatus('Claim signed locally. Submitting the exact outpoint evidence once…');
      const result = await api.guestClaim(quote.id, current.identity.capabilityToken,
        claim.hex, revision, current.claimKey!);
      if (result.id !== quote.id) throw new Error('Guest claim returned a different swap.');
      setPaymentStatus('Claim broadcast. Waiting for confirmation and settlement.');
      void poll(current);
    } catch (error) {
      if (error instanceof ApiResponseError && error.status === 503) {
        current.uncertain = true;
        setPaymentStatus('Claim outcome is uncertain. Do not retry; the watcher will reconcile the existing evidence.');
      } else if (error instanceof ApiResponseError && error.status === 409) {
        setPaymentStatus('Claim state changed. Refresh the status before continuing.');
        void poll(current);
      } else if (error instanceof ApiResponseError && [401, 403, 404].includes(error.status)) {
        current.uncertain = true;
        setPaymentStatus('Claim could not be authenticated. No claim was submitted.');
      } else {
        setPaymentStatus(error instanceof Error ? error.message : 'Claim was not submitted.');
      }
    } finally {
      if (flow === current) claimButton.disabled = !canClaim(current.status!) || current.uncertain === true;
    }
  });
  copyInvoiceButton.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(invoice.value); setPaymentStatus('Invoice copied.'); }
    catch { setPaymentStatus('Copy is unavailable. Select the invoice text instead.'); }
  });
  get('guest-cancel').addEventListener('click', close);
  get('guest-close').addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  return {
    setAvailability(nextConfigured: boolean, nextWatching: boolean) { configured = nextConfigured; watching = nextWatching; },
    begin,
    cancel: close,
  };
}
