import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, lstatSync, readFileSync } from 'node:fs';
import { lstat, mkdir, open, rename } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { address, initEccLib, networks } from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { z } from 'zod';
import { ArkAdminReportResponse, ArkQuoteRequest, ArkQuoteResponse, ArkRoute, ArkSwapStatusResponse, ArkTelemetryResponse } from '../api/schemas.js';

initEccLib(ecc);

export type ArkRouteKind = z.infer<typeof ArkRoute>;
export type ArkQuoteInput = z.infer<typeof ArkQuoteRequest>;
export type ArkQuote = z.infer<typeof ArkQuoteResponse>;
export type ArkTelemetry = z.infer<typeof ArkTelemetryResponse>;
export type ArkSwapPublicRecord = z.infer<typeof ArkSwapStatusResponse>;
export type ArkAdminReport = z.infer<typeof ArkAdminReportResponse>;
export type ArkSwapRecord = ArkSwapPublicRecord & {
  ownerId: string;
  idempotencyKey: string;
  fingerprint: string;
};

const persistedArkSwapRecord = ArkSwapStatusResponse.extend({
  ownerId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  fingerprint: z.string().min(1),
}).strict();

const persistedArkStoreSchema = z.object({
  schema: z.literal(1),
  swaps: z.array(persistedArkSwapRecord),
}).strict();

export function toPublicArkSwap(record: ArkSwapRecord): ArkSwapPublicRecord {
  const { ownerId: _o, idempotencyKey: _k, fingerprint: _f, ...publicRecord } = record;
  return ArkSwapStatusResponse.parse(publicRecord);
}

export class ArkSwapService {
  private quotes = new Map<string, ArkQuote>();
  private swaps = new Map<string, ArkSwapRecord>();
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(private readonly port?: ArkRegtestPort, private readonly storePath?: string) {
    if (storePath) {
      let stat: ReturnType<typeof lstatSync> | undefined;
      try {
        stat = lstatSync(storePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (stat) {
        if (stat.isSymbolicLink() || !stat.isFile()) {
          throw new Error('ARK_STORE_PATH_INVALID');
        }
        const parsed = persistedArkStoreSchema.parse(JSON.parse(readFileSync(storePath, 'utf8')));
        for (const record of parsed.swaps) this.swaps.set(record.id, structuredClone(record));
      }
    }
  }

  private async persist(): Promise<void> {
    if (!this.storePath) return;
    const targetPath = this.storePath;
    const snapshot = JSON.stringify({ schema: 1, swaps: [...this.swaps.values()] }, null, 2);
    const run = this.persistQueue.then(async () => {
      await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
      const assertRegularOrMissing = async (candidate: string) => {
        try {
          const stat = await lstat(candidate);
          if (stat.isSymbolicLink() || !stat.isFile()) {
            throw new Error('ARK_STORE_PATH_INVALID');
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      };
      await assertRegularOrMissing(targetPath);
      const tempPath = `${targetPath}.tmp`;
      await assertRegularOrMissing(tempPath);
      const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0);
      const handle = await open(tempPath, flags, 0o600);
      try {
        await handle.writeFile(snapshot);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tempPath, targetPath);
    });
    this.persistQueue = run.catch(() => {});
    await run;
  }

  quote(route: ArkRouteKind, amountSats: number, now = Date.now()): ArkQuote {
    for (const [id, q] of this.quotes) if (q.expiresAt <= now) this.quotes.delete(id);
    const created = buildArkQuote(route, amountSats, now);
    this.quotes.set(created.id, created);
    return created;
  }

  getQuote(id: string, now = Date.now()): ArkQuote | undefined {
    const q = this.quotes.get(id);
    if (!q || q.expiresAt <= now) return undefined;
    return q;
  }

  getSwap(ownerId: string, id: string): ArkSwapRecord | undefined {
    const record = this.swaps.get(id);
    if (!record || record.ownerId !== ownerId) return undefined;
    return structuredClone(record);
  }

  listSwaps(ownerId: string): ArkSwapRecord[] {
    return [...this.swaps.values()]
      .filter(s => s.ownerId === ownerId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(s => structuredClone(s));
  }

  listAllSwaps(): ArkSwapRecord[] {
    return [...this.swaps.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(s => structuredClone(s));
  }

  adminReport(): ArkAdminReport {
    const all = this.listAllSwaps();
    let completedSwaps = 0;
    let pendingSwaps = 0;
    let failedSwaps = 0;
    let onchainSentSats = 0;
    let onchainReceivedSats = 0;
    let arkSentSats = 0;
    let arkReceivedSats = 0;
    let collectedServiceFeesSats = 0;
    let estimatedNetworkFeesSats = 0;

    for (const swap of all) {
      if (swap.status === 'CONFIRMED') {
        completedSwaps++;
        if (swap.route === 'onchain-to-ark') {
          onchainSentSats += swap.quote.invoiceSats;
          arkReceivedSats += swap.quote.netSats;
        } else {
          arkSentSats += swap.quote.invoiceSats;
          onchainReceivedSats += swap.quote.netSats;
        }
        collectedServiceFeesSats += swap.quote.serviceFeeSats;
        estimatedNetworkFeesSats += swap.quote.claimFeeSats;
      } else if (swap.status === 'REJECTED') {
        failedSwaps++;
      } else {
        pendingSwaps++;
      }
    }

    return ArkAdminReportResponse.parse({
      network: 'regtest',
      summary: {
        totalSwaps: all.length,
        completedSwaps,
        pendingSwaps,
        failedSwaps,
        onchainSentSats,
        onchainReceivedSats,
        arkSentSats,
        arkReceivedSats,
        collectedServiceFeesSats,
        estimatedNetworkFeesSats,
        netOperationalRevenueSats: collectedServiceFeesSats,
      },
      swaps: all.map(toPublicArkSwap),
    });
  }

  async submit(
    ownerId: string,
    idempotencyKey: string,
    request: z.infer<typeof import('../api/schemas.js').ArkSwapRequest>,
    now = Date.now(),
  ): Promise<ArkSwapRecord> {
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(idempotencyKey)) throw new Error('IDEMPOTENCY_KEY_REQUIRED');
    const fingerprint = JSON.stringify({ ownerId, request });
    const existing = [...this.swaps.values()].find(s => s.ownerId === ownerId && s.idempotencyKey === idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error('IDEMPOTENCY_KEY_CONFLICT');
      return structuredClone(existing);
    }
    const quote = this.getQuote(request.quoteId, now);
    if (!quote || quote.route !== request.route || quote.amountSats !== request.amountSats) {
      throw new Error('ARK_QUOTE_INVALID_OR_EXPIRED');
    }
    if ([...this.swaps.values()].some(s => s.quote.id === quote.id)) {
      throw new Error('ARK_QUOTE_ALREADY_CONSUMED');
    }
    const inputOutpoint = request.route === 'onchain-to-ark' ? request.fundingOutpoint : request.vtxoOutpoint;
    if (!inputOutpoint) throw new Error('ARK_OUTPOINT_INVALID');
    validateOutpoint(inputOutpoint);
    const destination = request.route === 'onchain-to-ark'
      ? (request.recipientArkAddress ? validateRegtestArkAddress(request.recipientArkAddress) : `${request.wallet} (Ark VTXO)`)
      : validateRegtestBech32Address(request.destinationAddress ?? '');
    if ([...this.swaps.values()].some(s => s.inputOutpoint === inputOutpoint && s.status !== 'REJECTED')) {
      throw new Error('ARK_INPUT_ALREADY_RESERVED');
    }

    if (!this.port) throw new Error('ARK_ADAPTER_NOT_CONFIGURED');

    const record: ArkSwapRecord = {
      id: randomUUID(),
      ownerId,
      idempotencyKey,
      fingerprint,
      network: 'regtest',
      route: request.route,
      method: quote.method,
      status: 'PREPARED',
      quote,
      inputOutpoint,
      destination,
      commitmentTxid: null,
      createdAt: now,
      updatedAt: now,
    };
    // Fence intent before calling adapter port so uncertain outcome is never re-submitted.
    this.swaps.set(record.id, structuredClone(record));
    await this.persist();
    try {
      const result = request.route === 'onchain-to-ark'
        ? await this.port.board({ wallet: request.wallet, fundingOutpoint: inputOutpoint, amountSats: request.amountSats })
        : await this.port.offboardCooperative({ vtxoOutpoint: inputOutpoint, destinationAddress: destination, amountSats: request.amountSats });
      record.commitmentTxid = result.commitmentTxid;
      record.status = result.commitmentTxid ? 'SUBMITTED' : 'UNCERTAIN';
      record.updatedAt = Date.now();
    } catch (error) {
      const msg = error instanceof Error ? error.message : '';
      const definitive = [
        'ARK_CLI_NOT_CONFIGURED',
        'ARK_OPERATOR_UNAVAILABLE',
        'ARK_INVALID_AMOUNT',
        'ARK_REGTEST_ADDRESS_REQUIRED',
        'ARK_REGTEST_OFFCHAIN_ADDRESS_REQUIRED',
        'ARK_OUTPOINT_INVALID',
      ].includes(msg);
      record.status = definitive ? 'REJECTED' : 'UNCERTAIN';
      record.updatedAt = Date.now();
    }
    this.swaps.set(record.id, structuredClone(record));
    await this.persist();
    return structuredClone(record);
  }
}

const outpointPattern = /^[a-f0-9]{64}:(0|[1-9][0-9]{0,8})$/;
const txidPattern = /^[a-f0-9]{64}$/;

export function isArkOnchainRoute(send: string, receive: string): boolean {
  return (send === 'onchain' && receive === 'ark') || (send === 'ark' && receive === 'onchain');
}

export function arkRouteFromPair(send: string, receive: string): ArkRouteKind | undefined {
  if (send === 'onchain' && receive === 'ark') return 'onchain-to-ark';
  if (send === 'ark' && receive === 'onchain') return 'ark-to-onchain';
  return undefined;
}

export function validateRegtestBech32Address(candidate: string): string {
  if (!candidate.startsWith('bcrt1')) throw new Error('ARK_REGTEST_ADDRESS_REQUIRED');
  address.toOutputScript(candidate, networks.regtest);
  return candidate;
}

export function validateRegtestArkAddress(candidate: string): string {
  if (!/^tark1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{20,140}$/.test(candidate)) {
    throw new Error('ARK_REGTEST_OFFCHAIN_ADDRESS_REQUIRED');
  }
  return candidate;
}

export function validateOutpoint(candidate: string): string {
  if (!outpointPattern.test(candidate)) throw new Error('ARK_OUTPOINT_INVALID');
  return candidate;
}

/**
 * Deterministic regtest quote calculation for Ark <-> On-chain routes.
 * Service fee: 500 + Math.ceil(amountSats * 0.005) sats (consistent with SwapManager.quote; 750 sats at 50,000 sats).
 * On-chain -> Ark (boarding): 262 sats est. commitment network fee.
 * Ark -> On-chain (cooperative offboarding): 241 sats est. commitment network fee.
 */
export function buildArkQuote(route: ArkRouteKind, amountSats: number, now = Date.now()): ArkQuote {
  if (!Number.isSafeInteger(amountSats) || amountSats < 10_000 || amountSats > 1_000_000) {
    throw new Error('Amount must be 10000..1000000 sats');
  }
  const serviceFeeSats = 500 + Math.ceil(amountSats * 0.005);
  const networkFeeSats = route === 'onchain-to-ark' ? 262 : 241;
  return ArkQuoteResponse.parse({
    id: randomUUID(),
    network: 'regtest',
    route,
    method: route === 'onchain-to-ark' ? 'boarding' : 'cooperative-offboarding',
    amountSats,
    serviceFeeSats,
    invoiceSats: amountSats + serviceFeeSats,
    fundingReserveSats: 0,
    claimFeeSats: networkFeeSats,
    netSats: amountSats - networkFeeSats,
    dustSats: 330,
    expiresAt: now + 120_000,
  });
}

export type ArkCliRunner = (args: string[]) => Promise<unknown>;

const cliBalanceWallet = z.object({
  confirmed_sats: z.number().int().nonnegative(),
  pre_confirmed_sats: z.number().int().nonnegative(),
  recoverable_sats: z.number().int().nonnegative(),
  pending_recovery_sats: z.number().int().nonnegative(),
  total_sats: z.number().int().nonnegative(),
}).strict();

const cliBalanceEnvelope = z.object({
  network: z.literal('regtest'),
  asset: z.literal('BTC'),
  wallets: z.object({
    alice: cliBalanceWallet.optional(),
    bob: cliBalanceWallet.optional(),
  }).strict(),
}).strict();

const cliVtxoRow = z.object({
  outpoint: z.string().regex(outpointPattern),
  amount_sats: z.number().int().nonnegative(),
  origin: z.enum(['ark_transfer', 'batch_leaf']),
  commitment_txids: z.array(z.string().regex(txidPattern)),
  is_spent: z.boolean(),
  is_unrolled: z.boolean(),
  is_swept: z.boolean(),
  is_expired: z.boolean(),
  created_at: z.number().int(),
  expires_at: z.number().int(),
  spent_by: z.string().regex(txidPattern).nullable(),
  ark_txid: z.string().regex(txidPattern).nullable(),
  settled_by: z.string().regex(txidPattern).nullable(),
}).strict();

const cliVtxoEnvelope = z.object({
  network: z.literal('regtest'),
  asset: z.literal('BTC'),
  wallets: z.object({
    alice: z.array(cliVtxoRow).optional(),
    bob: z.array(cliVtxoRow).optional(),
  }).strict(),
}).strict();

const cliBoardWallet = z.object({
  input: z.string().regex(outpointPattern),
  commitment_txid: z.string().regex(txidPattern).nullable(),
}).strict();

const cliBoardEnvelope = z.object({
  network: z.literal('regtest'),
  asset: z.literal('BTC'),
  wallets: z.object({
    alice: cliBoardWallet.optional(),
    bob: cliBoardWallet.optional(),
  }).strict(),
}).strict();

const cliOffboardEnvelope = z.object({
  network: z.literal('regtest'),
  asset: z.literal('BTC'),
  wallets: z.object({
    bob: z.object({
      input: z.string().regex(outpointPattern),
      address: z.string().refine(v => v.startsWith('bcrt1')),
      amount_sats: z.number().int().positive(),
      commitment_txid: z.string().regex(txidPattern),
      method: z.literal('cooperative'),
    }).strict(),
  }).strict(),
}).strict();

const operatorInfoResponse = z.object({
  network: z.literal('regtest'),
  version: z.string().min(1),
  signerPubkey: z.string().regex(/^(02|03)[a-f0-9]{64}$/),
  forfeitAddress: z.string().refine(v => v.startsWith('bcrt1')),
  dust: z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]),
  sessionDuration: z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]).optional(),
  unilateralExitDelay: z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]).optional(),
  boardingExitDelay: z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]).optional(),
});

const allowedCliCommands = new Set([
  'balance',
  'list-vtxos',
  'addresses',
  'board',
  'offboard-coop',
]);

/**
 * Safe, explicit child_process.execFile runner for ark-lab CLI.
 * Never uses a shell, validates binary ownership/path and allowlists arguments.
 */
export function createArkLabCliRunner(binaryPath: string, options: {
  e2eFixture?: boolean;
  timeoutMs?: number;
  exec?: typeof execFile;
} = {}): ArkCliRunner {
  if (!isAbsolute(binaryPath)) throw new Error('ARK_CLI_PATH_MUST_BE_ABSOLUTE');
  const runExec = promisify(options.exec ?? execFile);
  return async (args: string[]) => {
    const stat = await lstat(binaryPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('ARK_CLI_BINARY_INVALID');
    const [command, ...rest] = args;
    if (!command || !allowedCliCommands.has(command)) throw new Error('ARK_CLI_COMMAND_REJECTED');
    for (const arg of rest) {
      if (typeof arg !== 'string' || arg.length === 0 || arg.length > 160 || arg.startsWith('-')) {
        throw new Error('ARK_CLI_ARGUMENT_REJECTED');
      }
    }
    const finalArgs = options.e2eFixture ? ['--e2e-fixture', command, ...rest] : [command, ...rest];
    const { stdout } = await runExec(binaryPath, finalArgs, {
      timeout: options.timeoutMs ?? 30_000,
      maxBuffer: 256 * 1024,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' },
    });
    return JSON.parse(String(stdout));
  };
}

export interface ArkRegtestPort {
  telemetry(): Promise<ArkTelemetry>;
  board(params: { wallet: 'alice' | 'bob'; fundingOutpoint: string; amountSats: number }): Promise<{ commitmentTxid: string | null }>;
  offboardCooperative(params: { vtxoOutpoint: string; destinationAddress: string; amountSats: number }): Promise<{ commitmentTxid: string }>;
  vtxos(wallet: 'alice' | 'bob'): Promise<z.infer<typeof cliVtxoRow>[]>;
}

export function createArkRegtestCliPort(options: {
  cli?: ArkCliRunner;
  operatorInfoUrl?: string;
  fetchImpl?: typeof fetch;
} = {}): ArkRegtestPort {
  let infoUrl: URL;
  try {
    infoUrl = new URL(options.operatorInfoUrl ?? 'http://127.0.0.1:37070/v1/info');
  } catch {
    throw new Error('ARK_OPERATOR_LOOPBACK_REQUIRED');
  }
  if (
    infoUrl.protocol !== 'http:'
    || !['127.0.0.1', 'localhost'].includes(infoUrl.hostname)
    || infoUrl.username
    || infoUrl.password
    || infoUrl.search
    || infoUrl.hash
    || infoUrl.pathname !== '/v1/info'
  ) {
    throw new Error('ARK_OPERATOR_LOOPBACK_REQUIRED');
  }
  const fetchFn = options.fetchImpl ?? fetch;

  async function queryOperator() {
    try {
      const response = await fetchFn(infoUrl, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error('ARK_OPERATOR_UNAVAILABLE');
      const parsed = operatorInfoResponse.parse(await response.json());
      validateRegtestBech32Address(parsed.forfeitAddress);
      return {
        version: parsed.version,
        signerPubkey: parsed.signerPubkey,
        forfeitAddress: parsed.forfeitAddress,
        dustSats: Number(parsed.dust),
        sessionDurationSeconds: parsed.sessionDuration !== undefined ? Number(parsed.sessionDuration) : null,
        unilateralExitDelay: parsed.unilateralExitDelay !== undefined ? Number(parsed.unilateralExitDelay) : null,
        boardingExitDelay: parsed.boardingExitDelay !== undefined ? Number(parsed.boardingExitDelay) : null,
      };
    } catch {
      throw new Error('ARK_OPERATOR_UNAVAILABLE');
    }
  }

  return {
    async telemetry(): Promise<ArkTelemetry> {
      const capturedAt = new Date().toISOString();
      let operator: Awaited<ReturnType<typeof queryOperator>>;
      try {
        operator = await queryOperator();
      } catch {
        return ArkTelemetryResponse.parse({
          network: 'regtest',
          asset: 'BTC',
          capturedAt,
          operatorStatus: 'unavailable',
          cliConfigured: Boolean(options.cli),
          operator: null,
          wallets: null,
        });
      }
      const mapWallet = (w?: z.infer<typeof cliBalanceWallet>) => w ? {
        confirmedSats: w.confirmed_sats,
        preconfirmedSats: w.pre_confirmed_sats,
        recoverableSats: w.recoverable_sats,
        pendingRecoverySats: w.pending_recovery_sats,
        totalSats: w.total_sats,
      } : null;

      if (!options.cli) {
        return ArkTelemetryResponse.parse({
          network: 'regtest',
          asset: 'BTC',
          capturedAt,
          operatorStatus: 'ok',
          cliConfigured: false,
          operator,
          wallets: null,
        });
      }
      try {
        const raw = cliBalanceEnvelope.parse(await options.cli(['balance']));
        return ArkTelemetryResponse.parse({
          network: 'regtest',
          asset: 'BTC',
          capturedAt,
          operatorStatus: 'ok',
          cliConfigured: true,
          operator,
          wallets: {
            alice: mapWallet(raw.wallets.alice),
            bob: mapWallet(raw.wallets.bob),
          },
        });
      } catch {
        return ArkTelemetryResponse.parse({
          network: 'regtest',
          asset: 'BTC',
          capturedAt,
          operatorStatus: 'ok',
          cliConfigured: true,
          operator,
          wallets: null,
        });
      }
    },
    async board({ wallet, fundingOutpoint, amountSats }) {
      validateOutpoint(fundingOutpoint);
      if (!Number.isSafeInteger(amountSats) || amountSats < 330) throw new Error('ARK_INVALID_AMOUNT');
      if (!options.cli) throw new Error('ARK_CLI_NOT_CONFIGURED');
      const operator = await queryOperator();
      if (amountSats < Math.max(330, operator.dustSats)) throw new Error('ARK_INVALID_AMOUNT');
      const raw = cliBoardEnvelope.parse(await options.cli(['board', wallet, fundingOutpoint]));
      const entry = raw.wallets[wallet];
      if (!entry || entry.input !== fundingOutpoint) throw new Error('ARK_BOARD_RESPONSE_MISMATCH');
      return { commitmentTxid: entry.commitment_txid };
    },
    async offboardCooperative({ vtxoOutpoint, destinationAddress, amountSats }) {
      validateOutpoint(vtxoOutpoint);
      validateRegtestBech32Address(destinationAddress);
      if (!Number.isSafeInteger(amountSats) || amountSats < 330) throw new Error('ARK_INVALID_AMOUNT');
      if (!options.cli) throw new Error('ARK_CLI_NOT_CONFIGURED');
      const operator = await queryOperator();
      if (amountSats < Math.max(330, operator.dustSats)) throw new Error('ARK_INVALID_AMOUNT');
      const raw = cliOffboardEnvelope.parse(await options.cli(['offboard-coop', vtxoOutpoint, destinationAddress, String(amountSats)]));
      if (raw.wallets.bob.input !== vtxoOutpoint || raw.wallets.bob.address !== destinationAddress || raw.wallets.bob.amount_sats !== amountSats) {
        throw new Error('ARK_OFFBOARD_RESPONSE_MISMATCH');
      }
      return { commitmentTxid: raw.wallets.bob.commitment_txid };
    },
    async vtxos(wallet) {
      if (!options.cli) throw new Error('ARK_CLI_NOT_CONFIGURED');
      await queryOperator();
      const raw = cliVtxoEnvelope.parse(await options.cli(['list-vtxos', wallet]));
      return raw.wallets[wallet] ?? [];
    },
  };
}
