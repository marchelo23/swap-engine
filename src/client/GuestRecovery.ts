import { createHash } from 'node:crypto';
import { ECPairFactory } from 'ecpair';
import * as ecc from 'tiny-secp256k1';
import { address, networks } from 'bitcoinjs-lib';
import { z } from 'zod';
import { buildHtlc, sha256 } from '../bitcoin/HtlcBuilder.js';

const keys = ECPairFactory(ecc);
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const hex32 = z.string().regex(/^[a-f0-9]{64}$/);
const pubkey = z.string().regex(/^(02|03)[a-f0-9]{64}$/).refine(value => ecc.isPoint(Buffer.from(value, 'hex')));
const bundleSchema = z.object({ version: z.literal(1), network: z.literal('regtest'),
  capabilityToken: z.string().regex(tokenPattern), swapId: z.uuid().optional(),
  paymentHash: hex32, claimPublicKey: pubkey, claimPrivateKey: hex32, preimage: hex32,
  destination: z.string(), refundPublicKey: pubkey, timeoutHeight: z.number().int().min(1).max(499_999_999),
  htlcAddress: z.string().regex(/^bcrt1[0-9a-z]{20,}$/), witnessScript: z.string().regex(/^[a-f0-9]+$/) }).strict();

/** Client-only recovery material. Never upload this object; the provider
 * receives only the commitment returned by recoveryCommitment(). */
export type GuestRecoveryBundle = z.infer<typeof bundleSchema>;
export type GuestRecoveryInput = Omit<GuestRecoveryBundle, 'version' | 'network'>;

export function createGuestRecoveryBundle(input: GuestRecoveryInput): GuestRecoveryBundle {
  if (!tokenPattern.test(input.capabilityToken)) throw new Error('Invalid capability token');
  const tokenBytes = Buffer.from(input.capabilityToken, 'base64url');
  if (tokenBytes.length !== 32 || tokenBytes.toString('base64url') !== input.capabilityToken) throw new Error('Invalid capability token');
  if (input.swapId) z.uuid().parse(input.swapId);
  const preimage = hex32.parse(input.preimage); const paymentHash = hex32.parse(input.paymentHash);
  if (sha256(Buffer.from(preimage, 'hex')).toString('hex') !== paymentHash) throw new Error('Preimage does not match payment hash');
  const privateKey = hex32.parse(input.claimPrivateKey);
  const key = keys.fromPrivateKey(Buffer.from(privateKey, 'hex'), { network: networks.regtest });
  if (Buffer.from(key.publicKey).toString('hex') !== input.claimPublicKey) throw new Error('Claim key does not match public key');
  const decoded = address.fromBech32(input.destination);
  if (decoded.prefix !== 'bcrt' || !input.destination.startsWith('bcrt1')) throw new Error('Unsupported destination');
  address.toOutputScript(input.destination, networks.regtest);
  const htlc = buildHtlc({ paymentHash, claimPublicKey: input.claimPublicKey, refundPublicKey: input.refundPublicKey,
    timeoutHeight: input.timeoutHeight });
  if (htlc.address !== input.htlcAddress || htlc.witnessScript.toString('hex') !== input.witnessScript)
    throw new Error('HTLC address, witness script or timeout mismatch');
  return Object.freeze({ version: 1 as const, network: 'regtest' as const, capabilityToken: input.capabilityToken,
    ...(input.swapId ? { swapId: input.swapId } : {}), paymentHash, claimPublicKey: input.claimPublicKey,
    claimPrivateKey: privateKey, preimage, destination: input.destination, refundPublicKey: input.refundPublicKey,
    timeoutHeight: input.timeoutHeight, htlcAddress: input.htlcAddress, witnessScript: input.witnessScript });
}

/** Stable text/commitment input. Include the trailing newline consistently. */
export function serializeGuestRecoveryBundle(bundle: GuestRecoveryBundle): string {
  const parsed = bundleSchema.parse(bundle);
  return JSON.stringify(createGuestRecoveryBundle(parsed)) + '\n';
}

export function parseGuestRecoveryBundle(text: string): GuestRecoveryBundle {
  const parsed = bundleSchema.parse(JSON.parse(text) as unknown);
  return createGuestRecoveryBundle(parsed);
}

/** The only value the browser sends to the provider before payment. */
export function recoveryCommitment(bundle: GuestRecoveryBundle): string {
  return createHash('sha256').update(serializeGuestRecoveryBundle(bundle)).digest('hex');
}
