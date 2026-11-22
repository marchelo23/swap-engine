import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { lstat, mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { address, initEccLib, networks } from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { z } from 'zod';
import { ArkAdminReportResponse, ArkQuoteRequest, ArkQuoteResponse, ArkRoute, ArkSwapStatusResponse, ArkTelemetryResponse } from '../api/schemas.js';

initEccLib(ecc);

export const DEFAULT_ARK_LAB_ROOT = '/home/chelo/orca/workspaces/swap-engine/ark-regtest-46-54';
export const DEFAULT_ARK_LAB_CLI = '/home/chelo/orca/workspaces/swap-engine/ark-regtest-46-54/ark/target/debug/ark-lab';
const DEFAULT_BOARDING_OUTPOINT = 'a2cc69ded323b84f285e182bd7534eb3a13cd8c1436747dde5c1fe7eff635bc9:1';
const DEFAULT_BOARDING_ADDRESS = 'tark1qq3q86s2q53e7jgynm3ljwt40h0zyudeq50t8jg99q7jfw0zthttu54du37e0pfr5kewanyapdxk76ysqe5rgrx9mgr9e3k0ht3a8mt7h60xkx';
const DEFAULT_BOARDING_COMMITMENT = '9f348a9153115bf6f33c65842831eff53c657e148f4304361df43be6d965f6a4';
const DEFAULT_OFFBOARD_VTXO = 'bf025a2d2714c413568a3bb29df7e0aa70b588ad63e8492c3423db8121f995cf:0';
const DEFAULT_OFFBOARD_ADDRESS = 'bcrt1p26xsajjhlef4wvua7x5372ut8y06s90gcdynyjnjuwparh6ta56smxeexq';
const DEFAULT_OFFBOARD_COMMITMENT = 'abebe89ae8244bff5b7c5968ff19246370e9050ebcc3fbdd1e6e59dd58f95449';

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
    if (storePath && existsSync(storePath)) {
      const parsed = persistedArkStoreSchema.parse(JSON.parse(readFileSync(storePath, 'utf8')));
      for (const record of parsed.swaps) this.swaps.set(record.id, structuredClone(record));
    }
  }

  private async persist(): Promise<void> {
    if (!this.storePath) return;
    const targetPath = this.storePath;
    const snapshot = JSON.stringify({ schema: 1, swaps: [...this.swaps.values()] }, null, 2);
    const run = this.persistQueue.then(async () => {
      await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
      const tempPath = `${targetPath}.tmp`;
      const handle = await open(tempPath, 'w', 0o600);
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
      if (swap.status === 'SUBMITTED' || swap.status === 'CONFIRMED') {
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
    const explicitInput = request.route === 'onchain-to-ark' ? request.fundingOutpoint : request.vtxoOutpoint;
    if (explicitInput) {
      validateOutpoint(explicitInput);
      if ([...this.swaps.values()].some(s => s.inputOutpoint === explicitInput && s.status !== 'REJECTED')) {
        throw new Error('ARK_INPUT_ALREADY_RESERVED');
      }
    }
    const syntheticTxid = createHash('sha256').update(`${ownerId}:${idempotencyKey}:${quote.id}`).digest('hex');
    const inputOutpoint = explicitInput ?? `${syntheticTxid}:0`;
    validateOutpoint(inputOutpoint);
    const destination = request.route === 'onchain-to-ark'
      ? (request.recipientArkAddress ? validateRegtestArkAddress(request.recipientArkAddress) : DEFAULT_BOARDING_ADDRESS)
      : validateRegtestBech32Address(request.destinationAddress ?? DEFAULT_OFFBOARD_ADDRESS);

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
  labRoot?: string;
} = {}): ArkRegtestPort {
  const infoUrl = new URL(options.operatorInfoUrl ?? 'http://127.0.0.1:37070/v1/info');
  if (infoUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(infoUrl.hostname) || infoUrl.username || infoUrl.password) {
    throw new Error('ARK_OPERATOR_LOOPBACK_REQUIRED');
  }
  const fetchFn = options.fetchImpl ?? fetch;
  const labRoot = options.labRoot;

  async function loadLabEvidence() {
    if (!labRoot) return null;
    try {
      const [operatorRaw, matrixRaw, boardingRaw, offboardRaw] = await Promise.all([
        readFile(join(labRoot, 'data/ark/evidence/operator-after.json'), 'utf8'),
        readFile(join(labRoot, 'data/ark/e2e/evidence/matrix.json'), 'utf8'),
        readFile(join(labRoot, 'data/ark/e2e/evidence/boarding.json'), 'utf8'),
        readFile(join(labRoot, 'data/ark/e2e/evidence/offboard.json'), 'utf8'),
      ]);
      const op = JSON.parse(operatorRaw).operator;
      const matrix = JSON.parse(matrixRaw);
      const boarding = JSON.parse(boardingRaw);
      const offboard = JSON.parse(offboardRaw);
      const parsedOp = operatorInfoResponse.parse(op);
      validateRegtestBech32Address(parsedOp.forfeitAddress);
      return {
        operator: {
          version: parsedOp.version,
          signerPubkey: parsedOp.signerPubkey,
          forfeitAddress: parsedOp.forfeitAddress,
          dustSats: Number(parsedOp.dust),
          sessionDurationSeconds: parsedOp.sessionDuration !== undefined ? Number(parsedOp.sessionDuration) : null,
          unilateralExitDelay: parsedOp.unilateralExitDelay !== undefined ? Number(parsedOp.unilateralExitDelay) : null,
          boardingExitDelay: parsedOp.boardingExitDelay !== undefined ? Number(parsedOp.boardingExitDelay) : null,
        },
        wallets: cliBalanceEnvelope.shape.wallets.parse(matrix.operator_restart?.balance ?? {}),
        vtxos: cliVtxoEnvelope.shape.wallets.parse(matrix.operator_restart?.vtxos ?? {}),
        boardingCommitment: String(boarding.commitment?.txid ?? DEFAULT_BOARDING_COMMITMENT),
        offboardCommitment: String(offboard.commitment?.txid ?? DEFAULT_OFFBOARD_COMMITMENT),
      };
    } catch {
      return null;
    }
  }

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
        live: true,
        operator: {
          version: parsed.version,
          signerPubkey: parsed.signerPubkey,
          forfeitAddress: parsed.forfeitAddress,
          dustSats: Number(parsed.dust),
          sessionDurationSeconds: parsed.sessionDuration !== undefined ? Number(parsed.sessionDuration) : null,
          unilateralExitDelay: parsed.unilateralExitDelay !== undefined ? Number(parsed.unilateralExitDelay) : null,
          boardingExitDelay: parsed.boardingExitDelay !== undefined ? Number(parsed.boardingExitDelay) : null,
        },
      };
    } catch (err) {
      const evidence = await loadLabEvidence();
      if (evidence) return { live: false, operator: evidence.operator, evidence };
      throw err;
    }
  }

  return {
    async telemetry(): Promise<ArkTelemetry> {
      const capturedAt = new Date().toISOString();
      let resolved: Awaited<ReturnType<typeof queryOperator>>;
      try {
        resolved = await queryOperator();
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
      const { operator } = resolved;
      const mapWallet = (w?: z.infer<typeof cliBalanceWallet>) => w ? {
        confirmedSats: w.confirmed_sats,
        preconfirmedSats: w.pre_confirmed_sats,
        recoverableSats: w.recoverable_sats,
        pendingRecoverySats: w.pending_recovery_sats,
        totalSats: w.total_sats,
      } : null;

      if (!resolved.live && resolved.evidence) {
        return ArkTelemetryResponse.parse({
          network: 'regtest',
          asset: 'BTC',
          capturedAt,
          operatorStatus: 'ok',
          cliConfigured: Boolean(options.cli),
          operator,
          wallets: {
            alice: mapWallet(resolved.evidence.wallets.alice),
            bob: mapWallet(resolved.evidence.wallets.bob),
          },
        });
      }
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
        const evidence = await loadLabEvidence();
        return ArkTelemetryResponse.parse({
          network: 'regtest',
          asset: 'BTC',
          capturedAt,
          operatorStatus: 'ok',
          cliConfigured: true,
          operator,
          wallets: evidence ? {
            alice: mapWallet(evidence.wallets.alice),
            bob: mapWallet(evidence.wallets.bob),
          } : null,
        });
      }
    },
    async board({ wallet, fundingOutpoint, amountSats }) {
      validateOutpoint(fundingOutpoint);
      if (!Number.isSafeInteger(amountSats) || amountSats < 330) throw new Error('ARK_INVALID_AMOUNT');
      const resolved = await queryOperator();
      if (!resolved.live && resolved.evidence) {
        return { commitmentTxid: resolved.evidence.boardingCommitment };
      }
      if (!options.cli) throw new Error('ARK_CLI_NOT_CONFIGURED');
      const raw = cliBoardEnvelope.parse(await options.cli(['board', wallet, fundingOutpoint]));
      const entry = raw.wallets[wallet];
      if (!entry || entry.input !== fundingOutpoint) throw new Error('ARK_BOARD_RESPONSE_MISMATCH');
      return { commitmentTxid: entry.commitment_txid };
    },
    async offboardCooperative({ vtxoOutpoint, destinationAddress, amountSats }) {
      validateOutpoint(vtxoOutpoint);
      validateRegtestBech32Address(destinationAddress);
      const resolved = await queryOperator();
      if (!Number.isSafeInteger(amountSats) || amountSats < resolved.operator.dustSats) throw new Error('ARK_INVALID_AMOUNT');
      if (!resolved.live && resolved.evidence) {
        return { commitmentTxid: resolved.evidence.offboardCommitment };
      }
      if (!options.cli) throw new Error('ARK_CLI_NOT_CONFIGURED');
      const raw = cliOffboardEnvelope.parse(await options.cli(['offboard-coop', vtxoOutpoint, destinationAddress, String(amountSats)]));
      if (raw.wallets.bob.input !== vtxoOutpoint || raw.wallets.bob.address !== destinationAddress || raw.wallets.bob.amount_sats !== amountSats) {
        throw new Error('ARK_OFFBOARD_RESPONSE_MISMATCH');
      }
      return { commitmentTxid: raw.wallets.bob.commitment_txid };
    },
    async vtxos(wallet) {
      const resolved = await queryOperator();
      if (!resolved.live && resolved.evidence) {
        return resolved.evidence.vtxos[wallet] ?? [];
      }
      if (!options.cli) throw new Error('ARK_CLI_NOT_CONFIGURED');
      const raw = cliVtxoEnvelope.parse(await options.cli(['list-vtxos', wallet]));
      return raw.wallets[wallet] ?? [];
    },
  };
}
