import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { Store } from '../../src/persistence/Store.js';
import { SwapManager } from '../../src/core/SwapManager.js';
import { createApi } from '../../src/api/server.js';
import { createOwnedPreparation } from '../../src/api/ownedPreparation.js';
import { createOwnedReverseApi, sessionOwnerAuthenticator } from '../../src/api/ownedReverse.js';
import { provisionAccount } from '../../scripts/provision-auth.js';
import { readAccounts } from '../../src/auth/store.js';
import { preparationFixture } from '../preparationFixture.js';

test('SWAP prepares/reviews once, pays only after Start, then a second explicit SWAP creates a fresh attempt without Hacer otro', async () => {
  const f = await preparationFixture(50000); const catalog = await Store.open(join(f.directory, 'catalog'));
  const accountPath = join(f.directory, 'accounts.json'); const password = 'synthetic-browser-admin-password';
  await provisionAccount(accountPath, 'truja503', 'ADMIN', password); const owner = (await readAccounts(accountPath))[0]!;
  const server = createApi(new SwapManager(catalog), async () => { throw Error('No real node adapters'); }, undefined, 'regtest', { auth: { storePath: accountPath } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let creates = 0; let executes = 0; let reviews = 0;
  const extra: Awaited<ReturnType<typeof preparationFixture>>[] = [];
  const service = await createOwnedPreparation(catalog, server.controlled.operatorIO.sessions, {
    async prepare() {
      creates++; const run = creates === 1 ? f : await preparationFixture(50000); if (run !== f) extra.push(run);
      const result = await run.harness().prepare(); const id = result.request.swapId;
      const api = createOwnedReverseApi(run.store, sessionOwnerAuthenticator(server.controlled.operatorIO.sessions), { origin }); await api.bind(owner.id, id, run.spec.claimDestination);
      api.approve({ ownerId: owner.id, swapId: id, expectedRevision: result.request.expectedRevision, termsDigest: 'ab'.repeat(32), expiresAt: Date.now() + 60000,
        async execute() { executes++; await run.store.transaction(db => { const s = db.swaps[id]!; s.state = 'COMPLETED'; s.revision++;
          s.clientPayment = { hash: s.contract.paymentHash, status: 'SUCCEEDED', feeLimitSats: 100, feeSats: 0 };
          s.lockup = { txid: '11'.repeat(32), vout: 0, hex: 'synthetic-browser-funding' }; s.claimTxid = '22'.repeat(32); });
          const s = run.store.read().swaps[id]!; return { id, revision: s.revision, state: s.state }; } });
      return { api, swapId: id, authorize: async () => { reviews++; }, terminal: async () => run.store.read().swaps[id]!.state === 'COMPLETED' ? 'COMPLETED' : undefined, close: () => api.drain() };
    }, restore: async () => undefined,
  }, { mode: 'regtest', ownerId: owner.id, ownerUsername: 'truja503', origin, profileDigest: 'cd'.repeat(32) });
  server.controlled.installPreparation(service);
  const browser = await chromium.launch({ channel: process.env.WEB_TEST_BROWSER_CHANNEL });
  let releaseExecution: (() => void) | undefined;
  let executionObserved!: () => void; const executionObservedOnServer = new Promise<void>(r => { executionObserved = r; });
  try {
    const page = await browser.newPage({ reducedMotion: 'reduce' }); const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/v1/reverse/preparations', async route => {
      const r = route.request(); assert.equal(r.method(), 'POST'); assert.deepEqual(r.postDataJSON(), { amountSats: 50000 });
      const headers = r.headers(); assert.equal(headers.origin, origin); assert.match(headers['x-csrf-token']!, /^[a-f0-9]{64}$/);
      assert.match(headers['idempotency-key']!, /^[A-Za-z0-9_-]{8,128}$/); assert.equal(headers.authorization, undefined);
      const durable = await page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith('swap-engine.preparation.')).map(([, v]) => JSON.parse(v)));
      assert.equal(durable[0].key, headers['idempotency-key']); await route.continue();
    });
    await page.route('**/v1/swaps/reverse', async route => {
      await route.fetch(); executionObserved();
      await new Promise<void>(r => { releaseExecution = r; });
      await route.abort('failed').catch(() => {});
    });
    await page.goto(origin + '/#account'); await page.getByLabel('Username', { exact: true }).fill('truja503');
    await page.getByLabel('Password', { exact: true }).fill(password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.locator('#account-dashboard').waitFor({ state: 'visible' });
    await page.getByRole('link', { name: 'Swap', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('quote-status')?.textContent?.includes('Quote ready'));
    const amount = page.locator('#amount'); await amount.fill('25000');
    await page.waitForFunction(() => document.getElementById('received-preview')?.textContent?.includes('23,875'));
    await amount.fill('50000');
    await page.waitForFunction(() => document.getElementById('received-preview')?.textContent?.includes('48,750'));
    assert.equal(creates, 0); assert.equal(executes, 0);
    await page.getByRole('button', { name: 'SWAP', exact: true }).click();
    const review = page.getByRole('dialog', { name: 'Confirm prepared swap' });
    try { await review.waitFor({ state: 'visible', timeout: 10000 }); }
    catch { throw new Error(`Review did not open: ${await page.locator('#quote-status').textContent()} / ${await page.locator('#owned-status').textContent()}`); }
    const text = await review.textContent(); for (const value of ['50,000', '48,750', '1,000', f.spec.claimDestination]) assert.ok(text?.includes(value));
    assert.match(text ?? '', /Maximum routing fee\s*0 sats/);
    assert.equal(creates, 1); assert.equal(f.posts(), 1); assert.equal(executes, 0);
    await page.reload(); await page.locator('#owned-controls').waitFor({ state: 'visible' });
    await page.getByRole('link', { name: 'Swap', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('quote-status')?.textContent?.includes('Quote ready'));
    await page.getByRole('button', { name: 'SWAP', exact: true }).click(); await review.waitFor({ state: 'visible' });
    assert.equal(creates, 1); assert.equal(executes, 0);
    await page.evaluate(() => localStorage.setItem('swap-engine.prepared.unrelated-owner.unrelated-swap.execute.once', 'retain-this-other-request'));
    await review.getByRole('button', { name: 'Start prepared swap', exact: true }).click();
    await executionObservedOnServer;
    assert.equal(page.url(), origin + '/#track');
    assert.ok(await page.evaluate(key => localStorage.getItem(key), `swap-engine.prepared.${owner.id}.${f.record().swapId}.execute.once`));
    const reloading = page.reload(); releaseExecution?.(); await reloading;
    await page.waitForFunction(() => document.getElementById('owned-evidence')?.textContent?.includes('COMPLETED'));
    assert.equal(executes, 1); assert.equal(creates, 1); assert.equal(reviews, 0); assert.deepEqual(errors, []);
    await page.waitForURL('**/#swap'); await page.waitForFunction(() => document.activeElement?.id === 'swap-title');
    await page.getByText('¡Swap exitoso!', { exact: true }).waitFor();
    const retained = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
    assert.equal(retained[`swap-engine.preparation.${owner.id}`], undefined);
    assert.equal(retained[`swap-engine.prepared.${owner.id}.${f.record().swapId}.execute.once`], undefined);
    assert.equal(retained['swap-engine.prepared.unrelated-owner.unrelated-swap.execute.once'], 'retain-this-other-request');
    const evidence = JSON.parse(retained[`swap-engine.completed.${owner.id}.${f.record().swapId}`]!);
    assert.equal(evidence.funding.txid, '11'.repeat(32)); assert.equal(evidence.claim.txid, '22'.repeat(32));
    await page.reload(); await page.waitForFunction(() => !document.getElementById('swap')?.hidden); assert.equal(executes, 1);
    await page.waitForFunction(() => document.getElementById('quote-status')?.textContent?.includes('Quote ready'));
    await page.getByRole('button', { name: 'SWAP', exact: true }).click(); await review.waitFor({ state: 'visible' });
    assert.equal(creates, 2); assert.equal(executes, 1); assert.equal(extra.length, 1);
    assert.notEqual(extra[0]!.record().swapId, f.record().swapId); assert.notEqual(extra[0]!.spec.client.paymentHash, f.spec.client.paymentHash);
    assert.equal(f.store.read().swaps[f.record().swapId!]!.state, 'COMPLETED');
  } finally { releaseExecution?.(); await browser.close(); await server.controlled.close(); await new Promise<void>(r => server.close(() => r())); await catalog.close(); for (const run of extra) await run.cleanup(); await f.cleanup(); }
});

for (const mode of ['lost-before-server', 'lost-after-server', 'left-during-review'] as const) test(`review ${mode} preserves one key and never navigates or opens a late modal`, async () => {
  const f = await preparationFixture(50000); const catalog = await Store.open(join(f.directory, 'catalog'));
  const accounts = join(f.directory, 'accounts.json'); const password = 'synthetic-browser-review-password';
  await provisionAccount(accounts, 'truja503', 'ADMIN', password); const owner = (await readAccounts(accounts))[0]!;
  const server = createApi(new SwapManager(catalog), async () => { throw Error('No real nodes'); }, undefined, 'regtest', { auth: { storePath: accounts } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let creates = 0; let reviews = 0; let executes = 0;
  server.controlled.installPreparation(await createOwnedPreparation(catalog, server.controlled.operatorIO.sessions, {
    async prepare() {
      creates++; const result = await f.harness().prepare(); const id = result.request.swapId;
      const api = createOwnedReverseApi(f.store, sessionOwnerAuthenticator(server.controlled.operatorIO.sessions), { origin });
      await api.bind(owner.id, id, f.spec.claimDestination);
      const approval = () => ({ ownerId: owner.id, swapId: id, expectedRevision: result.request.expectedRevision, termsDigest: 'ab'.repeat(32),
        expiresAt: Date.now() + 60000, execute: async () => { executes++; throw Error('Never start this synthetic payment'); } });
      api.approve({ ...approval(), expiresAt: Date.now() + 100 });
      return { api, swapId: id, terminal: async () => undefined, close: () => api.drain(), authorize: async () => { reviews++; api.replaceExpiredApproval(approval()); } };
    }, restore: async () => undefined,
  }, { mode: 'regtest', ownerId: owner.id, ownerUsername: 'truja503', origin, profileDigest: 'cd'.repeat(32) }));
  const browser = await chromium.launch({ channel: process.env.WEB_TEST_BROWSER_CHANNEL });
  let release: (() => void) | undefined;
  try {
    const page = await browser.newPage({ reducedMotion: 'reduce' }); const keys: string[] = [];
    await page.route('**/v1/reverse/preparations/*/review', async route => {
      keys.push(route.request().headers()['idempotency-key']!);
      if (keys.length === 1 && mode === 'lost-before-server') return route.abort('failed');
      if (keys.length === 1 && mode === 'lost-after-server') { await route.fetch(); return route.abort('failed'); }
      if (mode === 'left-during-review') await new Promise<void>(r => { release = r; });
      return route.continue();
    });
    await page.goto(origin + '/#account'); await page.getByLabel('Username', { exact: true }).fill('truja503');
    await page.getByLabel('Password', { exact: true }).fill(password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.locator('#account-dashboard').waitFor({ state: 'visible' }); await page.getByRole('link', { name: 'Swap', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('quote-status')?.textContent?.includes('Quote ready'));
    await page.getByRole('button', { name: 'SWAP', exact: true }).click();
    await page.waitForFunction(() => Object.values(localStorage).some(v => { try { return JSON.parse(v).reviewState === 'INTENT'; } catch { return false; } }));
    if (mode === 'left-during-review') {
      await page.getByRole('link', { name: 'Account', exact: true }).click(); await page.waitForURL('**/#account');
      // Wait until the intercepted POST is pending, then deliver its late response.
      for (let n = 0; !release && n < 50; n++) await new Promise(r => setTimeout(r, 10)); assert.ok(release); release();
      await page.waitForFunction(() => Object.values(localStorage).some(v => { try { return JSON.parse(v).reviewState === 'CONFIRMED'; } catch { return false; } }));
      assert.equal(page.url(), origin + '/#account'); assert.equal(await page.getByRole('dialog', { name: 'Confirm prepared swap' }).isVisible(), false);
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'account-title');
    } else {
      await page.waitForFunction(() => !(document.getElementById('swap-action') as HTMLButtonElement).disabled);
      const first = await page.evaluate(name => JSON.parse(localStorage.getItem(name)!), `swap-engine.preparation.${owner.id}`);
      await page.reload(); await page.waitForFunction(() => document.getElementById('quote-status')?.textContent?.includes('Quote ready'));
      await page.getByRole('button', { name: 'SWAP', exact: true }).click(); await page.getByRole('dialog', { name: 'Confirm prepared swap' }).waitFor();
      assert.equal(keys[0], first.reviewKey); if (mode === 'lost-before-server') assert.equal(keys[1], keys[0]); else assert.equal(keys.length, 1);
      const saved = await page.evaluate(name => JSON.parse(localStorage.getItem(name)!), `swap-engine.preparation.${owner.id}`);
      assert.equal(saved.reviewKey, first.reviewKey); assert.equal(saved.reviewState, 'CONFIRMED');
    }
    assert.equal(creates, 1); assert.equal(reviews, 1); assert.equal(executes, 0);
  } finally { release?.(); await browser.close(); await server.controlled.close(); await new Promise<void>(r => server.close(() => r())); await catalog.close(); await f.cleanup(); }
});
