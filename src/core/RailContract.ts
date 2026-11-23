import { z } from 'zod';

export const environments = ['simulation', 'regtest', 'signet', 'mainnet', 'ark-regtest', 'liquid-regtest'] as const;
export type Environment = typeof environments[number];
export const environmentSchema = z.enum(environments);

export const railIds = ['onchain', 'lightning', 'ark', 'liquid'] as const;
export type RailId = typeof railIds[number];
export const railIdSchema = z.enum(railIds);

export const railReasons = ['NOT_CONFIGURED', 'NOT_VERIFIED', 'WRONG_NETWORK', 'UNAVAILABLE', 'DISABLED'] as const;
export type RailReason = typeof railReasons[number];
export const railReasonSchema = z.enum(railReasons);

export const chainKinds = ['bitcoin', 'liquid', 'ark'] as const;
export type ChainKind = typeof chainKinds[number];
export const chainKindSchema = z.enum(chainKinds);

const sats = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
const status = z.enum(['available', 'unavailable', 'unknown']);
const onchainBalance = z.object({ confirmedSats: sats, unconfirmedSats: sats }).strict();
const lightningBalance = z.object({ localSats: sats, remoteSats: sats, capacitySats: sats }).strict();
const arkBalance = z.object({ spendableSats: sats, pendingSats: sats, recoverableSats: sats }).strict();
const liquidBalance = z.object({ assetId: z.string().regex(/^[a-f0-9]{64}$/), confirmedSats: sats, unconfirmedSats: sats }).strict();

export const railBalanceEntrySchema = z.discriminatedUnion('rail', [
  z.object({ rail: z.literal('onchain'), account: z.enum(['core', 'provider', 'alice']), status,
    reason: railReasonSchema.nullable(), balances: onchainBalance.nullable() }).strict(),
  z.object({ rail: z.literal('lightning'), account: z.enum(['provider', 'alice']), status,
    reason: railReasonSchema.nullable(), balances: lightningBalance.nullable() }).strict(),
  z.object({ rail: z.literal('ark'), account: z.string().min(1).max(40), status,
    reason: railReasonSchema.nullable(), balances: arkBalance.nullable() }).strict(),
  z.object({ rail: z.literal('liquid'), account: z.string().min(1).max(40), status,
    reason: railReasonSchema.nullable(), balances: liquidBalance.nullable() }).strict(),
]);
export type RailBalanceEntry = z.infer<typeof railBalanceEntrySchema>;

export const railAvailabilitySchema = z.object({ id: railIdSchema, configured: z.boolean(),
  verified: z.boolean(), available: z.boolean(), reason: railReasonSchema.nullable() }).strict()
  .refine(value => value.available === (value.configured && value.verified), 'rail availability requires configured and verified');
export type RailAvailability = z.infer<typeof railAvailabilitySchema>;
export const railAvailabilityMapSchema = z.object({
  onchain: railAvailabilitySchema, lightning: railAvailabilitySchema,
  ark: railAvailabilitySchema, liquid: railAvailabilitySchema,
}).strict();

export const capabilitiesSchema = z.object({
  schemaVersion: z.literal(1),
  environment: environmentSchema,
  chain: z.object({ kind: chainKindSchema, name: z.string().min(1).max(80), genesisHash: z.string().min(1).max(80).nullable() }).strict(),
  readOnly: z.literal(true),
  execution: z.object({ enabled: z.literal(false), policy: z.enum(['disabled', 'regtest-only']),
    reason: railReasonSchema.nullable() }).strict(),
  rails: railAvailabilityMapSchema,
  capturedAt: z.iso.datetime(),
}).strict();
export type Capabilities = z.infer<typeof capabilitiesSchema>;
