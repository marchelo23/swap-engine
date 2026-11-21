import * as z from 'zod/mini';
import type { HealthResponse, QuoteResponse } from '../api/schemas.js';
import { states } from '../core/SwapTypes.js';

export type Quote = z.infer<typeof QuoteResponse>;
type Health = z.infer<typeof HealthResponse>;
const session = z.object({
  user: z.object({ id: z.string(), username: z.string(), role: z.enum(['USER', 'ADMIN']) }),
  csrfToken: z.string().check(z.minLength(1)),
  expiresAt: z.int(),
});
export type Session = z.infer<typeof session>;

const health = z.object({
  status: z.literal('components-only'), liveSwapsEnabled: z.literal(false),
  readOnly: z.literal(true), network: z.literal('regtest'),
  mode: z.enum(['simulation', 'regtest']),
}) satisfies z.ZodMiniType<Health>;
const amount = z.int().check(z.nonnegative());
const quote = z.object({
  id: z.uuid(), amountSats: amount, serviceFeeSats: amount, invoiceSats: amount,
  fundingReserveSats: amount, claimFeeSats: amount, expiresAt: z.int(),
}) satisfies z.ZodMiniType<Quote>;

const probe = z.enum(['ok', 'unavailable', 'invalid_response']);
const height = z.nullable(amount);
const preflight = z.object({
  network: z.literal('regtest'),
  mode: z.literal('regtest-read-only'),
  prerequisitesSatisfied: z.boolean(),
  blockers: z.array(z.string()),
  bitcoin: z.object({ rpc: probe, height, headers: height, initialBlockDownload: z.nullable(z.boolean()) }),
  lnd: z.object({ rest: probe, syncedToChain: z.nullable(z.boolean()), activeChannels: height, inactiveChannels: height }),
  tipsMatch: z.nullable(z.boolean()),
});

const nullableSats = z.nullable(amount);
const walletFields = { confirmedSats: nullableSats, unconfirmedSats: nullableSats };
const lightningBalances = z.nullable(z.object({
  ...walletFields,
  localSats: nullableSats,
  remoteSats: nullableSats,
}));
const operationsBalances = z.object({
  network: z.literal('regtest'),
  capturedAt: z.iso.datetime(),
  core: z.nullable(z.object(walletFields)),
  provider: lightningBalances,
  alice: lightningBalances,
});
export type OperationsBalances = z.infer<typeof operationsBalances>;

const preparation = z.object({ id: z.string().check(z.regex(/^[a-f0-9]{64}$/)),
  status: z.enum(['INTENT', 'READY', 'UNKNOWN', 'COMPLETED', 'EXPIRED', 'REJECTED']), swapId: z.nullable(z.uuid()), statusUrl: z.string() });
export type OwnedPreparation = z.infer<typeof preparation>;
const reverseAvailability = z.object({
  network: z.literal('regtest'), liveSwapsEnabled: z.literal(false),
  controlledReverseConfigured: z.boolean(), executionAvailable: z.boolean(),
  recoveryAvailable: z.boolean(), preparedSwapIds: z.array(z.uuid()),
  preparationAvailable: z.optional(z.boolean()), preparations: z.optional(z.array(preparation)),
});
const ownedState = z.enum(states);
const ownedSwap = z.object({
  id: z.uuid(), network: z.literal('regtest'), revision: amount, state: ownedState, quote,
  claimDestination: z.string().check(z.regex(/^bcrt1[0-9a-z]{8,90}$/)),
  payment: z.object({ status: z.enum(['NOT_STARTED', 'INTENT', 'IN_FLIGHT', 'SUCCEEDED', 'FAILED', 'UNKNOWN']), valueSats: amount, feeSats: nullableSats }),
  funding: z.object({ txid: z.nullable(z.hex().check(z.length(64))), feeSats: nullableSats }),
  claim: z.object({ txid: z.nullable(z.hex().check(z.length(64))), feeSats: amount, netSats: amount }),
  execution: z.object({
    status: z.enum(['NOT_STARTED', 'RUNNING', 'RECONCILIATION_REQUIRED', 'COMPLETED']),
    approvedUntil: z.nullable(amount),
  }),
  allowedActions: z.array(z.enum(['EXECUTE', 'RECONCILE'])),
});
const ownedList = z.object({ network: z.literal('regtest'), swaps: z.array(ownedSwap) });
const guestAvailability = z.object({ network: z.literal('regtest'), configured: z.boolean(), watching: z.boolean() });
const guestQuote = z.object({ id: z.uuid(), status: z.string(), network: z.literal('regtest'), destination: z.string(),
  paymentHash: z.string().check(z.regex(/^[a-f0-9]{64}$/)), claimPublicKey: z.string(),
  amountSats: amount, invoiceSats: amount, serviceFeeSats: amount, claimFeeSats: amount,
  fundingReserveSats: amount, expiresAt: amount });
const guestClaimIntent = z.object({ txid: z.string().check(z.regex(/^[a-f0-9]{64}$/)),
  status: z.enum(['INTENT', 'BROADCAST', 'UNKNOWN']), feeSats: amount });
const guestClaimResponse = z.object({ id: z.uuid(), status: z.string(), network: z.literal('regtest'),
  swapId: z.optional(z.nullable(z.uuid())), claimTxid: z.optional(z.nullable(z.string())),
  revision: z.optional(z.nullable(amount)), invoiceState: z.optional(z.nullable(z.string())),
  recoveryCommitment: z.optional(z.string()) });
const guestStatus = z.object({ id: z.uuid(), status: z.string(), network: z.literal('regtest'), destination: z.string(),
  paymentHash: z.string().check(z.regex(/^[a-f0-9]{64}$/)), claimPublicKey: z.string(),
  refundPublicKey: z.optional(z.string()), amountSats: amount, invoiceSats: amount, serviceFeeSats: amount,
  claimFeeSats: amount, fundingReserveSats: amount, expiresAt: amount,
  recoveryCommitment: z.optional(z.string()), swapId: z.optional(z.nullable(z.uuid())),
  invoice: z.optional(z.nullable(z.string())), invoiceExpiresAt: z.optional(z.nullable(amount)),
  invoiceState: z.optional(z.nullable(z.string())), swapState: z.optional(z.nullable(z.enum(states))),
  revision: z.optional(z.nullable(amount)), fundingTxid: z.optional(z.nullable(z.string())),
  fundingVout: z.optional(z.nullable(amount)), fundingConfirmations: z.optional(z.nullable(amount)),
  fundingValueSats: z.optional(z.nullable(amount)), lockupHex: z.optional(z.nullable(z.string())),
  claimTxid: z.optional(z.nullable(z.string())), timeoutHeight: z.optional(z.nullable(amount)),
  htlcAddress: z.optional(z.nullable(z.string())), witnessScript: z.optional(z.nullable(z.string())),
  claimIntent: z.optional(z.nullable(guestClaimIntent)) });
const operation = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('SUCCEEDED'),
    result: z.object({
      id: z.uuid(), state: ownedState, revision: amount,
      next: z.optional(z.enum(['FUND', 'CLAIM', 'SETTLE', 'DONE', 'MANUAL_REVIEW'])),
    }),
  }),
  z.object({ status: z.literal('RUNNING') }),
  z.object({ status: z.literal('RECONCILIATION_REQUIRED') }),
]);
export type ReverseAvailability = z.infer<typeof reverseAvailability>;
export type OwnedSwap = z.infer<typeof ownedSwap>;
export type OwnedOperation = z.infer<typeof operation>;
export type GuestAvailability = z.infer<typeof guestAvailability>;
export type GuestQuote = z.infer<typeof guestQuote>;
export type GuestStatus = z.infer<typeof guestStatus>;
export type GuestClaimResponse = z.infer<typeof guestClaimResponse>;

export class ApiResponseError extends Error {
  constructor(readonly status: number) { super('Backend unavailable. Try again.'); }
}

function fetchApi(path: string, options: RequestInit = {}) {
  return fetch(path, {
    ...options,
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
    cache: 'no-store',
    redirect: 'error',
    credentials: 'same-origin',
  });
}

async function parse<T>(response: Response, schema: z.ZodMiniType<T>) {
  const result = schema.safeParse(await response.json().catch(() => undefined));
  if (!result.success) throw new Error('The backend did not provide a valid response.');
  return result.data;
}

async function request<T>(path: string, schema: z.ZodMiniType<T>, options: RequestInit = {}, allowDiagnosticFailure = false) {
  const response = await fetchApi(path, options);
  if (!response.ok && !(allowDiagnosticFailure && response.status === 503)) {
    throw new ApiResponseError(response.status);
  }
  return parse(response, schema);
}

export const api = {
  health: () => request('/v1/health', health),
  quote: (amountSats: number, signal: AbortSignal, csrfToken?: string) => request('/v1/quotes', quote, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}) },
    body: JSON.stringify({ amountSats }), signal,
  }),
  guestAvailability: (signal?: AbortSignal) => request('/v1/guest/availability', guestAvailability, { signal }),
  guestQuote(identity: { capabilityToken: string; paymentHash: string; claimPublicKey: string },
    destination: string, amountSats: number, key: string) {
    return request('/v1/guest/quotes', guestQuote, { method: 'POST', headers: { 'Content-Type': 'application/json',
      Authorization: `Bearer ${identity.capabilityToken}`, 'Idempotency-Key': key },
      body: JSON.stringify({ destination, amountSats, paymentHash: identity.paymentHash, claimPublicKey: identity.claimPublicKey }) });
  },
  guestPrepare(id: string, capabilityToken: string, recoveryCommitment: string, key: string) {
    return request('/v1/guest/quotes/' + encodeURIComponent(id) + '/prepare', guestStatus, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${capabilityToken}`,
        'Idempotency-Key': key }, body: JSON.stringify({ recoveryCommitment }) });
  },
  guestStatus(id: string, capabilityToken: string, signal?: AbortSignal) {
    return request('/v1/guest/quotes/' + encodeURIComponent(id), guestStatus,
      { headers: { Authorization: `Bearer ${capabilityToken}` }, signal });
  },
  guestClaim(id: string, capabilityToken: string, signedClaimHex: string, expectedRevision: number, key: string) {
    return request('/v1/guest/quotes/' + encodeURIComponent(id) + '/claim', guestClaimResponse, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${capabilityToken}`,
        'Idempotency-Key': key }, body: JSON.stringify({ signedClaimHex, expectedRevision }) });
  },
  reverseAvailability: (signal: AbortSignal) => request('/v1/reverse/availability', reverseAvailability, { signal }),
  preparation: (id: string, signal: AbortSignal) => request('/v1/reverse/preparations/' + encodeURIComponent(id), preparation, { signal }),
  prepare(key: string, csrf: string, amountSats: number) {
    return request('/v1/reverse/preparations', preparation, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, 'Idempotency-Key': key }, body: JSON.stringify({ amountSats }) });
  },
  reviewPreparation(id: string, key: string, csrf: string) {
    return request('/v1/reverse/preparations/' + encodeURIComponent(id) + '/review', preparation, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, 'Idempotency-Key': key }, body: '{}' });
  },
  ownedSwaps: (signal: AbortSignal) => request('/v1/swaps', ownedList, { signal }),
  ownedSwap: (id: string, signal: AbortSignal) => request('/v1/swaps/' + encodeURIComponent(id), ownedSwap, { signal }),
  reverseAction(id: string, expectedRevision: number, key: string, csrfToken: string, kind: 'execute' | 'reconcile') {
    const execute = kind === 'execute';
    const path = execute ? '/v1/swaps/reverse' : '/v1/swaps/' + encodeURIComponent(id) + '/reconcile';
    const body = execute ? { preparedSwapId: id, expectedRevision } : { expectedRevision };
    return request(path, operation, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken, 'Idempotency-Key': key },
      body: JSON.stringify(body),
    });
  },
  preflight: () => request('/v1/preflight', preflight, {}, true),
  operationsBalances: (signal: AbortSignal) => request('/v1/operations/balances', operationsBalances, { signal }),
  async session() {
    const response = await fetchApi('/v1/auth/session');
    if (response.status === 401) return null;
    if (!response.ok) throw new Error('The session service is unavailable.');
    const verified = await parse(response, session);
    return verified.expiresAt > Date.now() ? verified : null;
  },
  async login(username: string, password: string) {
    const response = await fetchApi('/v1/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
    });
    if (response.status === 401) return false;
    if (!response.ok) throw new Error('Sign-in is unavailable. Try again.');
    await parse(response, session);
    return true;
  },
  async logout(csrfToken: string) {
    const response = await fetchApi('/v1/auth/logout', { method: 'POST', headers: { 'x-csrf-token': csrfToken } });
    if (response.status !== 204 && response.status !== 401) throw new Error('Sign-out could not be confirmed.');
  },
};

export function quoteTotals(quote: Quote, amount: number, now = Date.now(), sourceAmount = false) {
  const amounts = [quote.amountSats, quote.invoiceSats, quote.serviceFeeSats, quote.claimFeeSats];
  if (!amounts.every(n => Number.isSafeInteger(n) && n >= 0)
    || (sourceAmount ? quote.invoiceSats !== amount : quote.amountSats !== amount) || quote.invoiceSats !== quote.amountSats + quote.serviceFeeSats
    || quote.claimFeeSats > quote.amountSats || quote.expiresAt <= now) {
    throw new Error('The backend returned an invalid or expired estimate.');
  }
  return { received: quote.amountSats - quote.claimFeeSats, lost: quote.serviceFeeSats + quote.claimFeeSats };
}
