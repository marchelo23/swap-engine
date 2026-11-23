import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { address, networks } from 'bitcoinjs-lib';
import { z } from 'zod';
import type { Store } from '../persistence/Store.js';
import type { Swap, Database } from '../core/SwapTypes.js';
import { states } from '../core/SwapTypes.js';
import { describeSwapState } from '../ui/swapStatus.js';
import { ReconcileResponse } from './schemas.js';
import { buildHtlc } from '../bitcoin/HtlcBuilder.js';
import { invoiceBudget } from '../core/SwapManager.js';
import { OWNED_ECONOMICS } from '../core/Economics.js';

const ownerSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const ownedExecuteRequest = z.object({ expectedRevision: revision }).strict();
export const ownedSubmitRequest = z.object({ preparedSwapId: z.uuid(), expectedRevision: revision }).strict();
const resultSchema = z.object({ id: z.uuid(), revision, state: z.enum(states) }).strict();
type Result = z.infer<typeof resultSchema>;
type RequestRecord = NonNullable<Database['ownedReverse']>['requests'][string];
type Approved = { ownerId: string; swapId: string; expectedRevision: number; termsDigest: string; expiresAt: number;
  execute(): Promise<{ id: string; state: string; revision: number }> };
export type OwnerAuthenticator = (request: IncomingMessage) => { ownerId: string; csrfVerified: boolean } | undefined | Promise<{ ownerId: string; csrfVerified: boolean } | undefined>;
/** Structural contract of the deployed auth-rbac Sessions class. Reuse the SAME instance:
 * session IDs are process-local and must never be accepted through forwarded identity headers. */
export interface OwnerSessions<S extends { account: { id: string; role: string } }> {
  get(request: IncomingMessage): Promise<S | undefined>;
  verifyCsrf(request: IncomingMessage, session: NoInfer<S>): boolean;
}
export type OwnedRecovery = { reconcile(id: string, expectedRevision: number): Promise<z.infer<typeof ReconcileResponse>> };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
class ApiError extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
function error(status: number, code: string): never { throw new ApiError(status, code); }
const active = new WeakMap<Store, Map<string, Promise<unknown>>>();

export function sessionOwnerAuthenticator<S extends { account: { id: string; role: string } }>(sessions: OwnerSessions<S>): OwnerAuthenticator {
  return async request => {
    const session = await sessions.get(request);
    if (!session || !['USER', 'ADMIN'].includes(session.account.role)) return undefined;
    return { ownerId: ownerSchema.parse(session.account.id), csrfVerified: sessions.verifyCsrf(request, session) };
  };
}

function profile(swap: Swap) {
  const q = swap.quote;
  const legacy = q.amountSats === 50000 && q.serviceFeeSats === 750 && q.invoiceSats === 50750;
  let current = false;
  try { const budget = invoiceBudget(q.invoiceSats, OWNED_ECONOMICS.invoice); current = Object.entries(budget).every(([key, value]) => q[key as keyof typeof budget] === value); } catch { /* Outside the approved profile. */ }
  if ((!legacy && !current) || q.claimFeeSats !== 500 || q.fundingReserveSats !== 1000 || !swap.invoice) error(409, 'PREPARED_SWAP_REQUIRED');
}
async function body(req: IncomingMessage) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') error(400, 'INVALID_REQUEST');
  let text = ''; for await (const part of req) { text += part.toString(); if (Buffer.byteLength(text) > 8192) error(400, 'INVALID_REQUEST'); }
  return JSON.parse(text) as unknown;
}

/** Explicit regtest gateway on the existing authenticated app. Owner binding/approval are server-side operations; HTTP
 * cannot create keys, choose inputs, supply node evidence, install an executor or resume funds.
 */
export function createOwnedReverseApi(store: Store, authenticate: OwnerAuthenticator,
  options: { origin: string; recovery?: OwnedRecovery; now?: () => number }) {
  const origin = new URL(options.origin);
  if (typeof authenticate !== 'function' || origin.origin !== options.origin || !['http:', 'https:'].includes(origin.protocol))
    throw new Error('Owned regtest API requires an explicit origin/session authenticator');
  const now = options.now ?? Date.now; const approvals = new Map<string, Approved>();
  let closing = false; let requests = 0; const drained: Array<() => void> = [];
  let running = active.get(store); if (!running) { running = new Map(); active.set(store, running); }
  const live = running;
  const owned = (ownerId: string, id: string) => {
    const db = store.read(); const owner = db.ownedReverse?.owners[id]; const swap = db.swaps[id];
    if (!owner || owner.ownerId !== ownerId || !swap || owner.paymentHash !== swap.contract.paymentHash || owner.contractDigest !== digest(swap.contract)) error(404, 'SWAP_NOT_FOUND');
    profile(swap); return { swap, owner, db };
  };
  const execution = (db: Database, id: string) => Object.entries(db.ownedReverse?.requests ?? {}).find(([, r]) => r.kind === 'EXECUTE' && r.swapId === id);
  const project = (ownerId: string, id: string) => {
    const { swap, owner, db } = owned(ownerId, id); const op = execution(db, id); const approval = approvals.get(id);
    const htlc = buildHtlc(swap.contract);
    const inProgress = !!op && live.has(op[0]);
    const executionStatus = swap.state === 'COMPLETED' ? 'COMPLETED' : inProgress ? 'RUNNING' : op ? 'RECONCILIATION_REQUIRED' : 'NOT_STARTED';
    const canExecute = !op && !!approval && approval.ownerId === ownerId && approval.expiresAt > now() &&
      swap.revision === approval.expectedRevision && swap.state === 'INVOICE_CREATED' && !swap.clientPayment && !swap.pendingAction && !swap.fundingIntent && !swap.lockup;
    return { id, revision: swap.revision, state: swap.state, display: describeSwapState(swap.state), network: 'regtest' as const,
      quote: structuredClone(swap.quote), paymentHash: swap.contract.paymentHash, invoice: swap.invoice,
      claimPublicKey: swap.contract.claimPublicKey, refundPublicKey: swap.contract.refundPublicKey,
      address: htlc.address, witnessScript: htlc.witnessScript.toString('hex'),
      claimDestination: owner.claimDestination, timeoutHeight: swap.contract.timeoutHeight,
      payment: { status: swap.clientPayment?.status ?? 'NOT_STARTED', valueSats: swap.quote.invoiceSats, feeSats: swap.clientPayment?.feeSats ?? null },
      funding: { txid: swap.lockup?.txid ?? null, vout: swap.lockup?.vout ?? null, feeSats: swap.fundingIntent?.feeSats ?? null },
      claim: { txid: swap.claimTxid ?? null, feeSats: swap.quote.claimFeeSats, netSats: swap.quote.amountSats - swap.quote.claimFeeSats },
      execution: { status: executionStatus, operationId: op?.[0] ?? null, approvedUntil: approval?.expiresAt ?? null },
      allowedActions: [...(canExecute ? ['EXECUTE'] : []), ...(options.recovery && !inProgress && (swap.clientPayment || op) ? ['RECONCILE'] : [])],
    };
  };
  const perform = async (ownerId: string, id: string, expectedRevision: number, key: string, kind: RequestRecord['kind']) => {
    owned(ownerId, id);
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) error(400, 'IDEMPOTENCY_KEY_REQUIRED');
    const requestId = digest([ownerId, key]); const fingerprint = digest({ kind, swapId: id, expectedRevision });
    const attemptId = randomUUID(); let replay: RequestRecord | undefined;
    await store.transaction(db => {
      if (closing) error(503, 'SERVICE_STOPPING');
      const existing = db.ownedReverse?.requests[requestId];
      if (existing) {
        if (existing.ownerId !== ownerId || existing.fingerprint !== fingerprint) error(409, 'IDEMPOTENCY_KEY_CONFLICT');
        replay = structuredClone(existing); return;
      }
      const { swap } = owned(ownerId, id);
      if (swap.revision !== expectedRevision) error(409, 'STALE_SWAP_REVISION');
      const previous = execution(db, id);
      if (Object.entries(db.ownedReverse?.requests ?? {}).some(([key, row]) => row.swapId === id && live.has(key))) error(409, 'OPERATION_IN_PROGRESS');
      if (kind === 'EXECUTE') {
        const approval = approvals.get(id);
        if (previous) error(409, 'EXECUTION_ALREADY_RESERVED');
        if (!approval || approval.ownerId !== ownerId || approval.expectedRevision !== expectedRevision || approval.expiresAt <= now() ||
          swap.state !== 'INVOICE_CREATED' || swap.pendingAction || swap.clientPayment || swap.fundingIntent || swap.lockup)
          error(409, 'EXECUTION_NOT_AUTHORIZED');
      } else if (!options.recovery) error(503, 'RECONCILIATION_NOT_CONFIGURED');
      else if (previous && live.has(previous[0])) error(409, 'EXECUTION_IN_PROGRESS');
      (db.ownedReverse ??= { owners: {}, requests: {} }).requests[requestId] = { ownerId, swapId: id, kind, fingerprint,
        attemptId, expectedRevision, createdAt: now(), status: 'INTENT' };
    });
    const response = (record: RequestRecord) => {
      if (record.ownerId !== ownerId || record.swapId !== id || record.fingerprint !== fingerprint) error(409, 'REQUEST_OWNERSHIP_CHANGED');
      if (record.status === 'SUCCEEDED') {
        const result = record.kind === 'EXECUTE' ? resultSchema.parse(record.result) : ReconcileResponse.parse(record.result);
        if (result.id !== id) error(409, 'REQUEST_OWNERSHIP_CHANGED');
        return { httpStatus: 200, value: { operationId: requestId, status: 'SUCCEEDED', result, statusUrl: `/v1/swaps/${id}` } };
      }
      return { httpStatus: 202, value: { operationId: requestId, status: live.has(requestId) ? 'RUNNING' : 'RECONCILIATION_REQUIRED', statusUrl: `/v1/swaps/${id}` } };
    };
    if (replay) return response(replay);
    if (closing) return response(store.read().ownedReverse!.requests[requestId]!);
    const work = Promise.resolve().then(async () => {
      try {
        const result = kind === 'EXECUTE' ? resultSchema.parse(await approvals.get(id)!.execute())
          : ReconcileResponse.parse(await options.recovery!.reconcile(id, expectedRevision));
        const current = owned(ownerId, id).swap;
        if (result.id !== id || result.revision !== current.revision || result.state !== current.state || (kind === 'EXECUTE' && result.state !== 'COMPLETED'))
          throw new Error('Result evidence changed');
        await store.transaction(db => {
          const record = db.ownedReverse?.requests[requestId];
          if (!record || record.ownerId !== ownerId || record.swapId !== id || record.kind !== kind || record.attemptId !== attemptId || record.status !== 'INTENT' || record.fingerprint !== fingerprint ||
            !same(db.swaps[id], current)) throw new Error('Request ownership changed');
          record.result = result; record.status = 'SUCCEEDED';
        });
      } catch {
        await store.transaction(db => {
          const record = db.ownedReverse?.requests[requestId];
          if (record?.ownerId === ownerId && record.swapId === id && record.kind === kind && record.attemptId === attemptId && record.status === 'INTENT' && record.fingerprint === fingerprint) record.status = 'UNKNOWN';
        });
      }
    });
    live.set(requestId, work);
    try { await work; } finally { live.delete(requestId); }
    return response(store.read().ownedReverse!.requests[requestId]!);
  };
  return {
    list(ownerId: string) {
      return Object.entries(store.read().ownedReverse?.owners ?? {}).filter(([, v]) => v.ownerId === ownerId).map(([id]) => project(ownerId, id));
    },
    /** Trusted operator/identity integration only. A browser cannot claim or reassign a swap. */
    async bind(ownerId: string, swapId: string, claimDestination: string) {
      ownerSchema.parse(ownerId); z.uuid().parse(swapId); address.toOutputScript(claimDestination, networks.regtest);
      if (!claimDestination.startsWith('bcrt1')) error(409, 'OWNER_DESTINATION_CONFLICT');
      await store.transaction(db => {
        const swap = db.swaps[swapId]; if (!swap) error(404, 'SWAP_NOT_FOUND'); profile(swap);
        if (swap.clientClaimIntent && swap.clientClaimIntent.destination !== claimDestination) error(409, 'OWNER_DESTINATION_CONFLICT');
        const binding = { ownerId, paymentHash: swap.contract.paymentHash, claimDestination, contractDigest: digest(swap.contract) };
        const prior = db.ownedReverse?.owners[swapId]; if (prior && !same(prior, binding)) error(409, 'OWNER_BINDING_CONFLICT');
        (db.ownedReverse ??= { owners: {}, requests: {} }).owners[swapId] = binding;
      });
    },
    /** Existing verified JIT executor closure, exact prepared revision and reviewed digest. */
    approve(value: Approved) {
      ownerSchema.parse(value.ownerId); hashSchema.parse(value.termsDigest); revision.parse(value.expectedRevision);
      if (!Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now() || value.expiresAt > now() + 600000 ||
        typeof value.execute !== 'function' || owned(value.ownerId, value.swapId).swap.revision !== value.expectedRevision || approvals.has(value.swapId))
        error(409, 'EXECUTION_NOT_AUTHORIZED');
      approvals.set(value.swapId, { ...value });
    },
    /** Explicit authenticated preparation review only; never called on startup/GET.
     * Refresh the same unused terms after expiry, never an admitted/uncertain execution. */
    replaceExpiredApproval(value: Approved) {
      const prior = approvals.get(value.swapId);
      if (execution(store.read(), value.swapId) || (prior && (prior.expiresAt > now() || prior.ownerId !== value.ownerId ||
        prior.termsDigest !== value.termsDigest || prior.expectedRevision !== value.expectedRevision))) error(409, 'EXECUTION_NOT_AUTHORIZED');
      if (prior) approvals.delete(value.swapId);
      try { this.approve(value); } catch (caught) { if (prior) approvals.set(value.swapId, prior); throw caught; }
    },
    revokeUnusedApproval(swapId: string) {
      if (execution(store.read(), swapId)) error(409, 'EXECUTION_ALREADY_RESERVED'); approvals.delete(swapId);
    },
    async drain() {
      closing = true;
      if (requests) await new Promise<void>(resolve => { drained.push(resolve); });
      await Promise.allSettled([...live.values()]);
    },
    async handle(req: IncomingMessage, res: ServerResponse, parsedBody?: { value: unknown }): Promise<boolean> {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (path !== '/v1/reverse/availability' && path !== '/v1/quotes' && path !== '/v1/swaps' && !path.startsWith('/v1/swaps/')) return false;
      requests++;
      const send = (status: number, value?: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store',
        ...(req.headers.origin === options.origin ? { 'access-control-allow-origin': options.origin, 'access-control-allow-credentials': 'true', vary: 'Origin' } : {}) }); res.end(value === undefined ? undefined : JSON.stringify(value)); };
      try {
        if (closing) error(503, 'SERVICE_STOPPING');
        if (req.headers.origin && req.headers.origin !== options.origin) error(403, 'ORIGIN_FORBIDDEN');
        if (req.method === 'OPTIONS') {
          if (req.headers.origin !== options.origin || !['GET', 'POST'].includes(String(req.headers['access-control-request-method'])) ||
            String(req.headers['access-control-request-headers'] ?? '').split(',').filter(Boolean).some(h => !['x-csrf-token', 'content-type', 'idempotency-key'].includes(h.trim().toLowerCase()))) error(403, 'ORIGIN_FORBIDDEN');
          res.writeHead(204, { 'access-control-allow-origin': options.origin, 'access-control-allow-methods': 'GET, POST',
            'access-control-allow-headers': 'X-CSRF-Token, Content-Type, Idempotency-Key', 'access-control-allow-credentials': 'true', vary: 'Origin', 'cache-control': 'no-store' }); res.end(); return true;
        }
        const principal = await authenticate(req);
        if (!principal || !ownerSchema.safeParse(principal.ownerId).success) error(401, 'AUTHENTICATION_REQUIRED');
        const ownerId = principal.ownerId;
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? '') && !principal.csrfVerified) error(403, 'CSRF_REJECTED');
        if (req.method === 'GET' && path === '/v1/reverse/availability') {
          const swaps = Object.entries(store.read().ownedReverse?.owners ?? {}).filter(([, v]) => v.ownerId === ownerId).map(([id]) => project(ownerId, id));
          send(200, { network: 'regtest', liveSwapsEnabled: false, controlledReverseConfigured: true,
            executionAvailable: swaps.some(s => s.allowedActions.includes('EXECUTE')),
            recoveryAvailable: !!options.recovery, preparedSwapIds: swaps.map(s => s.id) }); return true;
        }
        // Generic quote creation prunes expired quotes and must not interfere with the
        // approved retained-invoice plan. The owner UI uses its prepared quote instead.
        if (path === '/v1/quotes') error(409, 'USE_PREPARED_SWAP');
        if (req.method === 'GET' && path === '/v1/swaps') { send(200, { network: 'regtest', swaps: Object.entries(store.read().ownedReverse?.owners ?? {}).filter(([, v]) => v.ownerId === ownerId).map(([id]) => project(ownerId, id)) }); return true; }
        if (req.method === 'POST' && path === '/v1/swaps/reverse') {
          const input = ownedSubmitRequest.parse(parsedBody ? parsedBody.value : await body(req));
          const result = await perform(ownerId, input.preparedSwapId, input.expectedRevision, String(req.headers['idempotency-key'] ?? ''), 'EXECUTE'); send(result.httpStatus, result.value); return true;
        }
        const match = /^\/v1\/swaps\/([a-f0-9-]{36})(?:\/(revision|execute|reconcile))?$/.exec(path);
        if (!match || !z.uuid().safeParse(match[1]).success) error(404, 'NOT_FOUND');
        const id = match[1]!; owned(ownerId, id);
        if (req.method === 'GET' && !match[2]) { send(200, project(ownerId, id)); return true; }
        if (req.method === 'GET' && match[2] === 'revision') { send(200, { id, revision: owned(ownerId, id).swap.revision }); return true; }
        if (req.method === 'POST' && ['execute', 'reconcile'].includes(match[2] ?? '')) {
          const input = ownedExecuteRequest.parse(parsedBody ? parsedBody.value : await body(req));
          const result = await perform(ownerId, id, input.expectedRevision, String(req.headers['idempotency-key'] ?? ''), match[2] === 'execute' ? 'EXECUTE' : 'RECONCILE'); send(result.httpStatus, result.value); return true;
        }
        error(404, 'NOT_FOUND');
      } catch (caught) {
        if (caught instanceof ApiError) send(caught.status, { error: caught.code });
        else if (caught instanceof z.ZodError || caught instanceof SyntaxError) send(400, { error: 'INVALID_REQUEST' });
        else send(503, { error: 'SERVICE_UNAVAILABLE' });
        return true;
      } finally {
        requests--;
        if (!requests) for (const resolve of drained.splice(0)) resolve();
      }
    },
  };
}
export type OwnedReverseApi = ReturnType<typeof createOwnedReverseApi>;
