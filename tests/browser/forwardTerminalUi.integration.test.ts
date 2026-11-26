import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { address, networks, payments } from 'bitcoinjs-lib';
import { chromium, type Browser, type Page } from 'playwright';
import { provisionAccount } from '../../scripts/provision-auth.js';
import { readAccounts } from '../../src/auth/store.js';
import { createApi } from '../../src/api/server.js';
import { SwapManager } from '../../src/core/SwapManager.js';
import {
  FORWARD_DEPLOYMENT_ID,
  FORWARD_ORIGIN,
  FORWARD_PORT,
  FORWARD_REGTEST_GENESIS,
  SingleRunForwardAdmission,
  type ForwardClients,
  type ForwardRegtestPolicy,
} from '../../src/forward/ForwardRegtestProfile.js';
import { CoreLndForwardPorts } from '../../src/core/CoreLndForwardPorts.js';
import { recoveryPaymentsPath } from '../../src/lightning/LndPayerRecovery.js';
import { createTestForwardLeaseToken } from '../../src/persistence/ForwardPayerRegistry.js';
import { Store } from '../../src/persistence/Store.js';
import { privateTestDirectory } from '../helpers.js';

const testToken = createTestForwardLeaseToken();

const launchChromium = () => chromium.launch({
  timeout: 15_000,
  ...(process.env.WEB_TEST_BROWSER_CHANNEL ? { channel: process.env.WEB_TEST_BROWSER_CHANNEL } : {}),
  ...(process.env.WEB_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.WEB_TEST_BROWSER_EXECUTABLE } : {}),
});

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function childPids(ppid = process.pid): Promise<number[]> {
  if (process.platform !== 'linux') return [];
  const entries = await readdir('/proc').catch(() => [] as string[]);
  const pids: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === ppid) continue;
    const stat = await readFile(`/proc/${entry}/stat`, 'utf8').catch(() => '');
    const endComm = stat.lastIndexOf(')');
    if (endComm === -1) continue;
    const parent = Number(stat.slice(endComm + 2).split(' ')[1]);
    if (parent === ppid) pids.push(pid);
  }
  return pids;
}

async function closeBrowserBounded(browser: Browser | undefined, beforePids: Set<number>, timeoutMs = 5_000): Promise<void> {
  if (browser) {
    const disconnected = browser.isConnected()
      ? new Promise<void>(resolve => { browser.once('disconnected', () => resolve()); })
      : Promise.resolve();
    await withTimeout((async () => {
      for (const ctx of browser.contexts()) {
        await ctx.close().catch(() => {});
      }
      await browser.close();
      await disconnected;
    })(), timeoutMs, 'browser.close').catch(() => {});
    assert.equal(browser.isConnected(), false);
  }
  const deadline = Date.now() + 1_500;
  let leftover = (await childPids()).filter(pid => !beforePids.has(pid));
  while (leftover.length > 0 && Date.now() < deadline) {
    await new Promise<void>(resolve => setTimeout(resolve, 50));
    leftover = (await childPids()).filter(pid => !beforePids.has(pid));
  }
  for (const pid of leftover) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
  }
  if (leftover.length > 0) {
    await new Promise<void>(resolve => setTimeout(resolve, 100));
    leftover = (await childPids()).filter(pid => !beforePids.has(pid));
  }
  assert.deepEqual(leftover, []);
}

async function closeServerBounded(server: Server, sockets: Set<Socket>, timeoutMs = 2_000): Promise<void> {
  server.closeIdleConnections();
  const closed = new Promise<void>(resolve => {
    server.close(() => resolve());
  });
  const settled = await withTimeout(closed.then(() => true), timeoutMs, 'server.close').catch(() => false);
  if (!settled) {
    server.closeAllConnections();
    for (const socket of sockets) socket.destroy();
    await withTimeout(closed, 1_000, 'server.close force').catch(() => {});
  }
}

async function uiFixture(outcome: 'SUCCEEDED' | 'INSUFFICIENT_BALANCE') {
  const root = await privateTestDirectory('fwd-ui');
  const registry = join(root, 'registry');
  const dataDir = join(root, 'store');
  const storePath = join(root, 'users.json');
  const password = randomBytes(24).toString('base64url');
  await provisionAccount(storePath, 'admin3201', 'ADMIN', password);
  await provisionAccount(storePath, 'outsider', 'USER', password);
  const accounts = await readAccounts(storePath);
  const owner = accounts.find(a => a.username === 'admin3201')!;

  const payerNode = '02' + '11'.repeat(32);
  const payeeNode = '03' + '22'.repeat(32);
  const channelId = '1099511627776';
  const channelPoint = 'aa'.repeat(32) + ':0';
  const tipHash = 'bb'.repeat(32);
  const depositTxid = 'cc'.repeat(32);
  const preimage = '99'.repeat(32);
  const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
  const invoice = 'lnbcrt' + 'c'.repeat(40);
  const depositAddress = payments.p2wpkh({ hash: Buffer.alloc(20, 0x42), network: networks.regtest }).address!;
  const depositScript = Buffer.from(address.toOutputScript(depositAddress, networks.regtest)).toString('hex');

  const creds = join(root, 'creds');
  await mkdir(creds, { mode: 0o700 });
  const dummy = join(creds, 'dummy');
  await writeFile(dummy, 'unused', { mode: 0o600 });

  const policy: ForwardRegtestPolicy = {
    mode: 'regtest',
    deploymentId: FORWARD_DEPLOYMENT_ID,
    origin: FORWARD_ORIGIN,
    port: FORWARD_PORT,
    authStorePath: storePath,
    ownerId: owner.id,
    ownerUsername: owner.username,
    genesisHash: FORWARD_REGTEST_GENESIS,
    wallet: 'iso_rt_core_fwd',
    payerNode,
    payeeNode,
    channelId,
    channelPoint,
    dataDir,
    routing: {
      bitcoinOrigin: 'http://127.0.0.1:49443',
      payerOrigin: 'https://127.0.0.1:49081',
      payeeOrigin: 'https://127.0.0.1:49082',
    },
    credentialPaths: {
      bitcoinCookiePath: dummy,
      payerCertPath: join(creds, 'p.cert'),
      payerReadMacaroonPath: join(creds, 'p.ro'),
      payerRouterMacaroonPath: join(creds, 'p.rw'),
      payeeCertPath: join(creds, 'y.cert'),
      payeeReadMacaroonPath: join(creds, 'y.ro'),
    },
    limits: { invoiceSats: 5000, feeLimitSats: 100, depositSats: 5100, maxRuns: 1 },
  };

  let sends = 0;
  let tracks = 0;
  const clients: ForwardClients = {
    core: {
      async call<T>(method: string, params: unknown[] = []): Promise<T> {
        if (method === 'getblockchaininfo') {
          return { chain: 'regtest', initialblockdownload: false, blocks: 250, headers: 250, bestblockhash: tipHash } as T;
        }
        if (method === 'getblockhash') return FORWARD_REGTEST_GENESIS as T;
        if (method === 'listwallets') return [policy.wallet] as T;
        if (method === 'getwalletinfo') return { walletname: policy.wallet, private_keys_enabled: true } as T;
        if (method === 'getbalances') return { mine: { trusted: 0, untrusted_pending: 0, immature: 0 } } as T;
        if (method === 'getnewaddress') return depositAddress as T;
        if (method === 'getaddressinfo') return { scriptPubKey: depositScript, ismine: true, iswatchonly: false } as T;
        if (method === 'gettxout') {
          const [txid] = params as [string, number, boolean];
          if (txid === 'aa'.repeat(32)) {
            return { confirmations: 6, bestblock: tipHash, coinbase: false, scriptPubKey: { hex: '0020' + 'dd'.repeat(32) } } as T;
          }
          if (txid === depositTxid) {
            return { bestblock: tipHash, coinbase: false, confirmations: 2, value: 5100 / 1e8, scriptPubKey: { hex: depositScript } } as T;
          }
          return null as T;
        }
        throw new Error(`Unexpected Core call: ${method}`);
      },
    },
    payer: {
      origin: policy.routing.payerOrigin,
      async call<T>(path: string): Promise<T> {
        if (path === '/v1/state') return { state: 'SERVER_ACTIVE' } as T;
        if (path === '/v1/getinfo') {
          return {
            identity_pubkey: payerNode, synced_to_chain: true, wallet_synced: true, version: '0.20.8-beta commit=v0.20.8-beta',
            block_hash: tipHash, block_height: 250, chains: [{ chain: 'bitcoin', network: 'regtest' }],
          } as T;
        }
        if (path === '/v1/channels') {
          return {
            channels: [{
              chan_id: channelId, channel_point: channelPoint, remote_pubkey: payeeNode,
              active: true, zero_conf: false, local_balance: '290000', remote_balance: '0',
              commit_fee: '1500', unsettled_balance: '0', pending_htlcs: [],
              local_constraints: { chan_reserve_sat: '3000' },
            }],
          } as T;
        }
        if (path === recoveryPaymentsPath) return { first_index_offset: '0', last_index_offset: '0', payments: [] } as T;
        if (path.startsWith('/v1/payreq/')) {
          return {
            destination: payeeNode, payment_hash: paymentHash, num_satoshis: '5000', num_msat: '5000000',
            timestamp: String(Math.floor(Date.now() / 1000)), expiry: '600', cltv_expiry: '40',
          } as T;
        }
        throw new Error(`Unexpected payer call: ${path}`);
      },
    },
    payee: {
      origin: policy.routing.payeeOrigin,
      async call<T>(path: string): Promise<T> {
        if (path === '/v1/state') return { state: 'SERVER_ACTIVE' } as T;
        if (path === '/v1/getinfo') {
          return {
            identity_pubkey: payeeNode, synced_to_chain: true, wallet_synced: true, version: '0.20.8-beta commit=v0.20.8-beta',
            block_hash: tipHash, block_height: 250, chains: [{ chain: 'bitcoin', network: 'regtest' }],
          } as T;
        }
        if (path === '/v1/channels') {
          return {
            channels: [{
              chan_id: channelId, channel_point: channelPoint, remote_pubkey: payerNode,
              active: true, zero_conf: false, local_balance: '0', remote_balance: '290000',
              commit_fee: '1500', unsettled_balance: '0', pending_htlcs: [],
              local_constraints: { chan_reserve_sat: '3000' },
            }],
          } as T;
        }
        throw new Error(`Unexpected payee call: ${path}`);
      },
    },
    transport: {
      origin: policy.routing.payerOrigin,
      async stream(path, _body, onPayment, _signal, beforeRequest) {
        if (path === '/v2/router/send') {
          await beforeRequest?.();
          sends++;
          throw new Error('Simulated lost terminal response');
        }
        tracks++;
        if (outcome === 'INSUFFICIENT_BALANCE') {
          onPayment({
            status: 'FAILED', failure_reason: 'FAILURE_REASON_INSUFFICIENT_BALANCE',
            payment_hash: paymentHash, htlcs: [], fee_msat: '0', fee_sat: '0', fee: '0',
          });
          return;
        }
        onPayment({
          status: 'SUCCEEDED', failure_reason: 'FAILURE_REASON_NONE',
          payment_hash: paymentHash, payment_preimage: preimage, value_msat: '5000000', fee_msat: '100',
        });
      },
    },
  };

  await Store.provisionFreshForwardWithTestToken(testToken, dataDir, payerNode, registry);
  const store = await Store.openForForwardWithTestToken(testToken, dataDir, payerNode, registry);
  const basePorts = new CoreLndForwardPorts(clients.core, clients.payer, clients.transport, payerNode, payeeNode, channelId, store, testToken);
  const admission = new SingleRunForwardAdmission(store, basePorts, policy, clients, testToken);
  const server = createApi(new SwapManager(store), async () => ({ onchainSats: 0, incomingSats: 0 }), undefined, 'regtest', {
    environment: 'regtest',
    auth: { storePath },
    forward: { ownerId: owner.id, admission, requireAdminRole: true, testToken },
  });
  const sockets = new Set<Socket>();
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    base, password, owner, invoice, depositTxid, preimage, dataDir,
    counts: () => ({ sends, tracks }),
    admissionCount: () => Object.keys(store.read().forwardAdmissions ?? {}).length,
    cleanup: async () => {
      await closeServerBounded(server, sockets);
      await withTimeout(store.close(), 3_000, 'store.close');
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function runForwardUiTest(
  t: TestContext,
  outcome: 'SUCCEEDED' | 'INSUFFICIENT_BALANCE',
  fn: (ctx: { x: Awaited<ReturnType<typeof uiFixture>>; browser: Browser; page: Page }) => Promise<void>,
) {
  const x = await uiFixture(outcome);
  const beforePids = new Set(await childPids());
  let browser: Browser | undefined;
  let tornDown = false;
  const teardown = async () => {
    if (tornDown) return;
    tornDown = true;
    const errors: unknown[] = [];
    try {
      await closeBrowserBounded(browser, beforePids);
    } catch (error) {
      errors.push(error);
    }
    try {
      await x.cleanup();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) throw errors[0];
  };
  t.after(teardown);
  try {
    browser = await launchChromium();
    const page = await browser.newPage({ reducedMotion: 'reduce' });
    page.setDefaultTimeout(10_000);
    page.setDefaultNavigationTimeout(10_000);
    await fn({ x, browser, page });
  } finally {
    await teardown();
  }
}

test('forward UI denies non-owner accounts and renders UNKNOWN -> FAILED_INSUFFICIENT_BALANCE terminal state', { timeout: 60_000 }, async t => {
  await runForwardUiTest(t, 'INSUFFICIENT_BALANCE', async ({ x, page }) => {

  // Non-owner user sees unavailable notice and hidden controls; #swap quote returns 503 without mutating state.json
  const stateBeforeSwapView = await readFile(join(x.dataDir, 'state.json'));
  const quoteStatuses: number[] = [];
  page.on('response', res => {
    if (new URL(res.url()).pathname === '/v1/quotes') quoteStatuses.push(res.status());
  });
  await page.goto(`${x.base}/#swap`);
  await page.waitForFunction(() => document.getElementById('quote-status')?.textContent !== 'Checking quote…');
  assert.equal(quoteStatuses.some(s => s === 503), true);
  assert.equal(Buffer.compare(stateBeforeSwapView, await readFile(join(x.dataDir, 'state.json'))), 0);

  await page.goto(`${x.base}/#account`);
  await page.getByLabel('Username', { exact: true }).fill('outsider');
  await page.getByLabel('Password', { exact: true }).fill(x.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Account overview' }).waitFor();
  await page.goto(`${x.base}/#forward`);
  await page.getByText('Bitcoin on-chain → Lightning execution unavailable for this account.', { exact: true }).waitFor();
  assert.equal(await page.locator('#forward-controls').isVisible(), false);

  // Sign out and sign in as authorized ADMIN
  await page.goto(`${x.base}/#account`);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.locator('#signin').waitFor();
  await page.getByLabel('Username', { exact: true }).fill(x.owner.username);
  await page.getByLabel('Password', { exact: true }).fill(x.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Account overview' }).waitFor();

  await page.goto(`${x.base}/#forward`);
  await page.locator('#forward-controls').waitFor({ state: 'visible' });
  await page.locator('#forward-invoice').fill(x.invoice);
  await page.locator('#forward-amount').fill('5000');
  await page.getByRole('button', { name: 'Reserve deposit', exact: true }).click();
  await page.getByText('5,100 sats', { exact: true }).waitFor();

  await page.locator('#forward-txid').fill(x.depositTxid);
  await page.locator('#forward-vout').fill('0');
  await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await page.getByText('2 / 2', { exact: true }).waitFor();

  const payButton = page.getByRole('button', { name: 'Pay invoice', exact: true });
  const recoverButton = page.getByRole('button', { name: 'Check payment without resending', exact: true });
  assert.equal(await payButton.isEnabled(), true);
  await payButton.click();
  await page.getByText('Payment must be checked without resending.', { exact: true }).waitFor();
  assert.equal(await payButton.isDisabled(), true);
  assert.equal(await recoverButton.isEnabled(), true);

  await recoverButton.click();
  await page.getByText('LND verified insufficient balance. Payment was not sent; this deposit cannot be retried.', { exact: true }).waitFor();
  assert.match(await page.locator('#forward-evidence').textContent() ?? '', /FAILED_INSUFFICIENT_BALANCE/);
  assert.equal(await payButton.isDisabled(), true);
  assert.equal(await recoverButton.isDisabled(), true);
  assert.deepEqual(x.counts(), { sends: 1, tracks: 1 });
  });
});

test('forward UI renders UNKNOWN -> SUCCEEDED terminal state without leaking preimage', { timeout: 60_000 }, async t => {
  await runForwardUiTest(t, 'SUCCEEDED', async ({ x, page }) => {
    await page.goto(`${x.base}/#account`);
    await page.getByLabel('Username', { exact: true }).fill(x.owner.username);
    await page.getByLabel('Password', { exact: true }).fill(x.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('heading', { name: 'Account overview' }).waitFor();

    await page.goto(`${x.base}/#forward`);
    await page.locator('#forward-controls').waitFor({ state: 'visible' });
    await page.locator('#forward-invoice').fill(x.invoice);
    await page.locator('#forward-amount').fill('5000');
    await page.getByRole('button', { name: 'Reserve deposit', exact: true }).click();
    await page.getByText('5,100 sats', { exact: true }).waitFor();

    await page.locator('#forward-txid').fill(x.depositTxid);
    await page.locator('#forward-vout').fill('0');
    await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
    await page.getByText('2 / 2', { exact: true }).waitFor();

    await page.getByRole('button', { name: 'Pay invoice', exact: true }).click();
    await page.getByText('Payment must be checked without resending.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Check payment without resending', exact: true }).click();
    await page.getByText('Lightning payment verified by the backend.', { exact: true }).waitFor();
    const evidenceText = await page.locator('#forward-evidence').textContent() ?? '';
    assert.match(evidenceText, /SUCCEEDED/);
    assert.equal(evidenceText.includes(x.preimage), false);
    assert.deepEqual(x.counts(), { sends: 1, tracks: 1 });
  });
});

test('forward UI blocks submit until delayed admission list completes and prevents double reservation', { timeout: 60_000 }, async t => {
  await runForwardUiTest(t, 'SUCCEEDED', async ({ x, page }) => {
    let listRequested!: () => void;
    const listRequestStarted = new Promise<void>(resolve => { listRequested = resolve; });
    let releaseList!: () => void;
    const listGate = new Promise<void>(resolve => { releaseList = resolve; });
    let listRequests = 0;
    let admitRequests = 0;
    let releaseAdmit: (() => void) | undefined;

    await page.route('**/v1/forward', async route => {
      const req = route.request();
      if (req.method() === 'GET') {
        listRequests++;
        if (listRequests === 1) {
          listRequested();
          await listGate;
        }
        await route.continue();
        return;
      }
      if (req.method() === 'POST') {
        admitRequests++;
        if (admitRequests === 1) {
          const admitGate = new Promise<void>(resolve => { releaseAdmit = resolve; });
          const response = await route.fetch();
          await admitGate;
          await route.fulfill({ response });
          return;
        }
      }
      await route.continue();
    });

    await page.goto(`${x.base}/#account`);
    await page.getByLabel('Username', { exact: true }).fill(x.owner.username);
    await page.getByLabel('Password', { exact: true }).fill(x.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('heading', { name: 'Account overview' }).waitFor();

    await page.goto(`${x.base}/#forward`);
    await listRequestStarted;

    // While the admission list is still loading, controls must stay hidden/disabled and reject submits.
    assert.equal(await page.locator('#forward-controls').isVisible(), false);
    const submitButton = page.locator('#forward-submit');
    assert.equal(await page.getByRole('button', { name: 'Reserve deposit', exact: true }).count(), 0);
    assert.equal(await submitButton.isDisabled(), true);
    await page.evaluate(inv => {
      (document.getElementById('forward-invoice') as HTMLInputElement).value = inv;
      (document.getElementById('forward-amount') as HTMLInputElement).value = '5000';
      const form = document.getElementById('forward-admission') as HTMLFormElement;
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }, x.invoice);
    assert.equal(admitRequests, 0);
    assert.equal(x.admissionCount(), 0);

    releaseList();
    await page.locator('#forward-controls').waitFor({ state: 'visible' });
    assert.equal(await submitButton.isEnabled(), true);

    await page.locator('#forward-invoice').fill(x.invoice);
    await page.locator('#forward-amount').fill('5000');
    await submitButton.click();
    await page.waitForFunction(() => (document.getElementById('forward-submit') as HTMLButtonElement).disabled);

    // A concurrent submit while reservation is in flight must not create a second reservation.
    await page.evaluate(() => {
      const form = document.getElementById('forward-admission') as HTMLFormElement;
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    assert.equal(admitRequests, 1);

    releaseAdmit?.();
    await page.getByText('5,100 sats', { exact: true }).waitFor();
    assert.equal(admitRequests, 1);
    assert.equal(x.admissionCount(), 1);
  });
});
