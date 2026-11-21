import { address, networks } from 'bitcoinjs-lib';
import type { GuestPresentation } from './guest.js';
import { drawInvoiceQr } from './guestQr.js';
import { get, sats } from './ui.js';

const expiryFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium', timeStyle: 'long', timeZone: 'UTC',
});

function regtestDestination(destination: string): string | undefined {
  if (destination.length > 90) return;
  try {
    const { prefix, version, data } = address.fromBech32(destination);
    if (prefix !== networks.regtest.bech32) return;
    const supported = (version === 0 && (data.length === 20 || data.length === 32)) ||
      (version === 1 && data.length === 32);
    if (!supported) return;
    address.toOutputScript(destination, networks.regtest);
    return destination.toLowerCase();
  } catch {
    return;
  }
}

export function createGuestPresentation(): GuestPresentation {
  const dialog = get<HTMLDialogElement>('guest-dialog');
  const destination = get<HTMLInputElement>('guest-destination');
  const validation = get('guest-destination-status');
  const payment = get('guest-invoice-content');
  const unavailable = get('guest-invoice-unavailable');
  const invoice = get<HTMLTextAreaElement>('guest-invoice');
  const qr = get<HTMLCanvasElement>('guest-invoice-qr');
  const terms = get('guest-invoice-terms');
  const amount = get('guest-invoice-amount');
  const expiry = get<HTMLTimeElement>('guest-invoice-expiry');
  let expiryTimer: number | undefined;

  function validateDestination(showRequired: boolean) {
    const input = destination.value.trim();
    const valid = regtestDestination(input);
    const error = !valid && (input || showRequired)
      ? 'Enter a valid Bitcoin regtest address beginning with bcrt1.' : '';
    destination.setCustomValidity(error);
    if (error) destination.setAttribute('aria-invalid', 'true');
    else destination.removeAttribute('aria-invalid');
    const message = error || (valid ? 'Valid Bitcoin regtest address.' : '');
    if (validation.textContent !== message) validation.textContent = message;
    return valid;
  }

  function clearInvoice(message = '') {
    window.clearTimeout(expiryTimer);
    payment.hidden = true;
    qr.hidden = true;
    qr.width = qr.height = 0;
    invoice.value = '';
    amount.textContent = '';
    expiry.textContent = '';
    expiry.removeAttribute('datetime');
    unavailable.textContent = message;
  }

  destination.addEventListener('input', () => validateDestination(true));
  destination.addEventListener('invalid', () => validateDestination(true));
  dialog.addEventListener('close', () => {
    destination.value = '';
    validateDestination(false);
  });
  destination.disabled = false;
  get('guest-destination-field').hidden = false;
  terms.hidden = false;
  clearInvoice();

  return {
    readDestination() { return validateDestination(true); },
    showInvoice(value) {
      if (!value) { clearInvoice(); return; }

      const deadline = value.invoiceExpiresAt;
      const expiryDate = new Date(deadline ?? NaN);
      if (!Number.isFinite(expiryDate.getTime())) {
        clearInvoice('Invoice expiry is unavailable.');
        return;
      }
      const expiredMessage = 'This Lightning invoice has expired.';
      if (expiryDate.getTime() <= Date.now()) { clearInvoice(expiredMessage); return; }

      clearInvoice();
      invoice.value = value.invoice;
      amount.textContent = sats(value.invoiceSats);
      expiry.dateTime = expiryDate.toISOString();
      expiry.textContent = expiryFormat.format(expiryDate);
      payment.hidden = false;
      try {
        drawInvoiceQr(qr, value.invoice);
        qr.hidden = false;
      } catch {
        unavailable.textContent = 'QR unavailable. Copy the invoice to pay.';
      }

      function scheduleExpiry() {
        const remaining = expiryDate.getTime() - Date.now();
        if (remaining <= 0) clearInvoice(expiredMessage);
        else expiryTimer = window.setTimeout(scheduleExpiry, Math.min(remaining, 2_147_483_647));
      }
      scheduleExpiry();
    },
  };
}
