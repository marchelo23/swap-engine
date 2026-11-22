import { createServer, type IncomingMessage } from 'node:http';
import { available, type Balances } from '../liquidity/LiquidityManager.js';
import type { SwapManager } from '../core/SwapManager.js';
import { Sessions, roleDenial, sessionResponse, type AuthOptions } from '../auth/session.js';
import type { OperationsBalances } from '../operations/Balances.js';
import type { Capabilities, Environment, RailId } from '../core/RailContract.js';
import { QuoteRequest, QuoteResponse, ReverseRequest, HealthResponse, LiquidityResponse, OperationsBalancesResponse, CapabilitiesResponse, ErrorResponse, LoginRequest, SessionResponse } from './schemas.js';
import { ZodError } from 'zod';
import { readFile } from 'node:fs/promises';
import type { preflight } from '../diagnostics/preflight.js';
import type { ApplicationMode } from '../config.js';
import { createOwnedReverseGateway } from './ownedReverseGateway.js';
import { historicalSwaps, HistoricalSwapResponse } from './historicalSwaps.js';

const webAssets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
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
  { auth: authOptions = {}, operations, history = historicalSwaps, capabilities, environment }: {
    auth?: AuthOptions;
    operations?: () => Promise<OperationsBalances>;
    history?: () => unknown | Promise<unknown>;
    capabilities?: () => Capabilities;
    environment?: Environment;
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
  const controlled = createOwnedReverseGateway(auth, { enabled: mode === 'regtest', delegateWhenInactive: true });
  const server = createServer(async (req, res) => {
    const send = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
    const noContent = () => { res.writeHead(204, { 'cache-control': 'no-store' }); res.end(); };
    const deny = (status: 401 | 403) => send(status, { error: status === 401 ? 'AUTH_REQUIRED' : 'FORBIDDEN' });
    try {
      if (await controlled.handle(req, res)) return;
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
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
        return send(201, QuoteResponse.parse(await manager.quote(input.amountSats)));
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
      if (path === '/v1/admin' || path.startsWith('/v1/admin/')) {
        const status = roleDenial(session, 'ADMIN');
        if (status) return deny(status);
        if (req.method === 'GET' && path === '/v1/admin/swaps/historical') {
          try { return send(200, HistoricalSwapResponse.parse(await history())); }
          catch { return send(503, { error: 'HISTORICAL_EVIDENCE_UNAVAILABLE' }); }
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
