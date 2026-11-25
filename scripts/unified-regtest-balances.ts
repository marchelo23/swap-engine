import { OperationsBalancesResponse } from '../src/api/schemas.js';
import { createArkLabCliRunner, createArkRegtestCliPort } from '../src/ark/ArkAdapter.js';
import { config } from '../src/config.js';
import { ElementsReadOnlyClient } from '../src/environment/ElementsReadOnlyClient.js';
import { collectLiquidBalances } from '../src/liquid/LiquidBalances.js';
import type { RailBalanceEntry } from '../src/core/RailContract.js';

type Owner = 'alice' | 'provider';
const owners = ['alice', 'provider'] as const;

export function createRegtestBalanceExtension(env: NodeJS.ProcessEnv) {
  const liquidWallets = { alice: env.UNIFIED_LIQUID_ALICE_WALLET, provider: env.UNIFIED_LIQUID_PROVIDER_WALLET };
  const arkWallets = { alice: env.UNIFIED_ARK_ALICE_WALLET, provider: env.UNIFIED_ARK_PROVIDER_WALLET };
  if (!owners.some(owner => liquidWallets[owner] || arkWallets[owner])) return undefined;
  const c = config(env);
  if (!['regtest', 'liquid-regtest'].includes(c.environment) || c.spendPolicy !== 'disabled')
    throw new Error('Unified balance sources require a read-only regtest profile');
  const liquid = c.rails.liquid;
  const ark = c.rails.ark;
  if (liquidWallets.alice && liquidWallets.alice === liquidWallets.provider)
    throw new Error('Liquid balance owners require separate wallets');
  if (arkWallets.alice && arkWallets.alice === arkWallets.provider)
    throw new Error('Ark balance owners require separate wallets');
  if (owners.some(owner => liquidWallets[owner] && !/^[A-Za-z0-9._-]{1,120}$/.test(liquidWallets[owner]!)))
    throw new Error('Invalid Liquid wallet name');
  if (owners.some(owner => arkWallets[owner] && !['alice', 'bob'].includes(arkWallets[owner]!)))
    throw new Error('Ark wallet names must be alice or bob');
  if (owners.some(owner => liquidWallets[owner]) &&
    (!liquid.enabled || !liquid.genesisHash || liquid.parentGenesisHash !== c.bitcoinGenesisHash))
    throw new Error('Liquid balance owners require an explicit Elements and Bitcoin regtest identity');
  if (owners.some(owner => arkWallets[owner]) && (!ark.enabled || !ark.cliPath || !ark.labRoot))
    throw new Error('Ark balance owners require a read-only Ark regtest CLI');

  const arkPort = ark.enabled && ark.cliPath && ark.labRoot && owners.some(owner => arkWallets[owner])
    ? createArkRegtestCliPort({ operatorInfoUrl: ark.operatorInfoUrl, expectedSignerPubkey: ark.expectedSignerPubkey,
      cli: createArkLabCliRunner(ark.cliPath, { cwd: ark.labRoot, readOnly: true }) })
    : undefined;

  return async (raw: unknown) => {
    const report = OperationsBalancesResponse.parse(raw);
    const telemetry = arkPort?.telemetry().catch(() => undefined);
    const liquidSnapshots = await Promise.all(owners.map(async owner => {
      const wallet = liquidWallets[owner];
      if (!wallet || !liquid.enabled || !liquid.genesisHash) return undefined;
      return collectLiquidBalances({
        reader: new ElementsReadOnlyClient(liquid.rpcUrl, liquid.cookie, wallet), wallet,
        chainName: liquid.chainName, policyAsset: liquid.policyAsset, genesisHash: liquid.genesisHash,
        parentGenesisHash: liquid.parentGenesisHash,
      }).catch(() => undefined);
    }));
    const arkSnapshot = await telemetry;
    const entries: RailBalanceEntry[] = [];
    for (const [index, owner] of owners.entries()) {
      const wallet = arkWallets[owner];
      if (wallet === 'alice' || wallet === 'bob') {
        const balance = arkSnapshot?.operatorStatus === 'ok' ? arkSnapshot.wallets?.[wallet] : undefined;
        entries.push({ rail: 'ark', account: owner, status: balance ? 'available' : 'unavailable',
          reason: balance ? null : 'UNAVAILABLE', balances: balance ? {
            spendableSats: balance.confirmedSats, pendingSats: balance.preconfirmedSats,
            recoverableSats: balance.recoverableSats,
          } : null });
      }
      if (liquidWallets[owner]) {
        const balance = liquidSnapshots[index];
        entries.push({ rail: 'liquid', account: owner, status: balance ? 'available' : 'unavailable',
          reason: balance ? null : 'UNAVAILABLE', balances: balance ? {
            assetId: balance.assetId, confirmedSats: balance.confirmedBaseUnits, unconfirmedSats: balance.unconfirmedBaseUnits,
          } : null });
      }
    }
    return OperationsBalancesResponse.parse({ ...report, liquid: liquidWallets.provider ? liquidSnapshots[1] : report.liquid,
      rails: [...report.rails.filter(row => !entries.some(entry => entry.rail === row.rail && entry.account === row.account)), ...entries] });
  };
}
