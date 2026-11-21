import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { address, networks } from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { z } from 'zod';
import type { Store } from '../persistence/Store.js';
import { invoiceBudget } from '../core/SwapManager.js';

const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const hex32 = z.string().regex(/^[a-f0-9]{64}$/);
const publicKey = z.string().regex(/^(02|03)[a-f0-9]{64}$/).refine(key => ecc.isPoint(Buffer.from(key, 'hex')));
const requestSchema = z.object({ destination: z.string().min(8).max(90), amountSats: z.number().int().min(11000).max(50000),
  paymentHash: hex32, claimPublicKey: publicKey }).strict();

/** The capability is created and backed up by the guest. The service only retains its hash. */
function capabilityBytes(token: string): Buffer {
  if (!tokenPattern.test(token)) throw new Error('Invalid guest capability');
  const bytes = Buffer.from(token, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== token) throw new Error('Invalid guest capability');
  return bytes;
}
function digest(domain: string, ...parts: string[]) {
  const hash = createHash('sha256').update(domain);
  for (const part of parts) hash.update('\0').update(part);
  return hash.digest('hex');
}
function readToken(authorization: string | undefined) {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization ?? '');
  if (!match) throw new Error('Invalid guest capability');
  capabilityBytes(match[1]!); return match[1]!;
}
function validateDestination(value: string) {
  const decoded = address.fromBech32(value);
  if (decoded.prefix !== 'bcrt' || !((decoded.version === 0 && [20, 32].includes(decoded.data.length)) ||
    (decoded.version === 1 && decoded.data.length === 32))) throw new Error('Unsupported regtest destination');
  address.toOutputScript(value, networks.regtest);
  return value.toLowerCase();
}

/** Validate all guest-controlled values before any node I/O. */
export function validateGuestQuote(authorization: string | undefined, idempotencyKey: string, raw: unknown) {
  readToken(authorization);
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) throw new Error('Invalid idempotency key');
  const input = requestSchema.parse(raw); validateDestination(input.destination);
  return invoiceBudget(input.amountSats);
}

/** Admission only: no invoice, payment, signing, funding or broadcast capability. */
export class GuestAdmission {
  constructor(private readonly store: Store, private readonly clock: () => number = Date.now) {}

  private now() {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + 120000)) throw new Error('Invalid clock');
    return now;
  }

  private view(row: NonNullable<ReturnType<Store['read']>['guestAdmissions']>[string], now: number) {
    return { id: row.id, status: row.status === 'QUOTED' && now >= row.expiresAt ? 'EXPIRED' as const : row.status,
      expiresAt: row.expiresAt, ...row.terms };
  }

  async reserve(authorization: string | undefined, idempotencyKey: string, raw: unknown) {
    const token = readToken(authorization);
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) throw new Error('Invalid idempotency key');
    const input = requestSchema.parse(raw);
    const destination = validateDestination(input.destination);
    const budget = invoiceBudget(input.amountSats);
    const tokenHash = digest('guest-capability-v1', token);
    const requestKey = digest('guest-idempotency-v1', token, idempotencyKey);
    const fingerprint = digest('guest-terms-v1', JSON.stringify({ ...input, destination }));
    const now = this.now();
    return this.store.transaction(db => {
      const records = db.guestAdmissions ??= {};
      const existing = Object.values(records).find(row => row.requestKey === requestKey);
      if (existing) {
        if (existing.fingerprint !== fingerprint || existing.tokenHash !== tokenHash) throw new Error('Guest idempotency conflict');
        return this.view(existing, now);
      }
      if (Object.values(records).some(row => row.tokenHash === tokenHash)) throw new Error('Guest capability already used');
      if (Object.keys(records).length >= 1000) throw new Error('Guest admission capacity reached');
      const id = randomUUID();
      const terms = { network: 'regtest' as const, liquidity: 'UNRESERVED' as const, destination, paymentHash: input.paymentHash,
        claimPublicKey: input.claimPublicKey, ...budget };
      const row = { id, requestKey, fingerprint, tokenHash, status: 'QUOTED' as const, createdAt: now, expiresAt: now + 120000, terms };
      records[id] = row;
      return this.view(row, now);
    });
  }

  status(id: string, authorization: string | undefined) {
    const row = this.store.read().guestAdmissions?.[id];
    let provided: string;
    try { provided = digest('guest-capability-v1', readToken(authorization)); } catch { return undefined; }
    if (!row || !/^[a-f0-9]{64}$/.test(row.tokenHash)) return undefined;
    if (!timingSafeEqual(Buffer.from(row.tokenHash, 'hex'), Buffer.from(provided, 'hex'))) return undefined;
    return this.view(row, this.now());
  }
}
