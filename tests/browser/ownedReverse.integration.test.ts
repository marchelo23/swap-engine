import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { preparationFixture } from '../preparationFixture.js';
import { testAccount } from '../helpers.js';
import { readAccounts } from '../../src/auth/store.js';
import { SwapManager } from '../../src/core/SwapManager.js';
import { createApi } from '../../src/api/server.js';
import { createOwnedReverseApi, sessionOwnerAuthenticator } from '../../src/api/ownedReverse.js';

for (const ambiguous of [false, true]) test(`actual browser/session/gateway ${ambiguous ? 'retains uncertainty and reconciles' : 'executes once and survives reload'} with no node adapters`, async () => {
  const f = await preparationFixture(); const prepared = await f.harness().prepare(); const id = prepared.request.swapId;
  const account = await testAccount(f.directory, 'USER'); const [user] = await readAccounts(account.storePath);
  const server = createApi(new SwapManager(f.store), async () => { throw Error('No node adapters'); }, undefined, 'regtest', { auth: { storePath: account.storePath } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let executions = 0; let reconciliations = 0; let executionKey = '';
  const api = createOwnedReverseApi(f.store, sessionOwnerAuthenticator(server.controlled.operatorIO.sessions), { origin,
    recovery: { async reconcile(swapId, revision) {
      assert.equal(swapId, id); assert.equal(revision, f.store.read().swaps[id]!.revision); reconciliations++;
      const s = f.store.read().swaps[id]!; return { id, revision: s.revision, state: s.state, next: 'MANUAL_REVIEW' };
    } } });
  // An expired historical quote must not replace the server's JIT start-before decision.
  await f.store.transaction(db => { db.swaps[id]!.quote.expiresAt = Date.now() - 1000; });
  await api.bind(user!.id, id, f.spec.claimDestination);
  api.approve({ ownerId: user!.id, swapId: id, expectedRevision: prepared.request.expectedRevision,
    termsDigest: 'ab'.repeat(32), expiresAt: Date.now() + 60000, async execute() {
      executions++; assert.equal(Object.values(f.store.read().ownedReverse!.requests)[0]!.status, 'INTENT');
      await f.store.transaction(db => { const s = db.swaps[id]!; s.state = ambiguous ? 'MANUAL_REVIEW' : 'COMPLETED'; s.revision++;
        s.clientPayment = { hash: s.contract.paymentHash, status: ambiguous ? 'UNKNOWN' : 'SUCCEEDED', feeLimitSats: 100, ...(ambiguous ? {} : { feeSats: 0 }) };
        if (!ambiguous) { s.lockup = { txid: '11'.repeat(32), vout: 0, hex: 'synthetic-test-transaction' }; s.claimTxid = '22'.repeat(32); }
      });
      if (ambiguous) throw Error('synthetic-payment-uncertainty');
      const s = f.store.read().swaps[id]!; return { id, state: s.state, revision: s.revision };
    } });
  const mounted = server.controlled.operatorIO.serve(f.store, api, 3000, () => {});
  const browser = await chromium.launch({ channel: process.env.WEB_TEST_BROWSER_CHANNEL });
  try {
    const page = await browser.newPage({ reducedMotion: 'reduce' });
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/v1/swaps/reverse', route => {
      const request = route.request(); const headers = request.headers();
      assert.equal(headers.origin, origin); assert.match(headers['x-csrf-token']!, /^[a-f0-9]{64}$/);
      executionKey = headers['idempotency-key']!; assert.match(executionKey, /^[A-Za-z0-9_-]{8,128}$/);
      assert.deepEqual(request.postDataJSON(), { preparedSwapId: id, expectedRevision: 3 });
      assert.equal(headers.authorization, undefined); return route.continue();
    });
    await page.goto(origin + '/#account');
    await page.getByLabel('Username', { exact: true }).fill(account.username);
    await page.getByLabel('Password', { exact: true }).fill(account.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.locator('#account-dashboard').waitFor({ state: 'visible' });
    const cookie = (await page.context().cookies()).find(c => c.name === 'swap_session');
    assert.equal(cookie?.httpOnly, true); assert.equal(cookie?.sameSite, 'Strict');
    await page.getByRole('link', { name: 'Swap status', exact: true }).click();
    const review = page.getByRole('button', { name: 'Review prepared swap', exact: true });
    await review.waitFor(); await page.waitForFunction(() => !(document.getElementById('owned-review') as HTMLButtonElement).disabled);
    await review.click(); const dialog = page.getByRole('dialog', { name: 'Confirm prepared swap' });
    assert.match(await dialog.textContent() ?? '', /50,750/); assert.match(await dialog.textContent() ?? '', /49,500/);
    await dialog.getByRole('button', { name: 'Start prepared swap', exact: true }).click();
    await page.waitForFunction(() => (document.getElementById('owned-evidence')?.textContent ?? '').includes('COMPLETED') ||
      (document.getElementById('owned-evidence')?.textContent ?? '').includes('RECONCILIATION REQUIRED'));
    assert.equal(executions, 1); assert.ok(executionKey);
    await page.reload();
    await page.locator('#owned-controls').waitFor({ state: 'visible' });
    assert.equal(await review.isDisabled(), true); assert.equal(executions, 1);
    const saved = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('swap-engine.prepared')).map(([, value]) => JSON.parse(value)));
    assert.equal(saved[0].key, executionKey); assert.deepEqual(saved[0].body, { preparedSwapId: id, expectedRevision: 3 });
    if (ambiguous) {
      await page.getByRole('button', { name: 'Check recovery evidence', exact: true }).click();
      await page.getByText('Recovery requires manual operator review.', { exact: true }).waitFor();
      assert.equal(reconciliations, 1); assert.equal(executions, 1);
    }
    await page.getByRole('link', { name: 'Account', exact: true }).click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.locator('#signin').waitFor({ state: 'visible' });
    assert.equal((await page.request.get(origin + `/v1/swaps/${id}`)).status(), 401);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close(); await server.controlled.close(); await mounted;
    await new Promise<void>(r => server.close(() => r())); await f.cleanup();
  }
});
