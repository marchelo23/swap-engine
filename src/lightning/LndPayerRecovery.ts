import { createHash } from 'node:crypto';
import { z } from 'zod';
import { LndClient, type Invoice } from './LndClient.js';
import type { ReverseReconcileControls } from '../core/ReverseTestRunner.js';
import type { ReversePaymentStatus } from '../core/SwapTypes.js';
import type { ReverseRouting } from '../core/ReverseTestPlan.js';
import { verifyApprovedPaymentRoutes } from './LndRouteEvidence.js';

// Unary read API in LND v0.21.6-beta lnrpc/lightning.proto and lightning.yaml.
// Reject a full page rather than guessing whether unseen history contains a duplicate.
export const recoveryPaymentLimit = 100;
export const recoveryPaymentsPath = '/v1/payments?include_incomplete=true&index_offset=0&max_payments=100&reversed=false&count_total_payments=false&omit_hops=true';
export const recoveryRoutedPaymentsPath = recoveryPaymentsPath.replace('omit_hops=true', 'omit_hops=false');
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const pubkey = z.string().regex(/^(02|03)[a-f0-9]{64}$/);
const integer = z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine(v => BigInt(v) <= 0xffffffffffffffffn);
const infoSchema = z.object({ identity_pubkey: pubkey, synced_to_chain: z.literal(true), wallet_synced: z.literal(true),
  chains: z.array(z.object({ chain: z.literal('bitcoin'), network: z.literal('regtest') })).length(1) });
const rowSchema = z.object({ payment_hash: hash, payment_index: integer });
const pageSchema = z.object({ payments: z.array(rowSchema).max(recoveryPaymentLimit),
  first_index_offset: integer, last_index_offset: integer });
const paymentSchema = z.object({ payment_hash: hash, status: z.enum(['IN_FLIGHT', 'SUCCEEDED', 'FAILED']),
  value_sat: integer, value_msat: integer, fee_sat: integer, fee_msat: integer,
  failure_reason: z.enum(['FAILURE_REASON_NONE', 'FAILURE_REASON_TIMEOUT', 'FAILURE_REASON_NO_ROUTE',
    'FAILURE_REASON_ERROR', 'FAILURE_REASON_INCORRECT_PAYMENT_DETAILS', 'FAILURE_REASON_INSUFFICIENT_BALANCE', 'FAILURE_REASON_CANCELED']) });

/** Recovery-specific allowlist: no send, settle, cancel, delete, stream, or arbitrary query. */
export class LndRecoveryClient extends LndClient {
  override call<T>(path: string, body?: unknown): Promise<T> {
    if (body !== undefined || (path !== '/v1/getinfo' && path !== recoveryPaymentsPath && path !== recoveryRoutedPaymentsPath && !/^\/v1\/invoice\/[a-f0-9]{64}$/.test(path))) {
      return Promise.reject(new Error('READ_ONLY_RECOVERY: operation disabled'));
    }
    return super.call<T>(path);
  }
  override subscribe(_hash: string, _onInvoice: (invoice: Invoice) => void, _signal: AbortSignal): Promise<void> {
    return Promise.reject(new Error('READ_ONLY_RECOVERY: streaming disabled'));
  }
}

export async function assertRecoveryNode(client: Pick<LndClient, 'call'>, expectedPublicKey: string): Promise<void> {
  try {
    pubkey.parse(expectedPublicKey);
    if (infoSchema.parse(await client.call('/v1/getinfo')).identity_pubkey !== expectedPublicKey) throw new Error();
  } catch { throw new Error('Recovery node identity or regtest readiness unverified'); }
}

/** Observes an existing payment only; returned evidence contains no preimage or raw response. */
export class LndPayerRecovery implements ReverseReconcileControls {
  constructor(private readonly client: Pick<LndClient, 'call'>, private readonly expectedPublicKey: string,
    private readonly approvedRoute?: (hash: string) => { routing: ReverseRouting; providerNode: string } | undefined) {
    pubkey.parse(expectedPublicKey);
  }
  async lookupPayment(paymentHash: string): Promise<ReversePaymentStatus> {
    try {
      hash.parse(paymentHash);
      const approved = this.approvedRoute?.(paymentHash);
      await assertRecoveryNode(this.client, this.expectedPublicKey);
      const raw: unknown = await this.client.call(approved ? recoveryRoutedPaymentsPath : recoveryPaymentsPath);
      const page = pageSchema.parse(raw);
      if (!page.payments.length || page.payments.length === recoveryPaymentLimit) throw new Error();
      const indexes = page.payments.map(p => BigInt(p.payment_index));
      if (indexes.some((value, i) => value < 1n || (i > 0 && value <= indexes[i - 1]!)) ||
        page.first_index_offset !== page.payments[0]!.payment_index || page.last_index_offset !== page.payments.at(-1)!.payment_index) throw new Error();
      const matches = page.payments.map((p, index) => ({ p, index })).filter(({ p }) => p.payment_hash === paymentHash);
      if (matches.length !== 1) throw new Error();
      // The page schema strips raw payment fields, including preimages; inspect only the matching row.
      const original = (raw as { payments: unknown[] }).payments[matches[0]!.index];
      const p = paymentSchema.parse(original);
      const value = BigInt(p.value_sat); const valueMsat = BigInt(p.value_msat);
      const fee = BigInt(p.fee_sat); const feeMsat = BigInt(p.fee_msat);
      const roundedFee = (feeMsat + 999n) / 1000n;
      if (value < 1n || value > BigInt(Number.MAX_SAFE_INTEGER) || valueMsat !== value * 1000n ||
        fee !== feeMsat / 1000n || roundedFee > BigInt(Number.MAX_SAFE_INTEGER) ||
        (p.status === 'FAILED') === (p.failure_reason === 'FAILURE_REASON_NONE')) throw new Error();
      if (approved) {
        const routes = verifyApprovedPaymentRoutes(original, { channelId: approved.routing.channelId,
          providerNode: approved.providerNode, valueMsat }, p.status, feeMsat);
        if (p.status === 'IN_FLIGHT' && !routes.hasInFlight) throw new Error('Payer route remains uncertain');
      }
      if (p.status === 'SUCCEEDED') {
        const secret = hash.parse((original as { payment_preimage?: unknown }).payment_preimage);
        if (createHash('sha256').update(Buffer.from(secret, 'hex')).digest('hex') !== paymentHash) throw new Error();
      }
      await assertRecoveryNode(this.client, this.expectedPublicKey);
      return { hash: paymentHash, status: p.status, valueSats: Number(value),
        ...(p.status === 'SUCCEEDED' ? { feeSats: Number(roundedFee) } : {}) };
    } catch {
      // Raw transport/schema errors can contain payment material; never propagate them.
      throw new Error('Existing payer payment evidence unavailable or unsupported');
    }
  }
}
