import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { parseOperatorCommand, operatorAuthorizationSchema } from '../scripts/run-controlled-reverse.js';
import { verifyMacaroonPermissions, verifyCorePolicy, coreActionMethods, nativeActionDependencies, inspectActionMacaroon,
  probeCoreAction, inspectCoreAction, actionPathsSchema, type ActionInspection, type ActionPaths, type NativeActionIO } from '../src/operator/NativeActionCredentials.js';
import { sha256 } from '../src/operator/OperatorFiles.js';
import { readinessFixture } from './readinessFixture.js';

test('native operator CLI has no default or implicit execution, and binds all reviewed file hashes', () => {
  const dir = process.cwd(); const base = ['--run-dir', dir, '--spec-sha256', 'ab'.repeat(32)];
  assert.equal(parseOperatorCommand(['--help']).mode, 'help');
  assert.equal(parseOperatorCommand(['--review-jit-only', ...base]).mode, 'review');
  assert.equal(parseOperatorCommand(['--reconcile-only', ...base, '--jit-id', randomUUID(), '--expected-revision', '3']).mode, 'reconcile');
  for (const args of [[], ['--execute-jit', ...base], ['--pay', ...base], ['--review-jit-only', ...base, '--execute-jit'],
    ['--review-jit-only', ...base, '--spec-sha256', 'ab'.repeat(32)], ['--reconcile-only', ...base, '--jit-id', randomUUID(), '--expected-revision', '-1']])
    assert.throws(() => parseOperatorCommand(args));
  const auth = { specSha256: 'ab'.repeat(32), actionConfigSha256: 'cd'.repeat(32), backupConfigSha256: 'ef'.repeat(32),
    authorization: { id: randomUUID(), termsDigest: '12'.repeat(32), scope: 'isolated-regtest-one-requote-and-execute', issuedAt: 1,
      startBefore: 300001, maxBlocks: 2, quoteLifetimeMs: 120000, executionWindowMs: 90000 } };
  operatorAuthorizationSchema.parse(auth);
  assert.throws(() => operatorAuthorizationSchema.parse({ ...auth, enableLiveSwaps: true }));
  assert.throws(() => operatorAuthorizationSchema.parse({ ...auth, authorization: { ...auth.authorization, executionWindowMs: 90001 } }));
});

test('action macaroons require exact role permissions and reject admin, cross-role, duplicate and unknown caveats', () => {
  for (const [role, permissions] of [['pay', ['offchain:read', 'offchain:write']], ['settle', ['invoices:read', 'invoices:write']],
    ['pay', ['uri:/routerrpc.Router/SendPaymentV2']], ['settle', ['uri:/invoicesrpc.Invoices/SettleInvoice']]] as const)
    assert.equal(verifyMacaroonPermissions({ permissions: [...permissions], caveats: null }, role).role, role);
  for (const raw of [{ permissions: ['offchain:read'] }, { permissions: ['offchain:read', 'offchain:write', 'onchain:write'] },
    { permissions: ['invoices:read', 'invoices:write'] }, { permissions: ['offchain:read', 'offchain:write', 'offchain:write'] },
    { permissions: ['offchain:read', 'offchain:write'], caveats: ['unsupported'] }])
    assert.throws(() => verifyMacaroonPermissions(raw, 'pay'));
});

test('Core whitelist proof is bound to the active regtest process and exact methods with no cookie fallback', () => {
  const username = 'controlled_reverse'; const config = '/home/lab/.bitcoin/bitcoin.conf';
  const policy = `rpcwhitelistdefault=1\nrpcauth=${username}:synthetic-not-a-secret\n[regtest]\nrpcwhitelist=${username}:${coreActionMethods.join(',')}\n`;
  const argv = ['/usr/local/bin/bitcoind', '-regtest', '-conf=' + config];
  assert.equal(verifyCorePolicy(policy, username, config, argv).dedicatedUser, true);
  assert.equal(verifyCorePolicy(policy.replace('rpcwhitelistdefault=1', 'rpcwhitelistdefault=0'), username, config, argv).dedicatedUser, true);
  for (const invalid of [policy.replace('rpcwhitelistdefault=1', 'rpcwhitelistdefault=2'), policy + 'includeconf=elsewhere\n',
    policy.replace('testmempoolaccept', 'sendtoaddress'), policy.replace('walletprocesspsbt,', ''),
    policy + `rpcwhitelist=${username}:${coreActionMethods.join(',')}\n`])
    assert.throws(() => verifyCorePolicy(invalid, username, config, argv));
  for (const args of [argv.slice(0, 1), [...argv, '-rpcwhitelistdefault=0'], [...argv, '-rpcauth=override'],
    ['/usr/local/bin/bitcoind', '-regtest', '-conf=/other/bitcoin.conf']])
    assert.throws(() => verifyCorePolicy(policy, username, config, args));
  assert.throws(() => verifyCorePolicy(policy, '__cookie__', config, argv));
});

async function transportFixture() {
  const x = await readinessFixture(); const directory = await mkdtemp(join(x.f.directory, 'credentials-'));
  const files = { auth: Buffer.from('controlled_reverse:synthetic-password'), settle: Buffer.from('synthetic-invoice-token'),
    pay: Buffer.from('synthetic-router-token'), cert: Buffer.from('synthetic-ca') };
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(directory, name), bytes, { mode: 0o600, flag: 'wx' });
  const paths: ActionPaths = { bitcoinActionAuthPath: join(directory, 'auth'), bitcoinConfigPath: join(directory, 'config'),
    bitcoinPidPath: join(directory, 'pid'), providerSettleMacaroonPath: join(directory, 'settle'), payerSendMacaroonPath: join(directory, 'pay') };
  const inspected: ActionInspection = { core: { mode: 'dedicated-whitelist', dedicatedUser: true, methods: [...coreActionMethods], authFingerprint: sha256(files.auth), configFingerprint: 'ab'.repeat(32), pid: '123', startTicks: '100' },
    settle: { role: 'settle', permissions: ['invoices:read', 'invoices:write'], fingerprint: sha256(files.settle) },
    pay: { role: 'pay', permissions: ['offchain:read', 'offchain:write'], fingerprint: sha256(files.pay) },
    providerCertFingerprint: sha256(files.cert), payerCertFingerprint: sha256(files.cert) };
  const spec = { id: randomUUID(), isolationId: x.scope.isolationId, tipHeight: 100, providerNode: x.plan.providerNode, payerNode: x.plan.payerNode,
    routing: x.plan.routing, client: { paymentHash: x.keys.paymentHash, claimPublicKey: x.keys.claimPublicKey }, refundPublicKey: x.keys.refundPublicKey,
    claimDestination: x.plan.claimDestination, refundDestination: x.plan.refundDestination, input: { ...x.input, valueSats: 100000 } };
  const wires: Array<{ url: string; method: string; credential?: string; body?: string; tls?: boolean }> = [];
  let guardAllowed = true; let failure = false; let inspectHook = async () => {};
  const io: NativeActionIO = { inspectCore: async () => { await inspectHook(); return inspected.core; },
    fetch: (async (url: string | URL | Request, options: RequestInit) => {
      wires.push({ url: String(url), method: 'core', credential: (options.headers as Record<string, string>).authorization, body: String(options.body) });
      return new Response(JSON.stringify({ result: failure ? undefined : { psbt: 'synthetic' }, error: failure ? { message: 'must-not-echo' } : null }), { status: 200 });
    }) as typeof fetch,
    request: (url, options, callback) => {
      const req = new EventEmitter() as ClientRequest; const response = new PassThrough(); req.destroy = () => { response.destroy(); return req; };
      req.end = ((body?: string) => { wires.push({ url: String(url), method: options.method!, credential: (options.headers as Record<string, string>)['Grpc-Metadata-macaroon'],
        body, tls: options.rejectUnauthorized });
      Object.assign(response, { statusCode: failure ? 500 : 200 }); callback(response as unknown as IncomingMessage);
      queueMicrotask(() => response.end('{}')); return req; }) as ClientRequest['end']; return req;
    } };
  const certs = { providerCertPath: join(directory, 'cert'), payerCertPath: join(directory, 'cert') };
  const native = () => nativeActionDependencies(spec, paths, certs, inspected, x, () => { if (!guardAllowed) throw Error('expired'); }, io);
  return { x, directory, paths, inspected, certs, spec, io, wires, files, native,
    expire: () => { guardAllowed = false; }, fail: () => { failure = true; },
    hook: (fn: typeof inspectHook) => { inspectHook = fn; }, cleanup: x.f.cleanup };
}

test('native action wiring keeps read credentials separate and uses only scoped Core, settlement and TLS payer contracts', { skip: process.platform !== 'linux' }, async () => {
  const f = await transportFixture(); try {
    const native = f.native(); await native.bitcoin.call('getblockchaininfo'); assert.equal(f.wires.length, 0);
    await native.bitcoin.call('walletcreatefundedpsbt', [[], []], true);
    assert.equal(f.wires[0]!.url, f.spec.routing.bitcoinOrigin + '/wallet/lqwd-lab');
    assert.equal(f.wires[0]!.credential, 'Basic ' + f.files.auth.toString('base64'));
    await native.provider.lookup(f.spec.client.paymentHash); assert.equal(f.wires.length, 1);
    await native.provider.settle(f.x.f.preimage); assert.equal(f.wires[1]!.credential, f.files.settle.toString('hex'));
    assert.equal(f.wires[1]!.url, f.spec.routing.providerOrigin + '/v2/invoices/settle'); assert.equal(f.wires[1]!.tls, true);
    assert.deepEqual(JSON.parse(f.wires[1]!.body!), { preimage: Buffer.from(f.x.f.preimage, 'hex').toString('base64') });
    await assert.rejects(native.paymentTransport.stream('/v2/router/send', {
      payment_request: f.x.invoiceWire.payment_request, timeout_seconds: 60, fee_limit_sat: '100', max_parts: 16,
      outgoing_chan_ids: [f.spec.routing.channelId], no_inflight_updates: false, allow_self_payment: false, amp: false, cancelable: false,
    }, () => false, new AbortController().signal, () => {})); // Mock EOF is uncertain, never payment success.
    assert.equal(f.wires[2]!.url, f.spec.routing.payerOrigin + '/v2/router/send');
    assert.equal(f.wires[2]!.credential, f.files.pay.toString('hex')); assert.equal(f.wires[2]!.tls, true);
    assert.equal(JSON.parse(f.wires[2]!.body!).cancelable, false);
    await assert.rejects(native.bitcoin.call('sendtoaddress', ['unsupported']));
    await assert.rejects(native.bitcoin.call('walletprocesspsbt', [], false)); assert.equal(f.wires.length, 3);
  } finally { await f.cleanup(); }
});

test('native action expiry, replaced credentials, RPC errors and changed scope never trigger retries', { skip: process.platform !== 'linux' }, async () => {
  for (const point of ['expire', 'credential', 'rpc', 'endpoint']) {
    const f = await transportFixture(); try {
      const native = f.native();
      if (point === 'expire') f.hook(async () => f.expire());
      if (point === 'credential') await writeFile(f.paths.bitcoinActionAuthPath, 'substituted');
      if (point === 'rpc') f.fail();
      if (point === 'endpoint') f.x.provider.origin = 'https://127.0.0.1:8999';
      await assert.rejects(native.bitcoin.call('walletprocesspsbt', [], true), e => !String(e).includes('must-not-echo'));
      assert.equal(f.wires.length, point === 'rpc' ? 1 : 0);
      f.expire(); await assert.rejects(native.provider.settle(f.x.f.preimage));
      assert.equal(f.wires.length, point === 'rpc' ? 1 : 0);
    } finally { await f.cleanup(); }
  }
});

test('macaroon inspection pins protected bytes before and after local decode without exposing contents', { skip: process.platform !== 'linux' }, async () => {
  const f = await transportFixture(); try {
    const result = await inspectActionMacaroon(f.paths.payerSendMacaroonPath, 'pay', async () => ({ permissions: ['offchain:read', 'offchain:write'] }));
    assert.equal(JSON.stringify(result).includes('synthetic-router-token'), false);
    await assert.rejects(inspectActionMacaroon(f.paths.payerSendMacaroonPath, 'pay', async () => {
      await writeFile(f.paths.payerSendMacaroonPath, 'replaced'); return { permissions: ['offchain:read', 'offchain:write'] };
    }));
  } finally { await f.cleanup(); }
});

test('Core credential probes are read-only and reject broad credentials, wrong identity and authentication failure', { skip: process.platform !== 'linux' }, async () => {
  for (const point of ['valid', 'broad', 'identity', 'auth']) {
    const f = await transportFixture(); try {
      const methods: string[] = []; const request = (async (_url: unknown, options: RequestInit) => {
        const method = JSON.parse(String(options.body)).method; methods.push(method);
        if (method === 'getwalletinfo') return new Response('', { status: point === 'broad' ? 200 : 403 });
        return new Response(JSON.stringify({ result: { ...f.x.chain, ...(point === 'identity' ? { chain: 'main' } : {}) } }), { status: point === 'auth' ? 401 : 200 });
      }) as typeof fetch;
      const probe = probeCoreAction(f.spec, f.paths, f.inspected, f.x.bitcoin, request);
      if (point === 'valid') assert.equal((await probe).unlistedReadDenied, true); else await assert.rejects(probe);
      assert.ok(methods.every(m => ['getblockchaininfo', 'getwalletinfo'].includes(m)));
    } finally { await f.cleanup(); }
  }
});

test('explicit local regtest cookie profile pins the existing cookie and proves the wallet without requiring a Core restart', { skip: process.platform !== 'linux' }, async () => {
  const f = await transportFixture(); try {
    const paths = actionPathsSchema.parse({ coreMode: 'existing-regtest-cookie', bitcoinActionAuthPath: f.paths.bitcoinActionAuthPath,
      providerSettleMacaroonPath: f.paths.providerSettleMacaroonPath, payerSendMacaroonPath: f.paths.payerSendMacaroonPath });
    await assert.rejects(inspectCoreAction(paths)); // A named RPC user's secret cannot be relabeled as a cookie.
    await writeFile(paths.bitcoinActionAuthPath, '__cookie__:aabbccddeeff');
    const core = await inspectCoreAction(paths); assert.equal(core.mode, 'existing-regtest-cookie'); assert.equal(core.dedicatedUser, false);
    const methods: string[] = [];
    const probe = await probeCoreAction(f.spec, paths, { ...f.inspected, core }, f.x.bitcoin, (async (_url, options) => {
      const method = JSON.parse(String(options!.body)).method; methods.push(method);
      return new Response(JSON.stringify({ result: method === 'getwalletinfo'
        ? { walletname: 'lqwd-lab', private_keys_enabled: true, scanning: false, external_signer: false } : f.x.chain }));
    }) as typeof fetch);
    assert.equal(probe.unlistedReadDenied, false); assert.deepEqual(methods, ['getblockchaininfo', 'getwalletinfo']);
    assert.equal(JSON.stringify(core).includes('aabbccddeeff'), false);
  } finally { await f.cleanup(); }
});
