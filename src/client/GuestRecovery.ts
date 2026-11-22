import * as secp from '@noble/secp256k1';
import { address, networks } from 'bitcoinjs-lib';
import { z } from 'zod';

const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const base64urlPattern = /^[A-Za-z0-9_-]+$/;
const hex32 = z.string().regex(/^[a-f0-9]{64}$/);
const pubkey = z.string().regex(/^(02|03)[a-f0-9]{64}$/).refine(value => {
  try { secp.Point.fromHex(value); return true; } catch { return false; }
});
const amount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const secretsSchema = z.object({ version: z.literal(1), network: z.literal('regtest'),
  capabilityToken: z.string().regex(tokenPattern), quoteId: z.uuid(), destination: z.string(),
  paymentHash: hex32, claimPublicKey: pubkey, claimPrivateKey: hex32, preimage: hex32,
  amountSats: amount, invoiceSats: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  serviceFeeSats: amount, claimFeeSats: amount, fundingReserveSats: amount }).strict();
const contractSchema = z.object({ swapId: z.uuid().optional(), refundPublicKey: pubkey,
  timeoutHeight: z.number().int().min(1).max(499_999_999), htlcAddress: z.string().regex(/^bcrt1[0-9a-z]{20,}$/),
  witnessScript: z.string().regex(/^[a-f0-9]+$/) }).strict();
const bundleSchema = z.object({ ...secretsSchema.shape, ...contractSchema.shape }).strict();
const envelopeSchema = z.object({ version: z.literal(1), alg: z.literal('AES-GCM'), kdf: z.literal('PBKDF2-SHA256'),
  iterations: z.number().int().min(100_000).max(1_000_000), salt: z.string().regex(base64urlPattern),
  iv: z.string().regex(base64urlPattern), ciphertext: z.string().regex(base64urlPattern) }).strict();

export type GuestRecoveryIdentity = { capabilityToken: string; paymentHash: string; claimPublicKey: string;
  claimPrivateKey: string; preimage: string };
export type GuestRecoveryQuote = { id: string; destination: string; amountSats: number; invoiceSats: number;
  serviceFeeSats: number; claimFeeSats: number; fundingReserveSats: number };
export type GuestRecoverySecrets = z.infer<typeof secretsSchema>;
export type GuestRecoveryContract = z.infer<typeof contractSchema>;
export type GuestRecoveryBundle = z.infer<typeof bundleSchema>;
export type EncryptedGuestRecovery = z.infer<typeof envelopeSchema>;

const webcrypto = globalThis.crypto;
if (!webcrypto?.subtle || !webcrypto.getRandomValues) throw new Error('Web Crypto is required');

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length); webcrypto.getRandomValues(bytes); return bytes;
}
function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function base64ToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
  const binary = atob(padded); return Uint8Array.from(binary, char => char.charCodeAt(0));
}
function hex(bytes: Uint8Array): string { return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(''); }
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await webcrypto.subtle.digest('SHA-256', source(bytes))));
}
function bytesFromHex(value: string): Uint8Array { return Uint8Array.from(value.match(/../g) ?? [], part => Number.parseInt(part, 16)); }
function canonical(value: unknown): string { return JSON.stringify(value); }
function jsonBytes(value: unknown): Uint8Array { return new TextEncoder().encode(canonical(value)); }
function source(bytes: Uint8Array): BufferSource { return bytes as unknown as BufferSource; }

async function validateSecrets(value: GuestRecoverySecrets): Promise<GuestRecoverySecrets> {
  const parsed = secretsSchema.parse(value);
  if (!tokenPattern.test(parsed.capabilityToken)) throw new Error('Invalid capability token');
  if (base64ToBytes(parsed.capabilityToken).length !== 32) throw new Error('Invalid capability token');
  if (await sha256Hex(bytesFromHex(parsed.preimage)) !== parsed.paymentHash) throw new Error('Preimage does not match payment hash');
  if (hex(secp.getPublicKey(bytesFromHex(parsed.claimPrivateKey), true)) !== parsed.claimPublicKey)
    throw new Error('Claim key does not match public key');
  const decoded = address.fromBech32(parsed.destination);
  if (decoded.prefix !== 'bcrt' || !parsed.destination.startsWith('bcrt1')) throw new Error('Unsupported destination');
  address.toOutputScript(parsed.destination, networks.regtest);
  if (parsed.amountSats + parsed.serviceFeeSats !== parsed.invoiceSats) throw new Error('Quote amounts are inconsistent');
  return Object.freeze(parsed);
}

function secretsFromBundle(value: GuestRecoveryBundle): GuestRecoverySecrets {
  const { swapId: _swapId, refundPublicKey: _refundPublicKey, timeoutHeight: _timeoutHeight,
    htlcAddress: _htlcAddress, witnessScript: _witnessScript, ...secrets } = value;
  return secretsSchema.parse(secrets);
}

/** Generates the browser-held capability token, claim key and preimage before
 * the quote request. No provider request contains these values. */
export async function generateGuestRecoveryIdentity(): Promise<GuestRecoveryIdentity> {
  const capabilityToken = bytesToBase64Url(randomBytes(32));
  let claimPrivateKey = ''; let claimPublicKey = '';
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = hex(randomBytes(32));
    try { claimPublicKey = hex(secp.getPublicKey(bytesFromHex(candidate), true));
      claimPrivateKey = candidate; break; } catch { /* retry invalid scalar */ }
  }
  if (!claimPrivateKey) throw new Error('Unable to generate a claim key');
  const preimage = hex(randomBytes(32)); const paymentHash = await sha256Hex(bytesFromHex(preimage));
  return Object.freeze({ capabilityToken, paymentHash, claimPublicKey, claimPrivateKey, preimage });
}

/** Pre-invoice recovery material and quote terms. No HTLC/server contract field
 * is required yet, so the encrypted commitment can exist before the payable invoice. */
export async function createGuestRecoverySecrets(identity: GuestRecoveryIdentity, quote: GuestRecoveryQuote): Promise<GuestRecoverySecrets> {
  return validateSecrets({ version: 1, network: 'regtest', capabilityToken: identity.capabilityToken,
    quoteId: quote.id, destination: quote.destination.toLowerCase(), paymentHash: identity.paymentHash,
    claimPublicKey: identity.claimPublicKey, claimPrivateKey: identity.claimPrivateKey, preimage: identity.preimage,
    amountSats: quote.amountSats, invoiceSats: quote.invoiceSats, serviceFeeSats: quote.serviceFeeSats,
    claimFeeSats: quote.claimFeeSats, fundingReserveSats: quote.fundingReserveSats });
}

/** Adds the server's public contract fields after preparation, still before payment. */
export async function createGuestRecoveryBundle(secrets: GuestRecoverySecrets, contract: GuestRecoveryContract): Promise<GuestRecoveryBundle> {
  const validated = await validateSecrets(bundleSchema.pick({ version: true, network: true, capabilityToken: true,
    quoteId: true, destination: true, paymentHash: true, claimPublicKey: true, claimPrivateKey: true, preimage: true,
    amountSats: true, invoiceSats: true, serviceFeeSats: true, claimFeeSats: true, fundingReserveSats: true }).parse(secrets));
  const parsedContract = contractSchema.parse(contract);
  return Object.freeze({ ...validated, ...parsedContract });
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  if (typeof passphrase !== 'string' || passphrase.length < 8 || passphrase.length > 4096) throw new Error('Invalid recovery passphrase');
  const material = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return webcrypto.subtle.deriveKey({ name: 'PBKDF2', salt: source(salt), iterations, hash: 'SHA-256' }, material,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Encrypts either pre-invoice secrets or a full bundle with a passphrase. The
 * exported envelope contains no plaintext token, key or preimage. */
export async function encryptGuestRecovery(value: GuestRecoverySecrets | GuestRecoveryBundle, passphrase: string): Promise<EncryptedGuestRecovery> {
  const validated = 'refundPublicKey' in value ? bundleSchema.parse(value) : secretsSchema.parse(value);
  const salt = randomBytes(16); const iv = randomBytes(12); const iterations = 210_000;
  const key = await deriveKey(passphrase, salt, iterations);
  const plaintext = jsonBytes(validated);
  try {
    const ciphertext = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv: source(iv) }, key, source(plaintext)));
    return Object.freeze({ version: 1, alg: 'AES-GCM', kdf: 'PBKDF2-SHA256', iterations,
      salt: bytesToBase64Url(salt), iv: bytesToBase64Url(iv), ciphertext: bytesToBase64Url(ciphertext) });
  } finally { plaintext.fill(0); }
}

export async function decryptGuestRecovery(envelope: EncryptedGuestRecovery, passphrase: string): Promise<GuestRecoverySecrets | GuestRecoveryBundle> {
  const parsed = envelopeSchema.parse(envelope);
  const key = await deriveKey(passphrase, base64ToBytes(parsed.salt), parsed.iterations);
  let plaintext: Uint8Array;
  try { plaintext = new Uint8Array(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: source(base64ToBytes(parsed.iv)) }, key, source(base64ToBytes(parsed.ciphertext)))); }
  catch { throw new Error('Recovery decryption failed'); }
  try {
    const value = JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
    if (!value || typeof value !== 'object') throw new Error('Invalid recovery document');
    const bundle = bundleSchema.safeParse(value);
    if (bundle.success) { await validateSecrets(secretsFromBundle(bundle.data)); return Object.freeze(bundle.data); }
    const secrets = secretsSchema.parse(value); await validateSecrets(secrets); return Object.freeze(secrets);
  } finally { plaintext.fill(0); }
}

/** Stable textual export for the encrypted envelope. */
export function serializeEncryptedRecovery(envelope: EncryptedGuestRecovery): string {
  return JSON.stringify(envelopeSchema.parse(envelope)) + '\n';
}

export function parseEncryptedRecovery(text: string): EncryptedGuestRecovery {
  return Object.freeze(envelopeSchema.parse(JSON.parse(text) as unknown));
}

/** Commit only the encrypted export's hash to the provider before the invoice. */
export async function recoveryCommitment(envelope: EncryptedGuestRecovery): Promise<string> {
  return sha256Hex(jsonBytes(envelopeSchema.parse(envelope)));
}
