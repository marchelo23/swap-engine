import https from 'node:https';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { readAccounts } from '../auth/store.js';
import { BitcoinRpcClient } from '../bitcoin/BitcoinRpcClient.js';
import type { ApplicationMode, Config } from '../config.js';
import { CoreLndForwardPorts } from '../core/CoreLndForwardPorts.js';
import { isLegacyEconomics } from '../core/Economics.js';
import { ForwardAdmission } from '../core/ForwardAdmission.js';
import type { ForwardPorts } from '../core/ForwardExecutor.js';
import { assertOperatorBinding } from '../environment/OperatorBinding.js';
import type { StartupScope } from '../environment/StartupAttestation.js';
import type { StateScope } from '../environment/StateScope.js';
import { LndClient } from '../lightning/LndClient.js';
import { verifyLndMacaroonRole, type LndMacaroonRole } from '../lightning/LndMacaroon.js';
import { recoveryPaymentsPath } from '../lightning/LndPayerRecovery.js';
import { HttpsLndPaymentTransport, type PaymentStreamTransport } from '../lightning/LndPaymentTransport.js';
import { checkedJSON, protectedBytes, sha256 } from '../operator/OperatorFiles.js';
import {
  assertPersistentStorage,
  assertPrivateDirectory,
  FORWARD_STORE_MARKER,
  isValidTestForwardLeaseToken,
  readPrivateFileStrict,
} from '../persistence/ForwardPayerRegistry.js';
import { Store } from '../persistence/Store.js';

export { assertPersistentStorage };

export const FORWARD_DEPLOYMENT_ID = 'admin-regtest-3201';
export const FORWARD_ORIGIN = 'http://127.0.0.1:3201';
export const FORWARD_PORT = 3201;
export const FORWARD_REGTEST_GENESIS = '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206';
export const FORWARD_INVOICE_SATS = 5_000;
export const FORWARD_FEE_LIMIT_SATS = 100;
export const FORWARD_DEPOSIT_SATS = 5_100;
export const FORWARD_MAX_RUNS = 1;
export const FORWARD_CHANNEL_MIN_CONFIRMATIONS = 6;

const LND_V20_8_BETA_VERSION = '0.20.8-beta commit=v0.20.8-beta';
const LND_V20_8_BETA_COMMIT = '33f90e82464daf9e6d2f2a02e754955ba42e2951';

const hex64 = z.string().regex(/^[a-f0-9]{64}$/);
const pubkey = z.string().regex(/^0[23][a-f0-9]{64}$/);
const canonicalUuidV4 = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const absolute = z.string().refine(v => isAbsolute(v) && v.length <= 4096);
const channelIdSchema = z.string().regex(/^[1-9][0-9]{0,19}$/).refine(v => BigInt(v) <= 0xffffffffffffffffn);
const uintText = z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine(v => BigInt(v) <= 0xffffffffffffffffn);

const loopbackUrl = (protocol: 'http:' | 'https:') => z.string().refine(value => {
  try {
    const url = new URL(value);
    return url.origin === value && url.protocol === protocol && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
  } catch {
    return false;
  }
});

export const forwardRegtestPolicySchema = z.object({
  mode: z.literal('regtest'),
  deploymentId: z.literal(FORWARD_DEPLOYMENT_ID),
  origin: z.literal(FORWARD_ORIGIN),
  port: z.literal(FORWARD_PORT),
  authStorePath: absolute,
  ownerId: canonicalUuidV4,
  ownerUsername: z.string().min(1).max(64),
  genesisHash: z.literal(FORWARD_REGTEST_GENESIS),
  wallet: z.string().regex(/^[A-Za-z0-9._-]{1,120}$/).refine(w => w !== 'iso-core-lab'),
  payerNode: pubkey,
  payeeNode: pubkey,
  channelId: channelIdSchema,
  channelPoint: z.string().regex(/^[a-f0-9]{64}:[0-9]{1,10}$/).optional(),
  dataDir: absolute,
  routing: z.object({
    bitcoinOrigin: loopbackUrl('http:'),
    payerOrigin: loopbackUrl('https:'),
    payeeOrigin: loopbackUrl('https:'),
  }).strict(),
  credentialPaths: z.object({
    bitcoinCookiePath: absolute,
    payerCertPath: absolute,
    payerReadMacaroonPath: absolute,
    payerRouterMacaroonPath: absolute,
    payeeCertPath: absolute,
    payeeReadMacaroonPath: absolute,
  }).strict(),
  limits: z.object({
    invoiceSats: z.literal(FORWARD_INVOICE_SATS),
    feeLimitSats: z.literal(FORWARD_FEE_LIMIT_SATS),
    depositSats: z.literal(FORWARD_DEPOSIT_SATS),
    maxRuns: z.literal(FORWARD_MAX_RUNS),
  }).strict(),
}).strict().superRefine((policy, ctx) => {
  if (policy.payerNode === policy.payeeNode) {
    ctx.addIssue({ code: 'custom', message: 'Forward payerNode and payeeNode must differ' });
  }
  if (policy.routing.payerOrigin === policy.routing.payeeOrigin) {
    ctx.addIssue({ code: 'custom', message: 'Forward payerOrigin and payeeOrigin must differ' });
  }
  const creds = policy.credentialPaths;
  if (creds.payerRouterMacaroonPath === creds.payerReadMacaroonPath ||
    creds.payerRouterMacaroonPath === creds.payeeReadMacaroonPath ||
    creds.payerReadMacaroonPath === creds.payeeReadMacaroonPath ||
    creds.payerCertPath === creds.payeeCertPath) {
    ctx.addIssue({ code: 'custom', message: 'Forward payer and payee credentials must stay isolated' });
  }
});

export type ForwardRegtestPolicy = z.infer<typeof forwardRegtestPolicySchema>;
export type ForwardStartupArgs = { path: string; hash: string };

export type ForwardClients = {
  core: Pick<BitcoinRpcClient, 'call'>;
  payer: Pick<LndClient, 'call' | 'origin'>;
  payee: Pick<LndClient, 'call' | 'origin'>;
  transport: PaymentStreamTransport;
};

export type ForwardRegtestOverrides = {
  openStore?: (directory: string, payerNode: string) => Promise<Store>;
  assertPersistentStorage?: (directory: string) => Promise<void>;
  clients?: (policy: ForwardRegtestPolicy) => ForwardClients;
  testToken?: object;
  pinnedCredentials?: Map<string, string>;
};

export type PreparedForwardProfile = {
  policy: ForwardRegtestPolicy;
  clients: ForwardClients;
  openStore: (directory: string, payerNode: string) => Promise<Store>;
  testToken?: object;
};

export type ForwardRegtestRuntime = {
  policy: ForwardRegtestPolicy;
  store: Store;
  admission: SingleRunForwardAdmission;
  apiForward: { ownerId: string; admission: ForwardAdmission; requireAdminRole: true; testToken?: object };
};

export function forwardStartupArguments(args: string[], mode: ApplicationMode): ForwardStartupArgs | undefined {
  if (args[0] !== '--forward-regtest') return undefined;
  if (mode !== 'regtest' || args.length !== 5 || args[1] !== '--policy-path' ||
    !isAbsolute(args[2] ?? '') || args[3] !== '--policy-sha256' || !/^[a-f0-9]{64}$/.test(args[4] ?? '')) {
    throw new Error('FORWARD_STARTUP_REJECTED');
  }
  return { path: args[2]!, hash: args[4]! };
}

/** Derives canonical 15-field StateScope from an attested ForwardRegtestPolicy (LND_* is forward payer). */
export function forwardStateScope(policy: ForwardRegtestPolicy): StateScope {
  return {
    environment: policy.mode,
    deploymentId: policy.deploymentId,
    genesisHash: policy.genesisHash,
    wallet: policy.wallet,
    bitcoinOrigin: policy.routing.bitcoinOrigin,
    providerOrigin: policy.routing.payerOrigin,
    payerOrigin: policy.routing.payeeOrigin,
    providerNode: policy.payerNode,
    payerNode: policy.payeeNode,
    liquidOrigin: null,
    liquidWallet: null,
    liquidGenesisHash: null,
    liquidChainName: null,
    liquidPolicyAsset: null,
    liquidParentGenesisHash: null,
  };
}

/** Reads a private 0600 credential file with O_NOFOLLOW and verifies its SHA-256 against the pinned startup map. */
export function createPinnedCredentialReader(pinnedDigests: Map<string, string>) {
  return async (path: string): Promise<Buffer> => {
    const expected = pinnedDigests.get(path);
    if (!expected) throw new Error('FORWARD_CREDENTIAL_NOT_PINNED');
    const bytes = await protectedBytes(path, true);
    if (sha256(bytes) !== expected) {
      bytes.fill(0);
      throw new Error('FORWARD_CREDENTIAL_DIGEST_MISMATCH');
    }
    return bytes;
  };
}

/** Pins SHA-256 on first private 0600 read and enforces digest equality on all subsequent reads. */
export function createAutoPinningCredentialReader(pinnedDigests: Map<string, string>) {
  return async (path: string): Promise<Buffer> => {
    const bytes = await protectedBytes(path, true);
    const actual = sha256(bytes);
    const existing = pinnedDigests.get(path);
    if (existing !== undefined && existing !== actual) {
      bytes.fill(0);
      throw new Error('FORWARD_CREDENTIAL_DIGEST_MISMATCH');
    }
    pinnedDigests.set(path, actual);
    return bytes;
  };
}

const CORE_READ_METHODS = new Set(['getblockchaininfo', 'getblockhash', 'listwallets', 'gettxout', 'getzmqnotifications']);
const CORE_WALLET_METHODS = new Set(['getwalletinfo', 'getbalances', 'getnewaddress', 'getaddressinfo']);
const PAYER_READ_PATHS = new Set(['/v1/state', '/v1/getinfo', '/v1/channels', recoveryPaymentsPath]);
const PAYEE_READ_PATHS = new Set(['/v1/state', '/v1/getinfo', '/v1/channels']);

/** Enforces strict method/path allowlists over Core, payer LND, and payee LND forward clients. */
export function wrapForwardClients(clients: ForwardClients): ForwardClients {
  return {
    core: {
      call<T>(method: string, params: unknown[] = [], wallet = false): Promise<T> {
        const allowed = (CORE_READ_METHODS.has(method) && wallet === false) ||
          (CORE_WALLET_METHODS.has(method) && wallet === true);
        if (!allowed) return Promise.reject(new Error('FORWARD_CORE_OPERATION_DISABLED'));
        return clients.core.call<T>(method, params, wallet);
      },
    },
    payer: {
      origin: clients.payer.origin,
      call<T>(path: string, body?: unknown): Promise<T> {
        const allowed = body === undefined && (PAYER_READ_PATHS.has(path) ||
          /^\/v1\/payreq\/lnbcrt[0-9a-z]{20,4096}$/.test(path));
        if (!allowed) return Promise.reject(new Error('FORWARD_PAYER_OPERATION_DISABLED'));
        return clients.payer.call<T>(path);
      },
    },
    payee: {
      origin: clients.payee.origin,
      call<T>(path: string, body?: unknown): Promise<T> {
        if (body !== undefined || !PAYEE_READ_PATHS.has(path)) {
          return Promise.reject(new Error('FORWARD_PAYEE_OPERATION_DISABLED'));
        }
        return clients.payee.call<T>(path);
      },
    },
    transport: clients.transport,
  };
}

const chainSchema = z.object({
  chain: z.literal('regtest'),
  initialblockdownload: z.literal(false),
  blocks: z.number().int().positive(),
  headers: z.number().int().positive(),
  bestblockhash: hex64,
});

const lndStateSchema = z.object({ state: z.literal('SERVER_ACTIVE') });
const lndInfoSchema = z.object({
  identity_pubkey: pubkey,
  synced_to_chain: z.literal(true),
  wallet_synced: z.boolean().optional(),
  version: z.string(),
  commit_hash: z.string().optional(),
  block_hash: hex64,
  block_height: z.number().int().positive(),
  chains: z.array(z.object({ chain: z.literal('bitcoin'), network: z.literal('regtest') })).length(1),
});

const lndChannelsSchema = z.object({
  channels: z.array(z.object({
    chan_id: channelIdSchema,
    channel_point: z.string().regex(/^[a-f0-9]{64}:[0-9]{1,10}$/),
    remote_pubkey: pubkey,
    active: z.boolean(),
    zero_conf: z.boolean(),
    local_balance: uintText,
    remote_balance: uintText,
    commit_fee: uintText,
    unsettled_balance: uintText,
    pending_htlcs: z.array(z.unknown()),
    local_constraints: z.object({ chan_reserve_sat: uintText }),
  })).max(1000),
});

const payerPaymentsEmptySchema = z.object({
  first_index_offset: z.literal('0'),
  last_index_offset: z.literal('0'),
  payments: z.tuple([]),
});

const emptyWalletBalancesSchema = z.object({
  mine: z.object({
    trusted: z.literal(0),
    untrusted_pending: z.literal(0),
    immature: z.literal(0).optional(),
  }),
  watchonly: z.object({
    trusted: z.literal(0),
    untrusted_pending: z.literal(0),
    immature: z.literal(0).optional(),
  }).optional(),
});

function assertWalletSynced(info: z.infer<typeof lndInfoSchema>): void {
  if (info.wallet_synced !== true &&
    !(info.wallet_synced === undefined && info.version === LND_V20_8_BETA_VERSION && info.commit_hash === LND_V20_8_BETA_COMMIT)) {
    throw new Error('FORWARD_LND_WALLET_NOT_SYNCED');
  }
}

type ReadinessOptions = {
  requireChannel?: boolean;
  requireLiquidity?: boolean;
  requireEmptyPayerHistory?: boolean;
  requireZmq?: boolean;
  requireEmptyWalletBalance?: boolean;
};

/** Validates Core regtest/genesis, both LND nodes, direct confirmed channel, liquidity, and empty payer history. */
export async function assertForwardReadiness(
  clients: ForwardClients,
  policy: ForwardRegtestPolicy,
  options: ReadinessOptions = {},
): Promise<void> {
  const {
    requireChannel = true,
    requireLiquidity = false,
    requireEmptyPayerHistory = false,
    requireZmq = false,
    requireEmptyWalletBalance = false,
  } = options;
  const [chainRaw, genesisRaw, walletsRaw, walletInfoRaw] = await Promise.all([
    clients.core.call('getblockchaininfo'),
    clients.core.call('getblockhash', [0]),
    clients.core.call('listwallets'),
    clients.core.call('getwalletinfo', [], true),
  ]);
  const chain = chainSchema.parse(chainRaw);
  if (chain.blocks !== chain.headers) throw new Error('FORWARD_CORE_HEADERS_MISMATCH');
  if (hex64.parse(genesisRaw) !== policy.genesisHash) throw new Error('FORWARD_GENESIS_MISMATCH');
  const wallets = z.array(z.string()).parse(walletsRaw);
  const walletInfo = z.object({ walletname: z.literal(policy.wallet), private_keys_enabled: z.literal(true) }).parse(walletInfoRaw);
  if (!wallets.includes(walletInfo.walletname)) throw new Error('FORWARD_WALLET_NOT_LOADED');

  if (requireEmptyWalletBalance) {
    const parsedBalances = emptyWalletBalancesSchema.safeParse(await clients.core.call('getbalances', [], true));
    if (!parsedBalances.success) {
      throw new Error('FORWARD_WALLET_NOT_EMPTY');
    }
  }

  if (requireZmq) {
    const zmq = z.array(z.object({ type: z.string(), address: z.string() })).parse(await clients.core.call('getzmqnotifications'));
    const hasRawBlock = zmq.some(n => n.type === 'pubrawblock' && ['tcp://127.0.0.1:28332', 'tcp://0.0.0.0:28332'].includes(n.address));
    const hasRawTx = zmq.some(n => n.type === 'pubrawtx' && ['tcp://127.0.0.1:28333', 'tcp://0.0.0.0:28333'].includes(n.address));
    if (!hasRawBlock || !hasRawTx) {
      throw new Error('FORWARD_ZMQ_NOTIFICATIONS_MISSING');
    }
  }

  for (const [client, expectedPubkey] of [[clients.payer, policy.payerNode], [clients.payee, policy.payeeNode]] as const) {
    lndStateSchema.parse(await client.call('/v1/state'));
    const info = lndInfoSchema.parse(await client.call('/v1/getinfo'));
    assertWalletSynced(info);
    if (info.identity_pubkey !== expectedPubkey || info.block_hash !== chain.bestblockhash || info.block_height !== chain.blocks) {
      throw new Error('FORWARD_LND_IDENTITY_OR_TIP_MISMATCH');
    }
  }

  if (requireChannel || requireLiquidity) {
    const [payerChannelsRaw, payeeChannelsRaw] = await Promise.all([
      clients.payer.call('/v1/channels'),
      clients.payee.call('/v1/channels'),
    ]);
    const payerChannels = lndChannelsSchema.parse(payerChannelsRaw).channels.filter(c => c.chan_id === policy.channelId);
    const payeeChannels = lndChannelsSchema.parse(payeeChannelsRaw).channels.filter(c => c.chan_id === policy.channelId);
    if (payerChannels.length !== 1 || payeeChannels.length !== 1) {
      throw new Error('FORWARD_CHANNEL_NOT_FOUND');
    }
    const payerChan = payerChannels[0]!;
    const payeeChan = payeeChannels[0]!;
    if (!payerChan.active || payerChan.zero_conf || payerChan.remote_pubkey !== policy.payeeNode ||
      !payeeChan.active || payeeChan.zero_conf || payeeChan.remote_pubkey !== policy.payerNode ||
      payerChan.channel_point !== payeeChan.channel_point ||
      (policy.channelPoint && payerChan.channel_point !== policy.channelPoint)) {
      throw new Error('FORWARD_CHANNEL_BINDING_INVALID');
    }
    const [fundingTxid, fundingVoutText] = payerChan.channel_point.split(':');
    const fundingVout = z.number().int().min(0).max(0xffffffff).parse(Number(fundingVoutText));
    const funding = z.object({
      confirmations: z.number().int().min(FORWARD_CHANNEL_MIN_CONFIRMATIONS),
      bestblock: hex64,
      coinbase: z.literal(false),
      scriptPubKey: z.object({ hex: z.string().regex(/^0020[a-f0-9]{64}$/) }),
    }).parse(await clients.core.call('gettxout', [fundingTxid, fundingVout, true]));
    if (funding.bestblock !== chain.bestblockhash) {
      throw new Error('FORWARD_CHANNEL_TIP_CHANGED');
    }
    if (requireLiquidity) {
      if (payerChan.pending_htlcs.length > 0 || payerChan.unsettled_balance !== '0' ||
        payeeChan.pending_htlcs.length > 0 || payeeChan.unsettled_balance !== '0') {
        throw new Error('FORWARD_CHANNEL_PENDING_HTLCS');
      }
      const spendable = BigInt(payerChan.local_balance) - BigInt(payerChan.local_constraints.chan_reserve_sat) - BigInt(payerChan.commit_fee);
      if (spendable < BigInt(FORWARD_DEPOSIT_SATS)) {
        throw new Error('FORWARD_CHANNEL_LIQUIDITY_INSUFFICIENT');
      }
    }
  }

  if (requireEmptyPayerHistory) {
    payerPaymentsEmptySchema.parse(await clients.payer.call(recoveryPaymentsPath));
  }
}

/** Single-run 5000/5100 sats wrapper over ForwardAdmission; prevents second-hash bypasses and verifies live readiness before spend. */
export class SingleRunForwardAdmission extends ForwardAdmission {
  private admitQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly profileStore: Store,
    ports: ForwardPorts & { allocateDeposit(): Promise<unknown> },
    private readonly policy: ForwardRegtestPolicy,
    private readonly clients: ForwardClients,
    private readonly profileTestToken?: object,
  ) {
    super(profileStore, ports, policy.payerNode, policy.payeeNode, profileTestToken);
  }

  private assertSingleOwner(owner: string): void {
    if (owner !== this.policy.ownerId) {
      throw new Error('Forward admission owner unauthorized');
    }
  }

  override admit(owner: string, invoice: string, invoiceSats: number, key?: string) {
    const task = this.admitQueue.then(() => this.admitExclusive(owner, invoice, invoiceSats, key));
    this.admitQueue = task.catch(() => {});
    return task;
  }

  private async admitExclusive(owner: string, invoice: string, invoiceSats: number, key?: string) {
    this.assertSingleOwner(owner);
    if (invoiceSats !== FORWARD_INVOICE_SATS) {
      throw new Error('Forward profile requires exact 5000 sat invoice');
    }
    await this.profileStore.assertForwardPayerHeld(this.policy.payerNode, this.profileTestToken);
    const db = this.profileStore.read();
    const admissions = db.forwardAdmissions ?? {};
    const payments = db.forwardPayments ?? {};
    if (Object.keys(payments).length > 0) {
      throw new Error('Single-run forward budget exhausted');
    }
    const existingEntries = Object.entries(admissions);
    if (existingEntries.length > 0) {
      if (existingEntries.length > 1) {
        throw new Error('Single-run forward limit exceeded');
      }
      const [id, record] = existingEntries[0]!;
      if (key !== undefined && record.owner === owner && record.requestKey === key &&
        record.invoice === invoice && record.invoiceSats === FORWARD_INVOICE_SATS &&
        record.payerNode === this.policy.payerNode && record.payeeNode === this.policy.payeeNode) {
        return { id, address: record.address, depositSats: record.depositSats, expiresAt: record.expiresAt };
      }
      throw new Error('Single-run forward admission already exists');
    }
    await assertForwardReadiness(this.clients, this.policy, {
      requireChannel: true,
      requireLiquidity: true,
      requireEmptyPayerHistory: true,
      requireEmptyWalletBalance: true,
    });
    return super.admit(owner, invoice, invoiceSats, key);
  }

  override async submit(owner: string, id: string, candidate: { txid: string; vout: number }) {
    this.assertSingleOwner(owner);
    const db = this.profileStore.read();
    const record = db.forwardAdmissions?.[id];
    const payments = db.forwardPayments ?? {};
    const hashes = Object.keys(payments);
    if (hashes.length > 1 || (hashes.length === 1 && record && !payments[record.paymentHash])) {
      throw new Error('Single-run forward payment already exists');
    }
    return super.submit(owner, id, candidate);
  }

  override async execute(owner: string, id: string, candidate: { txid: string; vout: number }) {
    this.assertSingleOwner(owner);
    if (Object.keys(this.profileStore.read().forwardPayments ?? {}).length > 0) {
      throw new Error('Single-run forward budget exhausted');
    }
    await assertForwardReadiness(this.clients, this.policy, {
      requireChannel: true,
      requireLiquidity: true,
      requireEmptyPayerHistory: true,
    });
    return super.execute(owner, id, candidate);
  }

  override async recover(owner: string, id: string) {
    this.assertSingleOwner(owner);
    await assertForwardReadiness(this.clients, this.policy, {
      requireChannel: false,
      requireLiquidity: false,
      requireEmptyPayerHistory: false,
    });
    return super.recover(owner, id);
  }
}

function buildStrictForwardPorts(
  store: Store,
  policy: ForwardRegtestPolicy,
  clients: ForwardClients,
  testToken?: object,
): ForwardPorts & { allocateDeposit(): Promise<unknown> } {
  const base = new CoreLndForwardPorts(
    clients.core,
    clients.payer,
    clients.transport,
    policy.payerNode,
    policy.payeeNode,
    policy.channelId,
    store,
    testToken,
  );
  return {
    inspectPayer: () => base.inspectPayer(),
    async decodeInvoice(invoice: string) {
      const decoded = await base.decodeInvoice(invoice);
      z.object({
        num_satoshis: z.literal(String(FORWARD_INVOICE_SATS)),
        num_msat: z.literal(String(FORWARD_INVOICE_SATS * 1_000)),
      }).parse(decoded);
      return decoded;
    },
    allocateDeposit: () => base.allocateDeposit(),
    async inspectDeposit(txid: string, vout: number) {
      const deposit = await base.inspectDeposit(txid, vout);
      if (deposit.valueSats !== FORWARD_DEPOSIT_SATS) {
        throw new Error('Forward profile requires exact 5100 sat deposit');
      }
      return deposit;
    },
    async send(invoice: string, feeLimitSats: number, beforeSend: () => Promise<void>) {
      if (feeLimitSats !== FORWARD_FEE_LIMIT_SATS) {
        throw new Error('Forward profile requires 100 sat fee limit');
      }
      const evidence = await base.send(invoice, feeLimitSats, async () => {
        await beforeSend();
        const db = store.read();
        if (Object.keys(db.forwardAdmissions ?? {}).length !== 1 ||
          Object.keys(db.forwardPayments ?? {}).length !== 1) {
          throw new Error('Single-run forward state invariant violated');
        }
        await assertForwardReadiness(clients, policy, {
          requireChannel: true,
          requireLiquidity: true,
          requireEmptyPayerHistory: true,
        });
        await store.assertForwardPayerHeld(policy.payerNode, testToken);
      });
      z.object({
        status: z.literal('SUCCEEDED'),
        hash: hex64,
        preimage: hex64,
        valueMsat: z.literal(FORWARD_INVOICE_SATS * 1_000),
        feeMsat: z.number().int().nonnegative().max(FORWARD_FEE_LIMIT_SATS * 1_000),
      }).parse(evidence);
      return evidence;
    },
    async track(paymentHash: string) {
      await assertForwardReadiness(clients, policy, {
        requireChannel: false,
        requireLiquidity: false,
        requireEmptyPayerHistory: false,
      });
      return base.track(paymentHash);
    },
  };
}

function defaultClients(policy: ForwardRegtestPolicy, readCredential: (path: string) => Promise<Buffer>): ForwardClients {
  const creds = policy.credentialPaths;
  return {
    core: new BitcoinRpcClient(policy.routing.bitcoinOrigin, creds.bitcoinCookiePath, policy.wallet, readCredential),
    payer: new LndClient(policy.routing.payerOrigin, creds.payerCertPath, creds.payerReadMacaroonPath, readCredential),
    payee: new LndClient(policy.routing.payeeOrigin, creds.payeeCertPath, creds.payeeReadMacaroonPath, readCredential),
    transport: new HttpsLndPaymentTransport(policy.routing.payerOrigin, creds.payerCertPath, creds.payerRouterMacaroonPath, {
      credentials: async () => {
        const [ca, macaroon] = await Promise.all([
          readCredential(creds.payerCertPath),
          readCredential(creds.payerRouterMacaroonPath),
        ]);
        return { ca, macaroon };
      },
      request: (target, options, callback) => https.request(target, options, callback),
    }),
  };
}

/** Enforces exclusive regtest flags and explicit off-switches for all non-forward capabilities. */
export function assertForwardExclusiveConfig(c: Config, errorCode = 'FORWARD_CONFIG_REJECTED'): void {
  if (c.mode !== 'regtest' || c.environment !== 'regtest' || c.spendPolicy !== 'regtest-only' ||
    !c.features.forward || c.features.reverse || c.explicitFlags.reverse !== false ||
    c.features.guest || c.explicitFlags.guest !== false ||
    c.miningPolicy !== 'disabled' || c.explicitFlags.miningPolicy !== 'disabled' ||
    c.features.mining || c.explicitFlags.mining !== false ||
    c.explicitFlags.liveSwaps !== false ||
    c.rails.ark.enabled || c.explicitFlags.ark !== false || c.explicitFlags.arkExecution !== false ||
    c.rails.liquid.enabled || c.explicitFlags.liquid !== false || c.explicitFlags.liquidExecution !== false ||
    c.recovery !== undefined || c.explicitFlags.recovery !== false ||
    c.allowLegacyOfflineMigration || c.legacy.refundDestination !== null || c.legacy.lndAdminMacaroonPath !== null) {
    throw new Error(errorCode);
  }
}

/** Validates config, SHA-256 policy, admin UUID, private custody, storage, credentials, and startup readiness BEFORE StateScope or Store. */
export async function prepareForwardRegtestProfile(
  args: ForwardStartupArgs,
  c: Config,
  identity: StartupScope | undefined,
  portOverride?: number,
  overrides: ForwardRegtestOverrides = {},
): Promise<PreparedForwardProfile> {
  if (overrides.testToken !== undefined && !isValidTestForwardLeaseToken(overrides.testToken)) {
    throw new Error('FORWARD_TEST_TOKEN_INVALID');
  }
  const allowEphemeralTestPort = Boolean(overrides.testToken && portOverride === 0);
  const effectivePort = portOverride ?? c.port;

  assertForwardExclusiveConfig(c, 'FORWARD_CONFIG_REJECTED');
  if (c.deploymentId !== FORWARD_DEPLOYMENT_ID || c.auth.origin !== FORWARD_ORIGIN ||
    !c.auth.storePath || c.bitcoinGenesisHash !== FORWARD_REGTEST_GENESIS ||
    !isLegacyEconomics(c.economics) || !c.rails.onchain.enabled ||
    !c.rails.lightning.enabled || !c.rails.lightning.alice ||
    c.port !== FORWARD_PORT || (!allowEphemeralTestPort && effectivePort !== FORWARD_PORT)) {
    throw new Error('FORWARD_CONFIG_REJECTED');
  }

  const rawPolicy = await checkedJSON(args.path, args.hash);
  const policy = forwardRegtestPolicySchema.parse(rawPolicy);

  if (resolve(c.directory) !== resolve(policy.dataDir) ||
    c.auth.storePath !== policy.authStorePath ||
    c.auth.origin !== policy.origin ||
    c.deploymentId !== policy.deploymentId ||
    c.port !== policy.port ||
    (!allowEphemeralTestPort && effectivePort !== policy.port)) {
    throw new Error('FORWARD_POLICY_CONFIG_MISMATCH');
  }

  // LND_* (provider in StartupScope/Config) maps to the engine's forward payer; ALICE_LND_* maps to the external payee.
  if (!identity?.verified.onchain || !identity.verified.lightning ||
    identity.deploymentId !== policy.deploymentId ||
    identity.genesisHash !== policy.genesisHash ||
    identity.wallet !== policy.wallet ||
    identity.bitcoinOrigin !== policy.routing.bitcoinOrigin ||
    identity.providerOrigin !== policy.routing.payerOrigin ||
    identity.providerNode !== policy.payerNode ||
    identity.payerOrigin !== policy.routing.payeeOrigin ||
    identity.payerNode !== policy.payeeNode) {
    throw new Error('FORWARD_IDENTITY_MISMATCH');
  }

  assertOperatorBinding({
    wallet: policy.wallet,
    providerNode: policy.payerNode,
    payerNode: policy.payeeNode,
    routing: {
      bitcoinOrigin: policy.routing.bitcoinOrigin,
      providerOrigin: policy.routing.payerOrigin,
      payerOrigin: policy.routing.payeeOrigin,
    },
  }, {
    bitcoinCookiePath: policy.credentialPaths.bitcoinCookiePath,
    providerCertPath: policy.credentialPaths.payerCertPath,
    providerReadMacaroonPath: policy.credentialPaths.payerReadMacaroonPath,
    payerCertPath: policy.credentialPaths.payeeCertPath,
    payerReadMacaroonPath: policy.credentialPaths.payeeReadMacaroonPath,
  }, {
    wallet: c.rails.onchain.wallet,
    genesisHash: policy.genesisHash,
    bitcoinOrigin: new URL(c.rails.onchain.url).origin,
    providerOrigin: new URL(c.rails.lightning.provider.url).origin,
    payerOrigin: new URL(c.rails.lightning.alice.url).origin,
    providerNode: identity.providerNode,
    payerNode: identity.payerNode,
    bitcoinCookiePath: c.rails.onchain.cookie,
    providerCertPath: c.rails.lightning.provider.cert,
    providerReadMacaroonPath: c.rails.lightning.provider.macaroon,
    payerCertPath: c.rails.lightning.alice.cert,
    payerReadMacaroonPath: c.rails.lightning.alice.macaroon,
  });

  // Verify 0600 custody, pin SHA-256 of all 6 credentials, and validate LND macaroon roles (rejects admin.macaroon).
  const authBytes = await protectedBytes(policy.authStorePath, true);
  authBytes.fill(0);
  const pinnedDigests = overrides.pinnedCredentials ?? new Map<string, string>();
  const macaroonRoles = new Map<string, LndMacaroonRole>([
    [policy.credentialPaths.payerReadMacaroonPath, 'payer-readonly'],
    [policy.credentialPaths.payeeReadMacaroonPath, 'payee-readonly'],
    [policy.credentialPaths.payerRouterMacaroonPath, 'router'],
  ]);
  for (const credPath of Object.values(policy.credentialPaths)) {
    const bytes = await protectedBytes(credPath, true);
    try {
      const digest = sha256(bytes);
      const previouslyPinned = pinnedDigests.get(credPath);
      if (previouslyPinned !== undefined && previouslyPinned !== digest) {
        throw new Error('FORWARD_CREDENTIAL_DIGEST_MISMATCH');
      }
      pinnedDigests.set(credPath, digest);
      const role = macaroonRoles.get(credPath);
      if (role) verifyLndMacaroonRole(bytes, role);
    } finally {
      bytes.fill(0);
    }
  }

  const accounts = await readAccounts(policy.authStorePath);
  const ownerAccount = accounts.find(a => a.id === policy.ownerId);
  if (!ownerAccount || ownerAccount.role !== 'ADMIN' || ownerAccount.username !== policy.ownerUsername) {
    throw new Error('FORWARD_OWNER_UNAUTHORIZED');
  }

  const checkPersistent = overrides.assertPersistentStorage ?? assertPersistentStorage;
  await checkPersistent(policy.dataDir);
  await assertPrivateDirectory(policy.dataDir, false);

  // Require pre-provisioned forward marker, StateScope, and state.json before assertStateScope runs.
  const [markerFile, envScopeFile, stateFile] = await Promise.all([
    readPrivateFileStrict(join(policy.dataDir, FORWARD_STORE_MARKER)),
    readPrivateFileStrict(join(policy.dataDir, '.environment.json')),
    readPrivateFileStrict(join(policy.dataDir, 'state.json')),
  ]);
  if (!markerFile) throw new Error('FORWARD_CUSTODY_BINDING_REQUIRED');
  if (!envScopeFile) throw new Error('STATE_SCOPE_MIGRATION_REQUIRED');
  if (!stateFile) throw new Error('FORWARD_STATE_MISSING');

  const rawClients = overrides.clients
    ? overrides.clients(policy)
    : defaultClients(policy, createPinnedCredentialReader(pinnedDigests));
  const clients = wrapForwardClients(rawClients);
  await clients.transport.probeRouterAuth?.();
  await assertForwardReadiness(clients, policy, {
    requireChannel: true,
    requireLiquidity: false,
    requireEmptyPayerHistory: false,
    requireZmq: true,
  });

  return {
    policy,
    clients,
    openStore: overrides.openStore ?? ((dir, node) => Store.openForForward(dir, node)),
    ...(overrides.testToken ? { testToken: overrides.testToken } : {}),
  };
}

/** Opens Store exclusively via Store.openForForward and installs single-run ForwardAdmission after StateScope binding. */
export async function openForwardRegtestRuntime(prepared: PreparedForwardProfile): Promise<ForwardRegtestRuntime> {
  const { policy, clients, openStore, testToken } = prepared;
  const store = await openStore(policy.dataDir, policy.payerNode);
  try {
    const db = store.read();
    const admissionCount = Object.keys(db.forwardAdmissions ?? {}).length;
    const paymentCount = Object.keys(db.forwardPayments ?? {}).length;
    if (admissionCount > FORWARD_MAX_RUNS || paymentCount > FORWARD_MAX_RUNS) {
      throw new Error('Single-run forward limit exceeded on disk');
    }
    if (paymentCount === 0) {
      await assertForwardReadiness(clients, policy, {
        requireChannel: true,
        requireLiquidity: true,
        requireEmptyPayerHistory: true,
        requireEmptyWalletBalance: admissionCount === 0,
      });
    }
    const ports = buildStrictForwardPorts(store, policy, clients, testToken);
    const admission = new SingleRunForwardAdmission(store, ports, policy, clients, testToken);
    return {
      policy,
      store,
      admission,
      apiForward: {
        ownerId: policy.ownerId,
        admission,
        requireAdminRole: true,
        ...(testToken ? { testToken } : {}),
      },
    };
  } catch (error) {
    await store.close().catch(() => {});
    throw error;
  }
}
