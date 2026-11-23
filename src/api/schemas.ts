import { z } from 'zod';
import { states } from '../core/SwapTypes.js';
import { capabilitiesSchema, environments, railBalanceEntrySchema } from '../core/RailContract.js';
import { Password, Role, Username } from '../auth/credentials.js';

export const LoginRequest = z.object({ username: Username, password: Password }).strict();
export const SessionResponse = z.object({
  user: z.object({ id: z.uuid(), username: Username, role: Role }).strict(),
  csrfToken: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.number().int(),
}).strict();

export const QuoteRequest = z.object({ amountSats: z.number().int().min(10_000).max(1_000_000) }).strict();
export const QuoteResponse = z.object({ id: z.uuid(), amountSats: z.number().int(), serviceFeeSats: z.number().int(), invoiceSats: z.number().int(), fundingReserveSats: z.number().int(), claimFeeSats: z.number().int(), expiresAt: z.number().int() }).strict();
export const ReverseRequest = z.object({ quoteId: z.uuid(), paymentHash: z.string().regex(/^[0-9a-f]{64}$/), claimPublicKey: z.string().regex(/^(02|03)[0-9a-f]{64}$/) }).strict();
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const ReconcileRequest = z.object({ expectedRevision: revision }).strict();
export const ReconcileResponse = z.object({ id: z.uuid(), revision, state: z.enum(states),
  next: z.enum(['FUND', 'CLAIM', 'SETTLE', 'DONE', 'MANUAL_REVIEW']) }).strict();
export const SwapResponse = z.object({ id: z.uuid(), state: z.enum(states), display: z.object({ label: z.string(), tone: z.enum(['neutral', 'pending', 'success', 'warning', 'error']), terminal: z.boolean() }), quote: QuoteResponse, paymentHash: z.string(), claimPublicKey: z.string(), refundPublicKey: z.string(), timeoutHeight: z.number().int(), address: z.string(), witnessScript: z.string(), invoice: z.string().optional(), lockupTxid: z.string().optional(), lockupVout: z.number().int().optional(), claimTxid: z.string().optional(), refundTxid: z.string().optional() }).strict();
export const ErrorResponse = z.object({ error: z.string() }).strict();
export const HealthResponse = z.object({ status: z.literal('components-only'), liveSwapsEnabled: z.literal(false), readOnly: z.literal(true), network: z.enum(environments), mode: z.enum(['simulation', 'regtest']) }).strict();
export const LiquidityResponse = z.object({ onchainSats: z.number().int().nonnegative(), incomingSats: z.number().int().nonnegative() }).strict();

const BalanceSats = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
const WalletBalance = z.object({ confirmedSats: BalanceSats, unconfirmedSats: BalanceSats }).strict();
const LightningBalance = WalletBalance.extend({ localSats: BalanceSats, remoteSats: BalanceSats });
const LiquidBaseUnits = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const LiquidBalanceSnapshotResponse = z.object({
  wallet: z.string().min(1).max(120),
  chain: z.string().min(1).max(40),
  height: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  genesisHash: z.string().regex(/^[a-f0-9]{64}$/),
  assetId: z.string().regex(/^[a-f0-9]{64}$/),
  confirmedBaseUnits: LiquidBaseUnits,
  unconfirmedBaseUnits: LiquidBaseUnits,
  spendableBaseUnits: LiquidBaseUnits,
  utxoCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  assetEvidence: z.enum(['confirmed-wallet-and-coinbase', 'not-collected']),
  feePolicyVerified: z.literal(false),
  readOnly: z.literal(true),
}).strict();
export const OperationsBalancesResponse = z.object({
  network: z.literal('regtest'),
  capturedAt: z.iso.datetime(),
  core: WalletBalance,
  provider: LightningBalance.nullable(),
  alice: LightningBalance.nullable(),
  rails: z.array(railBalanceEntrySchema),
  liquid: LiquidBalanceSnapshotResponse.optional(),
}).strict();
export const CapabilitiesResponse = capabilitiesSchema;

export const ArkRoute = z.enum(['onchain-to-ark', 'ark-to-onchain']);
export const ArkQuoteRequest = z.object({
  route: ArkRoute,
  amountSats: z.number().int().min(10_000).max(1_000_000),
}).strict();
export const ArkQuoteResponse = z.object({
  id: z.uuid(),
  network: z.literal('regtest'),
  route: ArkRoute,
  method: z.enum(['boarding', 'cooperative-offboarding']),
  amountSats: z.number().int().min(10_000).max(1_000_000),
  serviceFeeSats: z.number().int().nonnegative(),
  invoiceSats: z.number().int().nonnegative(),
  fundingReserveSats: z.number().int().nonnegative(),
  claimFeeSats: z.number().int().nonnegative(),
  netSats: z.number().int().nonnegative(),
  dustSats: z.number().int().nonnegative(),
  expiresAt: z.number().int(),
}).strict();

const Outpoint = z.string().regex(/^[a-f0-9]{64}:(0|[1-9][0-9]{0,8})$/);
const RegtestBech32Address = z.string().regex(/^bcrt1[0-9a-z]{8,90}$/);
const RegtestArkAddress = z.string().regex(/^tark1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{20,140}$/);

export const ArkBoardingRequest = z.object({
  quoteId: z.uuid(),
  route: z.literal('onchain-to-ark'),
  wallet: z.enum(['alice', 'bob']).default('alice'),
  fundingOutpoint: Outpoint,
  recipientArkAddress: RegtestArkAddress.optional(),
  amountSats: z.number().int().min(10_000).max(1_000_000),
}).strict();

export const ArkOffboardRequest = z.object({
  quoteId: z.uuid(),
  route: z.literal('ark-to-onchain'),
  vtxoOutpoint: Outpoint,
  destinationAddress: RegtestBech32Address,
  amountSats: z.number().int().min(10_000).max(1_000_000),
}).strict();

export const ArkSwapRequest = z.discriminatedUnion('route', [ArkBoardingRequest, ArkOffboardRequest]);

export const ArkSwapStatusResponse = z.object({
  id: z.uuid(),
  network: z.literal('regtest'),
  route: ArkRoute,
  method: z.enum(['boarding', 'cooperative-offboarding']),
  status: z.enum(['PREPARED', 'SUBMITTED', 'CONFIRMED', 'UNCERTAIN', 'REJECTED']),
  quote: ArkQuoteResponse,
  inputOutpoint: Outpoint,
  destination: z.string(),
  commitmentTxid: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
}).strict();

export const ArkSwapListResponse = z.object({
  network: z.literal('regtest'),
  swaps: z.array(ArkSwapStatusResponse),
}).strict();

export const ArkAdminSummaryResponse = z.object({
  totalSwaps: z.number().int().nonnegative(),
  completedSwaps: z.number().int().nonnegative(),
  pendingSwaps: z.number().int().nonnegative(),
  failedSwaps: z.number().int().nonnegative(),
  onchainSentSats: z.number().int().nonnegative(),
  onchainReceivedSats: z.number().int().nonnegative(),
  arkSentSats: z.number().int().nonnegative(),
  arkReceivedSats: z.number().int().nonnegative(),
  collectedServiceFeesSats: z.number().int().nonnegative(),
  estimatedNetworkFeesSats: z.number().int().nonnegative(),
  netOperationalRevenueSats: z.number().int().nonnegative(),
}).strict();

export const ArkAdminReportResponse = z.object({
  network: z.literal('regtest'),
  summary: ArkAdminSummaryResponse,
  swaps: z.array(ArkSwapStatusResponse),
}).strict();

const ArkWalletBalance = z.object({
  confirmedSats: BalanceSats,
  preconfirmedSats: BalanceSats,
  recoverableSats: BalanceSats,
  pendingRecoverySats: BalanceSats,
  totalSats: BalanceSats,
}).strict();

export const ArkTelemetryResponse = z.object({
  network: z.literal('regtest'),
  asset: z.literal('BTC'),
  capturedAt: z.iso.datetime(),
  operatorStatus: z.enum(['ok', 'unavailable']),
  cliConfigured: z.boolean(),
  operator: z.object({
    version: z.string(),
    signerPubkey: z.string().regex(/^(02|03)[a-f0-9]{64}$/),
    forfeitAddress: RegtestBech32Address,
    dustSats: z.number().int().nonnegative(),
    sessionDurationSeconds: z.number().int().nonnegative().nullable(),
    unilateralExitDelay: z.number().int().nonnegative().nullable(),
    boardingExitDelay: z.number().int().nonnegative().nullable(),
  }).strict().nullable(),
  wallets: z.object({
    alice: ArkWalletBalance.nullable(),
    bob: ArkWalletBalance.nullable(),
  }).strict().nullable(),
}).strict();
