import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import axe from 'axe-core';
import { networks, payments } from 'bitcoinjs-lib';
import { chromium, type Page } from 'playwright';
import { createApi } from '../../src/api/server.js';
import { railIds, type Capabilities } from '../../src/core/RailContract.js';
import { createArkRegtestCliPort } from '../../src/ark/ArkAdapter.js';
import type { ArkQuote, Quote } from '../../src/web/api.js';
import { preflight } from '../../src/diagnostics/preflight.js';
import { setup, testAccount } from '../helpers.js';

const evidence = 'dist/web-verification';
const launchChromium = () => chromium.launch({
  ...(process.env.WEB_TEST_BROWSER_CHANNEL ? { channel: process.env.WEB_TEST_BROWSER_CHANNEL } : {}),
  ...(process.env.WEB_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.WEB_TEST_BROWSER_EXECUTABLE } : {}),
});

function debitQuote(invoiceSats: number, route: ArkQuote['route']): ArkQuote;
function debitQuote(invoiceSats: number): Quote;
function debitQuote(invoiceSats: number, route?: ArkQuote['route']): Quote | ArkQuote {
  const serviceFeeSats = 500 + Math.ceil(invoiceSats * .005);
  const claimFeeSats = route === 'onchain-to-ark' ? 262 : route === 'ark-to-onchain' ? 241 : 500;
  const amountSats = invoiceSats - serviceFeeSats;
  const quote = { id: randomUUID(), expiresAt: Date.now() + 120_000, invoiceSats, amountSats, serviceFeeSats, claimFeeSats,
    fundingReserveSats: route ? 0 : 1_000 };
  return route ? { ...quote, route, network: 'regtest', method: route === 'onchain-to-ark' ? 'boarding' : 'cooperative-offboarding',
    netSats: amountSats - claimFeeSats, dustSats: 330 } : quote;
}

async function mockDebitQuotes(page: Page) {
  for (const path of ['/v1/quotes', '/v1/ark/quotes']) {
    await page.route('**' + path, route => {
      const input = route.request().postDataJSON();
      return route.fulfill({ status: 201, json: debitQuote(input.amountSats, input.route) });
    });
  }
}

async function waitForRails(page: Page, send: string, receive: string) {
  await page.waitForFunction(([send, receive]) => {
    return !document.getElementById('quote-form')?.hasAttribute('data-turning')
      && (document.getElementById('send-network') as HTMLSelectElement).value === send
      && (document.getElementById('receive-network') as HTMLSelectElement).value === receive;
  }, [send, receive]);
}

async function audit(page: Page) {
  await page.evaluate(axe.source);
  const violations = await page.evaluate(async () => (await (window as Window & { axe?: typeof axe }).axe!.run()).violations);
  assert.deepEqual(violations.map(item => ({ id: item.id, targets: item.nodes.map(node => node.target) })), []);
}

test('three faces quote an exact debit and preserve keyboard, account and responsive accessibility', async context => {
  const f = await setup();
  context.after(f.cleanup);
  const server = createApi(f.manager, async () => { throw new Error('No nodes in browser test'); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const browser = await launchChromium();
  context.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  await page.clock.install();
  await mockDebitQuotes(page);
  await page.route('**/v1/auth/session', route => route.fulfill({ status: 401, json: {} }));
  const quoteRequests: number[] = [];
  const arkQuoteRequests: unknown[] = [];
  const swapRequests: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path === '/v1/quotes') quoteRequests.push(request.postDataJSON().amountSats);
    if (path === '/v1/ark/quotes') arkQuoteRequests.push(request.postDataJSON());
    if (path.startsWith('/v1/swaps')) swapRequests.push(path);
  });

  await mkdir(evidence, { recursive: true });
  await page.goto(base);
  assert.equal(await page.locator('#opening-overlay').isVisible(), false);
  await page.waitForFunction(() => document.fonts.size >= 2);
  await page.getByText('SIMULATION', { exact: true }).waitFor();
  await page.waitForFunction(() => document.getElementById('mode')?.dataset.mode === 'simulation');
  assert.equal(await page.locator('header.top').innerText(), 'SWAP\nACCOUNT\nOPERATIONS');
  assert.equal(await page.locator('.footer-squares i').count(), 3);
  await page.getByText('48,750', { exact: true }).waitFor();
  assert.deepEqual(quoteRequests, [50_000]);
  assert.equal(await page.locator('#quote-form .cube-unit').count(), 3);
  assert.equal(await page.locator('#swap .cube-send .plane-front #amount').count(), 1);
  assert.equal(await page.locator('#swap .cube-swap .plane-front #swap-action').count(), 1);
  assert.equal(await page.locator('#swap .cube-receive .plane-front #received-preview').count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Get quote' }).count(), 0);
  await page.keyboard.press('Tab');
  assert.equal(await page.locator(':focus').textContent(), 'Skip to content');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator(':focus').getAttribute('id'), 'main');

  const amount = page.getByRole('textbox', { name: 'Amount to send in sats' });
  const swap = page.getByRole('button', { name: 'SWAP', exact: true });
  assert.equal(await page.locator('#received-preview').evaluate(output => getComputedStyle(output).userSelect), 'none');
  assert.equal(await amount.evaluate(field => getComputedStyle(field).userSelect), 'text');
  for (const type of ['copy', 'cut']) {
    assert.equal(await amount.evaluate((field, eventType) =>
      field.dispatchEvent(new ClipboardEvent(eventType, { bubbles: true, cancelable: true })), type), false);
  }
  await amount.fill('50000.5');
  assert.equal(await swap.isDisabled(), true);
  assert.equal(await amount.getAttribute('aria-invalid'), 'true');
  await page.getByText(/Enter 10,000/).waitFor();
  assert.deepEqual(quoteRequests, [50_000]);
  await amount.fill('50000');
  await page.getByText('48,750', { exact: true }).waitFor();
  assert.equal(await page.locator('#service').textContent(), '750 sats');
  assert.equal(await page.locator('#claim').textContent(), '500 sats');
  assert.equal(await page.locator('#cost').textContent(), '1,250 sats');
  await amount.blur();
  await page.screenshot({ path: evidence + '/swap-desktop.png' });

  await swap.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Review quote' });
  await dialog.waitFor();
  assert.match(await dialog.textContent() ?? '', /Lightning invoice amount\s*50,000 sats/);
  await dialog.getByText('Unknown', { exact: true }).waitFor();
  await dialog.getByText(/Simulation.*Execution disabled/).waitFor();
  assert.equal(await dialog.getByRole('button', { name: 'Start swap' }).isDisabled(), true);
  assert.equal(await page.locator(':focus').textContent(), 'Close review');
  await page.screenshot({ path: evidence + '/review.png' });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator(':focus').getAttribute('id'), 'swap-action');

  await page.clock.fastForward(121_000);
  await page.getByText(/Quote expired/).waitFor();
  assert.equal(await page.locator('#received-preview').textContent(), '\u2014');
  await page.clock.setSystemTime(Date.now());

  let release!: () => void;
  const holding = new Promise<void>(resolve => { release = resolve; });
  let held!: () => void;
  const captured = new Promise<void>(resolve => { held = resolve; });
  await page.route('**/v1/quotes', async route => {
    const oldQuote = debitQuote(route.request().postDataJSON().amountSats);
    held();
    await holding;
    await route.fulfill({ status: 201, json: oldQuote }).catch(() => {});
  }, { times: 1 });
  await amount.fill('60000');
  await captured;
  await amount.fill('70000');
  await page.getByText('68,650', { exact: true }).waitFor();
  release();
  assert.deepEqual(quoteRequests, [50_000, 50_000, 60_000, 70_000]);
  assert.equal(await page.locator('#received-preview').textContent(), '68,650');

  await page.getByLabel('Send network').selectOption('onchain');
  await waitForRails(page, 'onchain', 'lightning');
  assert.equal(await swap.isDisabled(), true);
  await page.getByText('Route unavailable').waitFor();
  assert.equal(await page.locator('#cost').textContent(), '\u2014');
  await page.getByRole('button', { name: 'Rotate send cube' }).press('ArrowDown');
  await waitForRails(page, 'lightning', 'liquid');
  await page.getByLabel('Receive network').selectOption('onchain');
  await waitForRails(page, 'lightning', 'onchain');
  await page.getByText('68,650', { exact: true }).waitFor();
  assert.deepEqual(quoteRequests, [50_000, 50_000, 60_000, 70_000, 70_000]);

  await audit(page);
  await page.getByRole('link', { name: 'Account', exact: true }).click();
  await page.locator('.footer-squares[data-view-active="account"]').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Sign in' }).isEnabled(), true);
  assert.equal(await page.locator('#account-dashboard').isVisible(), false);
  assert.equal(await page.locator(':focus').getAttribute('id'), 'account-title');
  await audit(page);
  await page.screenshot({ path: evidence + '/account.png' });
  await page.getByRole('link', { name: 'Swap status' }).click();
  await page.getByText('Transaction status requires verified swap ownership.').waitFor();
  await audit(page);

  await page.getByRole('link', { name: 'Operations' }).click();
  await page.getByText('Sign in with an administrator account.').waitFor();
  assert.equal(await page.locator('#admin-dashboard').isVisible(), false);
  await audit(page);
  await page.screenshot({ path: evidence + '/operations.png' });
  await page.getByRole('link', { name: 'Swap', exact: true }).click();
  const beforeArk = quoteRequests.length;
  await page.getByLabel('Send network').selectOption('ark');
  await waitForRails(page, 'ark', 'onchain');
  assert.equal(await page.locator('#send-icon').getAttribute('href'), '#icon-ark');
  assert.equal(await page.locator('#icon-ark image').getAttribute('href'), '/arkade-mark.svg');
  assert.deepEqual(await page.locator('.cube-send .rail-icon').evaluate(icon =>
    [getComputedStyle(icon).width, getComputedStyle(icon).height]), ['19px', '19px']);
  await page.getByText('68,909', { exact: true }).waitFor();
  assert.equal(await page.locator('#service').textContent(), '850 sats');
  assert.equal(await page.locator('#claim').textContent(), '241 sats');
  assert.equal(await page.locator('#cost').textContent(), '1,091 sats');
  await page.getByText('Simulation · execution disabled', { exact: true }).waitFor();
  assert.equal(await swap.isDisabled(), false);

  await page.getByLabel('Receive network').selectOption('ark');
  await waitForRails(page, 'onchain', 'ark');
  await amount.fill('80000');
  await page.getByText('78,838', { exact: true }).waitFor();
  await page.getByText('Simulation · execution disabled', { exact: true }).waitFor();
  assert.equal(await swap.isDisabled(), false);
  assert.equal(await page.locator('#service').textContent(), '900 sats');
  assert.equal(await page.locator('#claim').textContent(), '262 sats');
  assert.equal(await page.locator('#cost').textContent(), '1,162 sats');
  assert.equal(await page.locator('#receive-icon').getAttribute('href'), '#icon-ark');
  assert.equal(quoteRequests.length, beforeArk);

  const beforeUnsupported = arkQuoteRequests.length;
  await page.getByLabel('Send network').selectOption('lightning');
  await waitForRails(page, 'lightning', 'ark');
  await page.getByText('Lightning → Ark unsupported', { exact: true }).waitFor();
  assert.equal(await swap.isDisabled(), true);
  await page.getByLabel('Receive network').selectOption('lightning');
  await waitForRails(page, 'liquid', 'lightning');
  await page.getByLabel('Send network').selectOption('ark');
  await waitForRails(page, 'ark', 'lightning');
  await page.getByText('Ark → Lightning unsupported', { exact: true }).waitFor();
  assert.equal(await swap.isDisabled(), true);
  assert.equal(await page.locator('#received-preview').textContent(), '—');
  assert.equal(quoteRequests.length, beforeArk);
  assert.equal(arkQuoteRequests.length, beforeUnsupported);
  for (const [width, height] of [[320, 700], [390, 844], [701, 844], [768, 844], [1024, 600], [1366, 768], [1440, 900]] as const) {
    await page.setViewportSize({ width, height });
    const bounds = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
      buttonBottom: document.getElementById('swap-action')!.getBoundingClientRect().bottom,
      clippedFaces: [...document.querySelectorAll('.plane-front')].some(face => face.scrollHeight > face.clientHeight),
    }));
    assert.ok(bounds.width <= width, 'Horizontal overflow at ' + width);
    assert.equal(bounds.clippedFaces, false, 'Face content overflows at ' + width);
    if (width >= 768) {
      assert.ok(bounds.height <= height, 'Desktop workspace scrolls at ' + width);
      assert.ok(bounds.buttonBottom <= height);
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: evidence + '/swap-mobile.png', fullPage: true });
  assert.deepEqual(swapRequests, []);
  assert.deepEqual(errors, []);
});

test('regtest page renders a real preflight 503 report with offline test ports', async context => {
  const f = await setup();
  context.after(f.cleanup);
  const offline = { call: async () => { throw new Error('Offline test port'); } };
  const diagnostics = () => preflight(offline, offline, 'test-wallet', 'regtest');
  const server = createApi(f.manager, async () => { throw new Error('Offline test port'); }, diagnostics, 'regtest');
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const browser = await launchChromium();
  context.after(() => browser.close());
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  await page.route('**/v1/auth/session', route => route.fulfill({ json: session('ADMIN') }));
  await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/#operations`);
  await page.getByText('Regtest setup requires attention.').waitFor();
  assert.equal(await page.locator('#ark-panel').isVisible(), true);
  await page.getByText('Balance snapshot unavailable.', { exact: true }).waitFor();
  assert.equal(await page.locator('#core-confirmed').textContent(), 'Unavailable');
  assert.equal(await page.locator('#balance-time').isVisible(), false);
  assert.equal(await page.locator('#mode').getAttribute('data-mode'), 'regtest');
  assert.equal(await page.locator('#core').textContent(), 'Unavailable');
  assert.equal(await page.locator('#height').textContent(), '—');
  assert.equal(await page.locator('#lnd').textContent(), 'Unavailable');
  await page.locator('#blockers').getByText('no active channels', { exact: true }).count().then(count => assert.equal(count, 0));
  await page.locator('#blockers').getByText('channel status unavailable', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByText('Regtest setup requires attention.').waitFor();
  await page.screenshot({ path: 'dist/web-verification/admin.png', fullPage: true });
});

test('public capabilities show the configured environment and only mark verified rails as available', async context => {
  const f = await setup();
  context.after(f.cleanup);
  let unavailable = false;
  const server = createApi(f.manager, async () => { throw new Error('Offline test port'); }, undefined, 'simulation', {
    capabilities: () => {
      if (unavailable) throw new Error('Capabilities unavailable');
      return {
        schemaVersion: 1, environment: 'signet', chain: { kind: 'bitcoin', name: 'signet', genesisHash: null },
        readOnly: true, execution: { enabled: false, policy: 'disabled', reason: 'DISABLED' },
        rails: {
          onchain: { id: 'onchain', configured: true, verified: true, available: true, reason: null },
          lightning: { id: 'lightning', configured: true, verified: false, available: false, reason: 'NOT_VERIFIED' },
          ark: { id: 'ark', configured: true, verified: false, available: false, reason: 'WRONG_NETWORK' },
          liquid: { id: 'liquid', configured: false, verified: false, available: false, reason: 'NOT_CONFIGURED' },
        },
        capturedAt: new Date().toISOString(),
      } satisfies Capabilities;
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const browser = await chromium.launch({ channel: process.env.WEB_TEST_BROWSER_CHANNEL });
  context.after(() => browser.close());
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  let balanceRequests = 0;
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/v1/operations/balances') balanceRequests++;
  });
  await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/#operations`);
  await page.getByText('Bitcoin signet · Read-only capabilities', { exact: true }).waitFor();
  assert.equal(await page.locator('#network').textContent(), 'SIGNET');
  const expected = { onchain: 'Verified', lightning: 'Not verified', ark: 'Wrong network', liquid: 'Not configured' };
  for (const rail of railIds) assert.equal(await page.locator(`#capability-${rail}`).textContent(), expected[rail]);
  assert.equal(await page.locator('#admin-dashboard').isVisible(), false);
  assert.equal(balanceRequests, 0);

  unavailable = true;
  await page.reload();
  await page.getByText('Network capabilities unavailable.', { exact: true }).waitFor();
  assert.equal(await page.locator('#network').textContent(), 'UNVERIFIED');
  for (const rail of railIds) assert.equal(await page.locator(`#capability-${rail}`).textContent(), 'Unverified');
});

test('administrator wallets group batteries by owner and use independent rail and asset scales', async context => {
  const f = await setup();
  context.after(f.cleanup);
  const server = createApi(f.manager, async () => { throw new Error('Offline test port'); }, undefined, 'regtest');
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const browser = await launchChromium();
  context.after(() => browser.close());
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  await page.clock.install();
  await page.route('**/v1/auth/session', route => route.fulfill({ json: session('ADMIN') }));
  await page.route('**/v1/liquid/lightning/availability', route => route.fulfill({ json: {
    route: 'liquid-to-lightning', available: false, executionEnabled: false,
    reason: 'LIQUID_LIGHTNING_ATOMIC_ADAPTER_UNAVAILABLE', atomicAdapterInstalled: false,
    invoiceValidationAvailable: false, recoveryAvailable: false, refundAvailable: false,
  } }));
  let denied = false;
  let zeroSnapshot = false;
  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve; });
  const capturedAt = new Date(Date.now() - 20_000).toISOString();
  const assetId = 'ab'.repeat(32);
  let aliceAssetId = assetId;
  await page.route('**/v1/operations/balances', async route => {
    if (denied) return route.fulfill({ status: 403, json: { error: 'FORBIDDEN' } });
    if (zeroSnapshot) {
      await refreshGate;
      return route.fulfill({ json: {
        network: 'regtest', capturedAt: new Date().toISOString(),
        core: { confirmedSats: 0, unconfirmedSats: 100_000 },
        provider: { confirmedSats: 0, unconfirmedSats: 0, localSats: 900_000, remoteSats: 1 },
        alice: { confirmedSats: null, unconfirmedSats: null, localSats: 0, remoteSats: 0 },
        rails: [
          { rail: 'onchain', account: 'core', status: 'available', reason: null, balances: { confirmedSats: 0, unconfirmedSats: 100_000 } },
          { rail: 'onchain', account: 'alice', status: 'unavailable', reason: 'UNAVAILABLE', balances: null },
          { rail: 'lightning', account: 'provider', status: 'available', reason: null, balances: { localSats: 900_000, remoteSats: 1, capacitySats: 900_001 } },
          { rail: 'lightning', account: 'alice', status: 'available', reason: null, balances: { localSats: 0, remoteSats: 0, capacitySats: 0 } },
          { rail: 'ark', account: 'operator', status: 'available', reason: null, balances: { spendableSats: 888, pendingSats: 777, recoverableSats: 666 } },
          { rail: 'ark', account: 'provider', status: 'unavailable', reason: 'NOT_VERIFIED', balances: null },
          { rail: 'ark', account: 'alice', status: 'available', reason: null, balances: { spendableSats: 0, pendingSats: 17, recoverableSats: null } },
          { rail: 'liquid', account: 'operator', status: 'unavailable', reason: 'NOT_CONFIGURED', balances: null },
          { rail: 'liquid', account: 'provider', status: 'unknown', reason: 'NOT_VERIFIED', balances: { assetId, confirmedSats: 300, unconfirmedSats: 0 } },
        ],
      } });
    }
    return route.fulfill({ json: {
      network: 'regtest', capturedAt,
      core: { confirmedSats: 520_000, unconfirmedSats: 0 },
      provider: null, alice: null,
      rails: [
        { rail: 'onchain', account: 'core', status: 'available', reason: null, balances: { confirmedSats: 100_000, unconfirmedSats: 0 } },
        { rail: 'onchain', account: 'alice', status: 'available', reason: null, balances: { confirmedSats: 25_000, unconfirmedSats: 925 } },
        { rail: 'lightning', account: 'provider', status: 'available', reason: null, balances: { localSats: 7_000, remoteSats: 21_000, capacitySats: 35_000 } },
        { rail: 'lightning', account: 'alice', status: 'unknown', reason: 'UNAVAILABLE', balances: { localSats: null, remoteSats: 0, capacitySats: null } },
        { rail: 'ark', account: 'provider', status: 'available', reason: null, balances: { spendableSats: 12_000, pendingSats: 0, recoverableSats: 500 } },
        { rail: 'ark', account: 'alice', status: 'available', reason: null, balances: { spendableSats: 3_000, pendingSats: 75_000, recoverableSats: null } },
        { rail: 'liquid', account: 'provider', status: 'available', reason: null, balances: { assetId, confirmedSats: 2_500, unconfirmedSats: 100 } },
        { rail: 'liquid', account: 'alice', status: 'available', reason: null, balances: { assetId: aliceAssetId, confirmedSats: 500, unconfirmedSats: 0 } },
      ],
      liquid: { wallet: 'lqwd-liquid-ops', chain: 'elementsregtest', height: 2,
        genesisHash: '20'.repeat(32), assetId: 'b2'.repeat(32),
        confirmedBaseUnits: 2_100_000_000, unconfirmedBaseUnits: 0, spendableBaseUnits: 2_100_000_000,
        utxoCount: 1, assetEvidence: 'confirmed-wallet-and-coinbase', feePolicyVerified: false,
        readOnly: true },
    } });
  });
  await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/#operations`);
  await page.getByText('Regtest snapshot', { exact: true }).waitFor();
  const piles = (owner: string) => page.getByRole('region', { name: owner, exact: true }).locator('.wallet-pile').evaluateAll(nodes => nodes.map(node => node.id));
  assert.deepEqual(await piles('Provider'), ['core-pile', 'provider-lightning-pile', 'provider-ark-pile', 'provider-liquid-pile']);
  assert.deepEqual(await piles('Alice'), ['alice-pile', 'alice-lightning-pile', 'alice-ark-pile', 'alice-liquid-pile']);
  assert.equal(await page.getByText('520,000 sats', { exact: true }).count(), 0);
  for (const [id, amount] of Object.entries({
    'core-confirmed': '100,000 sats', 'core-unconfirmed': '0 sats',
    'provider-local': '7,000 sats', 'provider-remote': '21,000 sats', 'provider-capacity': '35,000 sats',
    'alice-confirmed': '25,000 sats', 'alice-unconfirmed': '925 sats',
    'alice-local': 'Unknown', 'alice-remote': '0 sats', 'alice-capacity': 'Unknown',
    'provider-ark-spendable': '12,000 sats', 'provider-ark-pending': '0 sats', 'provider-ark-recoverable': '500 sats',
    'alice-ark-spendable': '3,000 sats', 'alice-ark-pending': '75,000 sats', 'alice-ark-recoverable': 'Unavailable',
    'provider-liquid-confirmed': '2,500 base units', 'provider-liquid-unconfirmed': '100 base units', 'provider-liquid-asset': assetId,
    'alice-liquid-confirmed': '500 base units', 'alice-liquid-unconfirmed': '0 base units', 'alice-liquid-asset': assetId,
  })) {
    assert.equal(await page.locator('#' + id).textContent(), amount);
  }
  const fill = (id: string) => page.locator('#' + id + '-pile').evaluate(pile => (pile as HTMLElement).style.getPropertyValue('--wallet-fill'));
  assert.equal(await fill('core'), '100%');
  assert.equal(await fill('provider-lightning'), '20%');
  assert.equal(await page.locator('#provider-lightning-pile').evaluate(pile =>
    (pile as HTMLElement).style.getPropertyValue('--wallet-occupied')), '80%');
  assert.equal(await page.locator('#provider-lightning-pile').getAttribute('data-capacity'), '');
  assert.equal(await fill('alice-lightning'), '');
  assert.equal(await page.locator('#alice-lightning-pile').getAttribute('data-state'), 'unavailable');
  assert.equal(await fill('alice'), '25%');
  assert.equal(await fill('provider-ark'), '100%');
  assert.equal(await fill('alice-ark'), '25%');
  assert.equal(await fill('provider-liquid'), '100%');
  assert.equal(await fill('alice-liquid'), '20%');
  assert.equal(await page.locator('#alice-pile').getAttribute('data-state'), 'known');
  await page.getByText(/relative to the larger known confirmed balance/).waitFor();
  await page.getByText(/reported channel capacity/).waitFor();
  assert.equal(await page.locator('#balance-time').getAttribute('datetime'), capturedAt);
  assert.equal(await page.locator('#liquid-tag').textContent(), 'READ ONLY');
  assert.equal(await page.locator('#liquid-confirmed').textContent(), '21.00000000 Liquid units');
  assert.equal(await page.locator('#liquid-spendable').textContent(), '21.00000000 Liquid units');
  assert.equal(await page.locator('#liquid-utxos').textContent(), '1');
  assert.equal(await page.locator('#liquid-wallet').textContent(), 'lqwd-liquid-ops');
  assert.equal(await page.locator('#liquid-chain').textContent(), 'elementsregtest');
  assert.equal(await page.locator('#liquid-asset').getAttribute('title'), 'b2'.repeat(32));
  await page.getByText(/Wallet asset matched to coinbase/).waitFor();
  assert.equal(await page.locator('#liquid-lightning-tag').textContent(), 'BLOCKED');
  await page.getByText(/no attested Liquid HTLC atomic adapter/).waitFor();
  await audit(page);
  await mkdir(evidence, { recursive: true });
  const walletPanel = page.getByRole('article', { name: 'Wallet balances by owner' });
  await walletPanel.screenshot({ path: evidence + '/operations-balances.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  await walletPanel.screenshot({ path: evidence + '/operations-balances-mobile.png' });
  const refresh = page.getByRole('button', { name: 'Refresh balances', exact: true });
  aliceAssetId = 'cd'.repeat(32);
  await refresh.click();
  await page.getByText(aliceAssetId, { exact: true }).waitFor();
  assert.equal(await fill('alice-liquid'), '100%');
  await page.clock.fastForward(41_000);
  await page.getByText('Regtest snapshot · at least 1 minute old', { exact: true }).waitFor();
  assert.equal(await page.locator('#balance-piles').getAttribute('data-stale'), '');
  assert.equal(await page.locator('#core-confirmed').textContent(), '100,000 sats');
  zeroSnapshot = true;
  await refresh.click();
  await page.getByText('Loading balances…', { exact: true }).waitFor();
  assert.equal(await page.locator('#core-pile').getAttribute('data-state'), 'loading');
  assert.equal(await page.locator('#provider-ark-pile').getAttribute('data-state'), 'loading');
  assert.equal(await fill('provider-lightning'), '');
  releaseRefresh();
  await page.getByText('Regtest snapshot', { exact: true }).waitFor();
  assert.equal(await page.locator('#core-pile').getAttribute('data-state'), 'known');
  assert.equal(await page.locator('#alice-pile').getAttribute('data-state'), 'unavailable');
  assert.equal(await page.locator('#core-confirmed').textContent(), '0 sats');
  assert.equal(await page.locator('#core-unconfirmed').textContent(), '100,000 sats');
  assert.equal(await page.locator('#provider-local').textContent(), '900,000 sats');
  assert.equal(await page.locator('#provider-capacity').textContent(), '900,001 sats');
  assert.equal(await page.locator('#alice-capacity').textContent(), '0 sats');
  assert.equal(await page.locator('#alice-lightning-pile').getAttribute('data-capacity'), null);
  assert.equal(await fill('core'), '0%');
  assert.equal(await fill('alice-lightning'), '0%');
  assert.equal(await fill('alice'), '');
  assert.equal(await fill('alice-ark'), '0%');
  assert.equal(await page.locator('#alice-ark-spendable').textContent(), '0 sats');
  assert.equal(await page.locator('#alice-ark-pending').textContent(), '17 sats');
  assert.equal(await page.locator('#provider-ark-spendable').textContent(), 'Unavailable');
  assert.equal(await page.locator('#provider-liquid-confirmed').textContent(), 'Unavailable');
  assert.equal(await page.locator('#provider-liquid-asset').textContent(), 'Unavailable');
  assert.equal(await page.locator('#alice-liquid-pile').getAttribute('data-state'), 'unavailable');
  assert.equal(await page.locator('#balance-piles').getAttribute('data-stale'), null);
  denied = true;
  await refresh.click();
  await page.getByText('Balance snapshot unavailable.', { exact: true }).waitFor();
  assert.equal(await page.locator('#provider-remote').textContent(), 'Unavailable');
  assert.equal(await page.locator('#alice-ark-pending').textContent(), 'Unavailable');
  assert.equal(await page.locator('#balance-time').isVisible(), false);
});

function session(role: 'USER' | 'ADMIN') {
  return { user: { id: 'test-user', username: 'test operator', role }, csrfToken: 'test-csrf', expiresAt: Date.now() + 60_000 };
}

test('Account accepts input during session checks and supports retry when auth routes are missing', async context => {
  const f = await setup();
  context.after(f.cleanup);
  const server = createApi(f.manager, async () => { throw new Error('Offline test port'); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const browser = await launchChromium();
  context.after(() => browser.close());
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  let resumeSession!: () => void;
  const pending = new Promise<void>(resolve => { resumeSession = resolve; });
  await page.route('**/v1/auth/session', async route => {
    await pending;
    await route.fulfill({ status: 404, json: { error: 'NOT_FOUND' } });
  });
  await page.route('**/v1/auth/login', route => route.fulfill({ status: 404, json: { error: 'NOT_FOUND' } }));
  await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/#account`);
  const username = page.getByLabel('Username', { exact: true });
  const password = page.getByLabel('Password', { exact: true });
  const submit = page.getByRole('button', { name: 'Sign in', exact: true });
  await username.pressSequentially('test-operator');
  await page.keyboard.press('Tab');
  assert.equal(await page.locator(':focus').getAttribute('id'), 'password');
  await password.pressSequentially('fixture-only');
  assert.equal(await submit.isDisabled(), true);
  resumeSession();
  await page.getByText('The session service is unavailable. You can try signing in.', { exact: true }).waitFor();
  await submit.waitFor();
  assert.equal(await submit.isEnabled(), true);
  assert.equal(await username.inputValue(), 'test-operator');
  const response = page.waitForResponse(reply => reply.url().endsWith('/v1/auth/login'));
  await password.press('Enter');
  const denied = await response;
  assert.equal(denied.status(), 404);
  assert.deepEqual(denied.request().postDataJSON(), { username: 'test-operator', password: 'fixture-only' });
  await page.getByText('Sign-in service unavailable. Try again.', { exact: true }).waitFor();
  assert.equal(await username.inputValue(), 'test-operator');
  assert.equal(await password.inputValue(), '');
  assert.equal(await page.locator(':focus').getAttribute('id'), 'password');
  assert.equal(await submit.isEnabled(), true);
  assert.equal(await page.locator('#account-dashboard').isVisible(), false);
  await audit(page);
  await page.screenshot({ path: evidence + '/account-signin-unavailable.png' });
});

test('the same-origin Account form signs in, shows administrator balances, and signs out through the real API', async context => {
  const f = await setup();
  context.after(f.cleanup);
  const account = await testAccount(f.directory, 'ADMIN');
  const server = createApi(f.manager, async () => { throw new Error('Offline test port'); }, undefined, 'regtest', {
    auth: { storePath: account.storePath },
    operations: async () => ({
      network: 'regtest', capturedAt: new Date().toISOString(),
      core: { confirmedSats: 100_000, unconfirmedSats: 0 }, provider: null, alice: null,
      rails: [{ rail: 'onchain', account: 'core', status: 'available', reason: null,
        balances: { confirmedSats: 100_000, unconfirmedSats: 0 } }],
    }),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const browser = await launchChromium();
  context.after(() => browser.close());
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await page.goto(`${base}/#account`);
  await page.getByLabel('Username').fill(account.username);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Account overview' }).waitFor();
  assert.equal(await page.locator('#account-role').textContent(), 'Administrator');
  await page.getByRole('link', { name: 'Operations' }).click();
  await page.getByText('Regtest snapshot', { exact: true }).waitFor();
  assert.equal(await page.locator('#core-confirmed').textContent(), '100,000 sats');
  await page.getByRole('link', { name: 'Account', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByText('Signed out.', { exact: true }).waitFor();
  assert.equal((await page.request.get(`${base}/v1/auth/session`)).status(), 401);
});

test('login success requires independent session verification and logout is CSRF protected', async context => {
  const f = await setup();
  context.after(f.cleanup);
  const server = createApi(f.manager, async () => { throw new Error('Offline test port'); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const browser = await launchChromium();
  context.after(() => browser.close());
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  let signedIn = false;
  let loginCount = 0;
  let balanceRequests = 0;
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/v1/operations/balances') balanceRequests++;
  });
  await page.route('**/v1/auth/session', route => signedIn
    ? route.fulfill({ json: session('USER') })
    : route.fulfill({ status: 401, json: {} }));
  await page.route('**/v1/auth/login', async route => {
    assert.equal(route.request().method(), 'POST');
    assert.deepEqual(route.request().postDataJSON(), { username: 'test operator', password: 'test-only' });
    loginCount++;
    if (loginCount === 1) { await route.fulfill({ status: 401, json: {} }); return; }
    signedIn = true;
    await route.fulfill({ json: session('ADMIN') }); // The subsequent GET returns USER.
  });
  let csrf = '';
  await page.route('**/v1/auth/logout', async route => {
    csrf = route.request().headers()['x-csrf-token'] ?? '';
    assert.equal(route.request().method(), 'POST');
    signedIn = false;
    await route.fulfill({ status: 204 });
  });
  await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/#account`);
  await page.getByLabel('Username').fill('test operator');
  await page.getByLabel('Password').fill('test-only');
  await page.getByLabel('Password').press('Enter');
  await page.getByText('Sign-in failed. Check your credentials.').waitFor();
  assert.equal(await page.getByLabel('Password').inputValue(), '');
  await page.getByLabel('Password').fill('test-only');
  await page.getByLabel('Password').press('Enter');
  await page.getByRole('heading', { name: 'Account overview' }).waitFor();
  assert.equal(await page.locator('#account-role').textContent(), 'User');
  await page.screenshot({ path: 'dist/web-verification/user.png', fullPage: true });
  await page.getByRole('link', { name: 'Operations' }).click();
  await page.getByText('Administrator role required.').waitFor();
  assert.equal(await page.locator('#admin-dashboard').isVisible(), false);
  assert.equal(balanceRequests, 0);
  await page.getByRole('link', { name: 'Account', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByText('Signed out.', { exact: true }).waitFor();
  assert.equal(csrf, 'test-csrf');
  assert.equal(await page.locator('#account-dashboard').isVisible(), false);
  const local = await page.evaluate(() => [localStorage.length, sessionStorage.length]);
  assert.deepEqual(local, [0, 0]);
});

test('prepared swaps use verified terms, durable idempotency and separate reconciliation', async context => {
  const f = await setup();
  context.after(f.cleanup);
  const server = createApi(f.manager, async () => { throw new Error('Offline test port'); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const browser = await launchChromium();
  context.after(() => browser.close());
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  const id = '5f962d5f-1fed-43f2-9d66-f0ccfca6595f';
  const quoteId = 'baaba8fe-d8db-483f-9599-011fa774ba61';
  const destination = 'bcrt1q8dfp6nje5y8zjpsmjevlecq8f6plqfhmnhqxgq';
  const approvedUntil = Date.now() + 120_000;
  const expiresAt = Date.now() - 600_000;
  const captured: Array<{ key: string; csrf: string; body: unknown; authorization?: string }> = [];
  const quotes: string[] = [];
  let revision = 7;
  let enabled = false;
  let recovering = false;
  let completed = false;
  const snapshot = () => ({
    network: 'regtest', id, revision, claimDestination: destination,
    state: completed ? 'COMPLETED' : 'INVOICE_CREATED',
    quote: {
      id: quoteId, expiresAt,
      amountSats: 50_000, serviceFeeSats: 750, invoiceSats: 50_750, fundingReserveSats: 1000, claimFeeSats: 500,
    },
    payment: { status: completed ? 'SUCCEEDED' : 'NOT_STARTED', feeSats: completed ? 0 : null, valueSats: 50_750 },
    funding: { txid: completed ? 'a'.repeat(64) : null, feeSats: completed ? 247 : null },
    claim: { txid: completed ? 'b'.repeat(64) : null, feeSats: 500, netSats: 49_500 },
    execution: { status: completed ? 'COMPLETED' : recovering ? 'RECONCILIATION_REQUIRED' : 'NOT_STARTED', approvedUntil },
    allowedActions: completed ? [] : recovering ? ['RECONCILE'] : ['EXECUTE'],
  });
  await page.route('**/v1/auth/session', route => route.fulfill({ json: session('USER') }));
  await page.route('**/v1/reverse/availability', route => route.fulfill({ json: {
    network: 'regtest', liveSwapsEnabled: false, controlledReverseConfigured: true,
    executionAvailable: enabled && !recovering && !completed, recoveryAvailable: true, preparedSwapIds: [id],
  } }));
  await page.route('**/v1/quotes', route => {
    quotes.push(route.request().method());
    return route.fulfill({ status: 409, json: { error: 'USE_PREPARED_SWAP' } });
  });
  await page.route('**/v1/swaps', route => route.fulfill({ json: { network: 'regtest', swaps: [snapshot()] } }));
  await page.route('**/v1/swaps/' + id, route => route.fulfill({ json: snapshot() }));
  await page.route('**/v1/swaps/reverse', route => {
    const headers = route.request().headers();
    captured.push({ key: headers['idempotency-key']!, csrf: headers['x-csrf-token']!,
      body: route.request().postDataJSON(), authorization: headers.authorization });
    if (captured.length === 1) return route.abort('failed');
    recovering = captured.length === 2;
    return route.fulfill({ status: 202, json: {
      operationId: 'c'.repeat(64), statusUrl: '/v1/swaps/' + id, status: recovering ? 'RECONCILIATION_REQUIRED' : 'RUNNING',
    } });
  });
  await page.route('**/v1/swaps/' + id + '/reconcile', route => {
    const headers = route.request().headers();
    captured.push({ key: headers['idempotency-key']!, csrf: headers['x-csrf-token']!,
      body: route.request().postDataJSON(), authorization: headers.authorization });
    completed = true;
    revision++;
    return route.fulfill({ json: { operationId: 'd'.repeat(64), statusUrl: '/v1/swaps/' + id,
      status: 'SUCCEEDED', result: { id, state: 'COMPLETED', revision, next: 'DONE' } } });
  });

  await page.goto('http://127.0.0.1:' + (server.address() as AddressInfo).port + '/');
  const preparedLink = page.getByRole('link', { name: 'Review prepared swaps' });
  await preparedLink.waitFor();
  await page.getByRole('button', { name: 'SWAP', exact: true }).click();
  const review = page.getByRole('button', { name: 'Review prepared swap', exact: true });
  await page.getByText('Swap status only. Execution unavailable.').waitFor();
  assert.equal(await review.isDisabled(), true);
  enabled = true;
  await page.getByRole('button', { name: 'Refresh status' }).click();
  await page.getByText('Prepared swap available for review.').waitFor();
  await review.click();
  const dialog = page.getByRole('dialog', { name: 'Confirm prepared swap' });
  const confirm = dialog.getByRole('button', { name: 'Start prepared swap' });
  await dialog.getByText(destination, { exact: true }).waitFor();
  await dialog.getByText('Prepared quote expiry', { exact: true }).waitFor();
  await dialog.getByText('Execution approval deadline', { exact: true }).waitFor();
  await dialog.getByText('Lightning invoice amount', { exact: true }).waitFor();
  assert.match(await dialog.textContent() ?? '', /Amount to send\s*50,750 sats/);
  await page.screenshot({ path: evidence + '/prepared-swap-review.png' });
  assert.equal(captured.length, 0);
  revision++;
  await confirm.click();
  await page.getByText('Swap terms or authorization changed. Review the latest status.', { exact: true }).waitFor();
  assert.equal(captured.length, 0);
  await review.click();
  await confirm.click();
  await page.getByText('Result uncertain. Refresh the swap status before retrying.', { exact: true }).waitFor();
  assert.deepEqual(captured[0]?.body, { preparedSwapId: id, expectedRevision: 8 });
  assert.match(captured[0]!.key, /^[A-Za-z0-9_-]{8,128}$/);
  assert.equal(captured[0]?.csrf, 'test-csrf');
  assert.equal(captured[0]?.authorization, undefined);
  const intent = await page.evaluate(() => {
    const entry = Object.keys(localStorage).find(key => key.endsWith('.execute.once'));
    return entry ? JSON.parse(localStorage.getItem(entry)!) : null;
  });
  assert.deepEqual(intent, { key: captured[0]!.key, body: captured[0]!.body });

  await page.reload();
  await review.click();
  await confirm.click();
  await page.getByText('Result uncertain. Check recovery evidence when available.', { exact: true }).waitFor();
  assert.deepEqual(captured[1], captured[0]);
  assert.equal(await review.isDisabled(), true);
  await page.getByRole('button', { name: 'Check recovery evidence' }).click();
  await page.getByText('Recovery evidence is complete.', { exact: true }).waitFor();
  await page.getByText('Swap completed', { exact: true }).waitFor();
  await page.getByText('b'.repeat(64), { exact: true }).waitFor();
  assert.notEqual(captured[2]?.key, captured[0]?.key);
  assert.equal(captured[2]?.csrf, 'test-csrf');
  assert.deepEqual(captured[2]?.body, { expectedRevision: 8 });
  assert.deepEqual(quotes, []);
  await audit(page);
  await page.screenshot({ path: evidence + '/prepared-swap-status.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
});

test('opening fills the viewport, draws six lines, fades and sequences a 3D entrance', async context => {
  const f = await setup();
  context.after(f.cleanup);
  const server = createApi(f.manager, async () => { throw new Error('Offline test ports'); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const browser = await launchChromium();
  context.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const start = Date.now();
  await page.clock.install({ time: start });
  await page.clock.pauseAt(start + 500);
  const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/';
  await page.goto(url);
  const opening = page.locator('#opening-overlay');
  await opening.waitFor();
  assert.deepEqual(await opening.boundingBox(), { x: 0, y: 0, width: 1440, height: 900 });
  assert.equal(await page.locator('#workspace-shell').evaluate(shell => (shell as HTMLElement).inert), true);
  await page.clock.runFor(390);
  const horizontalLines = await page.locator('#opening').evaluate((canvas: HTMLCanvasElement) => {
    const pixels = canvas.getContext('2d')!.getImageData(Math.round(canvas.width / 2), 0, 1, canvas.height).data;
    let lines = 0;
    for (let i = 3; i < pixels.length; i += 4) {
      if (pixels[i]! > 80 && (i === 3 || pixels[i - 4]! <= 80)) lines++;
    }
    return lines;
  });
  assert.equal(horizontalLines, 6);
  await page.screenshot({ path: evidence + '/intro-lines.png' });
  await page.clock.runFor(500);
  await page.screenshot({ path: evidence + '/intro-waves.png' });
  await page.clock.runFor(1320);
  await page.screenshot({ path: evidence + '/intro-swaps.png' });
  await page.clock.runFor(1060);
  await opening.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#workspace-shell').evaluate(shell => (shell as HTMLElement).inert), false);
  assert.ok(await page.locator('.cube-send').evaluate(cube => cube.getAnimations().length > 0));
  await page.screenshot({ path: evidence + '/intro-entrance.png' });
  await page.getByRole('link', { name: 'Account', exact: true }).click();
  await page.getByRole('link', { name: 'Swap', exact: true }).click();
  assert.equal(await opening.isVisible(), false);

  await page.reload();
  await page.keyboard.press('Tab');
  assert.equal(await page.locator(':focus').getAttribute('id'), 'skip-intro');
  await page.keyboard.press('Enter');
  assert.equal(await opening.isVisible(), false);
  assert.equal(await page.locator(':focus').getAttribute('id'), 'main');
});

test('actual mouse and touch gestures rotate in both directions and linked animation batches quote requests', async context => {
  const f = await setup();
  context.after(f.cleanup);
  const server = createApi(f.manager, async () => { throw new Error('Offline test ports'); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const browser = await launchChromium();
  context.after(() => browser.close());
  const desktop = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    ...(process.env.WEB_TEST_RECORD === '1' ? { recordVideo: { dir: evidence, size: { width: 1366, height: 768 } } } : {}),
  });
  const page = await desktop.newPage();
  await mockDebitQuotes(page);
  const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/';
  const observations: Array<Promise<[boolean, string, string]>> = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname !== '/v1/quotes') return;
    observations.push(page.evaluate(() => [
      document.getElementById('quote-form')!.hasAttribute('data-turning'),
      (document.getElementById('send-network') as HTMLSelectElement).value,
      (document.getElementById('receive-network') as HTMLSelectElement).value,
    ]));
  });
  await page.goto(url);
  await page.locator('#opening-overlay').waitFor({ state: 'hidden' });
  await page.locator('.cube-swap').evaluate(cube => Promise.all(cube.getAnimations().map(animation => animation.finished)));
  await page.getByText('48,750', { exact: true }).waitFor();

  const send = page.getByLabel('Send network');
  const receive = page.getByLabel('Receive network');
  await page.locator('#send-cube').evaluate(cube => {
    const observed: string[] = [];
    Object.assign(cube, { observed });
    new MutationObserver(() => observed.push(cube.getAttribute('data-rail')!))
      .observe(cube, { attributes: true, attributeFilter: ['data-rail'] });
  });
  await send.selectOption('onchain');
  const turning = await page.locator('#quote-form').evaluate(form => ({
    active: form.hasAttribute('data-turning'),
    rotors: [...form.querySelectorAll('.cube-rotor')].map(rotor => rotor.getAnimations().length),
    receiveNext: form.querySelector('.cube-receive .plane-bottom .turn-label')?.textContent,
    hiddenDetails: form.querySelectorAll('.cube-outer[data-rotating]').length,
  }));
  assert.equal(turning.active, true);
  assert.deepEqual(turning.rotors, [1, 1, 0]);
  assert.equal(turning.hiddenDetails, 2);
  assert.match(turning.receiveNext!, /LIGHTNING/);
  await page.waitForFunction(() => {
    const turns = [...document.querySelectorAll('.cube-rotor')].flatMap(rotor => rotor.getAnimations());
    return turns.length === 2 && turns.every(turn => typeof turn.currentTime === 'number' && turn.currentTime >= 78);
  });
  await page.screenshot({ path: evidence + '/linked-rotation.png' });
  await waitForRails(page, 'onchain', 'lightning');
  assert.equal(await page.locator('.cube-send .rail-icon use').getAttribute('href'), '#icon-onchain');
  const details = page.locator('.cube-send .face-value');
  assert.match(await details.evaluate(face => getComputedStyle(face).transitionTimingFunction), /ease-in-out/);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.cube-send .face-value')!).opacity === '1');
  assert.deepEqual(await page.locator('#send-cube').evaluate(cube => Reflect.get(cube, 'observed')), ['liquid', 'ark', 'onchain']);
  assert.equal(observations.length, 1);

  const sendGrip = page.getByRole('button', { name: 'Rotate send cube' });
  const drag = async (delta: number) => {
    const box = (await sendGrip.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + delta, { steps: 8 });
    assert.match(await page.locator('.cube-send .cube-rotor').evaluate(node => (node as HTMLElement).style.transform), /rotateX/);
    await page.mouse.up();
  };
  await drag(80);
  await waitForRails(page, 'lightning', 'liquid');
  await drag(-80);
  await waitForRails(page, 'onchain', 'liquid');
  await receive.selectOption('onchain');
  await waitForRails(page, 'lightning', 'onchain');
  await page.getByText('48,750', { exact: true }).waitFor();
  assert.equal(observations.length, 2);
  assert.deepEqual(await Promise.all(observations), [[false, 'lightning', 'onchain'], [false, 'lightning', 'onchain']]);

  await sendGrip.press('ArrowUp');
  await sendGrip.press('ArrowDown');
  await sendGrip.press('ArrowDown');
  await page.getByRole('button', { name: 'Rotate receive cube' }).press('ArrowUp');
  await waitForRails(page, 'liquid', 'ark');
  await page.getByText('Route unavailable', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'SWAP', exact: true }).isDisabled(), true);
  assert.equal(await page.locator('#received-preview').textContent(), '\u2014');
  assert.equal(observations.length, 2);
  const receiveGrip = page.getByRole('button', { name: 'Rotate receive cube' });
  await send.selectOption('onchain');
  await waitForRails(page, 'onchain', 'ark');
  await page.getByText('48,988', { exact: true }).waitFor();
  await receiveGrip.hover();
  await page.mouse.wheel(0, 80);
  await page.mouse.wheel(0, 80);
  await waitForRails(page, 'lightning', 'onchain');
  await page.getByText('48,750', { exact: true }).waitFor();
  await receiveGrip.hover();
  await page.mouse.wheel(0, -80);
  await waitForRails(page, 'lightning', 'ark');
  await page.getByText('Lightning → Ark unsupported', { exact: true }).waitFor();
  assert.equal(observations.length, 3);
  const video = page.video();
  await desktop.close();
  if (video) {
    await video.saveAs(evidence + '/cube-experience.webm');
    await video.delete();
  }

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const touchPage = await mobile.newPage();
  await touchPage.goto(url);
  await touchPage.getByRole('button', { name: 'Skip intro' }).tap();
  await touchPage.locator('.cube-send').evaluate(cube => Promise.all(cube.getAnimations().map(animation => animation.finished)));
  const cdp = await mobile.newCDPSession(touchPage);
  const stack = await touchPage.locator('.cube-scene').evaluate(scene => {
    const cubes = ['.cube-send', '.cube-swap', '.cube-receive'].map(selector => scene.querySelector<HTMLElement>(selector)!);
    return cubes.map(cube => [cube.offsetTop, cube.offsetHeight]);
  });
  assert.equal(stack[1]![0], stack[0]![0]! + stack[0]![1]!);
  assert.equal(stack[2]![0], stack[1]![0]! + stack[1]![1]!);

  async function swipe(dx: number, dy: number) {
    const face = (await touchPage.locator('.cube-send .face-header').boundingBox())!;
    const x = Math.round(face.x + face.width / 2);
    const y = Math.round(face.y + face.height / 2);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (const progress of [.48, 1]) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove', touchPoints: [{ x: x + dx * progress, y: y + dy * progress }],
      });
    }
    if (dx) {
      const transform = await touchPage.locator('.cube-send .cube-rotor').evaluate(rotor => (rotor as HTMLElement).style.transform);
      assert.match(transform, /rotateY/);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  await swipe(74, 0);
  await waitForRails(touchPage, 'liquid', 'onchain');
  await swipe(-74, 0);
  await waitForRails(touchPage, 'lightning', 'onchain');
  await touchPage.getByRole('button', { name: 'Rotate send cube' }).press('ArrowRight');
  await waitForRails(touchPage, 'liquid', 'onchain');
  await swipe(0, -95);
  await touchPage.waitForFunction(() => window.scrollY > 10);
  await waitForRails(touchPage, 'liquid', 'onchain');
  await mobile.close();
});

test('Ark regtest UI gates execution, separates pending from confirmed, and updates unavailable telemetry', async context => {
  const f = await setup();
  context.after(f.cleanup);
  const adminAccount = await testAccount(f.directory, 'ADMIN');

  const boardingOutpoint = '11'.repeat(32) + ':1';
  const boardingCommitment = '22'.repeat(32);
  const offboardVtxo = '33'.repeat(32) + ':0';
  const offboardDestination = payments.p2wpkh({ hash: Buffer.alloc(20, 0x11), network: networks.regtest }).address!;
  const offboardCommitment = '44'.repeat(32);
  const syntheticForfeitAddress = payments.p2wpkh({ hash: Buffer.alloc(20, 0x22), network: networks.regtest }).address!;

  let operatorDown = false;
  const mockPort = createArkRegtestCliPort({ operatorInfoUrl: 'http://127.0.0.1:37070/v1/info',
    fetchImpl: (async () => operatorDown
      ? new Response('down', { status: 503 })
      : new Response(JSON.stringify({
          network: 'regtest',
          version: 'v0.9.25',
          signerPubkey: '032203ea0a05239f49049ee3f939757dde2271b9051eb3c905283d24b9e25dd6be',
          forfeitAddress: syntheticForfeitAddress,
          dust: 330,
        }), { status: 200 })) as typeof fetch,
    cli: async args => {
      if (args[0] === 'balance') {
        return {
          network: 'regtest',
          asset: 'BTC',
          wallets: {
            alice: { confirmed_sats: 125_000, pre_confirmed_sats: 0, recoverable_sats: 0, pending_recovery_sats: 0, total_sats: 125_000 },
            bob: { confirmed_sats: 45_000, pre_confirmed_sats: 0, recoverable_sats: 0, pending_recovery_sats: 0, total_sats: 45_000 },
          },
        };
      }
      if (args[0] === 'board') {
        return { network: 'regtest', asset: 'BTC', wallets: { [args[1]!]: { input: args[2], commitment_txid: boardingCommitment } } };
      }
      throw new Error('Unexpected CLI call');
    },
  });

  const server = createApi(f.manager, async () => { throw new Error('Offline test port'); }, undefined, 'regtest', {
    auth: { storePath: adminAccount.storePath },
    ark: mockPort,
    arkStorePath: join(f.directory, 'ark-swaps.json'),
    arkExecutionOwner: adminAccount.username,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const browser = await launchChromium();
  context.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const errors: string[] = [];
  page.on('pageerror', err => errors.push(err.message));

  let boardingQuote: ArkQuote | undefined;
  await page.route('**/v1/ark/quotes', async route => {
    const input = route.request().postDataJSON();
    if (input.route === 'ark-to-onchain') return route.fulfill({ status: 201, json: debitQuote(input.amountSats, input.route) });
    let response = await route.fetch();
    boardingQuote = await response.json() as ArkQuote;
    if (boardingQuote.invoiceSats !== input.amountSats) {
      // Bridge the b10e4a7 principal-based fixture while retaining a real server quote ID for POST.
      assert.equal(input.amountSats, 50_000);
      response = await route.fetch({ postData: { ...input, amountSats: 49_253 } });
      boardingQuote = await response.json() as ArkQuote;
    }
    assert.equal(boardingQuote.invoiceSats, input.amountSats);
    return route.fulfill({ response });
  });

  // 1. A session with an unavailable route can review, but cannot submit.
  await page.route('**/v1/ark/availability', route => route.fulfill({ json: { executionAvailable: false } }));
  await page.goto(`${base}/#account`);
  await page.getByLabel('Username', { exact: true }).fill(adminAccount.username);
  await page.getByLabel('Password', { exact: true }).fill(adminAccount.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.locator('#account-dashboard').waitFor({ state: 'visible' });

  async function selectBoarding() {
    await page.getByLabel('Send network').selectOption('onchain');
    await waitForRails(page, 'onchain', 'lightning');
    await page.getByLabel('Receive network').selectOption('ark');
    await waitForRails(page, 'onchain', 'ark');
    await page.locator('#received-preview').filter({ hasText: /^48,9[0-9]{2}$/ }).waitFor();
  }
  await page.getByRole('link', { name: 'Swap', exact: true }).click();
  await selectBoarding();
  await page.getByText('Ark execution unavailable for this account', { exact: true }).waitFor();
  for (const [width, height] of [[320, 700], [701, 640], [1440, 900]] as const) {
    await page.setViewportSize({ width, height });
    assert.equal(await page.locator('.cube-swap .plane-front').evaluate(face => face.scrollHeight <= face.clientHeight), true,
      `Route readiness overflows the face at ${width}×${height}`);
  }
  await page.getByRole('button', { name: 'SWAP', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Review quote' });
  const startSwap = dialog.getByRole('button', { name: 'Start swap', exact: true });
  await dialog.getByText('Ark execution unavailable for this account', { exact: true }).waitFor();
  assert.equal(await startSwap.isDisabled(), true);
  assert.equal(await page.locator('#ark-execution-fields').isVisible(), false);

  // Restore the baseline contract and submit boarding via the fake adapter.
  await page.unroute('**/v1/ark/availability');
  await page.reload();
  await selectBoarding();
  await page.getByText('Regtest execution available', { exact: true }).waitFor();

  const capturedSwaps: Array<{ key: string; csrf: string; body: unknown }> = [];
  page.on('request', req => {
    if (new URL(req.url()).pathname === '/v1/ark/swaps' && req.method() === 'POST') {
      const h = req.headers();
      capturedSwaps.push({ key: h['idempotency-key']!, csrf: h['x-csrf-token']!, body: req.postDataJSON() });
    }
  });

  await page.getByRole('button', { name: 'SWAP', exact: true }).click();
  await dialog.waitFor({ state: 'visible' });
  assert.equal(await page.locator('#ark-execution-fields').isVisible(), true);
  assert.equal(await page.locator('#ark-boarding-fields').isVisible(), true);
  assert.equal(await page.locator('#ark-offboard-fields').isVisible(), false);
  assert.equal(await startSwap.isDisabled(), true);
  assert.equal(await page.getByLabel('Funding outpoint (txid:vout)').inputValue(), '');

  await audit(page);

  await page.getByLabel('Funding outpoint (txid:vout)').fill('not-an-outpoint');
  assert.equal(await startSwap.isDisabled(), true);

  await page.getByLabel('Funding outpoint (txid:vout)').fill(boardingOutpoint);
  assert.equal(await startSwap.isDisabled(), false);

  await startSwap.click();
  await dialog.locator('#execution-status').filter({ hasText: /^Boarding · pending confirmation$/ }).waitFor();
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: evidence + '/mock-ark-boarding-pending.png' });
  assert.equal(await page.locator('#quote-status').textContent(), 'Boarding · pending confirmation');
  assert.equal(await page.getByText('¡Swap exitoso!').count(), 0);
  assert.equal(capturedSwaps.length, 1);
  assert.match(capturedSwaps[0]!.key, /^[A-Za-z0-9_-]{8,128}$/);
  assert.match(capturedSwaps[0]!.csrf, /^[a-f0-9]{64}$/);
  assert.deepEqual((capturedSwaps[0]!.body as Record<string, unknown>).fundingOutpoint, boardingOutpoint);
  assert.deepEqual((capturedSwaps[0]!.body as Record<string, unknown>).wallet, 'alice');
  assert.equal((capturedSwaps[0]!.body as Record<string, unknown>).amountSats, boardingQuote?.amountSats);
  assert.notEqual((capturedSwaps[0]!.body as Record<string, unknown>).amountSats, 50_000);

  await dialog.getByRole('button', { name: 'Close review', exact: true }).click();
  await page.getByRole('link', { name: 'Account', exact: true }).click();
  await page.locator('#account-history-list').getByText('Pending', { exact: true }).waitFor();
  assert.equal(await page.locator('#account-active-swaps').textContent(), '1');
  assert.equal(await page.locator('#account-completed-swaps').textContent(), '0');
  assert.equal(await page.locator('#account-failed-swaps').textContent(), '0');
  assert.equal(await page.locator('#account-history-list .tag').textContent(), 'Pending');

  // 2. Sign in as ADMIN: verify Operations shows pending=1, completed=0, settled=0 sats, and live->unavailable telemetry
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.locator('#signin').waitFor({ state: 'visible' });
  await page.getByLabel('Username', { exact: true }).fill(adminAccount.username);
  await page.getByLabel('Password', { exact: true }).fill(adminAccount.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.locator('#account-dashboard').waitFor({ state: 'visible' });

  await page.getByRole('link', { name: 'Operations', exact: true }).click();
  await page.getByText('1 Ark ↔ On-chain swap recorded on regtest.', { exact: true }).waitFor();
  assert.equal(await page.locator('#activity-total').textContent(), '1');
  assert.equal(await page.locator('#activity-completed').textContent(), '0');
  assert.equal(await page.locator('#activity-pending').textContent(), '1');
  assert.equal(await page.locator('#activity-failed').textContent(), '0');
  assert.equal(await page.locator('#activity-onchain-sent').textContent(), '0 sats');
  assert.equal(await page.locator('#activity-ark-received').textContent(), '0 sats');
  assert.equal(await page.locator('#fee-collected').textContent(), '0 sats');
  assert.equal(await page.locator('#fee-network').textContent(), '0 sats');
  assert.equal(await page.locator('#fee-net-revenue').textContent(), '0 sats');
  assert.equal(await page.locator('#ark-tag').textContent(), 'REGTEST · v0.9.25');
  assert.match(await page.locator('#ark-status').textContent() ?? '', /Alice: 125,000 sats · Bob: 45,000 sats/);

  // Operator goes down -> Refresh must clear stale telemetry to UNAVAILABLE
  operatorDown = true;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('ark-tag')?.textContent === 'UNAVAILABLE');
  assert.equal(await page.locator('#ark-status').textContent(), 'Ark regtest operator telemetry is unavailable.');

  // 3. Mock cooperative offboarding progressing from a 202 to a confirmed status read.
  const confirmedQuote = debitQuote(50_000, 'ark-to-onchain');
  const offboardId = '22222222-2222-4222-8222-222222222222';
  const confirmedRecord = {
    id: offboardId,
    network: 'regtest',
    route: 'ark-to-onchain',
    method: 'cooperative-offboarding',
    status: 'CONFIRMED',
    quote: confirmedQuote,
    inputOutpoint: offboardVtxo,
    destination: offboardDestination,
    commitmentTxid: offboardCommitment,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  let postAttempt = 0;
  let statusReads = 0;
  const offboardKeys: string[] = [];
  await page.route(`**/v1/ark/swaps/${offboardId}`, route => {
    statusReads++;
    assert.equal(route.request().method(), 'GET');
    return route.fulfill({ json: { ...confirmedRecord, updatedAt: Date.now() } });
  });
  await page.route('**/v1/ark/swaps', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    postAttempt++;
    offboardKeys.push(route.request().headers()['idempotency-key']!);
    if (postAttempt === 1) return route.abort('failed');
    confirmedRecord.quote.id = route.request().postDataJSON().quoteId;
    return route.fulfill({
      status: 202,
      json: { ...confirmedRecord, status: 'SUBMITTED', updatedAt: Date.now() },
    });
  });

  await page.getByRole('link', { name: 'Swap', exact: true }).click();
  await page.getByLabel('Send network').selectOption('ark');
  await waitForRails(page, 'ark', 'onchain');
  await page.getByText('49,009', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'SWAP', exact: true }).click();
  await dialog.waitFor({ state: 'visible' });
  assert.equal(await page.locator('#ark-offboard-fields').isVisible(), true);
  assert.equal(await startSwap.isDisabled(), true);

  await page.getByLabel('VTXO outpoint (txid:vout)').fill(offboardVtxo);
  assert.equal(await startSwap.isDisabled(), true);
  await page.getByLabel('On-chain destination (regtest bcrt1...)').fill(offboardDestination);
  assert.equal(await startSwap.isDisabled(), false);

  await audit(page);

  await startSwap.click();
  await dialog.getByText('Could not connect to the backend. Try again.', { exact: true }).waitFor();
  assert.equal(await startSwap.isDisabled(), false);

  await startSwap.click();
  await dialog.locator('#execution-status').filter({ hasText: /^Offboarding · pending confirmation$/ }).waitFor();
  assert.equal(await page.locator('#quote-status').textContent(), 'Offboarding · pending confirmation');
  await dialog.locator('#execution-status').filter({ hasText: /^Offboarding · confirmed$/ }).waitFor();
  await page.screenshot({ path: evidence + '/mock-ark-offboarding-confirmed.png' });
  assert.equal(await page.locator('#quote-status').textContent(), 'Offboarding · confirmed');
  assert.equal(statusReads, 1);
  assert.equal(offboardKeys.length, 2);
  assert.equal(offboardKeys[1], offboardKeys[0]);
  await dialog.getByRole('button', { name: 'Close review', exact: true }).click();

  // Verify confirmed state reflection in Account & Admin when backend serves a CONFIRMED swap
  await page.route('**/v1/ark/swaps', route => route.request().method() === 'GET'
    ? route.fulfill({ json: { network: 'regtest', swaps: [confirmedRecord] } })
    : route.continue());
  await page.route('**/v1/admin/ark/swaps', route => route.fulfill({
    json: {
      network: 'regtest',
      summary: {
        totalSwaps: 1,
        completedSwaps: 1,
        pendingSwaps: 0,
        failedSwaps: 0,
        onchainSentSats: 0,
        onchainReceivedSats: confirmedQuote.netSats,
        arkSentSats: confirmedQuote.invoiceSats,
        arkReceivedSats: 0,
        collectedServiceFeesSats: confirmedQuote.serviceFeeSats,
        estimatedNetworkFeesSats: confirmedQuote.claimFeeSats,
        netOperationalRevenueSats: confirmedQuote.serviceFeeSats,
      },
      swaps: [confirmedRecord],
    },
  }));

  await page.getByRole('link', { name: 'Account', exact: true }).click();
  await page.locator('#account-history-list').getByText('Confirmed', { exact: true }).waitFor();
  assert.equal(await page.locator('#account-active-swaps').textContent(), '0');
  assert.equal(await page.locator('#account-completed-swaps').textContent(), '1');

  await page.getByRole('link', { name: 'Operations', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('activity-completed')?.textContent === '1');
  assert.equal(await page.locator('#activity-pending').textContent(), '0');
  assert.equal(await page.locator('#activity-ark-sent').textContent(), '50,000 sats');
  assert.equal(await page.locator('#activity-onchain-received').textContent(), '49,009 sats');
  assert.equal(await page.locator('#fee-collected').textContent(), '750 sats');
  assert.equal(await page.locator('#fee-network').textContent(), '241 sats');
  assert.equal(await page.locator('#fee-net-revenue').textContent(), '750 sats');

  assert.deepEqual(errors, []);
});

test('private history filters rails and terminal states and deduplicates linked attempts without exposing other records', async context => {
  const f = await setup(); context.after(f.cleanup);
  const account = await testAccount(f.directory, 'USER');
  const server = createApi(f.manager, async () => { throw new Error('Offline test port'); }, undefined, 'regtest', {
    auth: { storePath: account.storePath },
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  context.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const browser = await launchChromium(); context.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await mockDebitQuotes(page);
  const id = (digit: string) => `${digit.repeat(8)}-${digit.repeat(4)}-4222-8222-${digit.repeat(12)}`;
  const claimDestination = payments.p2wpkh({ hash: Buffer.alloc(20, 0x44), network: networks.regtest }).address!;
  const swap = { id: id('1'), network: 'regtest', revision: 4, state: 'REFUNDED', quote: f.quote, claimDestination,
    payment: { status: 'FAILED', valueSats: f.quote.invoiceSats, feeSats: null },
    funding: { txid: '11'.repeat(32), feeSats: 100 },
    claim: { txid: null, feeSats: f.quote.claimFeeSats, netSats: f.quote.amountSats - f.quote.claimFeeSats },
    execution: { status: 'RECONCILIATION_REQUIRED', approvedUntil: null }, allowedActions: [], invoice: 'must-not-display-invoice' };
  const attempt = (digit: string, status: string, swapId: string | null = null) => ({ id: digit.repeat(64), status, swapId, statusUrl: '/unused' });
  await page.route('**/v1/reverse/availability', route => route.fulfill({ json: {
    network: 'regtest', liveSwapsEnabled: false, controlledReverseConfigured: true, executionAvailable: false,
    recoveryAvailable: true, preparedSwapIds: [swap.id],
    preparations: [attempt('b', 'READY', swap.id), attempt('c', 'EXPIRED'), attempt('d', 'REJECTED')],
  } }));
  await page.route('**/v1/swaps', route => route.fulfill({ json: {
    network: 'regtest', swaps: [{ ...swap, state: 'INVOICE_CREATED', revision: 1 }, swap, { ...swap, id: id('9') }],
  } }));
  await page.route('**/v1/ark/swaps', route => route.fulfill({ json: { network: 'regtest', swaps: [] } }));
  const guestReads: string[] = [];
  page.on('request', request => { if (request.url().includes('/v1/guest/quotes')) guestReads.push(request.url()); });

  await page.goto(base + '/#account');
  await page.getByLabel('Username', { exact: true }).fill(account.username);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const list = page.locator('#account-history-list');
  await list.getByText('Refunded', { exact: true }).waitFor();
  assert.equal(await list.locator('li').count(), 3);
  assert.equal(await page.locator('#account-expired-swaps').textContent(), '1');
  assert.equal(await page.locator('#account-failed-swaps').textContent(), '1');
  assert.equal(await page.locator('#account-refunded-swaps').textContent(), '1');
  assert.doesNotMatch(await list.textContent() ?? '', new RegExp(`${id('9')}|${'b'.repeat(64)}|must-not-display-invoice`));
  await page.getByLabel('History status').selectOption('Expired');
  assert.equal(await list.locator('li').count(), 1);
  await page.getByLabel('History route').selectOption('On-chain → Ark');
  await page.getByText('No matching records.', { exact: true }).waitFor();

  await page.getByRole('link', { name: 'Swap', exact: true }).click();
  await page.getByLabel('Send network').selectOption('onchain');
  await waitForRails(page, 'onchain', 'lightning');
  await page.getByLabel('Receive network').selectOption('ark');
  await waitForRails(page, 'onchain', 'ark');
  const swapButton = page.getByRole('button', { name: 'SWAP', exact: true });
  const review = page.getByRole('dialog', { name: 'Review quote' });
  for (const _ of [1, 2]) {
    await swapButton.click();
    await review.getByRole('button', { name: 'Close review', exact: true }).click();
  }
  await page.getByRole('link', { name: 'Account', exact: true }).click();
  await page.getByLabel('History status').selectOption('Quoted');
  await list.getByText('Reviewed in this session', { exact: true }).waitFor();
  assert.equal(await list.locator('li').count(), 1);
  await audit(page);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.locator('#signin').waitFor();
  assert.equal(await list.locator('li').count(), 0);
  assert.deepEqual(guestReads, []);
});
