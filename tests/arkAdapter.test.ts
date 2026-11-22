import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { setup, testAccount } from './helpers.js';
import { provisionAccount } from '../scripts/provision-auth.js';
import { createApi } from '../src/api/server.js';
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

const boardingOutpoint = 'a2cc69ded323b84f285e182bd7534eb3a13cd8c1436747dde5c1fe7eff635bc9:1';
const boardingCommitment = '9f348a9153115bf6f33c65842831eff53c657e148f4304361df43be6d965f6a4';
const offboardVtxo = 'bf025a2d2714c413568a3bb29df7e0aa70b588ad63e8492c3423db8121f995cf:0';
const offboardDestination = 'bcrt1p26xsajjhlef4wvua7x5372ut8y06s90gcdynyjnjuwparh6ta56smxeexq';
const offboardCommitment = 'abebe89ae8244bff5b7c5968ff19246370e9050ebcc3fbdd1e6e59dd58f95449';

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
  assert.throws(() => validateOutpoint('a2cc69ded323b84f285e182bd7534eb3a13cd8c1436747dde5c1fe7eff635bc9:-1'), /ARK_OUTPOINT_INVALID/);
});

test('buildArkQuote enforces 10,000..1,000,000 sats and calculates boarding and cooperative offboarding terms', () => {
  const bq = buildArkQuote('onchain-to-ark', 50_000, 1_000);
  assert.equal(bq.method, 'boarding');
  assert.equal(bq.serviceFeeSats, 750);
  assert.equal(bq.claimFeeSats, 262);
  assert.equal(bq.invoiceSats, 50_750);
  assert.equal(bq.netSats, 49_738);
  assert.equal(bq.expiresAt, 121_000);

  const oq = buildArkQuote('ark-to-onchain', 75_000, 2_000);
  assert.equal(oq.method, 'cooperative-offboarding');
  assert.equal(oq.serviceFeeSats, 875);
  assert.equal(oq.claimFeeSats, 241);
  assert.equal(oq.invoiceSats, 75_875);
  assert.equal(oq.netSats, 74_759);
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
      forfeitAddress: 'bcrt1qfvpfxsp7me72y6nlkek9lk5ahl35yqlkx2x3w3',
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
  const mockPort = createArkRegtestCliPort({
    fetchImpl: (async () => new Response(JSON.stringify({
      network: 'regtest',
      version: 'v0.9.25',
      signerPubkey: '032203ea0a05239f49049ee3f939757dde2271b9051eb3c905283d24b9e25dd6be',
      forfeitAddress: 'bcrt1qfvpfxsp7me72y6nlkek9lk5ahl35yqlkx2x3w3',
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
    { auth: { storePath: adminAccount.storePath }, ark: mockPort },
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
    assert.equal(lnQuote.amountSats, 50_000);
    assert.equal(lnQuote.serviceFeeSats, 750);
    assert.equal(lnQuote.invoiceSats, 50_750);
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
    assert.equal(boardSubmit.status, 201);
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
    assert.equal(replaySubmit.status, 201);
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
    assert.equal(offboardSubmit.status, 201);
    const offboardRecord = await offboardSubmit.json();
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

    // 6. Owner-scoped Ark swap list and ADMIN activity/fee reporting
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
    assert.equal(adminReport.summary.completedSwaps, 2);
    assert.equal(adminReport.summary.pendingSwaps, 0);
    assert.equal(adminReport.summary.failedSwaps, 0);
    assert.equal(adminReport.summary.onchainSentSats, 50_750);
    assert.equal(adminReport.summary.arkReceivedSats, 49_738);
    assert.equal(adminReport.summary.arkSentSats, 30_650);
    assert.equal(adminReport.summary.onchainReceivedSats, 29_759);
    assert.equal(adminReport.summary.collectedServiceFeesSats, 750 + 650);
    assert.equal(adminReport.summary.estimatedNetworkFeesSats, 262 + 241);
    assert.equal(adminReport.summary.netOperationalRevenueSats, 750 + 650);
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
    assert.equal(report.summary.collectedServiceFeesSats, 750);
    assert.equal(report.summary.estimatedNetworkFeesSats, 241);
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
