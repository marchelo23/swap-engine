import { z } from 'zod';
import type { RailBalanceEntry } from '../core/RailContract.js';
import { collectLiquidBalances, type LiquidBalanceSnapshot, type LiquidBalanceSource } from '../liquid/LiquidBalances.js';

const CoreRegtest = z.object({ chain: z.literal('regtest') });
const LndRegtest = z.object({
  chains: z.tuple([z.object({ chain: z.literal('bitcoin'), network: z.literal('regtest') })]),
});
const LndSats = z.union([z.string(), z.number()]);

const CoreWalletBalances = z.object({
  mine: z.object({
    trusted: z.number().nonnegative(),
    untrusted_pending: z.number().nonnegative(),
  }),
});

const LndWalletBalances = z.object({
  confirmed_balance: LndSats,
  unconfirmed_balance: LndSats,
});

const LndChannel = z.object({
  active: z.boolean(),
  local_balance: LndSats,
  remote_balance: LndSats,
  capacity: LndSats.optional(),
});

const LndChannels = z.object({
  channels: z.array(LndChannel).optional(),
});

const MAX_SAFE_SATS = BigInt(Number.MAX_SAFE_INTEGER);

export type CoreBalance = {
  confirmedSats: number | null;
  unconfirmedSats: number | null;
};

export type NodeBalance = {
  confirmedSats: number | null;
  unconfirmedSats: number | null;
  localSats: number | null;
  remoteSats: number | null;
};

export type OperationsBalances = {
  network: 'regtest';
  capturedAt: string;
  core: CoreBalance;
  provider: NodeBalance | null;
  alice: NodeBalance | null;
  rails: RailBalanceEntry[];
  liquid?: LiquidBalanceSnapshot;
};

type NodeSnapshot = { legacy: NodeBalance; capacitySats: number | null };

export type BitcoinBalanceReader = {
  call<T>(method: string, params?: unknown[], wallet?: boolean): Promise<T>;
};

export type LndBalanceReader = {
  call<T>(path: string, body?: unknown): Promise<T>;
};

export type OperationsBalancesClients = {
  bitcoin: BitcoinBalanceReader | null;
  provider: LndBalanceReader | null;
  alice: LndBalanceReader | null;
  liquid?: LiquidBalanceSource | null;
};

async function read<T>(schema: z.ZodType<T>, call: () => Promise<unknown>): Promise<T | null> {
  try {
    return schema.parse(await call());
  } catch {
    return null;
  }
}

function btcToSats(value: number): number | null {
  if (!Number.isFinite(value) || value < 0) return null;
  const sats = Math.round(value * 1e8);
  return Number.isSafeInteger(sats) ? sats : null;
}

function lndToSats(value: string | number): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (!/^\d+$/.test(value)) return null;
  const sats = Number(value);
  return Number.isSafeInteger(sats) ? sats : null;
}

function sumSats(values: Array<number | null>): number | null {
  let total = 0n;
  for (const value of values) {
    if (value === null || !Number.isSafeInteger(value) || value < 0) return null;
    total += BigInt(value);
    if (total > MAX_SAFE_SATS) return null;
  }
  return Number(total);
}

async function collectCore(bitcoin: BitcoinBalanceReader | null): Promise<CoreBalance> {
  if (!bitcoin || !await read(CoreRegtest, () => bitcoin.call('getblockchaininfo'))) {
    return { confirmedSats: null, unconfirmedSats: null };
  }
  const result = await read(CoreWalletBalances, () => bitcoin.call('getbalances', [], true));
  if (!result) return { confirmedSats: null, unconfirmedSats: null };
  return {
    confirmedSats: btcToSats(result.mine.trusted),
    unconfirmedSats: btcToSats(result.mine.untrusted_pending),
  };
}

async function collectOnchain(client: LndBalanceReader): Promise<Pick<NodeBalance, 'confirmedSats' | 'unconfirmedSats'> | null> {
  const result = await read(LndWalletBalances, () => client.call('/v1/balance/blockchain'));
  if (!result) return null;
  return {
    confirmedSats: lndToSats(result.confirmed_balance),
    unconfirmedSats: lndToSats(result.unconfirmed_balance),
  };
}

async function collectLightning(client: LndBalanceReader): Promise<Pick<NodeBalance, 'localSats' | 'remoteSats'> & { capacitySats: number | null } | null> {
  const result = await read(LndChannels, () => client.call('/v1/channels'));
  if (!result) return null;
  const channels = result.channels ?? [];
  return {
    localSats: sumSats(channels.map(channel => lndToSats(channel.local_balance))),
    remoteSats: sumSats(channels.map(channel => lndToSats(channel.remote_balance))),
    capacitySats: sumSats(channels.map(channel => channel.capacity === undefined ? null : lndToSats(channel.capacity))),
  };
}

async function collectNode(client: LndBalanceReader | null): Promise<NodeSnapshot | null> {
  if (!client || !await read(LndRegtest, () => client.call('/v1/getinfo'))) return null;
  const [onchain, lightning] = await Promise.all([collectOnchain(client), collectLightning(client)]);
  if (!onchain && !lightning) return null;
  return {
    legacy: {
      confirmedSats: onchain?.confirmedSats ?? null,
      unconfirmedSats: onchain?.unconfirmedSats ?? null,
      localSats: lightning?.localSats ?? null,
      remoteSats: lightning?.remoteSats ?? null,
    },
    capacitySats: lightning?.capacitySats ?? null,
  };
}

function statusOf(values: Array<number | null>): 'available' | 'unavailable' | 'unknown' {
  if (values.every(value => value === null)) return 'unavailable';
  return values.every(value => value !== null) ? 'available' : 'unknown';
}
function railEntries(core: CoreBalance, provider: NodeSnapshot | null, alice: NodeSnapshot | null,
  liquid: LiquidBalanceSnapshot | null, liquidConfigured: boolean): RailBalanceEntry[] {
  const onchainCoreStatus = statusOf([core.confirmedSats, core.unconfirmedSats]);
  const entries: RailBalanceEntry[] = [{ rail: 'onchain', account: 'core', status: onchainCoreStatus,
    reason: onchainCoreStatus === 'available' ? null : onchainCoreStatus === 'unavailable' ? 'UNAVAILABLE' : 'UNAVAILABLE',
    balances: onchainCoreStatus === 'unavailable' ? null : { confirmedSats: core.confirmedSats, unconfirmedSats: core.unconfirmedSats } }];
  for (const [account, node] of [['provider', provider], ['alice', alice]] as const) {
    const values = node ? [node.legacy.confirmedSats, node.legacy.unconfirmedSats] : [null, null];
    const status = statusOf(values);
    entries.push({ rail: 'onchain', account, status, reason: status === 'available' ? null : 'UNAVAILABLE',
      balances: status === 'unavailable' ? null : { confirmedSats: values[0]!, unconfirmedSats: values[1]! } });
  }
  for (const [account, node] of [['provider', provider], ['alice', alice]] as const) {
    const values = node ? [node.legacy.localSats, node.legacy.remoteSats, node.capacitySats] : [null, null, null];
    const status = statusOf(values);
    entries.push({ rail: 'lightning', account, status, reason: status === 'available' ? null : 'UNAVAILABLE',
      balances: status === 'unavailable' ? null : { localSats: values[0]!, remoteSats: values[1]!, capacitySats: values[2]! } });
  }
  entries.push({ rail: 'ark', account: 'operator', status: 'unavailable', reason: 'NOT_CONFIGURED', balances: null });
  entries.push({ rail: 'liquid', account: 'operator', status: liquid ? 'available' : 'unavailable',
    reason: liquid ? null : liquidConfigured ? 'UNAVAILABLE' : 'NOT_CONFIGURED',
    balances: liquid ? { assetId: liquid.assetId, confirmedBaseUnits: liquid.confirmedBaseUnits,
      unconfirmedBaseUnits: liquid.unconfirmedBaseUnits, spendableBaseUnits: liquid.spendableBaseUnits,
      utxoCount: liquid.utxoCount } : null });
  return entries;
}

async function collectLiquid(source: LiquidBalanceSource | null | undefined): Promise<LiquidBalanceSnapshot | null> {
  if (!source) return null;
  try {
    return await collectLiquidBalances(source);
  } catch {
    return null;
  }
}

export async function collectOperationsBalances(
  clients: OperationsBalancesClients,
  now = new Date(),
): Promise<OperationsBalances> {
  const [core, provider, alice, liquid] = await Promise.all([
    collectCore(clients.bitcoin),
    collectNode(clients.provider),
    collectNode(clients.alice),
    collectLiquid(clients.liquid),
  ]);
  return {
    network: 'regtest',
    capturedAt: now.toISOString(),
    core,
    provider: provider?.legacy ?? null,
    alice: alice?.legacy ?? null,
    rails: railEntries(core, provider, alice, liquid, Boolean(clients.liquid)),
    ...(liquid ? { liquid } : {}),
  };
}
