import { createServer, type IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { available, assertLiquidity, type Balances } from '../liquidity/LiquidityManager.js';
import { invoiceBudget, type SwapManager } from '../core/SwapManager.js';
import { LEGACY_ECONOMICS } from '../core/Economics.js';
import { Sessions, roleDenial, sessionResponse, type AuthOptions } from '../auth/session.js';
import type { OperationsBalances } from '../operations/Balances.js';
import type { Capabilities, Environment, RailId } from '../core/RailContract.js';
import { QuoteRequest, QuoteResponse, ReverseRequest, HealthResponse, LiquidityResponse, OperationsBalancesResponse, CapabilitiesResponse, ErrorResponse, LoginRequest, SessionResponse, ArkQuoteRequest, ArkQuoteResponse, ArkSwapRequest, ArkSwapStatusResponse, ArkSwapListResponse, ArkAdminReportResponse, ArkTelemetryResponse } from './schemas.js';
import { ZodError } from 'zod';
import { readFile } from 'node:fs/promises';
import type { preflight } from '../diagnostics/preflight.js';
import type { ApplicationMode } from '../config.js';
import { createOwnedReverseGateway } from './ownedReverseGateway.js';
import { historicalSwaps, HistoricalSwapResponse } from './historicalSwaps.js';
import { ArkSwapService, toPublicArkSwap, type ArkRegtestPort } from '../ark/ArkAdapter.js';
import { GuestAdmission, validateGuestQuote } from '../guest/GuestAdmission.js';
import { GuestReverse, GuestReverseError } from '../guest/GuestReverse.js';
import { LiquidLightningRequest, liquidLightningUnavailable } from '../liquid/LightningAdmission.js';

const webAssets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ['/arkade-mark.svg', ['arkade-mark.svg', 'image/svg+xml']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
]);

async function body(req: IncomingMessage): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new SyntaxError('Expected application/json');
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > 8192) throw new SyntaxError('Body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);

export function createApi(
  manager: SwapManager,
  liquidity: () => Promise<Balances>,
  diagnostics?: () => ReturnType<typeof preflight>,
  mode: ApplicationMode = 'simulation',
  { auth: authOptions = {}, operations, history = historicalSwaps, capabilities, environment, ark: arkPort, arkStorePath, arkExecutionOwner, guestQuotes = false, guestReverse }: {
    auth?: AuthOptions;
    operations?: () => Promise<OperationsBalances>;
    history?: () => unknown | Promise<unknown>;
    capabilities?: () => Capabilities;
    environment?: Environment;
    ark?: ArkRegtestPort;
    arkStorePath?: string;
    arkExecutionOwner?: string;
    guestQuotes?: boolean;
    guestReverse?: GuestReverse;
  } = {},
) {
  const auth = new Sessions(authOptions, mode);
  const fallbackCapabilities = (): Capabilities => {
    const unavailable = (id: RailId) => ({ id, configured: false, verified: false, available: false, reason: 'NOT_CONFIGURED' as const });
    return { schemaVersion: 1, environment: mode === 'regtest' ? 'regtest' : 'simulation',
      chain: { kind: 'bitcoin', name: mode === 'regtest' ? 'regtest' : 'simulation', genesisHash: null }, readOnly: true,
      execution: { enabled: false, policy: 'disabled', reason: 'DISABLED' },
      rails: { onchain: unavailable('onchain'), lightning: unavailable('lightning'), ark: unavailable('ark'), liquid: unavailable('liquid') },
      capturedAt: new Date().toISOString() };
  };
  const arkService = new ArkSwapService(arkPort, arkStorePath);
  const arkProfile = mode === 'regtest' || environment === 'ark-regtest';
  if ((guestQuotes || guestReverse) && mode !== 'regtest') throw new Error('Guest quote admission requires regtest');
  const guests = guestQuotes || guestReverse ? (guestReverse?.admission ?? new GuestAdmission(manager.store)) : undefined;
  const guestAttempts = new Map<string, { until: number; count: number }>();
  const controlled = createOwnedReverseGateway(auth, { enabled: mode === 'regtest', delegateWhenInactive: true });
  const server = createServer(async (req, res) => {
    const send = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
    const noContent = () => { res.writeHead(204, { 'cache-control': 'no-store' }); res.end(); };
    const deny = (status: 401 | 403) => send(status, { error: status === 401 ? 'AUTH_REQUIRED' : 'FORBIDDEN' });
    try {
      if (await controlled.handle(req, res)) return;
      const url = new URL(req.url ?? '/', 'http://localhost'); const path = url.pathname;
      if (req.method === 'GET' && path === '/v1/guest/availability') {
        if (url.search) return send(403, { error: 'FORBIDDEN' });
        return send(200, { network: 'regtest' as const, configured: guestReverse !== undefined,
          watching: guestReverse?.watching === true });
      }
      if (req.method === 'GET' && path === '/v1/guest/estimate') {
        if (!guestReverse?.watching) return send(503, { error: 'GUEST_SERVICE_UNAVAILABLE' });
        const amounts = url.searchParams.getAll('amountSats');
        if (url.searchParams.size !== 1 || !/^\d{5}$/.test(amounts[0] ?? ''))
          return send(400, { error: 'INVALID_REQUEST' });
        const amount = Number(amounts[0]);
        const policy = LEGACY_ECONOMICS.invoice;
        if (amount < policy.minSats || amount > policy.maxSats) return send(400, { error: 'INVALID_REQUEST' });
        return send(200, QuoteResponse.parse({ id: randomUUID(), ...invoiceBudget(amount), expiresAt: Date.now() + policy.ttlMs }));
      }
      if (path === '/v1/guest/quotes' || path.startsWith('/v1/guest/quotes/')) {
        if (!guests && !guestReverse) return send(503, { error: 'GUEST_QUOTES_NOT_CONFIGURED' });
        if (url.search || (req.headers.origin !== undefined && !auth.sameOrigin(req))) return send(403, { error: 'FORBIDDEN' });
        const guestFailure = (error: unknown) => {
          if (error instanceof GuestReverseError) return send(error.status, { error: error.code });
          const invalid = error instanceof ZodError || error instanceof SyntaxError;
          return send(invalid ? 400 : 503, { error: invalid ? 'INVALID_REQUEST' : 'GUEST_SERVICE_UNAVAILABLE' });
        };
        if (req.method === 'POST' && path === '/v1/guest/quotes') {
          if (!guests) return send(503, { error: 'GUEST_QUOTES_NOT_CONFIGURED' });
          if (!auth.sameOrigin(req)) return send(403, { error: 'FORBIDDEN' });
          const now = Date.now(); const peer = req.socket.remoteAddress ?? '';
          for (const [key, record] of guestAttempts) if (record.until <= now) guestAttempts.delete(key);
          const previous = guestAttempts.get(peer);
          if ((!previous && guestAttempts.size >= 256) || (previous && previous.count >= 10)) return send(429, { error: 'RATE_LIMITED' });
          guestAttempts.set(peer, previous ? { ...previous, count: previous.count + 1 } : { until: now + 60000, count: 1 });
          try {
            const input = await body(req);
            const key = String(req.headers['idempotency-key'] ?? '');
            const budget = validateGuestQuote(req.headers.authorization, key, input);
            try { assertLiquidity(manager.store.read(), await liquidity(), budget.amountSats, budget.invoiceSats, budget.fundingReserveSats); }
            catch { return send(503, { error: 'GUEST_LIQUIDITY_UNAVAILABLE' }); }
            return send(201, await guests.reserve(req.headers.authorization, key, input));
          }
          catch { return send(400, { error: 'GUEST_QUOTE_REJECTED' }); }
        }
        const guest = /^\/v1\/guest\/quotes\/([a-f0-9-]{36})(?:\/(prepare|claim))?$/.exec(path);
        if (!guest) return send(404, { error: 'NOT_FOUND' });
        const id = guest[1]!; const action = guest[2];
        if (req.method === 'GET' && !action) {
          if (guestReverse) {
            try { return send(200, await guestReverse.status(id, req.headers.authorization)); }
            catch (error) { return guestFailure(error); }
          }
          const result = guests!.status(id, req.headers.authorization);
          return result ? send(200, result) : send(404, { error: 'NOT_FOUND' });
        }
        if (req.method === 'POST' && action === 'prepare') {
          if (!guestReverse) return send(503, { error: 'GUEST_REVERSE_NOT_CONFIGURED' });
          if (!auth.sameOrigin(req)) return send(403, { error: 'FORBIDDEN' });
          const key = String(req.headers['idempotency-key'] ?? '');
          try { return send(201, await guestReverse.prepare(id, req.headers.authorization, key, await body(req))); }
          catch (error) { return guestFailure(error); }
        }
        if (req.method === 'POST' && action === 'claim') {
          if (!guestReverse) return send(503, { error: 'GUEST_REVERSE_NOT_CONFIGURED' });
          if (!auth.sameOrigin(req)) return send(403, { error: 'FORBIDDEN' });
          const key = String(req.headers['idempotency-key'] ?? '');
          try { return send(202, await guestReverse.submitClaim(id, req.headers.authorization, key, await body(req))); }
          catch (error) { return guestFailure(error); }
        }
        return send(404, { error: 'NOT_FOUND' });
      }
      if (req.method === 'OPTIONS') return noContent();
      const asset = webAssets.get(path);
      if (req.method === 'GET' && asset) {
        const content = await readFile(new URL(`../web/${asset[0]}`, import.meta.url));
        res.writeHead(200, { 'content-type': asset[1]!, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" });
        return res.end(content);
      }
      if (req.method === 'GET' && path === '/v1/health') return send(200, HealthResponse.parse({ status: 'components-only', liveSwapsEnabled: false, readOnly: true,
        network: environment ?? (mode === 'regtest' ? 'regtest' : 'simulation'), mode }));
      if (req.method === 'GET' && path === '/v1/capabilities') {
        if (req.url?.includes('?')) return send(404, ErrorResponse.parse({ error: 'NOT_FOUND' }));
        try { return send(200, CapabilitiesResponse.parse((capabilities ?? fallbackCapabilities)())); }
        catch { return send(503, ErrorResponse.parse({ error: 'CAPABILITIES_UNAVAILABLE' })); }
      }
      if (req.method === 'GET' && path === '/v1/preflight') {
        if (!diagnostics) return send(503, ErrorResponse.parse({ error: 'DIAGNOSTICS_NOT_CONFIGURED' }));
        const report = await diagnostics();
        return send(report.prerequisitesSatisfied ? 200 : 503, report);
      }
      if (req.method === 'POST' && path === '/v1/quotes') {
        const input = QuoteRequest.parse(await body(req));
        return send(201, QuoteResponse.parse(await manager.quoteDebit(input.amountSats)));
      }
      if (req.method === 'POST' && path === '/v1/ark/quotes') {
        const input = ArkQuoteRequest.parse(await body(req));
        return send(201, ArkQuoteResponse.parse(arkService.quote(input.route, input.amountSats)));
      }
      const session = await auth.get(req);
      if (req.method === 'POST' && path === '/v1/auth/login') {
        const failed = () => { req.resume(); return send(401, { error: 'INVALID_CREDENTIALS' }); };
        if (!auth.allowLoginAttempt(req)) return failed();
        if (session ? !auth.verifyCsrf(req, session) : req.headers.origin !== undefined && !auth.sameOrigin(req)) return failed();
        try {
          const input = LoginRequest.parse(await body(req));
          const next = await auth.login(req, input.username, input.password);
          if (!next) return failed();
          if (session) auth.revoke(session);
          res.setHeader('set-cookie', auth.cookie(next));
          return send(200, SessionResponse.parse(sessionResponse(next)));
        } catch {
          return failed();
        }
      }
      if (session && !safeMethods.has(req.method ?? '') && !auth.verifyCsrf(req, session)) {
        return send(403, { error: 'CSRF_REJECTED' });
      }
      if (req.method === 'GET' && path === '/v1/auth/session') {
        if (!session) return deny(401);
        return send(200, SessionResponse.parse(sessionResponse(session)));
      }
      if (req.method === 'POST' && path === '/v1/auth/logout') {
        if (!session) return deny(401);
        auth.revoke(session);
        res.setHeader('set-cookie', auth.cookie());
        return noContent();
      }
      if (req.method === 'GET' && path === '/v1/liquid/lightning/availability') {
        const status = roleDenial(session, 'USER');
        if (status) return deny(status);
        return send(200, liquidLightningUnavailable());
      }
      if (req.method === 'POST' && (path === '/v1/liquid/lightning/quotes' || path === '/v1/liquid/lightning/swaps')) {
        const status = roleDenial(session, 'USER');
        if (status) return deny(status);
        LiquidLightningRequest.parse(await body(req));
        if (!/^[a-zA-Z0-9_-]{8,128}$/.test(String(req.headers['idempotency-key'] ?? '')))
          return send(400, ErrorResponse.parse({ error: 'IDEMPOTENCY_KEY_REQUIRED' }));
        // No attested Liquid atomic adapter is installed. Never delegate to generic quotes,
        // create an invoice or reserve funds, including in simulation/mainnet.
        return send(503, ErrorResponse.parse({ error: liquidLightningUnavailable().reason }));
      }
      if (path === '/v1/admin' || path.startsWith('/v1/admin/')) {
        const status = roleDenial(session, 'ADMIN');
        if (status) return deny(status);
        if (req.method === 'GET' && path === '/v1/admin/swaps/historical') {
          try { return send(200, HistoricalSwapResponse.parse(await history())); }
          catch { return send(503, { error: 'HISTORICAL_EVIDENCE_UNAVAILABLE' }); }
        }
        if (req.method === 'GET' && path === '/v1/admin/ark/swaps') {
          if (!arkProfile || !arkPort) {
            return send(503, ErrorResponse.parse({ error: 'ARK_SWAPS_REGTEST_ADAPTER_NOT_CONFIGURED' }));
          }
          return send(200, ArkAdminReportResponse.parse(arkService.adminReport()));
        }
        return send(503, { error: 'SERVICE_UNAVAILABLE' });
      }
      if (req.method === 'GET' && path === '/v1/operations/balances') {
        const status = roleDenial(session, 'ADMIN');
        if (status) return deny(status);
        if (!operations) return send(503, { error: 'OPERATIONS_BALANCES_NOT_CONFIGURED' });
        try {
          return send(200, OperationsBalancesResponse.parse(await operations()));
        } catch {
          return send(503, { error: 'SERVICE_UNAVAILABLE' });
        }
      }
      if (req.method === 'GET' && path === '/v1/ark/telemetry') {
        const status = roleDenial(session, 'ADMIN');
        if (status) return deny(status);
        if (!arkProfile || !arkPort) return send(503, ErrorResponse.parse({ error: 'ARK_TELEMETRY_NOT_CONFIGURED' }));
        try {
          const telemetry = await arkPort.telemetry();
          return send(telemetry.operatorStatus === 'ok' ? 200 : 503, ArkTelemetryResponse.parse(telemetry));
        } catch {
          return send(503, ErrorResponse.parse({ error: 'ARK_TELEMETRY_UNAVAILABLE' }));
        }
      }
      if (req.method === 'GET' && path === '/v1/ark/availability') {
        const status = roleDenial(session, 'USER');
        if (status) return deny(status);
        return send(200, { executionAvailable: Boolean(arkProfile && arkPort && arkExecutionOwner &&
          session!.account.username === arkExecutionOwner) });
      }
      if (req.method === 'POST' && path === '/v1/ark/swaps') {
        const status = roleDenial(session, 'USER');
        if (status) return deny(status);
        const input = ArkSwapRequest.parse(await body(req));
        const key = String(req.headers['idempotency-key'] ?? '');
        if (!/^[a-zA-Z0-9_-]{8,128}$/.test(key)) return send(400, ErrorResponse.parse({ error: 'IDEMPOTENCY_KEY_REQUIRED' }));
        if (!arkProfile || !arkPort) {
          return send(503, ErrorResponse.parse({ error: 'ARK_SWAPS_REGTEST_ADAPTER_NOT_CONFIGURED' }));
        }
        if (!arkExecutionOwner) return send(503, ErrorResponse.parse({ error: 'ARK_EXECUTION_UNAVAILABLE' }));
        if (session!.account.username !== arkExecutionOwner) return deny(403);
        try {
          const record = await arkService.submit(session!.account.id, key, input);
          const publicRecord = toPublicArkSwap(record);
          const httpStatus = record.status === 'CONFIRMED'
            ? 201
            : record.status === 'REJECTED'
              ? 503
              : 202;
          return send(httpStatus, publicRecord);
        } catch (err) {
          const msg = err instanceof Error ? err.message : '';
          if (msg === 'IDEMPOTENCY_KEY_CONFLICT' || msg === 'ARK_QUOTE_ALREADY_CONSUMED' || msg === 'ARK_INPUT_ALREADY_RESERVED') {
            return send(409, ErrorResponse.parse({ error: msg }));
          }
          if ([
            'ARK_QUOTE_INVALID_OR_EXPIRED',
            'ARK_OUTPOINT_INVALID',
            'ARK_REGTEST_ADDRESS_REQUIRED',
            'ARK_REGTEST_OFFCHAIN_ADDRESS_REQUIRED',
            'ARK_INVALID_AMOUNT',
          ].includes(msg)) {
            return send(400, ErrorResponse.parse({ error: msg }));
          }
          return send(503, ErrorResponse.parse({ error: 'ARK_EXECUTION_UNAVAILABLE' }));
        }
      }
      if (req.method === 'GET' && path === '/v1/ark/swaps') {
        const status = roleDenial(session, 'USER');
        if (status) return deny(status);
        if (!arkProfile || !arkPort) {
          return send(503, ErrorResponse.parse({ error: 'ARK_SWAPS_REGTEST_ADAPTER_NOT_CONFIGURED' }));
        }
        return send(200, ArkSwapListResponse.parse({
          network: 'regtest',
          swaps: arkService.listSwaps(session!.account.id).map(toPublicArkSwap),
        }));
      }
      if (req.method === 'GET' && /^\/v1\/ark\/swaps\/[a-f0-9-]{36}$/.test(path)) {
        const status = roleDenial(session, 'USER');
        if (status) return deny(status);
        const id = path.split('/').at(-1)!;
        const record = arkService.getSwap(session!.account.id, id);
        if (!record) return send(404, ErrorResponse.parse({ error: 'SWAP_NOT_FOUND' }));
        return send(200, toPublicArkSwap(record));
      }
      if (req.method === 'POST' && path === '/v1/swaps/reverse') {
        const status = roleDenial(session, 'USER');
        if (status) return deny(status);
        ReverseRequest.parse(await body(req));
        if (!/^[a-zA-Z0-9_-]{8,128}$/.test(String(req.headers['idempotency-key'] ?? ''))) return send(400, ErrorResponse.parse({ error: 'IDEMPOTENCY_KEY_REQUIRED' }));
        return send(503, ErrorResponse.parse({ error: 'LIVE_SWAPS_DISABLED_OBSERVER_AND_RECOVERY_NOT_VERIFIED' }));
      }
      if (req.method === 'GET' && path === '/v1/liquidity') {
        const status = roleDenial(session, 'ADMIN');
        if (status) return deny(status);
        try { return send(200, LiquidityResponse.parse(available(manager.store.read(), await liquidity()))); }
        catch { return send(503, ErrorResponse.parse({ error: 'NODE_LIQUIDITY_UNAVAILABLE' })); }
      }
      if (req.method === 'GET' && /^\/v1\/swaps\/[a-f0-9-]{36}$/.test(path)) {
        // Persisted swaps have no owner. A session cannot prove access to any record.
        return send(404, ErrorResponse.parse({ error: 'SWAP_NOT_FOUND' }));
      }
      return send(404, ErrorResponse.parse({ error: 'NOT_FOUND' }));
    } catch (error) {
      req.resume();
      const invalid = error instanceof ZodError || error instanceof SyntaxError;
      return send(invalid ? 400 : 503, ErrorResponse.parse({ error: invalid ? 'INVALID_REQUEST' : 'SERVICE_UNAVAILABLE' }));
    }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  return Object.assign(server, { controlled });
}
