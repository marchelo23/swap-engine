import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { networks, payments } from 'bitcoinjs-lib';
import { setup, testAccount } from './helpers.js';
import { provisionAccount } from '../scripts/provision-auth.js';
import { createApi } from '../src/api/server.js';
import { config } from '../src/config.js';
import {
  ArkSwapService,
  arkRouteFromPair,
  buildArkQuote,
  createArkLabCliRunner,
  createArkRegtestCliPort,
  isArkOnchainRoute,
  validateOutpoint,
  validateRegtestArkAddress,
  validateRegtestBech32Address,
} from '../src/ark/ArkAdapter.js';

const boardingOutpoint = '11'.repeat(32) + ':1';
const boardingCommitment = '22'.repeat(32);
const offboardVtxo = '33'.repeat(32) + ':0';
const offboardDestination = payments.p2wpkh({ hash: Buffer.alloc(20, 0x11), network: networks.regtest }).address!;
const offboardCommitment = '44'.repeat(32);
const syntheticForfeitAddress = payments.p2wpkh({ hash: Buffer.alloc(20, 0x22), network: networks.regtest }).address!;

test('Ark <-> On-chain route identification and regtest address/outpoint validation enforce boundaries', () => {
  assert.equal(isArkOnchainRoute('onchain', 'ark'), true);
  assert.equal(isArkOnchainRoute('ark', 'onchain'), true);
  assert.equal(isArkOnchainRoute('lightning', 'ark'), false);
  assert.equal(isArkOnchainRoute('ark', 'lightning'), false);
  assert.equal(isArkOnchainRoute('liquid', 'ark'), false);
  assert.equal(arkRouteFromPair('onchain', 'ark'), 'onchain-to-ark');
  assert.equal(arkRouteFromPair('ark', 'onchain'), 'ark-to-onchain');
  assert.equal(arkRouteFromPair('lightning', 'onchain'), undefined);

  assert.equal(validateRegtestBech32Address(offboardDestination), offboardDestination);
  assert.throws(() => validateRegtestBech32Address('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'), /ARK_REGTEST_ADDRESS_REQUIRED/);
  assert.throws(() => validateRegtestBech32Address('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'), /ARK_REGTEST_ADDRESS_REQUIRED/);
  assert.throws(() => validateRegtestBech32Address('1BitcoinEaterAddressDontSendf59kuE'), /ARK_REGTEST_ADDRESS_REQUIRED/);

  const validTark = 'tark1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
  assert.equal(validateRegtestArkAddress(validTark), validTark);
  assert.throws(() => validateRegtestArkAddress('ark1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'), /ARK_REGTEST_OFFCHAIN_ADDRESS_REQUIRED/);

  assert.equal(validateOutpoint(boardingOutpoint), boardingOutpoint);
  assert.throws(() => validateOutpoint('not-an-outpoint'), /ARK_OUTPOINT_INVALID/);
  assert.throws(() => validateOutpoint('11'.repeat(32) + ':-1'), /ARK_OUTPOINT_INVALID/);
});

test('buildArkQuote enforces 10,000..1,000,000 sats and calculates boarding and cooperative offboarding terms', () => {
  const bq = buildArkQuote('onchain-to-ark', 50_000, 1_000);
  assert.equal(bq.method, 'boarding');
  assert.equal(bq.serviceFeeSats, 750);
  assert.equal(bq.claimFeeSats, 262);
  assert.equal(bq.invoiceSats, 50_000);
  assert.equal(bq.netSats, 48_988);
  assert.equal(bq.expiresAt, 121_000);

  const oq = buildArkQuote('ark-to-onchain', 75_000, 2_000);
  assert.equal(oq.method, 'cooperative-offboarding');
  assert.equal(oq.serviceFeeSats, 875);
  assert.equal(oq.claimFeeSats, 241);
  assert.equal(oq.invoiceSats, 75_000);
  assert.equal(oq.netSats, 73_884);
  assert.equal(oq.expiresAt, 122_000);

  for (const invalid of [0, 329, 9_999, 1_000_001, 50_000.5, NaN]) {
    assert.throws(() => buildArkQuote('onchain-to-ark', invalid));
    assert.throws(() => buildArkQuote('ark-to-onchain', invalid));
  }
});

test('createArkLabCliRunner rejects relative paths, disallowed commands, and option injection', async () => {
  const f = await setup();
  try {
    assert.throws(() => createArkLabCliRunner('relative/ark-lab'), /ARK_CLI_PATH_MUST_BE_ABSOLUTE/);
    const fakeBin = join(f.directory, 'ark-lab');
    await writeFile(fakeBin, '#!/bin/sh\n', { mode: 0o700 });
    const captured: Array<{ file: string; args: readonly string[] }> = [];
    const runner = createArkLabCliRunner(fakeBin, {
      e2eFixture: true,
      exec: ((file: string, args: readonly string[], _opts: unknown, cb: (err: Error | null, res: { stdout: string; stderr: string }) => void) => {
        captured.push({ file, args });
        cb(null, { stdout: JSON.stringify({ network: 'regtest', asset: 'BTC', wallets: {} }), stderr: '' });
      }) as unknown as typeof import('node:child_process').execFile,
    });
    await assert.rejects(() => runner(['transfer-submit', boardingOutpoint, '50000']), /ARK_CLI_COMMAND_REJECTED/);
    await assert.rejects(() => runner(['board', '--malicious-flag', boardingOutpoint]), /ARK_CLI_ARGUMENT_REJECTED/);
    await runner(['balance', 'alice']);
    assert.deepEqual(captured, [{ file: fakeBin, args: ['--e2e-fixture', 'balance', 'alice'] }]);
  } finally {
    await f.cleanup();
  }
});

test('ArkRegtestCliPort enforces loopback operator URL and wraps boarding, offboarding and telemetry', async () => {
  assert.throws(() => createArkRegtestCliPort({ operatorInfoUrl: 'https://ark.example.com/v1/info' }), /ARK_OPERATOR_LOOPBACK_REQUIRED/);
  const cliCalls: string[][] = [];
  const port = createArkRegtestCliPort({
    operatorInfoUrl: 'http://127.0.0.1:37070/v1/info',
    fetchImpl: (async () => new Response(JSON.stringify({
      network: 'regtest',
      version: 'v0.9.25',
      signerPubkey: '032203ea0a05239f49049ee3f939757dde2271b9051eb3c905283d24b9e25dd6be',
      forfeitAddress: syntheticForfeitAddress,
      dust: '330',
      sessionDuration: '10',
      unilateralExitDelay: '20',
      boardingExitDelay: '30',
    }), { status: 200 })) as typeof fetch,
    cli: async args => {
      cliCalls.push(args);
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
        return {
          network: 'regtest',
          asset: 'BTC',
          wallets: { alice: { input: args[2], commitment_txid: boardingCommitment } },
        };
      }
      if (args[0] === 'offboard-coop') {
        return {
          network: 'regtest',
          asset: 'BTC',
          wallets: {
            bob: {
              input: args[1],
              address: args[2],
              amount_sats: Number(args[3]),
              commitment_txid: offboardCommitment,
              method: 'cooperative',
            },
          },
        };
      }
      throw new Error('Unexpected command');
    },
  });

  const telemetry = await port.telemetry();
  assert.equal(telemetry.operatorStatus, 'ok');
  assert.equal(telemetry.operator?.version, 'v0.9.25');
  assert.equal(telemetry.wallets?.alice?.totalSats, 125_000);
  assert.equal(telemetry.wallets?.bob?.totalSats, 45_000);

  const boarded = await port.board({ wallet: 'alice', fundingOutpoint: boardingOutpoint, amountSats: 200_000 });
  assert.equal(boarded.commitmentTxid, boardingCommitment);

  const offboarded = await port.offboardCooperative({ vtxoOutpoint: offboardVtxo, destinationAddress: offboardDestination, amountSats: 30_000 });
  assert.equal(offboarded.commitmentTxid, offboardCommitment);
  assert.deepEqual(cliCalls, [
    ['balance'],
    ['board', 'alice', boardingOutpoint],
    ['offboard-coop', offboardVtxo, offboardDestination, '30000'],
  ]);
});

test('HTTP API exposes Ark quotes, enforces auth/CSRF/idempotency on Ark swaps and telemetry, and leaves LN->On-chain untouched', async () => {
  const f = await setup();
  const adminAccount = await testAccount(f.directory, 'ADMIN');
  const userAccount = { username: 'ark-user', password: 'ark-user-password-123456' };
  await provisionAccount(adminAccount.storePath, userAccount.username, 'USER', userAccount.password);
  const mockPort = createArkRegtestCliPort({ operatorInfoUrl: 'http://127.0.0.1:37070/v1/info',
    fetchImpl: (async () => new Response(JSON.stringify({
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
            alice: { confirmed_sats: 200_000, pre_confirmed_sats: 0, recoverable_sats: 0, pending_recovery_sats: 0, total_sats: 200_000 },
          },
        };
      }
      if (args[0] === 'board') {
        return {
          network: 'regtest',
          asset: 'BTC',
          wallets: { alice: { input: args[2], commitment_txid: boardingCommitment } },
        };
      }
      if (args[0] === 'offboard-coop') {
        return {
          network: 'regtest',
          asset: 'BTC',
          wallets: {
            bob: {
              input: args[1],
              address: args[2],
              amount_sats: Number(args[3]),
              commitment_txid: offboardCommitment,
              method: 'cooperative',
            },
          },
        };
      }
      throw new Error('Unexpected CLI call');
    },
  });

  const server = createApi(
    f.manager,
    async () => ({ onchainSats: 1_000_000, incomingSats: 1_000_000 }),
    undefined,
    'regtest',
    { auth: { storePath: adminAccount.storePath }, ark: mockPort, arkExecutionOwner: userAccount.username },
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    // 1. Existing LN -> On-chain quote is completely unchanged
    const lnQuoteRes = await fetch(`${origin}/v1/quotes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amountSats: 50_000 }),
    });
    assert.equal(lnQuoteRes.status, 201);
    const lnQuote = await lnQuoteRes.json();
    assert.equal(lnQuote.amountSats, 49_250);
    assert.equal(lnQuote.serviceFeeSats, 750);
    assert.equal(lnQuote.invoiceSats, 50_000);
    assert.equal(lnQuote.claimFeeSats, 500);

    // 2. Unauthenticated access to telemetry and swap submission is denied
    assert.equal((await fetch(`${origin}/v1/ark/telemetry`)).status, 401);
    assert.equal((await fetch(`${origin}/v1/ark/swaps`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'unauth-key-1' },
      body: JSON.stringify({
        quoteId: lnQuote.id,
        route: 'onchain-to-ark',
        fundingOutpoint: boardingOutpoint,
        amountSats: 50_000,
      }),
    })).status, 401);

    // 3. Sign in as USER and verify ADMIN gate on telemetry
    const userLogin = await fetch(`${origin}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ username: userAccount.username, password: userAccount.password }),
    });
    assert.equal(userLogin.status, 200);
    const userCookie = userLogin.headers.get('set-cookie')!.split(';')[0]!;
    const userSession = await userLogin.json();
    assert.equal((await fetch(`${origin}/v1/ark/telemetry`, { headers: { cookie: userCookie } })).status, 403);

    // 4. USER can quote and submit an On-chain -> Ark boarding swap and Ark -> On-chain cooperative offboard
    const bQuoteRes = await fetch(`${origin}/v1/ark/quotes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ route: 'onchain-to-ark', amountSats: 50_000 }),
    });
    assert.equal(bQuoteRes.status, 201);
    const bQuote = await bQuoteRes.json();

    // Missing CSRF token rejected
    assert.equal((await fetch(`${origin}/v1/ark/swaps`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: userCookie, origin, 'idempotency-key': 'ark-board-key-1' },
      body: JSON.stringify({
        quoteId: bQuote.id,
        route: 'onchain-to-ark',
        wallet: 'alice',
        fundingOutpoint: boardingOutpoint,
        amountSats: 50_000,
      }),
    })).status, 403);

    const boardSubmit = await fetch(`${origin}/v1/ark/swaps`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: userCookie,
        origin,
        'x-csrf-token': userSession.csrfToken,
        'idempotency-key': 'ark-board-key-1',
      },
      body: JSON.stringify({
        quoteId: bQuote.id,
        route: 'onchain-to-ark',
        wallet: 'alice',
        fundingOutpoint: boardingOutpoint,
        amountSats: 50_000,
      }),
    });
    assert.equal(boardSubmit.status, 202);
    const boardRecord = await boardSubmit.json();
    assert.equal(boardRecord.status, 'SUBMITTED');
    assert.equal(boardRecord.commitmentTxid, boardingCommitment);

    // Replay with same idempotency key returns identical swap record
    const replaySubmit = await fetch(`${origin}/v1/ark/swaps`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: userCookie,
        origin,
        'x-csrf-token': userSession.csrfToken,
        'idempotency-key': 'ark-board-key-1',
      },
      body: JSON.stringify({
        quoteId: bQuote.id,
        route: 'onchain-to-ark',
        wallet: 'alice',
        fundingOutpoint: boardingOutpoint,
        amountSats: 50_000,
      }),
    });
    assert.equal(replaySubmit.status, 202);
    assert.deepEqual(await replaySubmit.json(), boardRecord);

    // Lookup owned swap status
    const statusRes = await fetch(`${origin}/v1/ark/swaps/${boardRecord.id}`, {
      headers: { cookie: userCookie },
    });
    assert.equal(statusRes.status, 200);
    assert.deepEqual(await statusRes.json(), boardRecord);

    // Ark -> On-chain cooperative offboard
    const oQuote = await (await fetch(`${origin}/v1/ark/quotes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ route: 'ark-to-onchain', amountSats: 30_000 }),
    })).json();

    const offboardSubmit = await fetch(`${origin}/v1/ark/swaps`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: userCookie,
        origin,
        'x-csrf-token': userSession.csrfToken,
        'idempotency-key': 'ark-offboard-key-1',
      },
      body: JSON.stringify({
        quoteId: oQuote.id,
        route: 'ark-to-onchain',
        vtxoOutpoint: offboardVtxo,
        destinationAddress: offboardDestination,
        amountSats: 30_000,
      }),
    });
    assert.equal(offboardSubmit.status, 202);
    const offboardRecord = await offboardSubmit.json();
    assert.equal(offboardRecord.status, 'SUBMITTED');
    assert.equal(offboardRecord.method, 'cooperative-offboarding');
    assert.equal(offboardRecord.commitmentTxid, offboardCommitment);

    // 5. Sign in as ADMIN: telemetry returns 200 and cannot access USER's private swap
    const adminLogin = await fetch(`${origin}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ username: adminAccount.username, password: adminAccount.password }),
    });
    assert.equal(adminLogin.status, 200);
    const adminCookie = adminLogin.headers.get('set-cookie')!.split(';')[0]!;
    const telemetryRes = await fetch(`${origin}/v1/ark/telemetry`, { headers: { cookie: adminCookie } });
    assert.equal(telemetryRes.status, 200);
    const telemetryBody = await telemetryRes.json();
    assert.equal(telemetryBody.operator.version, 'v0.9.25');
    assert.equal(telemetryBody.wallets.alice.totalSats, 200_000);
    assert.equal((await fetch(`${origin}/v1/ark/swaps/${boardRecord.id}`, { headers: { cookie: adminCookie } })).status, 404);

    // 6. Owner-scoped Ark swap list and ADMIN activity/fee reporting (SUBMITTED is pending, excluded from completed/settled)
    assert.equal((await fetch(`${origin}/v1/ark/swaps`)).status, 401);
    const userListRes = await fetch(`${origin}/v1/ark/swaps`, { headers: { cookie: userCookie } });
    assert.equal(userListRes.status, 200);
    const userList = await userListRes.json();
    assert.equal(userList.swaps.length, 2);
    const adminOwnList = await (await fetch(`${origin}/v1/ark/swaps`, { headers: { cookie: adminCookie } })).json();
    assert.equal(adminOwnList.swaps.length, 0);

    assert.equal((await fetch(`${origin}/v1/admin/ark/swaps`)).status, 401);
    assert.equal((await fetch(`${origin}/v1/admin/ark/swaps`, { headers: { cookie: userCookie } })).status, 403);
    const adminReportRes = await fetch(`${origin}/v1/admin/ark/swaps`, { headers: { cookie: adminCookie } });
    assert.equal(adminReportRes.status, 200);
    const adminReport = await adminReportRes.json();
    assert.equal(adminReport.summary.totalSwaps, 2);
    assert.equal(adminReport.summary.completedSwaps, 0);
    assert.equal(adminReport.summary.pendingSwaps, 2);
    assert.equal(adminReport.summary.failedSwaps, 0);
    assert.equal(adminReport.summary.onchainSentSats, 0);
    assert.equal(adminReport.summary.arkReceivedSats, 0);
    assert.equal(adminReport.summary.arkSentSats, 0);
    assert.equal(adminReport.summary.onchainReceivedSats, 0);
    assert.equal(adminReport.summary.collectedServiceFeesSats, 0);
    assert.equal(adminReport.summary.estimatedNetworkFeesSats, 0);
    assert.equal(adminReport.summary.netOperationalRevenueSats, 0);
    assert.equal(adminReport.swaps.length, 2);
    assert.equal('ownerId' in adminReport.swaps[0], false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    await f.cleanup();
  }
});

test('ArkSwapService persists swaps to disk and reloads them across restarts', async () => {
  const f = await setup();
  try {
    const storePath = join(f.directory, 'ark-swaps.json');
    const port = {
      telemetry: async () => { throw new Error('unused'); },
      vtxos: async () => [],
      board: async () => ({ commitmentTxid: boardingCommitment }),
      offboardCooperative: async () => ({ commitmentTxid: offboardCommitment }),
    };
    const first = new ArkSwapService(port, storePath);
    const q = first.quote('ark-to-onchain', 50_000);
    const submitted = await first.submit('owner-persist', 'persist-key-1', {
      quoteId: q.id,
      route: 'ark-to-onchain',
      vtxoOutpoint: offboardVtxo,
      destinationAddress: offboardDestination,
      amountSats: 50_000,
    });
    assert.equal(submitted.status, 'SUBMITTED');

    const reloaded = new ArkSwapService(port, storePath);
    const found = reloaded.getSwap('owner-persist', submitted.id);
    assert.deepEqual(found, submitted);
    const report = reloaded.adminReport();
    assert.equal(report.summary.totalSwaps, 1);
    assert.equal(report.summary.completedSwaps, 0);
    assert.equal(report.summary.pendingSwaps, 1);
    assert.equal(report.summary.failedSwaps, 0);
    assert.equal(report.summary.collectedServiceFeesSats, 0);
    assert.equal(report.summary.estimatedNetworkFeesSats, 0);
    assert.equal(report.summary.netOperationalRevenueSats, 0);
    assert.equal(report.swaps[0]?.id, submitted.id);
  } finally {
    await f.cleanup();
  }
});

test('ArkSwapService fences uncertain submissions and prevents duplicate input spend', async () => {
  let calls = 0;
  const service = new ArkSwapService({
    telemetry: async () => { throw new Error('unused'); },
    vtxos: async () => [],
    board: async () => {
      calls++;
      throw new Error('ArkSubmissionUncertain');
    },
    offboardCooperative: async () => ({ commitmentTxid: offboardCommitment }),
  });
  const quote = service.quote('onchain-to-ark', 50_000);
  const first = await service.submit('owner-1', 'uncertain-key-1', {
    quoteId: quote.id,
    route: 'onchain-to-ark',
    wallet: 'alice',
    fundingOutpoint: boardingOutpoint,
    amountSats: 50_000,
  });
  assert.equal(first.status, 'UNCERTAIN');
  assert.equal(calls, 1);

  // Replaying with same idempotency key does not re-submit
  const replay = await service.submit('owner-1', 'uncertain-key-1', {
    quoteId: quote.id,
    route: 'onchain-to-ark',
    wallet: 'alice',
    fundingOutpoint: boardingOutpoint,
    amountSats: 50_000,
  });
  assert.deepEqual(replay, first);
  assert.equal(calls, 1);

  // Attempting to reuse the same funding outpoint with a new quote/key fails closed
  const quote2 = service.quote('onchain-to-ark', 50_000);
  await assert.rejects(() => service.submit('owner-1', 'second-key-same-input', {
    quoteId: quote2.id,
    route: 'onchain-to-ark',
    wallet: 'alice',
    fundingOutpoint: boardingOutpoint,
    amountSats: 50_000,
  }), /ARK_INPUT_ALREADY_RESERVED/);
  assert.equal(calls, 1);
});

test('regression: config() has no /home/chelo defaults, validates ARK_LAB_E2E_FIXTURE, and source omits hardcoded defaults', async () => {
  const c = config({} as NodeJS.ProcessEnv);
  assert.deepEqual(c.rails.ark, { enabled: false });

  assert.throws(() => config({ ARK_LAB_E2E_FIXTURE: 'yes' } as NodeJS.ProcessEnv), /ARK_LAB_E2E_FIXTURE/);
  assert.throws(() => config({ ARK_LAB_E2E_FIXTURE: '1' } as NodeJS.ProcessEnv), /ARK_LAB_E2E_FIXTURE/);
  assert.throws(() => config({ ARK_LAB_E2E_FIXTURE: 'true' }), /ARK_LAB_E2E_FIXTURE_FORBIDDEN/);
  assert.deepEqual(config({ ARK_LAB_E2E_FIXTURE: 'false' }).rails.ark, { enabled: false });

  const [adapterSource, configSource, envExampleSource] = await Promise.all([
    readFile(new URL('../src/ark/ArkAdapter.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/config.ts', import.meta.url), 'utf8'),
    readFile(new URL('../.env.example', import.meta.url), 'utf8'),
  ]);
  for (const forbidden of [
    '/home/chelo',
    'DEFAULT_ARK_LAB_',
    'DEFAULT_BOARDING_',
    'DEFAULT_OFFBOARD_',
    'loadLabEvidence',
    'a2cc69ded323b84f',
    '9f348a9153115bf6',
    'bf025a2d2714c413',
    'bcrt1p26xsajjhle',
    'abebe89ae8244bff',
    'tark1qq3q86s2q53',
  ]) {
    assert.equal(adapterSource.includes(forbidden), false, `ArkAdapter.ts must not contain ${forbidden}`);
    assert.equal(configSource.includes(forbidden), false, `config.ts must not contain ${forbidden}`);
    assert.equal(envExampleSource.includes(forbidden), false, `.env.example must not contain ${forbidden}`);
  }
  for (const [label, source] of [['ArkAdapter.ts', adapterSource], ['config.ts', configSource], ['.env.example', envExampleSource]] as const) {
    assert.equal(/[a-f0-9]{64}:\d+/.test(source), false, `${label} must not contain hardcoded outpoints`);
    assert.equal(/\b(bcrt1|tark1)[0-9a-z]{10,}/.test(source), false, `${label} must not contain hardcoded regtest addresses`);
  }
});

test('regression: .gitignore ignores .env files and .env.ark.regtest.example contains safe Ark template placeholders only', async () => {
  const [gitignore, envExample] = await Promise.all([
    readFile(new URL('../.gitignore', import.meta.url), 'utf8'),
    readFile(new URL('../.env.ark.regtest.example', import.meta.url), 'utf8'),
  ]);
  assert.match(gitignore, /^\.env$/m);
  assert.match(gitignore, /^\.env\.\*$/m);
  assert.match(gitignore, /^!\.env\.example$/m);




  assert.match(envExample, /^ARK_OPERATOR_URL=http:\/\/127\.0\.0\.1:\d+\/v1\/info$/m);
  assert.match(envExample, /^ARK_EXECUTION_ENABLED=false$/m);
  assert.match(envExample, /^ARK_CLI_PATH=\/ABS\//m);
  assert.equal(envExample.includes('/home/chelo'), false);
  assert.equal(/[a-f0-9]{64}:\d+/.test(envExample), false);
  assert.equal(/\b(bcrt1|tark1)[0-9a-z]{10,}/.test(envExample), false);
});

test('regression: POST /v1/ark/swaps requires explicit inputs and loopback check rejects query/hash/non-info paths', async () => {
  assert.throws(() => createArkRegtestCliPort({ operatorInfoUrl: 'http://127.0.0.1:37070/v1/other' }), /ARK_OPERATOR_LOOPBACK_REQUIRED/);
  assert.throws(() => createArkRegtestCliPort({ operatorInfoUrl: 'http://127.0.0.1:37070/v1/info?x=1' }), /ARK_OPERATOR_LOOPBACK_REQUIRED/);
  assert.throws(() => createArkRegtestCliPort({ operatorInfoUrl: 'http://127.0.0.1:37070/v1/info#frag' }), /ARK_OPERATOR_LOOPBACK_REQUIRED/);
  const userInfoUrl = new URL('http://127.0.0.1:37070/v1/info');
  userInfoUrl.username = 'u';
  userInfoUrl.password = 'p';
  assert.throws(() => createArkRegtestCliPort({ operatorInfoUrl: userInfoUrl.toString() }), /ARK_OPERATOR_LOOPBACK_REQUIRED/);

  const f = await setup();
  const userAccount = await testAccount(f.directory, 'USER');
  const port = createArkRegtestCliPort({ operatorInfoUrl: 'http://127.0.0.1:37070/v1/info',
    fetchImpl: (async () => new Response('', { status: 503 })) as typeof fetch,
  });
  const server = createApi(f.manager, async () => ({ onchainSats: 0, incomingSats: 0 }), undefined, 'regtest', {
    auth: { storePath: userAccount.storePath },
    ark: port,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const authHeaders = { ...await userAccount.headers(origin), 'content-type': 'application/json' };
    const bQuote = await (await fetch(`${origin}/v1/ark/quotes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ route: 'onchain-to-ark', amountSats: 50_000 }),
    })).json();
    const oQuote = await (await fetch(`${origin}/v1/ark/quotes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ route: 'ark-to-onchain', amountSats: 50_000 }),
    })).json();

    // Missing fundingOutpoint -> 400
    const missingBoard = await fetch(`${origin}/v1/ark/swaps`, {
      method: 'POST',
      headers: { ...authHeaders, 'idempotency-key': 'missing-board-1' },
      body: JSON.stringify({ quoteId: bQuote.id, route: 'onchain-to-ark', wallet: 'alice', amountSats: 50_000 }),
    });
    assert.equal(missingBoard.status, 400);

    // Missing vtxoOutpoint -> 400
    const missingVtxo = await fetch(`${origin}/v1/ark/swaps`, {
      method: 'POST',
      headers: { ...authHeaders, 'idempotency-key': 'missing-vtxo-1' },
      body: JSON.stringify({ quoteId: oQuote.id, route: 'ark-to-onchain', destinationAddress: offboardDestination, amountSats: 50_000 }),
    });
    assert.equal(missingVtxo.status, 400);

    // Missing destinationAddress -> 400
    const missingDest = await fetch(`${origin}/v1/ark/swaps`, {
      method: 'POST',
      headers: { ...authHeaders, 'idempotency-key': 'missing-dest-1' },
      body: JSON.stringify({ quoteId: oQuote.id, route: 'ark-to-onchain', vtxoOutpoint: offboardVtxo, amountSats: 50_000 }),
    });
    assert.equal(missingDest.status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    await f.cleanup();
  }
});

test('regression: unreachable operator or missing/failing CLI fails closed without historical evidence fallback and rejects symlinks', async () => {
  const f = await setup();
  try {
    // Seed historical evidence files on disk to verify they are NEVER read or returned
    await mkdir(join(f.directory, 'data/ark/evidence'), { recursive: true });
    await mkdir(join(f.directory, 'data/ark/e2e/evidence'), { recursive: true });
    await writeFile(join(f.directory, 'data/ark/evidence/operator-after.json'), JSON.stringify({
      operator: {
        network: 'regtest',
        version: 'v0.0.0-historical',
        signerPubkey: '032203ea0a05239f49049ee3f939757dde2271b9051eb3c905283d24b9e25dd6be',
        forfeitAddress: syntheticForfeitAddress,
        dust: '330',
      },
    }));
    await writeFile(join(f.directory, 'data/ark/e2e/evidence/matrix.json'), JSON.stringify({
      operator_restart: { balance: { alice: { confirmed_sats: 999999, pre_confirmed_sats: 0, recoverable_sats: 0, pending_recovery_sats: 0, total_sats: 999999 } } },
    }));
    await writeFile(join(f.directory, 'data/ark/e2e/evidence/boarding.json'), JSON.stringify({ commitment: { txid: boardingCommitment } }));
    await writeFile(join(f.directory, 'data/ark/e2e/evidence/offboard.json'), JSON.stringify({ commitment: { txid: offboardCommitment } }));

    // 1. Unreachable operator (non-200) -> telemetry unavailable, execution/vtxos fail closed
    const unreachablePort = createArkRegtestCliPort({ operatorInfoUrl: 'http://127.0.0.1:37070/v1/info',
      fetchImpl: (async () => new Response('down', { status: 503 })) as typeof fetch,
      cli: async () => { throw new Error('CLI should not run when operator unavailable'); },
    });
    const downTelemetry = await unreachablePort.telemetry();
    assert.equal(downTelemetry.operatorStatus, 'unavailable');
    assert.equal(downTelemetry.operator, null);
    assert.equal(downTelemetry.wallets, null);
    await assert.rejects(() => unreachablePort.board({ wallet: 'alice', fundingOutpoint: boardingOutpoint, amountSats: 50_000 }), /ARK_OPERATOR_UNAVAILABLE/);
    await assert.rejects(() => unreachablePort.offboardCooperative({ vtxoOutpoint: offboardVtxo, destinationAddress: offboardDestination, amountSats: 50_000 }), /ARK_OPERATOR_UNAVAILABLE/);
    await assert.rejects(() => unreachablePort.vtxos('alice'), /ARK_OPERATOR_UNAVAILABLE/);

    // 2. Live operator + unconfigured CLI -> telemetry has wallets: null, execution/vtxos fail closed
    const liveOperatorFetch = (async () => new Response(JSON.stringify({
      network: 'regtest',
      version: 'v0.9.25',
      signerPubkey: '032203ea0a05239f49049ee3f939757dde2271b9051eb3c905283d24b9e25dd6be',
      forfeitAddress: syntheticForfeitAddress,
      dust: 546,
    }), { status: 200 })) as typeof fetch;
    const noCliPort = createArkRegtestCliPort({ operatorInfoUrl: 'http://127.0.0.1:37070/v1/info', fetchImpl: liveOperatorFetch });
    const noCliTelemetry = await noCliPort.telemetry();
    assert.equal(noCliTelemetry.operatorStatus, 'ok');
    assert.equal(noCliTelemetry.cliConfigured, false);
    assert.equal(noCliTelemetry.wallets, null);
    await assert.rejects(() => noCliPort.board({ wallet: 'alice', fundingOutpoint: boardingOutpoint, amountSats: 50_000 }), /ARK_CLI_NOT_CONFIGURED/);
    await assert.rejects(() => noCliPort.offboardCooperative({ vtxoOutpoint: offboardVtxo, destinationAddress: offboardDestination, amountSats: 50_000 }), /ARK_CLI_NOT_CONFIGURED/);
    await assert.rejects(() => noCliPort.vtxos('alice'), /ARK_CLI_NOT_CONFIGURED/);

    // 3. Operator dust enforcement + failing CLI -> wallets: null, no fallback
    const failingCliPort = createArkRegtestCliPort({ operatorInfoUrl: 'http://127.0.0.1:37070/v1/info',
      fetchImpl: liveOperatorFetch,
      cli: async () => { throw new Error('cli crashed'); },
    });
    const failedCliTelemetry = await failingCliPort.telemetry();
    assert.equal(failedCliTelemetry.operatorStatus, 'ok');
    assert.equal(failedCliTelemetry.wallets, null);
    await assert.rejects(() => failingCliPort.board({ wallet: 'alice', fundingOutpoint: boardingOutpoint, amountSats: 400 }), /ARK_INVALID_AMOUNT/);
    await assert.rejects(() => failingCliPort.offboardCooperative({ vtxoOutpoint: offboardVtxo, destinationAddress: offboardDestination, amountSats: 400 }), /ARK_INVALID_AMOUNT/);

    // 4. Simulation mode denies /v1/ark/telemetry with 503 ARK_TELEMETRY_NOT_CONFIGURED
    const adminAccount = await testAccount(f.directory, 'ADMIN');
    const simServer = createApi(f.manager, async () => ({ onchainSats: 0, incomingSats: 0 }), undefined, 'simulation', {
      auth: { storePath: adminAccount.storePath },
      ark: noCliPort,
    });
    simServer.listen(0, '127.0.0.1');
    await once(simServer, 'listening');
    try {
      const simOrigin = `http://127.0.0.1:${(simServer.address() as AddressInfo).port}`;
      const simHeaders = await adminAccount.headers(simOrigin);
      const simTelemetry = await fetch(`${simOrigin}/v1/ark/telemetry`, { headers: simHeaders });
      assert.equal(simTelemetry.status, 503);
      assert.deepEqual(await simTelemetry.json(), { error: 'ARK_TELEMETRY_NOT_CONFIGURED' });
    } finally {
      await new Promise<void>((resolve, reject) => simServer.close(err => err ? reject(err) : resolve()));
    }

    // 5. Symlink storePath rejected on load and write
    const realTarget = join(f.directory, 'real-target.json');
    await writeFile(realTarget, JSON.stringify({ schema: 1, swaps: [] }));
    const linkStorePath = join(f.directory, 'symlink-ark.json');
    try { await symlink(realTarget, linkStorePath); }
    catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    assert.throws(() => new ArkSwapService(noCliPort, linkStorePath), /ARK_STORE_PATH_INVALID/);

    const nonExistentTargetLink = join(f.directory, 'dangling-ark.json');
    await symlink(join(f.directory, 'does-not-exist.json'), nonExistentTargetLink);
    assert.throws(() => new ArkSwapService(noCliPort, nonExistentTargetLink), /ARK_STORE_PATH_INVALID/);
  } finally {
    await f.cleanup();
  }
});

test('regression: SUBMITTED is pending and excluded from settled accounting, while CONFIRMED is completed/settled and REJECTED returns 503', async () => {
  const f = await setup();
  try {
    const adminAccount = await testAccount(f.directory, 'ADMIN');
    const userAccount = { username: 'ark-accounting-user', password: 'ark-accounting-password-123' };
    await provisionAccount(adminAccount.storePath, userAccount.username, 'USER', userAccount.password);

    const storePath = join(f.directory, 'ark-accounting.json');
    const confirmedQuote = buildArkQuote('onchain-to-ark', 40_000, 10_000);
    await writeFile(storePath, JSON.stringify({
      schema: 1,
      swaps: [{
        id: '11111111-1111-4111-8111-111111111111',
        ownerId: 'seeded-owner',
        idempotencyKey: 'seeded-confirmed-key',
        fingerprint: 'seeded-fingerprint',
        network: 'regtest',
        route: 'onchain-to-ark',
        method: 'boarding',
        status: 'CONFIRMED',
        quote: confirmedQuote,
        inputOutpoint: 'c'.repeat(64) + ':0',
        destination: 'alice (Ark VTXO)',
        commitmentTxid: 'd'.repeat(64),
        createdAt: 10_000,
        updatedAt: 10_500,
      }],
    }));

    let failOperator = false;
    const port = createArkRegtestCliPort({ operatorInfoUrl: 'http://127.0.0.1:37070/v1/info',
      fetchImpl: (async () => failOperator
        ? new Response('down', { status: 503 })
        : new Response(JSON.stringify({
            network: 'regtest',
            version: 'v0.9.25',
            signerPubkey: '032203ea0a05239f49049ee3f939757dde2271b9051eb3c905283d24b9e25dd6be',
            forfeitAddress: syntheticForfeitAddress,
            dust: 330,
          }), { status: 200 })) as typeof fetch,
      cli: async args => {
        if (args[0] === 'board') {
          return { network: 'regtest', asset: 'BTC', wallets: { alice: { input: args[2], commitment_txid: boardingCommitment } } };
        }
        throw new Error('Unexpected CLI call');
      },
    });

    const server = createApi(f.manager, async () => ({ onchainSats: 0, incomingSats: 0 }), undefined, 'regtest', {
      auth: { storePath: adminAccount.storePath },
      ark: port,
      arkStorePath: storePath,
      arkExecutionOwner: 'ark-accounting-user',
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const userLogin = await fetch(`${origin}/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ username: 'ark-accounting-user', password: userAccount.password }),
      });
      const userCookie = userLogin.headers.get('set-cookie')!.split(';')[0]!;
      const userSession = await userLogin.json();

      // Submit a SUBMITTED swap -> 202
      const qSub = await (await fetch(`${origin}/v1/ark/quotes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ route: 'onchain-to-ark', amountSats: 50_000 }),
      })).json();
      const subRes = await fetch(`${origin}/v1/ark/swaps`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: userCookie,
          origin,
          'x-csrf-token': userSession.csrfToken,
          'idempotency-key': 'submitted-key-1',
        },
        body: JSON.stringify({
          quoteId: qSub.id,
          route: 'onchain-to-ark',
          wallet: 'alice',
          fundingOutpoint: boardingOutpoint,
          amountSats: 50_000,
        }),
      });
      assert.equal(subRes.status, 202);
      assert.equal((await subRes.json()).status, 'SUBMITTED');

      // Submit when operator is unavailable -> REJECTED with 503 and publicRecord
      failOperator = true;
      const qRej = await (await fetch(`${origin}/v1/ark/quotes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ route: 'ark-to-onchain', amountSats: 30_000 }),
      })).json();
      const rejRes = await fetch(`${origin}/v1/ark/swaps`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: userCookie,
          origin,
          'x-csrf-token': userSession.csrfToken,
          'idempotency-key': 'rejected-key-1',
        },
        body: JSON.stringify({
          quoteId: qRej.id,
          route: 'ark-to-onchain',
          vtxoOutpoint: offboardVtxo,
          destinationAddress: offboardDestination,
          amountSats: 30_000,
        }),
      });
      assert.equal(rejRes.status, 503);
      const rejBody = await rejRes.json();
      assert.equal(rejBody.status, 'REJECTED');
      assert.equal('ownerId' in rejBody, false);

      // Admin report counts ONLY the CONFIRMED swap in completed & settled accounting
      const adminHeaders = await adminAccount.headers(origin);
      const reportRes = await fetch(`${origin}/v1/admin/ark/swaps`, { headers: adminHeaders });
      assert.equal(reportRes.status, 200);
      const report = await reportRes.json();
      assert.equal(report.summary.totalSwaps, 3);
      assert.equal(report.summary.completedSwaps, 1);
      assert.equal(report.summary.pendingSwaps, 1);
      assert.equal(report.summary.failedSwaps, 1);
      assert.equal(report.summary.onchainSentSats, confirmedQuote.invoiceSats);
      assert.equal(report.summary.arkReceivedSats, confirmedQuote.netSats);
      assert.equal(report.summary.arkSentSats, 0);
      assert.equal(report.summary.onchainReceivedSats, 0);
      assert.equal(report.summary.collectedServiceFeesSats, confirmedQuote.serviceFeeSats);
      assert.equal(report.summary.estimatedNetworkFeesSats, confirmedQuote.claimFeeSats);
      assert.equal(report.summary.netOperationalRevenueSats, confirmedQuote.serviceFeeSats);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    }
  } finally {
    await f.cleanup();
  }
});
