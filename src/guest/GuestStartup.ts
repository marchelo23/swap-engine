import { isAbsolute } from 'node:path';
import { address, networks } from 'bitcoinjs-lib';
import { z } from 'zod';
import type { Store } from '../persistence/Store.js';
import { BitcoinRpcClient } from '../bitcoin/BitcoinRpcClient.js';
import { LndClient } from '../lightning/LndClient.js';
import { HttpsLndInvoiceTransport } from '../lightning/LndInvoiceTransport.js';
import { reverseRoutingSchema } from '../core/ReverseTestPlan.js';
import { controlledGuestExecution, controlledPortsFactory, type GuestExecution } from './GuestExecution.js';
import { GuestReverse, guestReversePolicySchema, type GuestReverseClients } from './GuestReverse.js';
import { guestFundingPolicySchema } from './GuestFunding.js';

const pubkey = z.string().regex(/^(02|03)[a-f0-9]{64}$/);
const absolute = z.string().refine(isAbsolute);
const loopback = (protocol: 'http:' | 'https:') => z.string().refine(value => {
  try {
    const url = new URL(value);
    return url.origin === value && url.protocol === protocol && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
  } catch { return false; }
});
const credentialPaths = z.object({ bitcoinCookiePath: absolute, providerReadMacaroonPath: absolute,
  providerInvoiceMacaroonPath: absolute, providerSettleMacaroonPath: absolute, payerReadMacaroonPath: absolute }).strict();

export const guestStartupPolicySchema = z.object({
  mode: z.literal('regtest'),
  isolationId: z.uuid(),
  providerNode: pubkey,
  payerNode: pubkey,
  routing: reverseRoutingSchema,
  refundPublicKey: pubkey,
  refundDestination: z.string().refine(value => {
    try { return value.startsWith('bcrt1') && address.toOutputScript(value, networks.regtest).length > 0; } catch { return false; }
  }),
  funding: guestFundingPolicySchema,
  runsDirectory: absolute,
  ownedRunsDirectory: absolute.optional(),
  watcherIntervalMs: z.number().int().min(1000).max(60000).optional(),
  clients: z.object({
    bitcoin: z.object({ url: loopback('http:'), wallet: z.string().min(1).max(120) }).strict(),
    provider: z.object({ url: loopback('https:'), certPath: absolute }).strict(),
    payer: z.object({ url: loopback('https:'), certPath: absolute }).strict(),
    invoices: z.object({ url: loopback('https:'), certPath: absolute }).strict(),
    credentials: credentialPaths,
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.providerNode === value.payerNode) context.addIssue({ code: 'custom', message: 'Guest provider and payer nodes differ' });
  if (value.routing.providerOrigin === value.routing.payerOrigin) context.addIssue({ code: 'custom', message: 'Guest provider and payer endpoints differ' });
  if (value.clients.bitcoin.url !== value.routing.bitcoinOrigin) context.addIssue({ code: 'custom', message: 'Guest Bitcoin endpoint differs from routing' });
  if (value.clients.provider.url !== value.routing.providerOrigin) context.addIssue({ code: 'custom', message: 'Guest provider endpoint differs from routing' });
  if (value.clients.payer.url !== value.routing.payerOrigin) context.addIssue({ code: 'custom', message: 'Guest payer endpoint differs from routing' });
  if (value.clients.invoices.url !== value.routing.providerOrigin) context.addIssue({ code: 'custom', message: 'Guest invoice endpoint differs from provider' });
  if (value.clients.invoices.certPath !== value.clients.provider.certPath) context.addIssue({ code: 'custom', message: 'Guest invoice certificate differs from provider' });
});
export type GuestStartupPolicy = z.infer<typeof guestStartupPolicySchema>;

export class GuestStartupError extends Error {
  readonly code = 'GUEST_STARTUP_REJECTED';
  constructor(readonly reason: string) { super(reason); }
}

type GuestRuntimeOverrides = { clients?: GuestReverseClients; execution?: GuestExecution;
  broadcast?: (hex: string) => Promise<string> };

export type GuestRuntime = {
  policy: GuestStartupPolicy;
  guestReverse: GuestReverse;
  start(): void;
  stop(): void;
};

function buildClients(policy: GuestStartupPolicy) {
  const credentials = policy.clients.credentials;
  const bitcoin = new BitcoinRpcClient(policy.clients.bitcoin.url, credentials.bitcoinCookiePath, policy.clients.bitcoin.wallet);
  const providerRead = new LndClient(policy.clients.provider.url, policy.clients.provider.certPath, credentials.providerReadMacaroonPath);
  const providerSettle = new LndClient(policy.clients.provider.url, policy.clients.provider.certPath, credentials.providerSettleMacaroonPath);
  const payer = new LndClient(policy.clients.payer.url, policy.clients.payer.certPath, credentials.payerReadMacaroonPath);
  const invoices = new HttpsLndInvoiceTransport(policy.clients.invoices.url, policy.clients.invoices.certPath,
    credentials.providerReadMacaroonPath, credentials.providerInvoiceMacaroonPath);
  const provider = {
    origin: providerRead.origin,
    call: providerRead.call.bind(providerRead),
    assertRegtest: providerRead.assertRegtest.bind(providerRead),
    lookup: providerRead.lookup.bind(providerRead),
    settle: providerSettle.settle.bind(providerSettle),
    cancel: providerSettle.cancel.bind(providerSettle),
  };
  const clients: GuestReverseClients = {
    bitcoin,
    provider,
    payer,
    invoices,
    tip: async () => {
      const chain = z.object({ chain: z.literal('regtest'), blocks: z.number().int().positive() })
        .parse(await bitcoin.call('getblockchaininfo'));
      return chain.blocks;
    },
  };
  const execution = controlledGuestExecution(controlledPortsFactory({ bitcoin, provider, payer }));
  return { clients, bitcoin, execution };
}

/** Only an explicit operator policy can install guest capability execution.
 * Construction is inert: the short-lived HTTP routes are enabled by the caller,
 * and the reviewed watcher starts only when `start()` is called. */
export function createGuestRuntime(store: Store, value: unknown,
  options: GuestRuntimeOverrides & { watchRequested?: boolean } = {}): GuestRuntime {
  const policy = guestStartupPolicySchema.parse(value);
  if (options.watchRequested && !policy.watcherIntervalMs) throw new GuestStartupError('GUEST_WATCH_INTERVAL_REQUIRED');
  const built = options.clients ? undefined : buildClients(policy);
  const clients = options.clients ?? built!.clients;
  const execution = options.execution ?? built?.execution;
  if (options.watchRequested && !execution) throw new GuestStartupError('GUEST_WATCH_EXECUTION_REQUIRED');
  const guestPolicy = guestReversePolicySchema.parse({ mode: policy.mode, isolationId: policy.isolationId,
    providerNode: policy.providerNode, payerNode: policy.payerNode, routing: policy.routing,
    refundPublicKey: policy.refundPublicKey, refundDestination: policy.refundDestination,
    funding: policy.funding, runsDirectory: policy.runsDirectory });
  const broadcast = options.broadcast ?? (built ? (hex: string) => built.bitcoin.broadcast(hex) : undefined);
  const guestReverse = new GuestReverse(store, guestPolicy, clients, {
    ...(execution ? { execution } : {}),
    ...(broadcast ? { broadcast } : {}),
    ...(policy.ownedRunsDirectory ? { ownedRunsDirectory: policy.ownedRunsDirectory } : {}),
  });
  return {
    policy, guestReverse,
    start() {
      if (!policy.watcherIntervalMs) throw new GuestStartupError('GUEST_WATCH_INTERVAL_REQUIRED');
      guestReverse.start(policy.watcherIntervalMs);
    },
    stop() { guestReverse.stop(); },
  };
}
