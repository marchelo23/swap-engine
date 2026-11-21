import https from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, lstat, stat } from 'node:fs/promises';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { z } from 'zod';
import type { PreparationSpec } from '../core/ReversePreparation.js';
import { HttpsLndPaymentTransport, type PaymentTransportIO } from '../lightning/LndPaymentTransport.js';
import type { ReadOnlyBitcoinClient, ReadOnlyLndClient } from '../diagnostics/ReadOnlyClients.js';
import { protectedBytes, sha256, operatorStopped } from './OperatorFiles.js';

const absolute = z.string().refine(isAbsolute);
const actionBase = { bitcoinActionAuthPath: absolute, providerSettleMacaroonPath: absolute, payerSendMacaroonPath: absolute };
export const actionPathsSchema = z.union([
  z.object({ ...actionBase, coreMode: z.literal('existing-regtest-cookie') }).strict(),
  z.object({ ...actionBase, coreMode: z.literal('dedicated-whitelist').optional(), bitcoinConfigPath: absolute, bitcoinPidPath: absolute }).strict(),
]);
export type ActionPaths = z.infer<typeof actionPathsSchema>;
export const coreActionMethods = ['getblockchaininfo', 'walletcreatefundedpsbt', 'walletprocesspsbt', 'finalizepsbt', 'sendrawtransaction', 'generatetoaddress', 'testmempoolaccept'] as const;
const coreWrites = new Set<string>(coreActionMethods.slice(1));
const sorted = (a: string[]) => [...a].sort().join('\n');
const roles = {
  settle: { standard: ['invoices:read', 'invoices:write'], uri: 'uri:/invoicesrpc.Invoices/SettleInvoice' },
  pay: { standard: ['offchain:read', 'offchain:write'], uri: 'uri:/routerrpc.Router/SendPaymentV2' },
};

/** Local decode only; no RPC, credential baking, mutation or raw decode output. */
export function verifyMacaroonPermissions(raw: unknown, role: keyof typeof roles) {
  const decoded = z.object({ permissions: z.array(z.string()).min(1).max(16), caveats: z.array(z.unknown()).nullish() }).parse(raw);
  if (decoded.caveats?.length || new Set(decoded.permissions).size !== decoded.permissions.length ||
    (sorted(decoded.permissions) !== sorted(roles[role].standard) && sorted(decoded.permissions) !== roles[role].uri)) throw operatorStopped();
  return { role, permissions: [...decoded.permissions] };
}
export type MacaroonDecoder = (path: string) => Promise<unknown>;
export const decodeMacaroon: MacaroonDecoder = async path => {
  try {
    const { stdout } = await promisify(execFile)('/usr/local/bin/lncli', ['printmacaroon', '--macaroon_file', path],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
    return JSON.parse(stdout) as unknown;
  } catch { throw operatorStopped(); }
};
export async function inspectActionMacaroon(path: string, role: keyof typeof roles, decode: MacaroonDecoder = decodeMacaroon) {
  const bytes = await protectedBytes(path, false);
  try {
    const fingerprint = sha256(bytes); const permissions = verifyMacaroonPermissions(await decode(path), role);
    const after = await protectedBytes(path, false);
    try { if (sha256(after) !== fingerprint) throw operatorStopped(); } finally { after.fill(0); }
    return { ...permissions, fingerprint };
  } finally { bytes.fill(0); }
}

/** Conservative supported Core config: one exact user whitelist, active global/regtest settings,
 * no includes or command-line auth overrides. Unknown arrangements require operator review.
 */
export function verifyCorePolicy(text: string, username: string, configPath: string, argv: string[]) {
  if (!/^[A-Za-z][A-Za-z0-9_-]{3,63}$/.test(username) || argv.some(a => /^-(rpcwhitelist|rpcwhitelistdefault|rpcuser|rpcpassword|rpcauth|includeconf)=/.test(a))) throw operatorStopped();
  const conf = argv.filter(a => a.startsWith('-conf=')); const data = argv.filter(a => a.startsWith('-datadir='));
  if (conf.length > 1 || data.length > 1) throw operatorStopped();
  const actual = conf[0]?.slice(6) ?? (data[0] ? join(data[0].slice(9), 'bitcoin.conf') : undefined);
  if (!actual || !isAbsolute(actual) || resolve(actual) !== resolve(configPath) || !argv.some(a => a === '-regtest' || a === '-regtest=1')) throw operatorStopped();
  let section = ''; const settings: Array<[string, string]> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) { if (!/^\[[A-Za-z0-9]+\]$/.test(line)) throw operatorStopped(); section = line.slice(1, -1); continue; }
    const split = line.indexOf('='); if (split < 1) throw operatorStopped(); const name = line.slice(0, split).trim(); const value = line.slice(split + 1).trim();
    if (name === 'includeconf') throw operatorStopped();
    if (section === '' || section === 'regtest') settings.push([name, value]);
  }
  const defaults = settings.filter(([key]) => key === 'rpcwhitelistdefault');
  const whitelists = settings.filter(([key, value]) => key === 'rpcwhitelist' && value.startsWith(username + ':'));
  // The explicit action-user whitelist applies with either global default. Do not
  // force changes to the permissions of existing Core/LND reader accounts.
  if (defaults.length !== 1 || !['0', '1'].includes(defaults[0]![1]) || whitelists.length !== 1 ||
    !settings.some(([key, value]) => key === 'rpcauth' && value.startsWith(username + ':'))) throw operatorStopped();
  const methods = whitelists[0]![1].slice(username.length + 1).split(',');
  if (methods.length !== coreActionMethods.length || sorted(methods) !== sorted([...coreActionMethods])) throw operatorStopped();
  return { dedicatedUser: true as const, methods: [...coreActionMethods] };
}

export async function inspectCoreAction(paths: ActionPaths) {
  if (process.platform !== 'linux' || !process.getuid) throw operatorStopped();
  const auth = await protectedBytes(paths.bitcoinActionAuthPath);
  try {
    const text = auth.toString('utf8').trim(); const separator = text.indexOf(':');
    if (separator < 1 || separator === text.length - 1 || /[\r\n\0]/.test(text)) throw operatorStopped();
    if (paths.coreMode === 'existing-regtest-cookie') {
      if (!/^__cookie__:[A-Za-z0-9+/=]+$/.test(text)) throw operatorStopped();
      return { mode: 'existing-regtest-cookie' as const, dedicatedUser: false as const,
        methods: [...coreActionMethods], authFingerprint: sha256(auth) };
    }
    if (!('bitcoinConfigPath' in paths)) throw operatorStopped();
    const config = await protectedBytes(paths.bitcoinConfigPath, false);
    const pidBytes = await protectedBytes(paths.bitcoinPidPath, false);
    const pid = pidBytes.toString('ascii').trim(); if (!/^[1-9][0-9]{0,9}$/.test(pid)) throw operatorStopped();
    const processPath = `/proc/${pid}`; if ((await lstat(processPath)).uid !== process.getuid()) throw operatorStopped();
    const argv = (await readFile(join(processPath, 'cmdline'), 'utf8')).split('\0').filter(Boolean);
    if (!argv[0] || !/\/bitcoind$/.test(argv[0])) throw operatorStopped();
    const processStat = await readFile(join(processPath, 'stat'), 'utf8');
    const startTicks = processStat.slice(processStat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
    const boot = /^btime ([0-9]+)$/m.exec(await readFile('/proc/stat', 'utf8'))?.[1];
    const hz = (await promisify(execFile)('/usr/bin/getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 })).stdout.trim();
    if (!startTicks || !boot || !/^[1-9][0-9]*$/.test(hz) || !/^[0-9]+$/.test(startTicks)) throw operatorStopped();
    const startedAt = Number(boot) * 1000 + Number(startTicks) * 1000 / Number(hz);
    // A new whitelist written after process startup is not evidence of active permissions.
    if (!Number.isSafeInteger(Math.floor(startedAt)) || (await stat(paths.bitcoinConfigPath)).mtimeMs >= startedAt - 1000) throw operatorStopped();
    const policy = verifyCorePolicy(config.toString('utf8'), text.slice(0, separator), paths.bitcoinConfigPath, argv);
    return { ...policy, mode: 'dedicated-whitelist' as const, authFingerprint: sha256(auth), configFingerprint: sha256(config), pid, startTicks };
  } finally { auth.fill(0); }
}

type ReadClients = { bitcoin: Pick<ReadOnlyBitcoinClient, 'origin' | 'call'>; provider: Pick<ReadOnlyLndClient, 'origin' | 'call' | 'lookup'>;
  payer: Pick<ReadOnlyLndClient, 'origin' | 'call'> };
export type ActionInspection = { core: Awaited<ReturnType<typeof inspectCoreAction>>;
  settle: Awaited<ReturnType<typeof inspectActionMacaroon>>; pay: Awaited<ReturnType<typeof inspectActionMacaroon>>;
  providerCertFingerprint: string; payerCertFingerprint: string };
export async function inspectNativeActions(paths: ActionPaths, certs: { providerCertPath: string; payerCertPath: string }): Promise<ActionInspection> {
  const core = await inspectCoreAction(paths);
  const settle = await inspectActionMacaroon(paths.providerSettleMacaroonPath, 'settle');
  const pay = await inspectActionMacaroon(paths.payerSendMacaroonPath, 'pay');
  return { core, settle, pay, providerCertFingerprint: sha256(await protectedBytes(certs.providerCertPath, false, true)),
    payerCertFingerprint: sha256(await protectedBytes(certs.payerCertPath, false, true)) };
}
async function pinned(path: string, fingerprint: string, secret = true) {
  const bytes = await protectedBytes(path, false, !secret);
  if (sha256(bytes) !== fingerprint) { bytes.fill(0); throw operatorStopped(); } return bytes;
}
/** Both probes are reads: prove authenticated regtest identity and server rejection of
 * an unlisted wallet read before giving this credential to any mutation transport.
 */
export async function probeCoreAction(spec: PreparationSpec, paths: ActionPaths, inspected: ActionInspection,
  read: ReadClients['bitcoin'], request: typeof fetch = fetch) {
  const before = z.object({ chain: z.literal('regtest'), initialblockdownload: z.literal(false), blocks: z.number().int(), bestblockhash: z.string() })
    .parse(await read.call('getblockchaininfo'));
  const auth = await pinned(paths.bitcoinActionAuthPath, inspected.core.authFingerprint);
  try {
    const headers = { authorization: `Basic ${Buffer.from(auth.toString('utf8').trim()).toString('base64')}`, 'content-type': 'application/json' };
    const allowed = await request(spec.routing.bitcoinOrigin, { method: 'POST', redirect: 'error', headers, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ jsonrpc: '1.0', id: 'read-only-scope-probe', method: 'getblockchaininfo', params: [] }) });
    if (!allowed.ok) throw operatorStopped();
    const decoded = await allowed.json() as { result?: unknown; error?: unknown };
    const found = z.object({ chain: z.literal('regtest'), initialblockdownload: z.literal(false), blocks: z.number().int(), bestblockhash: z.string() }).parse(decoded.result);
    if (decoded.error || JSON.stringify(found) !== JSON.stringify(before)) throw operatorStopped();
    const denied = await request(spec.routing.bitcoinOrigin + '/wallet/lqwd-lab', { method: 'POST', redirect: 'error', headers,
      signal: AbortSignal.timeout(15000), body: JSON.stringify({ jsonrpc: '1.0', id: 'read-only-scope-probe', method: 'getwalletinfo', params: [] }) });
    if (inspected.core.mode === 'existing-regtest-cookie') {
      if (!denied.ok) throw operatorStopped();
      const wallet = await denied.json() as { result?: unknown; error?: unknown };
      if (wallet.error) throw operatorStopped();
      z.object({ walletname: z.literal('lqwd-lab'), private_keys_enabled: z.literal(true), scanning: z.literal(false),
        external_signer: z.literal(false) }).parse(wallet.result);
      return { regtestIdentity: true as const, unlistedReadDenied: false };
    }
    await denied.body?.cancel(); if (denied.status !== 403) throw operatorStopped();
    return { regtestIdentity: true as const, unlistedReadDenied: true as const };
  } finally { auth.fill(0); }
}
export type NativeActionIO = { fetch: typeof fetch; request: PaymentTransportIO['request']; inspectCore: typeof inspectCoreAction };
/** These transports possess only the required action credential; read inspection always uses
 * separate read-only clients. Runtime durable intents and exact plan checks remain mandatory.
 */
export function nativeActionDependencies(spec: PreparationSpec, paths: ActionPaths,
  certs: { providerCertPath: string; payerCertPath: string }, inspected: ActionInspection, readers: ReadClients,
  beforeAction: () => void,
  io: NativeActionIO = { fetch, request: (url, options, callback) => https.request(url, options, callback), inspectCore: inspectCoreAction }) {
  const endpoints = () => {
    if (readers.bitcoin.origin !== spec.routing.bitcoinOrigin || readers.provider.origin !== spec.routing.providerOrigin ||
      readers.payer.origin !== spec.routing.payerOrigin) throw operatorStopped();
  }; endpoints();
  const bitcoin = { get origin() { return readers.bitcoin.origin; }, async call<T>(method: string, params: unknown[] = [], wallet = false): Promise<T> {
    endpoints(); if (!coreWrites.has(method)) return readers.bitcoin.call<T>(method, params, wallet);
    if (wallet !== ['walletcreatefundedpsbt', 'walletprocesspsbt'].includes(method)) throw operatorStopped();
    // Recheck active-process whitelist and its immutable identity before every Core action.
    const fresh = await io.inspectCore(paths);
    if (JSON.stringify(fresh) !== JSON.stringify(inspected.core)) throw operatorStopped();
    const auth = await pinned(paths.bitcoinActionAuthPath, inspected.core.authFingerprint);
    let response: Response;
    try {
      beforeAction(); endpoints();
      response = await io.fetch(`${spec.routing.bitcoinOrigin}${wallet ? '/wallet/lqwd-lab' : ''}`, { method: 'POST', redirect: 'error',
        signal: AbortSignal.timeout(15000), headers: { authorization: `Basic ${Buffer.from(auth.toString('utf8').trim()).toString('base64')}`,
          'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '1.0', id: 'controlled-reverse', method, params }) });
    } finally { auth.fill(0); }
    if (!response.ok) throw operatorStopped();
    const reader = response.body?.getReader(); if (!reader) throw operatorStopped();
    const chunks: Uint8Array[] = []; let length = 0;
    for (;;) { const next = await reader.read(); if (next.done) break; length += next.value.length;
      if (length > 2000000) { await reader.cancel(); throw operatorStopped(); } chunks.push(next.value); }
    const body = Buffer.concat(chunks).toString('utf8');
    const value = JSON.parse(body) as { result: T; error?: unknown }; if (value.error) throw operatorStopped(); return value.result;
  } };
  const credentials = async (role: 'settle' | 'pay') => {
    endpoints(); const settle = role === 'settle';
    return { ca: await pinned(settle ? certs.providerCertPath : certs.payerCertPath,
      settle ? inspected.providerCertFingerprint : inspected.payerCertFingerprint, false),
    macaroon: await pinned(settle ? paths.providerSettleMacaroonPath : paths.payerSendMacaroonPath,
      settle ? inspected.settle.fingerprint : inspected.pay.fingerprint) };
  };
  const provider = { get origin() { return readers.provider.origin; }, call: readers.provider.call.bind(readers.provider),
    lookup: readers.provider.lookup.bind(readers.provider),
    async settle(preimage: string): Promise<unknown> {
      if (!/^[a-f0-9]{64}$/.test(preimage)) throw operatorStopped(); const credential = await credentials('settle');
      beforeAction(); endpoints();
      return new Promise((resolve, reject) => {
        let request: ReturnType<NativeActionIO['request']>; let data = ''; let timer: ReturnType<typeof setTimeout>;
        const fail = () => { clearTimeout(timer); request?.destroy(); reject(operatorStopped()); };
        timer = setTimeout(fail, 15000);
        request = io.request(new URL('/v2/invoices/settle', spec.routing.providerOrigin), { method: 'POST', ca: credential.ca,
          rejectUnauthorized: true, timeout: 15000, headers: { 'Grpc-Metadata-macaroon': credential.macaroon.toString('hex'), 'content-type': 'application/json' } }, response => {
          response.setEncoding('utf8'); response.on('error', fail); response.on('aborted', fail);
          response.on('data', (chunk: string) => { data += chunk; if (Buffer.byteLength(data) > 262144) fail(); });
          response.on('end', () => { clearTimeout(timer); if (response.statusCode !== 200) return fail();
            try { resolve(JSON.parse(data)); } catch { fail(); } });
        });
        request.on('error', fail); request.on('timeout', fail);
        request.end(JSON.stringify({ preimage: Buffer.from(preimage, 'hex').toString('base64') }));
      });
    } };
  return { bitcoin, provider, payer: readers.payer,
    paymentTransport: new HttpsLndPaymentTransport(spec.routing.payerOrigin, '', '', { credentials: () => credentials('pay'), request: io.request }) };
}
