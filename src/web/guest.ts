import { address, payments, networks } from 'bitcoinjs-lib';
import { api, ApiResponseError, quoteTotals, type GuestQuote, type GuestStatus } from './api.js';
import {
  createGuestRecoveryBundle, createGuestRecoverySecrets, decryptGuestRecovery, encryptGuestRecovery,
  generateGuestRecoveryIdentity, parseEncryptedRecovery, recoveryCommitment, serializeEncryptedRecovery,
  type EncryptedGuestRecovery, type GuestRecoveryBundle, type GuestRecoveryIdentity,
} from '../client/GuestRecovery.js';
import { signGuestClaim, validateGuestClaimBundle, validateGuestFunding } from '../client/GuestClaim.js';
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

type GuestFlow = {
  identity: GuestRecoveryIdentity; quote?: GuestQuote; status?: GuestStatus; bundle?: GuestRecoveryBundle;
  verified: boolean; poll?: number; controller?: AbortController; claimKey?: string; claimRevision?: number;
  claiming?: boolean; claimSubmitted?: boolean; uncertain?: boolean;
};
type NewFlow = GuestFlow & {
  kind: 'new'; amountSats: number; quoteKey: string; prepareKey: string; envelope?: EncryptedGuestRecovery; exported: boolean;
  active: () => boolean;
};
type Flow = NewFlow | (GuestFlow & { kind: 'restored'; bundle: GuestRecoveryBundle; quote: GuestStatus });

const terminal = new Set(['COMPLETED', 'EXPIRED', 'REFUNDED', 'FAILED', 'MANUAL_REVIEW', 'PREPARATION_UNKNOWN', 'UNKNOWN']);
const guestFinished = (status: GuestStatus) => terminal.has(status.status) || terminal.has(status.swapState ?? '');
const hex = /^[a-f0-9]{64}$/;
function bytes(value: string) { return Uint8Array.from(value.match(/../g) ?? [], part => Number.parseInt(part, 16)); }
function statusText(status: GuestStatus) {
  if (status.status === 'COMPLETED') return 'Guest swap completed.';
  if (status.status === 'EXPIRED' || status.swapState === 'EXPIRED') return 'Guest swap expired.';
  if (status.status === 'REFUNDED' || status.swapState === 'REFUNDED') return 'Guest swap refunded.';
  if (status.status === 'FAILED' || status.swapState === 'FAILED') return 'Guest swap failed.';
  if (status.swapState === 'REFUND_PENDING') return 'Guest refund pending.';
  if (status.status === 'CLAIM_BROADCAST_PENDING_CONFIRMATION') return 'Claim broadcast. Waiting for confirmation and settlement.';
  if (status.status === 'CLAIM_DETECTED_NOT_SETTLED') return 'Claim detected. Waiting for invoice settlement.';
  if (status.status === 'LIGHTNING_SETTLED_PENDING_CHAIN_EVIDENCE') return 'Invoice settled. Waiting for verified claim evidence.';
  if (status.status === 'PAYMENT_ACCEPTED_NOT_SETTLED') return 'Invoice accepted. Waiting for the watcher to confirm the on-chain funding.';
  if (status.status === 'FUNDED_AWAITING_CLAIM' && status.claimIntent) return 'A claim is already recorded. Waiting for verified status.';
  if (status.status === 'FUNDED_AWAITING_CLAIM') return 'Funding confirmed. Sign the claim locally when you are ready.';
  if (status.status === 'INVOICE_CREATED') return 'Waiting for payment and confirmed funding.';
  if (status.status === 'MANUAL_REVIEW' || status.swapState === 'MANUAL_REVIEW' || status.status === 'UNKNOWN' || status.status === 'PREPARATION_UNKNOWN')
    return 'Manual review required. No claim was submitted and nothing will be retried.';
  return 'Guest status updated.';
}
function canClaim(status: GuestStatus) {
  return status.status === 'FUNDED_AWAITING_CLAIM' && status.invoiceState === 'ACCEPTED' && !status.claimIntent &&
    !!status.fundingTxid && hex.test(status.fundingTxid) && Number.isSafeInteger(status.fundingVout) &&
    Number.isSafeInteger(status.fundingConfirmations) && status.fundingConfirmations! >= 1 &&
    typeof status.lockupHex === 'string' && Number.isSafeInteger(status.revision);
}
class RecoveryMismatch extends Error {}

function restoredStatus(bundle: GuestRecoveryBundle, status: GuestStatus) {
  if (status.network !== bundle.network || status.id !== bundle.quoteId || !status.swapId ||
    (bundle.swapId !== undefined && bundle.swapId !== status.swapId) || status.destination !== bundle.destination ||
    status.paymentHash !== bundle.paymentHash || status.claimPublicKey !== bundle.claimPublicKey ||
    status.refundPublicKey !== bundle.refundPublicKey || status.timeoutHeight !== bundle.timeoutHeight ||
    status.htlcAddress !== bundle.htlcAddress || status.witnessScript !== bundle.witnessScript ||
    status.amountSats !== bundle.amountSats || status.invoiceSats !== bundle.invoiceSats ||
    status.serviceFeeSats !== bundle.serviceFeeSats || status.claimFeeSats !== bundle.claimFeeSats ||
    status.fundingReserveSats !== bundle.fundingReserveSats) {
    throw new RecoveryMismatch('The server record does not match this recovery file.');
  }
  if (canClaim(status)) {
    try {
      if (status.swapState !== 'LOCKUP_CONFIRMED' || status.fundingValueSats !== bundle.amountSats) throw new Error();
      validateGuestFunding(bundle, status.lockupHex!, status.fundingTxid!, status.fundingVout!);
    } catch { throw new RecoveryMismatch('Confirmed funding does not match this recovery file.'); }
  }
  const { invoice: _invoice, ...publicStatus } = status;
  return publicStatus;
}
function sameFunding(a: GuestStatus, b: GuestStatus) {
  return a.id === b.id && a.paymentHash === b.paymentHash && a.claimPublicKey === b.claimPublicKey &&
    (a.invoice === undefined || a.invoice === b.invoice) && a.revision === b.revision && a.fundingTxid === b.fundingTxid &&
    a.fundingVout === b.fundingVout && a.lockupHex === b.lockupHex && a.invoiceState === b.invoiceState;
}
function validStatus(flow: Flow, status: GuestStatus): GuestStatus {
  if (flow.kind === 'restored') {
    if (flow.quote.swapId !== status.swapId) throw new RecoveryMismatch('The restored swap ID changed.');
    return restoredStatus(flow.bundle, status);
  }
  const quote = flow.quote;
  if (!quote) throw new Error('Guest quote is not ready.');
  if (status.id !== quote.id || status.paymentHash !== flow.identity.paymentHash ||
    status.claimPublicKey !== flow.identity.claimPublicKey ||
    (flow.status?.invoice !== undefined && status.invoice !== undefined && status.invoice !== flow.status.invoice) ||
    status.amountSats !== quote.amountSats || status.invoiceSats !== quote.invoiceSats ||
    status.claimFeeSats !== quote.claimFeeSats || status.serviceFeeSats !== quote.serviceFeeSats)
    throw new Error('Guest status changed identity or terms.');
  return status;
}

export function mountGuest(presentation: GuestPresentation = {}) {
  const dialog = get<HTMLDialogElement>('guest-dialog');
  const form = get<HTMLFormElement>('guest-recovery-form');
  const importForm = get<HTMLFormElement>('guest-import-form');
  const importFile = get<HTMLInputElement>('guest-import-file');
  const importPassphrase = get<HTMLInputElement>('guest-import-passphrase');
  const importSubmit = get<HTMLButtonElement>('guest-import-submit');
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
  let importing = false;
  let importRequest: AbortController | undefined;
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
    importing = false;
    importRequest?.abort(); importRequest = undefined;
    if (flow) { stopPolling(flow); flow = undefined; }
    presentation.showInvoice?.(null);
    passphrase.value = ''; confirmation.value = ''; restorePassphrase.value = ''; exportText.value = ''; invoice.value = '';
    if (dialog.open) dialog.close();
    importForm.reset(); importForm.hidden = true; importSubmit.disabled = false;
    get('guest-details').replaceChildren();
    form.hidden = false; exportSection.hidden = true; paymentSection.hidden = true;
    claimButton.hidden = true; claimButton.disabled = true; verifyButton.disabled = true;
    prepareButton.disabled = false;
  }
  function render(current: Flow) {
    const status = current.status;
    if (!status) return;
    const onlyStatus = current.kind === 'restored' && (status.status === 'INVOICE_CREATED' ||
      (status.status === 'FUNDED_AWAITING_CLAIM' && !status.claimIntent && !canClaim(status)));
    setPaymentStatus(onlyStatus ? 'Waiting for verified funding evidence for the original swap.' : statusText(status));
    if (status.status === 'COMPLETED') {
      stopPolling(current); claimButton.hidden = true; claimButton.disabled = true;
      setPaymentStatus('Guest swap completed. The resulting claim is confirmed and the invoice is settled.');
      return;
    }
    const claimable = !guestFinished(status) && canClaim(status) && !current.claimSubmitted;
    claimButton.hidden = !claimable;
    claimButton.disabled = !claimable || current.uncertain === true || current.claiming === true;
    if (guestFinished(status)) {
      stopPolling(current); claimButton.hidden = true; claimButton.disabled = true;
    }
  }
  async function poll(current: Flow) {
    if (flow !== current || !current.verified || !dialog.open) return;
    stopPolling(current);
    const controller = new AbortController(); current.controller = controller;
    const quote = current.quote;
    if (!quote) return;
    try {
      const status = validStatus(current, await api.guestStatus(quote.id, current.identity.capabilityToken, controller.signal));
      if (flow !== current || controller.signal.aborted) return;
      current.status = status; render(current);
      if (!guestFinished(status))
        current.poll = window.setTimeout(() => void poll(current), 3000);
    } catch (error) {
      if (flow !== current || controller.signal.aborted || !dialog.open) return;
      claimButton.hidden = true; claimButton.disabled = true;
      if (error instanceof RecoveryMismatch) { setPaymentStatus(error.message); return; }
      if (error instanceof ApiResponseError && [401, 403, 404].includes(error.status)) {
        setPaymentStatus('Guest status could not be authenticated. No claim was submitted.');
        return;
      }
      setPaymentStatus('Guest status is unavailable. Retrying without submitting a claim.');
      current.poll = window.setTimeout(() => void poll(current), 5000);
    }
  }

  get('guest-open-import').addEventListener('click', () => {
    close(); importing = true;
    form.hidden = true; importForm.hidden = false;
    text('guest-import-status', '');
    dialog.showModal(); importFile.focus();
  });
  get('guest-import-close').addEventListener('click', close);
  importForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (!importing || importSubmit.disabled) return;
    const file = importFile.files?.[0];
    if (!file || file.size === 0 || file.size > 65_536) {
      text('guest-import-status', 'Choose an encrypted recovery JSON file up to 64 KB.'); return;
    }
    const version = epoch;
    const controller = new AbortController(); importRequest = controller;
    const password = importPassphrase.value;
    importPassphrase.value = '';
    importSubmit.disabled = true;
    text('guest-import-status', 'Opening recovery file locally…');
    try {
      const bundle = await decryptGuestRecovery(parseEncryptedRecovery(await file.text()), password);
      if (version !== epoch) return;
      if (!('refundPublicKey' in bundle)) throw new RecoveryMismatch('Use the complete recovery file saved after invoice preparation.');
      try { validateGuestClaimBundle(bundle); }
      catch { throw new RecoveryMismatch('The recovery file contains an invalid swap contract.'); }
      const status = restoredStatus(bundle, await api.guestStatus(bundle.quoteId, bundle.capabilityToken, controller.signal));
      if (version !== epoch) return;
      const current: Flow = { kind: 'restored', identity: bundle, quote: status, status, bundle, verified: true };
      flow = current;
      importForm.reset(); importForm.hidden = true;
      get('guest-invoice-content').hidden = true;
      details(get('guest-details'), [
        ['Network', 'Bitcoin Regtest'], ['Swap ID', status.swapId!], ['Destination', bundle.destination],
        ['Original Lightning invoice amount', sats(bundle.invoiceSats)],
        ['Estimated net receipt', sats(bundle.amountSats - bundle.claimFeeSats)],
      ]);
      paymentSection.hidden = false;
      get('guest-close').focus();
      render(current);
      if (!guestFinished(status)) current.poll = window.setTimeout(() => void poll(current), 3000);
    } catch (error) {
      if (version !== epoch) return;
      const message = error instanceof RecoveryMismatch ? error.message
        : error instanceof ApiResponseError ? ([401, 403, 404].includes(error.status)
          ? 'The original swap could not be authenticated.' : 'The original swap status is unavailable. Try again.')
          : 'Could not open the recovery file or check its status. Check the file and passphrase.';
      text('guest-import-status', message);
      importPassphrase.focus();
    } finally {
      if (version === epoch) { importSubmit.disabled = false; importRequest = undefined; }
    }
  });

  async function begin(amountSats: number, active: () => boolean) {
    if (!configured || !watching) throw new Error('Guest watcher unavailable. No invoice was created.');
    const version = epoch;
    const availability = await api.guestAvailability();
    if (!availability.configured || !availability.watching) throw new Error('Guest watcher unavailable. No invoice was created.');
    const identity = await generateGuestRecoveryIdentity();
    if (!active() || version !== epoch || importing) return;
    close();
    const current: NewFlow = { kind: 'new', identity, amountSats, quoteKey: crypto.randomUUID(),
      prepareKey: crypto.randomUUID(), exported: false, verified: false, active };
    flow = current;
    details(get('guest-details'), [
      ['Network', 'Bitcoin Regtest'],
      ['Amount to send', sats(amountSats)],
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
    if (current?.kind !== 'new' || prepareButton.disabled) return;
    if (passphrase.value.length < 8 || passphrase.value !== confirmation.value) {
      setStatus('Use the same passphrase in both fields (at least 8 characters).'); return;
    }
    const supplied = presentation.readDestination?.();
    let destination: string;
    if (presentation.readDestination) {
      if (!supplied) return;
      destination = supplied.trim().toLowerCase();
    } else {
      destination = payments.p2wpkh({ pubkey: bytes(current.identity.claimPublicKey), network: networks.regtest }).address ?? '';
    }
    if (!/^bcrt1[0-9a-z]{20,}$/.test(destination)) {
      setStatus('Enter a valid regtest on-chain destination.'); return;
    }
    try { address.toOutputScript(destination, networks.regtest); }
    catch { setStatus('Enter a valid regtest on-chain destination.'); return; }
    if (!current.active()) return;
    prepareButton.disabled = true;
    try {
      const availability = await api.guestAvailability();
      if (!availability.configured || !availability.watching) throw new Error('Guest watcher unavailable. No invoice was created.');
      if (!current.quote) {
        setStatus('Creating the guest quote…');
        const quote = await api.guestQuote(current.identity, destination, current.amountSats, current.quoteKey);
        if (!current.active()) return;
        if (quote.destination !== destination || quote.paymentHash !== current.identity.paymentHash ||
          quote.claimPublicKey !== current.identity.claimPublicKey)
          throw new Error('Guest quote changed identity, destination or amount.');
        const amounts = quoteTotals(quote, current.amountSats);
        current.quote = quote;
        details(get('guest-details'), [
          ['Network', 'Bitcoin Regtest'], ['Destination', quote.destination],
          ['Amount to send', sats(current.amountSats)], ['Lightning invoice amount', sats(quote.invoiceSats)],
          ['Service fee', sats(quote.serviceFeeSats)], ['Estimated claim fee', sats(quote.claimFeeSats)],
          ['Estimated net receipt', sats(amounts.received)],
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
      if (flow !== current) return;
      current.status = status; current.bundle = bundle; current.envelope = envelope;
      passphrase.value = ''; confirmation.value = '';
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
    const current = flow; const quote = current?.quote; if (current?.kind !== 'new' || !current.envelope || !quote) return;
    const blob = new Blob([exportText.value], { type: 'application/json' });
    const href = URL.createObjectURL(blob); const link = document.createElement('a');
    link.href = href; link.download = `guest-recovery-${quote.id}.json`; link.click();
    URL.revokeObjectURL(href); current.exported = true; verifyButton.disabled = false;
    setExportStatus('Encrypted recovery downloaded. Re-enter the passphrase and verify the restore.');
  });
  copyButton.addEventListener('click', async () => {
    const current = flow; if (current?.kind !== 'new' || !current.envelope) return;
    try {
      await navigator.clipboard.writeText(exportText.value);
      current.exported = true; verifyButton.disabled = false;
      setExportStatus('Encrypted recovery copied. Re-enter the passphrase and verify the restore.');
    } catch { setExportStatus('Copy is unavailable. Download the encrypted recovery instead.'); }
  });
  verifyButton.addEventListener('click', async () => {
    const current = flow;
    if (current?.kind !== 'new' || !current.bundle || !current.envelope || !current.exported || restorePassphrase.value.length < 8) {
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
      if (flow !== current || !current.active()) return;
      current.verified = true; restorePassphrase.value = '';
      exportSection.hidden = true; paymentSection.hidden = false;
      get('guest-invoice-content').hidden = false;
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
    const prior = current?.status;
    if (claimButton.disabled || !current?.bundle || !quote || !current.verified || !prior || guestFinished(prior) || !canClaim(prior) ||
      current.uncertain || current.claiming || current.claimSubmitted) return;
    current.claiming = true;
    claimButton.disabled = true;
    stopPolling(current);
    const controller = new AbortController(); current.controller = controller;
    let submitted = false;
    try {
      const availability = await api.guestAvailability(controller.signal);
      if (!availability.configured || !availability.watching) throw new Error('Guest watcher unavailable. No claim was submitted.');
      const fresh = validStatus(current, await api.guestStatus(quote.id, current.identity.capabilityToken, controller.signal));
      if (flow !== current) return;
      if (!sameFunding(prior, fresh) || guestFinished(fresh) || !canClaim(fresh)) {
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
      if (flow !== current) return;
      setPaymentStatus('Claim signed locally. Submitting the exact outpoint evidence once…');
      submitted = true;
      const result = await api.guestClaim(quote.id, current.identity.capabilityToken,
        claim.hex, revision, current.claimKey!);
      if (flow !== current) return;
      if (result.id !== quote.id || (current.kind === 'restored' && result.swapId !== current.quote.swapId))
        throw new RecoveryMismatch('Guest claim returned a different swap.');
      current.claimSubmitted = true;
      claimButton.hidden = true;
      setPaymentStatus('Claim broadcast. Waiting for confirmation and settlement.');
    } catch (error) {
      if (flow !== current) return;
      if (submitted && (!(error instanceof ApiResponseError) || error.status >= 500)) {
        current.uncertain = true;
        setPaymentStatus('Claim outcome is uncertain. Do not retry; the watcher will reconcile the existing evidence.');
      } else if (error instanceof RecoveryMismatch) {
        current.status = undefined;
        claimButton.hidden = true;
        setPaymentStatus(error.message);
      } else if (error instanceof ApiResponseError && error.status === 409) {
        setPaymentStatus('Claim state changed. Refresh the status before continuing.');
        current.status = undefined;
      } else if (error instanceof ApiResponseError && [401, 403, 404].includes(error.status)) {
        current.uncertain = true;
        setPaymentStatus('Claim could not be authenticated. No claim was submitted.');
      } else {
        setPaymentStatus(error instanceof Error ? error.message : 'Claim was not submitted.');
      }
    } finally {
      current.claiming = false;
      if (flow === current) {
        const latest = current.status;
        claimButton.disabled = !latest || guestFinished(latest) || !canClaim(latest) || !!current.uncertain || !!current.claimSubmitted;
        if (!latest || !guestFinished(latest)) current.poll = window.setTimeout(() => void poll(current), 1500);
      }
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
    cancel() { if (!importing) close(); },
  };
}
