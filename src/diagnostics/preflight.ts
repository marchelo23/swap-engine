import { z } from 'zod';
import type { ApplicationMode } from '../config.js';

interface Rpc { call<T>(method: string, params?: unknown[], wallet?: boolean): Promise<T> }
interface Rest { call<T>(path: string): Promise<T> }
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const chainSchema = z.object({ chain: z.string(), blocks: count, headers: count,
  bestblockhash: hash, initialblockdownload: z.boolean() });
const infoSchema = z.object({ chains: z.array(z.object({ chain: z.string(), network: z.string() })),
  block_height: count, block_hash: hash, synced_to_chain: z.boolean(),
  wallet_synced: z.boolean().optional(), num_peers: count,
  version: z.string().optional(), commit_hash: z.string().optional() });

function failureReason(error: unknown) {
  const e = error as { code?: string; cause?: { code?: string }; message?: string } | null;
  const code = e?.code ?? e?.cause?.code;
  if (code === 'ENOENT') return 'credential_file_missing';
  if (code === 'EACCES' || code === 'EPERM') return 'credential_file_unreadable';
  if (code === 'ECONNREFUSED') return 'connection_refused';
  if (code === 'CERT_HAS_EXPIRED' || code === 'ERR_TLS_CERT_ALTNAME_INVALID' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT') return 'tls_verification_failed';
  if (/^(Bitcoin RPC|LND) HTTP (401|403)$/.test(e?.message ?? '')) return 'authentication_or_permission_rejected';
  return 'remote_or_configuration_error';
}

async function probe<T>(schema: z.ZodType<T>, read: () => Promise<unknown>) {
  try {
    const raw = await read();
    const parsed = schema.safeParse(raw);
    return parsed.success ? { status: 'ok' as const, reason: null, value: parsed.data }
      : { status: 'invalid_response' as const, reason: 'invalid_response', value: null };
  } catch (error) {
    // Never return remote messages, credential paths, raw responses or TLS details.
    return { status: 'unavailable' as const, reason: failureReason(error), value: null };
  }
}

export type PreflightMode = 'simulation-read-only' | 'regtest-read-only';

export function preflightMode(mode: ApplicationMode): PreflightMode {
  return mode === 'regtest' ? 'regtest-read-only' : 'simulation-read-only';
}

/** Connectivity and safety diagnostics only; never fixes node or wallet state. */
export async function preflight(bitcoin: Rpc, lnd: Rest, wallet: string, mode: ApplicationMode = 'simulation') {
  const [core, loaded, directory, lightning, channels, walletState, notifications] = await Promise.all([
    probe(chainSchema, () => bitcoin.call('getblockchaininfo')),
    probe(z.array(z.string()), () => bitcoin.call('listwallets')),
    probe(z.object({ wallets: z.array(z.object({ name: z.string() })) }), () => bitcoin.call('listwalletdir')),
    probe(infoSchema, () => lnd.call('/v1/getinfo')),
    probe(z.object({ channels: z.array(z.object({ active: z.boolean() })) }), () => lnd.call('/v1/channels')),
    probe(z.object({ state: z.enum(['NON_EXISTING', 'LOCKED', 'UNLOCKED', 'RPC_ACTIVE', 'SERVER_ACTIVE', 'WAITING_TO_START']) }), () => lnd.call('/v1/state')),
    probe(z.array(z.object({ type: z.string(), address: z.string() })), () => bitcoin.call('getzmqnotifications')),
  ]);
  const c = core.value;
  const l = lightning.value;
  const coreRegtest = c ? c.chain === 'regtest' : null;
  const lndRegtest = l ? l.chains.length === 1 && l.chains[0]?.chain === 'bitcoin' && l.chains[0]?.network === 'regtest' : null;
  const walletLoaded = loaded.value ? loaded.value.includes(wallet) : null;
  const foundOnDisk = directory.value ? directory.value.wallets.some(w => w.name === wallet) : null;
  const active = channels.value ? channels.value.channels.filter(c => c.active).length : null;
  const inactive = channels.value ? channels.value.channels.filter(c => !c.active).length : null;
  const tipsMatch = c && l ? c.blocks === l.block_height && c.bestblockhash === l.block_hash : null;
  // This pinned upstream implementation gates synced_to_chain on Wallet.IsSynced().
  // Unknown builds and an explicit negative wallet signal are not inferred away.
  const walletSyncSource = l?.wallet_synced !== undefined ? 'explicit' as const
    : l?.version === '0.20.8-beta commit=v0.20.8-beta' && l.commit_hash === '33f90e82464daf9e6d2f2a02e754955ba42e2951'
      ? 'lnd-v0.20.8-beta-chain-sync' as const : null;
  const walletSynced = l?.wallet_synced ?? (walletSyncSource && l?.synced_to_chain === true ? true : null);
  // These are the existing lab LND configurations, not addresses the app opens.
  const rawBlocks = notifications.value ? notifications.value.some(n => n.type === 'pubrawblock' && ['tcp://127.0.0.1:28332', 'tcp://0.0.0.0:28332'].includes(n.address)) : null;
  const rawTransactions = notifications.value ? notifications.value.some(n => n.type === 'pubrawtx' && ['tcp://127.0.0.1:28333', 'tcp://0.0.0.0:28333'].includes(n.address)) : null;
  const blockers: string[] = [];
  if (coreRegtest !== true) blockers.push(c ? 'CORE_NOT_REGTEST' : 'CORE_RPC_UNAVAILABLE_OR_INVALID');
  if (c?.blocks === 0) blockers.push('CORE_GENESIS_ONLY');
  if (c?.initialblockdownload !== false) blockers.push('CORE_SYNC_UNRESOLVED');
  if (c && c.blocks !== c.headers) blockers.push('CORE_HEADERS_AHEAD');
  if (rawBlocks !== true) blockers.push('CORE_RAW_BLOCK_NOTIFICATIONS_UNAVAILABLE');
  if (rawTransactions !== true) blockers.push('CORE_RAW_TX_NOTIFICATIONS_UNAVAILABLE');
  if (walletLoaded !== true) blockers.push(loaded.value ? 'WALLET_NOT_LOADED' : 'WALLET_LOADING_STATUS_UNAVAILABLE');
  if (foundOnDisk !== true) blockers.push(directory.value ? 'WALLET_NOT_FOUND_ON_DISK' : 'WALLET_DIRECTORY_UNAVAILABLE');
  if (lndRegtest !== true) blockers.push(l ? 'LND_NOT_REGTEST' : 'LND_REST_UNAVAILABLE_OR_INVALID');
  if (walletState.value?.state === 'LOCKED') blockers.push('LND_WALLET_LOCKED');
  else if (walletState.value?.state !== 'SERVER_ACTIVE') blockers.push('LND_SERVER_STATE_UNRESOLVED');
  if (l?.synced_to_chain !== true) blockers.push('LND_CHAIN_SYNC_UNRESOLVED');
  if (walletSynced !== true) blockers.push('LND_WALLET_SYNC_UNRESOLVED');
  if (tipsMatch !== true) blockers.push('CORE_LND_TIP_UNVERIFIED_OR_DIFFERENT');
  if (active === null) blockers.push('CHANNEL_STATUS_UNAVAILABLE');
  else if (active === 0) blockers.push('NO_ACTIVE_CHANNELS');
  if (l?.num_peers === 0) blockers.push('NO_LND_PEERS');
  return {
    mode: preflightMode(mode), network: 'regtest' as const,
    liveSwapsEnabled: false as const, signingEnabled: false as const,
    broadcastingEnabled: false as const, miningEnabled: false as const, paymentsEnabled: false as const,
    diagnosticsOk: [core, loaded, directory, lightning, channels, walletState, notifications].every(p => p.status === 'ok'),
    prerequisitesSatisfied: blockers.length === 0, blockers,
    bitcoin: { rpc: core.status, rpcReason: core.reason, regtest: coreRegtest, height: c?.blocks ?? null,
      headers: c?.headers ?? null, initialBlockDownload: c?.initialblockdownload ?? null,
      notificationsRpc: notifications.status, rawBlockNotifications: rawBlocks, rawTransactionNotifications: rawTransactions },
    wallet: { loadingRpc: loaded.status, loadingReason: loaded.reason, directoryRpc: directory.status, directoryReason: directory.reason, loaded: walletLoaded, foundOnDisk },
    lnd: { rest: lightning.status, restReason: lightning.reason, walletStateRpc: walletState.status, walletState: walletState.value?.state ?? null, regtest: lndRegtest, height: l?.block_height ?? null,
      syncedToChain: l?.synced_to_chain ?? null, walletSynced, walletSyncSource,
      peers: l?.num_peers ?? null, channelsRpc: channels.status, channelsReason: channels.reason, activeChannels: active, inactiveChannels: inactive },
    tipsMatch,
  };
}
