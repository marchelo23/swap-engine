import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { networks, payments } from 'bitcoinjs-lib';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createApi } from '../../src/api/server.js';
import { buildHtlc } from '../../src/bitcoin/HtlcBuilder.js';
import { GuestAdmission } from '../../src/guest/GuestAdmission.js';
import { setup } from '../helpers.js';

const invoice = `lnbcrt150u1${'qpzry9x8gf2tvdw0s3jn54khce6mua7l'.repeat(8)}`;
const destination = payments.p2wpkh({ hash: new Uint8Array(20).fill(7), network: networks.regtest }).address!;
const mainnet = payments.p2wpkh({ hash: new Uint8Array(20).fill(7), network: networks.bitcoin }).address!;
const passphrase = 'test guest recovery passphrase';
const decodeQr: (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null =
  createRequire(import.meta.url)('jsqr');

// Exercise the actual cubes and recovery controller while the app wiring remains on DS-02's branch.
async function guestUiBundle() {
  const app = await readFile('src/web/app.ts', 'utf8');
  const contents = app.includes('mountGuest()')
    ? `import { createGuestPresentation } from './guestUi.js';\n${app.replace('mountGuest()', 'mountGuest(createGuestPresentation())')}`
    : app;
  const result = await build({
    stdin: { contents, resolveDir: 'src/web', loader: 'ts', sourcefile: 'app.ts' },
    bundle: true, write: false, format: 'esm', target: 'es2022', loader: { '.woff2': 'binary' },
  });
  return result.outputFiles[0]!.text;
}

test('guest cubes work after signed-in reverse is denied and show an exact invoice QR only after recovery', async context => {
  const f = await setup();
  context.after(f.cleanup);
  const admission = new GuestAdmission(f.store);
  let watching = true;
  const invoiceExpiresAt = Date.now() + 3_600_000;
  let prepared: object | undefined;
  const guestReverse = {
    admission,
    get watching() { return watching; },
    async prepare(id: string, authorization: string | undefined, _key: string, raw: { recoveryCommitment: string }) {
      const quote = admission.status(id, authorization)!;
      const contract = { paymentHash: quote.paymentHash, claimPublicKey: quote.claimPublicKey,
        refundPublicKey: f.contract.refundPublicKey, timeoutHeight: 130 };
      const lockup = buildHtlc(contract);
      prepared = { ...quote, ...contract, status: 'INVOICE_CREATED', swapId: randomUUID(),
        invoice, invoiceExpiresAt, invoiceState: 'OPEN', swapState: 'INVOICE_CREATED',
        recoveryCommitment: raw.recoveryCommitment, htlcAddress: lockup.address, witnessScript: lockup.witnessScript.toString('hex') };
      return prepared;
    },
    async status() { return prepared; },
  };
  const server = createApi(f.manager, async () => ({ onchainSats: 1_000_000, incomingSats: 1_000_000 }),
    undefined, 'regtest', { guestReverse: guestReverse as never });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = await chromium.launch({ channel: process.env.WEB_TEST_BROWSER_CHANNEL });
  context.after(() => browser.close());
  const page = await browser.newPage({ reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'], viewport: { width: 390, height: 844 } });
  const bundle = await guestUiBundle();
  await page.route('**/app.js', route => route.fulfill({ contentType: 'text/javascript', body: bundle }));
  await page.context().addCookies([{ name: 'mock-owner', value: 'account-cookie', url: base, httpOnly: true }]);
  await page.route('**/v1/auth/session', route => route.fulfill({ json: {
    user: { id: 'owner-without-reverse', username: 'guest-option', role: 'USER' },
    csrfToken: 'a'.repeat(64), expiresAt: Date.now() + 60_000,
  } }));
  await page.route('**/v1/reverse/availability', route => route.fulfill({ status: 403, json: { error: 'FORBIDDEN' } }));
  const guestQuotes: string[] = [];
  const guestHeaders: Array<Promise<Record<string, string>>> = [];
  const remoteRequests: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin !== base) remoteRequests.push(url.origin);
    if (url.pathname === '/v1/guest/quotes' && request.method() === 'POST') {
      guestQuotes.push(request.postDataJSON().destination);
      guestHeaders.push(request.allHeaders());
    }
  });
  await page.goto(base);
  await page.getByRole('textbox', { name: 'Amount to send in sats' }).waitFor();
  const requestedSats = Number(await page.locator('#amount').inputValue());
  await page.getByRole('button', { name: 'SWAP', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Guest swap recovery' });
  await dialog.waitFor();
  assert.equal(await page.locator('#quote-form .cube-unit').count(), 3);
  assert.equal(await page.locator('form#quote-form').count(), 1);
  const field = dialog.getByLabel('Bitcoin regtest payout address');
  const create = dialog.getByRole('button', { name: 'Create invoice' });
  const qr = dialog.getByRole('img', { name: 'Lightning invoice QR code', includeHidden: true });
  const invoiceField = page.locator('#guest-invoice');
  await dialog.getByLabel('Recovery passphrase', { exact: true }).fill(passphrase);
  await dialog.getByLabel('Confirm passphrase').fill(passphrase);
  for (const invalid of ['', mainnet, destination.slice(0, -1) + (destination.endsWith('q') ? 'p' : 'q')]) {
    await field.fill(invalid);
    await create.click();
    await dialog.getByText('Enter a valid Bitcoin regtest address beginning with bcrt1.', { exact: true }).waitFor();
    assert.equal(await field.getAttribute('aria-invalid'), 'true');
  }
  assert.deepEqual(guestQuotes, []);
  await field.fill(` ${destination.toUpperCase()} `);
  await dialog.getByText('Valid Bitcoin regtest address.', { exact: true }).waitFor();
  assert.equal(await field.getAttribute('aria-invalid'), null);
  await create.click();
  await dialog.getByLabel('Encrypted recovery export', { exact: true }).waitFor();
  const terms = await page.locator('#guest-details').textContent();
  assert.match(terms ?? '', /Amount to send\s*50,000 sats/);
  assert.match(terms ?? '', /Lightning invoice amount\s*50,000 sats/);
  assert.match(terms ?? '', /Estimated net receipt\s*48,750 sats/);
  assert.deepEqual(guestQuotes, [destination]);
  const [headers] = await Promise.all(guestHeaders);
  assert.equal(headers?.['x-csrf-token'], undefined);
  assert.equal(headers?.cookie, undefined);
  assert.match(headers?.authorization ?? '', /^Bearer /);
  assert.equal(await invoiceField.inputValue(), '');
  assert.equal(await qr.isVisible(), false);
  await dialog.getByRole('button', { name: 'Download encrypted recovery' }).click();
  const restore = dialog.getByLabel('Re-enter passphrase to verify restore');
  const verify = dialog.getByRole('button', { name: 'Verify restore' });
  await restore.fill('incorrect passphrase');
  await verify.click();
  await dialog.getByText('Recovery decryption failed', { exact: true }).waitFor();
  assert.equal(await invoiceField.inputValue(), '');
  assert.equal(await qr.isVisible(), false);
  watching = false;
  await restore.fill(passphrase);
  await verify.click();
  await dialog.getByText('Guest watcher unavailable. The payable invoice was not shown.', { exact: true }).waitFor();
  assert.equal(await invoiceField.inputValue(), '');
  assert.equal(await qr.isVisible(), false);
  watching = true;
  await verify.click();
  await qr.waitFor();
  assert.equal(await invoiceField.inputValue(), invoice);
  assert.equal(await page.locator('#guest-invoice-amount').textContent(), requestedSats.toLocaleString('en-US') + ' sats');
  assert.equal(await page.locator('#guest-invoice-expiry').getAttribute('datetime'), new Date(invoiceExpiresAt).toISOString());
  const pixels = await qr.evaluate((canvas: HTMLCanvasElement) => {
    const { width, height } = canvas;
    return { width, height, data: Array.from(canvas.getContext('2d')!.getImageData(0, 0, width, height).data) };
  });
  assert.equal(decodeQr(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height)?.data, invoice);
  await dialog.getByRole('button', { name: 'Copy invoice' }).click();
  await dialog.getByText('Invoice copied.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), invoice);
  assert.deepEqual(remoteRequests, []);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  assert.equal(await invoiceField.inputValue(), '');
  assert.equal(await qr.isVisible(), false);
});
