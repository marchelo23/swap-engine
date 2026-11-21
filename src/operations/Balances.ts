import { z } from 'zod';

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
};

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

async function collectLightning(client: LndBalanceReader): Promise<Pick<NodeBalance, 'localSats' | 'remoteSats'> | null> {
  const result = await read(LndChannels, () => client.call('/v1/channels'));
  if (!result) return null;
  const channels = result.channels ?? [];
  return {
    localSats: sumSats(channels.map(channel => lndToSats(channel.local_balance))),
    remoteSats: sumSats(channels.map(channel => lndToSats(channel.remote_balance))),
  };
}

async function collectNode(client: LndBalanceReader | null): Promise<NodeBalance | null> {
  if (!client || !await read(LndRegtest, () => client.call('/v1/getinfo'))) return null;
  const [onchain, lightning] = await Promise.all([collectOnchain(client), collectLightning(client)]);
  if (!onchain && !lightning) return null;
  return {
    confirmedSats: onchain?.confirmedSats ?? null,
    unconfirmedSats: onchain?.unconfirmedSats ?? null,
    localSats: lightning?.localSats ?? null,
    remoteSats: lightning?.remoteSats ?? null,
  };
}

export async function collectOperationsBalances(
  clients: OperationsBalancesClients,
  now = new Date(),
): Promise<OperationsBalances> {
  const [core, provider, alice] = await Promise.all([
    collectCore(clients.bitcoin),
    collectNode(clients.provider),
    collectNode(clients.alice),
  ]);
  return {
    network: 'regtest',
    capturedAt: now.toISOString(),
    core,
    provider,
    alice,
  };
}
