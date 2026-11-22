import * as z from 'zod/mini';
import type { ArkAdminReportResponse, ArkQuoteResponse, ArkSwapListResponse, ArkSwapStatusResponse, ArkTelemetryResponse, QuoteResponse } from '../api/schemas.js';
import { capabilitiesSchema, railBalanceEntrySchema } from '../core/RailContract.js';
import { states } from '../core/SwapTypes.js';

export type Quote = z.infer<typeof QuoteResponse>;
export type ArkQuote = z.infer<typeof ArkQuoteResponse>;
export type ArkSwapStatus = z.infer<typeof ArkSwapStatusResponse>;
export type ArkSwapList = z.infer<typeof ArkSwapListResponse>;
export type ArkAdminReport = z.infer<typeof ArkAdminReportResponse>;
export type ArkTelemetry = z.infer<typeof ArkTelemetryResponse>;
const session = z.object({
  user: z.object({ id: z.string(), username: z.string(), role: z.enum(['USER', 'ADMIN']) }),
  csrfToken: z.string().check(z.minLength(1)),
  expiresAt: z.int(),
});
export type Session = z.infer<typeof session>;

const amount = z.int().check(z.nonnegative());
const quote = z.object({
  id: z.uuid(), amountSats: amount, serviceFeeSats: amount, invoiceSats: amount,
  fundingReserveSats: amount, claimFeeSats: amount, expiresAt: z.int(),
}) satisfies z.ZodMiniType<Quote>;
const arkQuote = z.object({
  id: z.uuid(), network: z.literal('regtest'),
  route: z.enum(['onchain-to-ark', 'ark-to-onchain']),
  method: z.enum(['boarding', 'cooperative-offboarding']),
  amountSats: amount, serviceFeeSats: amount, invoiceSats: amount,
  fundingReserveSats: amount, claimFeeSats: amount, netSats: amount, dustSats: amount,
  expiresAt: z.int(),
}) satisfies z.ZodMiniType<ArkQuote>;

const arkSwapStatus = z.object({
  id: z.uuid(), network: z.literal('regtest'),
  route: z.enum(['onchain-to-ark', 'ark-to-onchain']),
  method: z.enum(['boarding', 'cooperative-offboarding']),
  status: z.enum(['PREPARED', 'SUBMITTED', 'CONFIRMED', 'UNCERTAIN', 'REJECTED']),
  quote: arkQuote,
  inputOutpoint: z.string(),
  destination: z.string(),
  commitmentTxid: z.nullable(z.string()),
  createdAt: z.int(),
  updatedAt: z.int(),
}) satisfies z.ZodMiniType<ArkSwapStatus>;

const arkSwapList = z.object({
  network: z.literal('regtest'),
  swaps: z.array(arkSwapStatus),
}) satisfies z.ZodMiniType<ArkSwapList>;

const arkAdminReport = z.object({
  network: z.literal('regtest'),
  summary: z.object({
    totalSwaps: amount,
    completedSwaps: amount,
    pendingSwaps: amount,
    failedSwaps: amount,
    onchainSentSats: amount,
    onchainReceivedSats: amount,
    arkSentSats: amount,
    arkReceivedSats: amount,
    collectedServiceFeesSats: amount,
    estimatedNetworkFeesSats: amount,
    netOperationalRevenueSats: amount,
  }),
  swaps: z.array(arkSwapStatus),
}) satisfies z.ZodMiniType<ArkAdminReport>;

const arkWalletBalance = z.nullable(z.object({
  confirmedSats: z.nullable(amount),
  preconfirmedSats: z.nullable(amount),
  recoverableSats: z.nullable(amount),
  pendingRecoverySats: z.nullable(amount),
  totalSats: z.nullable(amount),
}));
const arkTelemetry = z.object({
  network: z.literal('regtest'),
  asset: z.literal('BTC'),
  capturedAt: z.iso.datetime(),
  operatorStatus: z.enum(['ok', 'unavailable']),
  cliConfigured: z.boolean(),
  operator: z.nullable(z.object({
    version: z.string(),
    signerPubkey: z.string(),
    forfeitAddress: z.string(),
    dustSats: amount,
    sessionDurationSeconds: z.nullable(amount),
    unilateralExitDelay: z.nullable(amount),
    boardingExitDelay: z.nullable(amount),
  })),
  wallets: z.nullable(z.object({
    alice: arkWalletBalance,
    bob: arkWalletBalance,
  })),
}) satisfies z.ZodMiniType<ArkTelemetry>;

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
const operationsBalances = z.object({
  network: z.literal('regtest'),
  capturedAt: z.iso.datetime(),
  rails: z.array(railBalanceEntrySchema),
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
    credentials: options.credentials ?? 'same-origin',
  });
}

type ResponseSchema<T> = {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
};

async function parse<T>(response: Response, schema: ResponseSchema<T>) {
  const result = schema.safeParse(await response.json().catch(() => undefined));
  if (!result.success) throw new Error('The backend did not provide a valid response.');
  return result.data;
}

async function request<T>(path: string, schema: ResponseSchema<T>, options: RequestInit = {}, allowDiagnosticFailure = false) {
  const response = await fetchApi(path, options);
  if (!response.ok && !(allowDiagnosticFailure && response.status === 503)) {
    throw new ApiResponseError(response.status);
  }
  return parse(response, schema);
}

export type ArkSwapPayload =
  | {
      quoteId: string;
      route: 'onchain-to-ark';
      wallet: 'alice' | 'bob';
      fundingOutpoint: string;
      recipientArkAddress?: string;
      amountSats: number;
    }
  | {
      quoteId: string;
      route: 'ark-to-onchain';
      vtxoOutpoint: string;
      destinationAddress: string;
      amountSats: number;
    };

export const api = {
  arkAvailability: () => request('/v1/ark/availability', z.object({ executionAvailable: z.boolean() })),
  capabilities: () => request('/v1/capabilities', capabilitiesSchema, { credentials: 'omit' }),
  quote: (amountSats: number, signal: AbortSignal, csrfToken?: string) => request('/v1/quotes', quote, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}) },
    body: JSON.stringify({ amountSats }), signal,
  }),
  arkQuote: (route: 'onchain-to-ark' | 'ark-to-onchain', amountSats: number, signal: AbortSignal, csrfToken?: string) => request('/v1/ark/quotes', arkQuote, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}) },
    body: JSON.stringify({ route, amountSats }), signal,
  }),
  arkSwap: async (payload: ArkSwapPayload, key: string, csrfToken: string) => {
    const response = await fetchApi('/v1/ark/swaps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken, 'Idempotency-Key': key },
      body: JSON.stringify(payload),
    });
    if (response.status === 503) {
      const json = await response.json().catch(() => undefined);
      const parsed = arkSwapStatus.safeParse(json);
      if (parsed.success) return parsed.data;
      const err = z.object({ error: z.string() }).safeParse(json);
      throw new Error(err.success ? err.data.error : 'Ark regtest execution is unavailable.');
    }
    if (!response.ok) {
      const json = await response.json().catch(() => undefined);
      const err = z.object({ error: z.string() }).safeParse(json);
      throw new Error(err.success ? err.data.error : 'Backend unavailable. Try again.');
    }
    return parse(response, arkSwapStatus);
  },
  arkSwaps: (signal: AbortSignal) => request('/v1/ark/swaps', arkSwapList, { signal }),
  arkSwapStatus: (id: string, signal: AbortSignal) => request(`/v1/ark/swaps/${encodeURIComponent(id)}`, arkSwapStatus, { signal }),
  arkAdminReport: (signal: AbortSignal) => request('/v1/admin/ark/swaps', arkAdminReport, { signal }),
  arkTelemetry: (signal: AbortSignal) => request('/v1/ark/telemetry', arkTelemetry, { signal }, true),
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
