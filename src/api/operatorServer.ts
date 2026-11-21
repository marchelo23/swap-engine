/** Private native operator HTTP seam; never mounted by the public application. */
import { createServer, type IncomingMessage } from 'node:http';
import { buildHtlc } from '../bitcoin/HtlcBuilder.js';
import { available, type Balances } from '../liquidity/LiquidityManager.js';
import type { SwapManager } from '../core/SwapManager.js';
import { QuoteRequest, QuoteResponse, ReverseRequest, SwapResponse, HealthResponse, LiquidityResponse, ErrorResponse, ReconcileRequest, ReconcileResponse } from './schemas.js';
import { RecoveryConflict, RecoveryNotFound, type ReverseRecovery } from './reverseRecovery.js';
import { ZodError } from 'zod';
import { readFile } from 'node:fs/promises';
import type { preflight } from '../diagnostics/preflight.js';
import { describeSwapState } from '../ui/swapStatus.js';
import { timingSafeEqual } from 'node:crypto';
import type { ControlledExecution } from './controlledExecution.js';
import type { OwnedReverseApi } from './ownedReverse.js';

const webAssets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
]);

async function body(req: IncomingMessage): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new SyntaxError('Expected application/json');
  let text = '';
  for await (const chunk of req) { text += chunk.toString(); if (Buffer.byteLength(text) > 8192) throw new SyntaxError('Body too large'); }
  return JSON.parse(text);
}
export function createOperatorApi(manager: SwapManager, liquidity: () => Promise<Balances>, diagnostics?: () => ReturnType<typeof preflight>, recovery?: ReverseRecovery, execution?: ControlledExecution, owned?: Pick<OwnedReverseApi, 'handle'>) {
  let executionConsumed = false;
  const server = createServer(async (req, res) => {
    const send = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
    try {
      if (owned && await owned.handle(req, res)) return;
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (path === '/v1/reverse/availability') return send(503, { network: 'regtest', liveSwapsEnabled: false,
        controlledReverseConfigured: false, executionAvailable: false, recoveryAvailable: false, error: 'CONTROLLED_REVERSE_NOT_CONFIGURED' });
      const asset = webAssets.get(path);
      if (req.method === 'GET' && asset) {
        const content = await readFile(new URL(`../web/${asset[0]}`, import.meta.url));
        res.writeHead(200, { 'content-type': asset[1]!, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" });
        return res.end(content);
      }
      if (req.method === 'GET' && path === '/v1/health') return send(200, HealthResponse.parse({ status: 'components-only', liveSwapsEnabled: false, readOnly: true, network: 'regtest', mode: 'regtest' }));
      if (req.method === 'GET' && path === '/v1/preflight') {
        if (!diagnostics) return send(503, ErrorResponse.parse({ error: 'DIAGNOSTICS_NOT_CONFIGURED' }));
        const report = await diagnostics();
        return send(report.prerequisitesSatisfied ? 200 : 503, report);
      }
      if (req.method === 'POST' && path === '/v1/quotes') {
        const input = QuoteRequest.parse(await body(req));
        return send(201, QuoteResponse.parse(await manager.quote(input.amountSats)));
      }
      if (req.method === 'POST' && path === '/v1/swaps/reverse') {
        ReverseRequest.parse(await body(req));
        if (!/^[a-zA-Z0-9_-]{8,128}$/.test(String(req.headers['idempotency-key'] ?? ''))) return send(400, ErrorResponse.parse({ error: 'IDEMPOTENCY_KEY_REQUIRED' }));
        return send(503, ErrorResponse.parse({ error: 'LIVE_SWAPS_DISABLED_OBSERVER_AND_RECOVERY_NOT_VERIFIED' }));
      }
      if (req.method === 'POST' && /^\/v1\/swaps\/[a-f0-9-]{36}\/execute$/.test(path)) {
        const input = ReconcileRequest.parse(await body(req));
        if (!execution) return send(503, ErrorResponse.parse({ error: 'CONTROLLED_EXECUTION_NOT_CONFIGURED' }));
        const actual = Buffer.from(String(req.headers.authorization ?? '')); const expected = Buffer.from('Bearer ' + execution.token);
        if (req.headers.origin || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '') ||
          actual.length !== expected.length || !timingSafeEqual(actual, expected)) return send(403, ErrorResponse.parse({ error: 'CONTROLLED_EXECUTION_FORBIDDEN' }));
        if (path.split('/')[3] !== execution.swapId || input.expectedRevision !== execution.expectedRevision || executionConsumed)
          return send(409, ErrorResponse.parse({ error: 'CONTROLLED_EXECUTION_REQUIRES_RECONCILIATION' }));
        executionConsumed = true; // Never release/retry after an ambiguous caller or backend result.
        const result = await execution.execute();
        if (result.id !== execution.swapId || result.state !== 'COMPLETED' || !Number.isSafeInteger(result.revision) || result.revision < input.expectedRevision)
          throw new Error('Controlled execution evidence unavailable');
        return send(200, { id: result.id, state: result.state, revision: result.revision });
      }
      if (req.method === 'POST' && /^\/v1\/swaps\/[a-f0-9-]{36}\/reconcile$/.test(path)) {
        const input = ReconcileRequest.parse(await body(req));
        if (!recovery) return send(503, ErrorResponse.parse({ error: 'RECONCILIATION_NOT_CONFIGURED' }));
        return send(200, ReconcileResponse.parse(await recovery.reconcile(path.split('/')[3]!, input.expectedRevision)));
      }
      if (req.method === 'GET' && /^\/v1\/swaps\/[a-f0-9-]{36}\/revision$/.test(path)) {
        const swap = manager.get(path.split('/')[3]!);
        if (!swap) return send(404, ErrorResponse.parse({ error: 'SWAP_NOT_FOUND' }));
        return send(200, { id: swap.id, revision: swap.revision });
      }
      if (req.method === 'GET' && path === '/v1/liquidity') {
        try { return send(200, LiquidityResponse.parse(available(manager.store.read(), await liquidity()))); }
        catch { return send(503, ErrorResponse.parse({ error: 'NODE_LIQUIDITY_UNAVAILABLE' })); }
      }
      if (req.method === 'GET' && /^\/v1\/swaps\/[a-f0-9-]{36}$/.test(path)) {
        const swap = manager.get(path.split('/').at(-1)!);
        if (!swap) return send(404, ErrorResponse.parse({ error: 'SWAP_NOT_FOUND' }));
        const contract = buildHtlc(swap.contract);
        return send(200, SwapResponse.parse({ id: swap.id, state: swap.state, display: describeSwapState(swap.state), quote: swap.quote, ...swap.contract, address: contract.address, witnessScript: contract.witnessScript.toString('hex'), invoice: swap.invoice, lockupTxid: swap.lockup?.txid, lockupVout: swap.lockup?.vout, claimTxid: swap.claimTxid, refundTxid: swap.refundTxid }));
      }
      return send(404, ErrorResponse.parse({ error: 'NOT_FOUND' }));
    } catch (error) {
      if (error instanceof RecoveryConflict) return send(409, ErrorResponse.parse({ error: 'STALE_SWAP_REVISION' }));
      if (error instanceof RecoveryNotFound) return send(404, ErrorResponse.parse({ error: 'SWAP_NOT_FOUND' }));
      const invalid = error instanceof ZodError || error instanceof SyntaxError;
      return send(invalid ? 400 : 503, ErrorResponse.parse({ error: invalid ? 'INVALID_REQUEST' : 'SERVICE_UNAVAILABLE' }));
    }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  return server;
}
