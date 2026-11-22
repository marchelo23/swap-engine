import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { Store } from '../persistence/Store.js';
import type { Database } from '../core/SwapTypes.js';
import type { OwnedReverseApi, OwnerSessions } from './ownedReverse.js';
import { invoiceBudget } from '../core/SwapManager.js';

export type PreparationEntry = NonNullable<Database['ownedPreparations']>[string];
/** Trusted native adapter proof: the invoice-creation harness was never invoked. */
export class PreparationRejected extends Error {}
export type PreparedRuntime = { swapId: string; api: OwnedReverseApi;
  /** Read evidence only; UNKNOWN/active financial work must never release the slot. */
  terminal(): Promise<'COMPLETED' | 'EXPIRED' | undefined>;
  /** Explicit review can authorize only the same unused invoice; never sends funds. */
  authorize(reviewId: string): Promise<void>; close(): Promise<void> };
export type PreparationFactory = { prepare(id: string, entry: PreparationEntry): Promise<PreparedRuntime>;
  restore(id: string, entry: PreparationEntry): Promise<PreparedRuntime | undefined>; history?(): Promise<PreparedRuntime[]>;
  preflight?(): Promise<unknown>; close?(): Promise<void> };
const inputSchema = z.object({ amountSats: z.number().int().min(11000).max(50000) }).strict();
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
class Rejected extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
function reject(status: number, code: string): never { throw new Rejected(status, code); }
async function json(req: IncomingMessage) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') reject(400, 'INVALID_REQUEST');
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length; if (size > 8192) reject(400, 'INVALID_REQUEST'); chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString()) as unknown;
}

/** One operator-approved regtest profile and ADMIN owner. Admission is durable before
 * custody/invoice calls. No HTTP request supplies credentials, destinations or node evidence. */
export async function createOwnedPreparation<S extends { account: { id: string; role: string; username: string } }>(
  store: Store, sessions: OwnerSessions<S>, factory: PreparationFactory,
  policy: { mode: 'regtest'; ownerId: string; ownerUsername: string; origin: string; profileDigest: string },
) {
  if (policy.mode !== 'regtest' || !z.uuid().safeParse(policy.ownerId).success ||
    !/^[a-f0-9]{64}$/.test(policy.profileDigest) || new URL(policy.origin).origin !== policy.origin ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(policy.origin).hostname)) throw new Error('PREPARATION_DISABLED');
  const runtimes = new Map<string, PreparedRuntime>(); const pending = new Map<string, Promise<void>>();
  let closing = false; let requests = 0; let drained: (() => void) | undefined;
  for (const runtime of await factory.history?.() ?? []) runtimes.set(`history-${runtime.swapId}`, runtime);
  // Restart is lookup-only. An interrupted create is never replayed, even with the same key.
  for (const [id, entry] of Object.entries(store.read().ownedPreparations ?? {})) {
    if (entry.ownerId !== policy.ownerId) throw new Error('PREPARATION_OWNER_CHANGED');
    try { const runtime = await factory.restore(id, structuredClone(entry));
      if (runtime) {
        if (entry.swapId && entry.swapId !== runtime.swapId) { await runtime.close(); throw new Error('Restored swap differs'); }
        runtimes.set(id, runtime);
      }
    }
    catch { /* Preserve the durable slot and require reconciliation, never another create. */ }
    await store.transaction(db => {
      const row = db.ownedPreparations?.[id]; if (!row || !same(row, entry)) throw new Error('Preparation changed on restore');
      if (runtimes.has(id) && ['INTENT', 'UNKNOWN'].includes(row.status)) { row.status = 'READY'; row.swapId = runtimes.get(id)!.swapId; }
      else if (row.status === 'INTENT' || (row.status === 'READY' && !runtimes.has(id))) row.status = 'UNKNOWN';
      for (const review of Object.values(row.reviews ?? {})) if (review.status === 'INTENT') review.status = 'UNKNOWN';
    });
  }
  const project = (id: string) => {
    const row = store.read().ownedPreparations?.[id]; if (!row || row.ownerId !== policy.ownerId) reject(404, 'PREPARATION_NOT_FOUND');
    return { id, status: row.status === 'INTENT' && !pending.has(id) ? 'UNKNOWN' : row.status,
      swapId: row.swapId ?? null, statusUrl: `/v1/reverse/preparations/${id}` };
  };
  const refresh = async () => {
    for (const [id, runtime] of runtimes) {
      const row = store.read().ownedPreparations?.[id];
      if (!row || ['COMPLETED', 'EXPIRED'].includes(row.status) || pending.has(id)) continue;
      const terminal = await runtime.terminal();
      if (terminal) await store.transaction(db => { if (same(db.ownedPreparations?.[id], row)) db.ownedPreparations![id]!.status = terminal; });
    }
  };
  const start = (id: string, entry: PreparationEntry) => {
    const work = Promise.resolve().then(async () => {
      let runtime: PreparedRuntime | undefined;
      try {
        runtime = await factory.prepare(id, structuredClone(entry));
        const snapshot = store.read().ownedPreparations?.[id];
        if (!same(snapshot, entry)) throw new Error('Preparation ownership changed');
        await store.transaction(db => {
          if (!same(db.ownedPreparations?.[id], entry)) throw new Error('Preparation ownership changed');
          db.ownedPreparations![id] = { ...entry, status: 'READY', swapId: runtime!.swapId };
        });
        runtimes.set(id, runtime); runtime = undefined;
      } catch (caught) {
        await runtime?.close();
        await store.transaction(db => { if (same(db.ownedPreparations?.[id], entry)) db.ownedPreparations![id]!.status = caught instanceof PreparationRejected ? 'REJECTED' : 'UNKNOWN'; });
      }
    }).finally(() => { pending.delete(id); });
    pending.set(id, work); void work.catch(() => {});
  };
  return {
    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
      const path = new URL(req.url ?? '/', policy.origin).pathname;
      if (path !== '/v1/quotes' && path !== '/v1/reverse/availability' && !path.startsWith('/v1/reverse/preparations') &&
        path !== '/v1/swaps' && !path.startsWith('/v1/swaps/')) return false;
      requests++;
      const send = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
      try {
        if (closing) reject(503, 'SERVICE_STOPPING');
        if (req.headers.origin && req.headers.origin !== policy.origin) reject(403, 'ORIGIN_FORBIDDEN');
        const session = await sessions.get(req); if (!session) reject(401, 'AUTHENTICATION_REQUIRED');
        if (session.account.id !== policy.ownerId || session.account.username !== policy.ownerUsername || session.account.role !== 'ADMIN') reject(403, 'FORBIDDEN');
        if (!['GET', 'HEAD'].includes(req.method ?? '') && !sessions.verifyCsrf(req, session)) reject(403, 'CSRF_REJECTED');
        if (req.method === 'POST' && path === '/v1/quotes') {
          const input = inputSchema.parse(await json(req));
          send(201, { id: randomUUID(), ...invoiceBudget(input.amountSats), expiresAt: Date.now() + 120000 }); return true;
        }
        if (req.method === 'GET' && path === '/v1/reverse/availability') {
          await refresh();
          const swaps = [...runtimes.values()].flatMap(r => r.api.list(policy.ownerId));
          send(200, { network: 'regtest', liveSwapsEnabled: false, controlledReverseConfigured: true, preparationAvailable: true,
            executionAvailable: swaps.some(s => s.allowedActions.includes('EXECUTE')), recoveryAvailable: true,
            preparedSwapIds: swaps.map(s => s.id), preparations: Object.keys(store.read().ownedPreparations ?? {}).map(project) }); return true;
        }
        if (req.method === 'GET' && path === '/v1/swaps') {
          send(200, { network: 'regtest', swaps: [...runtimes.values()].flatMap(r => r.api.list(policy.ownerId)) }); return true;
        }
        if (req.method === 'POST' && path === '/v1/reverse/preparations') {
          const input = inputSchema.parse(await json(req)); const key = String(req.headers['idempotency-key'] ?? '');
          if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) reject(400, 'IDEMPOTENCY_KEY_REQUIRED');
          const id = digest([policy.ownerId, key]); const fingerprint = digest({ input, profile: policy.profileDigest });
          await refresh(); let created: PreparationEntry | undefined;
          await store.transaction(db => {
            if (closing) reject(503, 'SERVICE_STOPPING');
            const existing = db.ownedPreparations?.[id];
            if (existing) { if (existing.ownerId !== policy.ownerId || existing.fingerprint !== fingerprint) reject(409, 'IDEMPOTENCY_KEY_CONFLICT'); return; }
            if (Object.values(db.ownedPreparations ?? {}).some(r => !['COMPLETED', 'EXPIRED', 'REJECTED'].includes(r.status))) reject(409, 'EXISTING_PREPARATION_REQUIRES_REVIEW');
            created = { ownerId: policy.ownerId, fingerprint, attemptId: randomUUID(), createdAt: Date.now(), status: 'INTENT', sourceAmountSats: input.amountSats };
            (db.ownedPreparations ??= {})[id] = created;
          });
          if (created) start(id, created); send(created || pending.has(id) ? 202 : 200, project(id)); return true;
        }
        const match = /^\/v1\/reverse\/preparations\/([a-f0-9]{64})(\/review)?$/.exec(path);
        if (match) {
          const id = match[1]!; project(id);
          if (req.method === 'GET' && !match[2]) { await refresh(); send(200, project(id)); return true; }
          if (req.method === 'POST' && match[2]) {
            z.object({}).strict().parse(await json(req));
            const key = String(req.headers['idempotency-key'] ?? ''); if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) reject(400, 'IDEMPOTENCY_KEY_REQUIRED');
            const reviewId = digest([id, key]); const attemptId = randomUUID(); let replay = false;
            await store.transaction(db => {
              const row = db.ownedPreparations?.[id]; if (row?.status !== 'READY' || !runtimes.has(id)) reject(409, 'RECONCILIATION_REQUIRED');
              const prior = row.reviews?.[reviewId]; if (prior) { if (prior.status !== 'READY') reject(409, 'RECONCILIATION_REQUIRED'); replay = true; return; }
              if (Object.values(row.reviews ?? {}).some(r => r.status === 'INTENT')) reject(409, 'RECONCILIATION_REQUIRED');
              (row.reviews ??= {})[reviewId] = { attemptId, status: 'INTENT' };
            });
            if (!replay) {
              const own = () => store.read().ownedPreparations?.[id]?.reviews?.[reviewId];
              try {
                await runtimes.get(id)!.authorize(reviewId);
                await store.transaction(db => { const r = db.ownedPreparations?.[id]?.reviews?.[reviewId]; if (r?.attemptId !== attemptId || r.status !== 'INTENT') throw new Error('Review conflict'); r.status = 'READY'; });
              } catch {
                if (own()?.attemptId === attemptId) await store.transaction(db => { const r = db.ownedPreparations?.[id]?.reviews?.[reviewId]; if (r?.attemptId === attemptId && r.status === 'INTENT') r.status = 'UNKNOWN'; });
                reject(409, 'RECONCILIATION_REQUIRED');
              }
            }
            send(200, project(id)); return true;
          }
          reject(404, 'NOT_FOUND');
        }
        let supplied: { value: unknown } | undefined; let id: string | undefined;
        if (req.method === 'POST' && path === '/v1/swaps/reverse') {
          supplied = { value: await json(req) }; id = z.object({ preparedSwapId: z.uuid() }).parse(supplied.value).preparedSwapId;
        } else id = /^\/v1\/swaps\/([a-f0-9-]{36})(?:\/.*)?$/.exec(path)?.[1];
        const runtime = [...runtimes.values()].find(r => r.swapId === id); if (!runtime) reject(404, 'SWAP_NOT_FOUND');
        return await runtime.api.handle(req, res, supplied);
      } catch (caught) {
        if (caught instanceof Rejected) send(caught.status, { error: caught.code });
        else if (caught instanceof z.ZodError || caught instanceof SyntaxError) send(400, { error: 'INVALID_REQUEST' });
        else send(503, { error: 'PREPARATION_UNAVAILABLE_RECONCILE_WITHOUT_RETRY' });
        return true;
      } finally {
        requests--; if (!requests) drained?.();
      }
    },
    async close() {
      closing = true; if (requests) await new Promise<void>(r => { drained = r; });
      await Promise.allSettled([...pending.values()]);
      await Promise.all([...runtimes.values()].map(r => r.close())); await factory.close?.();
    },
  };
}
export type OwnedPreparationService = Awaited<ReturnType<typeof createOwnedPreparation>>;
