import { isAbsolute } from 'node:path';
import type { Capabilities, Environment, RailId, RailReason } from './core/RailContract.js';
import { environmentSchema } from './core/RailContract.js';
import { LEGACY_ECONOMICS, validateEconomics, type EconomicsConfig } from './core/Economics.js';
import { assertRegtestAddress } from './bitcoin/AddressPolicy.js';

export type ApplicationMode = 'simulation' | 'regtest';

const modeAliases: Record<string, ApplicationMode> = {
  simulation: 'simulation', simulated: 'simulation',
  regtest: 'regtest', 'regtest-read-only': 'regtest', 'regtest-readonly': 'regtest',
};
const rejectedMainnetModes = new Set(['mainnet', 'main', 'bitcoin', 'btc', 'live', 'production']);
const environmentAliases: Record<string, Environment> = {
  simulation: 'simulation', simulated: 'simulation', offline: 'simulation',
  regtest: 'regtest', 'regtest-read-only': 'regtest', 'regtest-readonly': 'regtest',
  signet: 'signet', mainnet: 'mainnet', main: 'mainnet', bitcoin: 'mainnet', btc: 'mainnet',
  'ark-regtest': 'ark-regtest', ark: 'ark-regtest',
  'liquid-regtest': 'liquid-regtest', liquid: 'liquid-regtest',
};

export function applicationMode(value: string | undefined = process.env.APP_MODE): ApplicationMode {
  const normalized = (value ?? 'simulation').trim().toLowerCase();
  if (rejectedMainnetModes.has(normalized)) throw new Error('Mainnet is rejected; only simulation and regtest read-only modes are supported');
  const mode = modeAliases[normalized];
  if (!mode) throw new Error('Invalid application mode; expected simulation or regtest');
  return mode;
}

export function environment(value: string | undefined): Environment {
  const normalized = (value ?? 'simulation').trim().toLowerCase();
  const selected = environmentAliases[normalized];
  if (!selected) throw new Error('Invalid environment; expected simulation, regtest, signet, mainnet, ark-regtest or liquid-regtest');
  return environmentSchema.parse(selected);
}

const BITCOIN_GENESIS: Record<'regtest' | 'signet' | 'mainnet', string> = {
  regtest: '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206',
  signet: '00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6',
  mainnet: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
};

export type OnchainRailConfig = { enabled: true; url: string; cookie: string; wallet: string } | { enabled: false };
export type LightningRailConfig = {
  enabled: true;
  provider: { url: string; cert: string; macaroon: string };
  alice: { url: string; cert: string; macaroon: string } | null;
} | { enabled: false };
export type ArkRailConfig = { enabled: true; operatorInfoUrl: string; expectedSignerPubkey: string;
  labRoot: string | null; cliPath: string | null; storePath: string | null; confirmationPolicy: 'disabled' | 'read-only';
  executionEnabled: boolean; executionOwner: string | null } | { enabled: false };
export type LiquidRailConfig = { enabled: true; rpcUrl: string; cookie: string; chainName: string;
  policyAsset: string; parentGenesisHash: string; genesisHash: string | null; wallet: string; confirmationPolicy: 'disabled' | 'read-only' } | { enabled: false };

export type RecoveryConfig = { payerUrl: string; payerCert: string; payerMacaroon: string;
  payerNode: string; providerNode: string };

export type Config = {
  environment: Environment;
  mode: ApplicationMode;
  network: 'regtest';
  readOnly: true;
  chain: { kind: 'bitcoin' | 'liquid' | 'ark'; name: string; genesisHash: string | null };
  bitcoinNetwork: 'regtest' | 'signet' | 'mainnet' | null;
  bitcoinGenesisHash: string | null;
  deploymentId: string | null;
  signetChallenge: string | null;
  allowLegacyOfflineMigration: boolean;
  features: { reverse: boolean; forward: boolean; guest: boolean; mining: boolean };
  reverseSwapExplicit: boolean;
  explicitFlags: {
    reverse: boolean | undefined;
    guest: boolean | undefined;
    forward: boolean | undefined;
    mining: boolean | undefined;
    liveSwaps: boolean | undefined;
    ark: boolean | undefined;
    arkExecution: boolean | undefined;
    liquid: boolean | undefined;
    liquidExecution: boolean | undefined;
    recovery: boolean | undefined;
    miningPolicy: string | undefined;
  };
  miningPolicy: 'disabled' | 'regtest-only';
  spendPolicy: 'disabled' | 'regtest-only';
  economics: EconomicsConfig;
  auth: { storePath: string | null; origin: string | null };
  legacy: { refundDestination: string | null; lndAdminMacaroonPath: string | null };
  rails: { onchain: OnchainRailConfig; lightning: LightningRailConfig; ark: ArkRailConfig; liquid: LiquidRailConfig };
  /** Legacy flat fields retained for existing clients and scripts. */
  bitcoinUrl: string; cookie: string; wallet: string;
  lndUrl: string; cert: string; macaroon: string;
  aliceLnd: { url: string; cert: string; macaroon: string } | null;
  directory: string; port: number; recovery: RecoveryConfig | undefined;
  capabilities(verified?: Partial<Record<RailId, boolean>>, now?: Date): Capabilities;
};

const loopbackHttp = (value: string) => {
  try { const url = new URL(value); return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
    !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash; } catch { return false; }
};
const loopbackHttpEndpoint = (value: string) => {
  try { const url = new URL(value); return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
    !url.username && !url.password && !url.search && !url.hash; } catch { return false; }
};
const loopbackHttps = (value: string) => {
  try { const url = new URL(value); return url.protocol === 'https:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
    !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash; } catch { return false; }
};
const absolutePath = (value: string) => isAbsolute(value) && value.length <= 4096;
const required = (env: NodeJS.ProcessEnv, name: string) => {
  const value = env[name]?.trim(); if (!value) throw new Error(`${name}_REQUIRED`); return value;
};
const optional = (env: NodeJS.ProcessEnv, name: string) => env[name]?.trim() || undefined;
const pick = (env: NodeJS.ProcessEnv, canonical: string, ...aliases: string[]) => {
  const values = [canonical, ...aliases].map(name => optional(env, name)).filter((value): value is string => value !== undefined);
  if (new Set(values).size > 1) throw new Error(`${canonical}_CONFLICT`);
  return values[0];
};
const allOrNone = (env: NodeJS.ProcessEnv, names: string[]) => {
  const values = names.map(name => optional(env, name));
  if (values.every(value => value === undefined)) return undefined;
  if (values.some(value => value === undefined)) throw new Error(`${names[0]}_CONFIGURATION_INCOMPLETE`);
  return values as string[];
};

function onchainRail(env: NodeJS.ProcessEnv): OnchainRailConfig {
  const values = allOrNone(env, ['BITCOIN_RPC_URL', 'BITCOIN_COOKIE_PATH', 'BITCOIN_WALLET']);
  if (!values) return { enabled: false };
  const [url, cookie, wallet] = values;
  if (!loopbackHttp(url!) || !absolutePath(cookie!) || !/^[A-Za-z0-9._-]{1,120}$/.test(wallet!))
    throw new Error('BITCOIN_RAIL_CONFIGURATION_INVALID');
  return { enabled: true, url: url!, cookie: cookie!, wallet: wallet! };
}
function lightningRail(env: NodeJS.ProcessEnv): LightningRailConfig {
  const provider = allOrNone(env, ['LND_REST_URL', 'LND_TLS_CERT_PATH', 'LND_MACAROON_PATH']);
  const alice = allOrNone(env, ['ALICE_LND_REST_URL', 'ALICE_LND_TLS_CERT_PATH', 'ALICE_LND_MACAROON_PATH']);
  if (!provider) {
    if (alice) throw new Error('LND_PROVIDER_CONFIGURATION_REQUIRED');
    return { enabled: false };
  }
  const [url, cert, macaroon] = provider;
  if (!loopbackHttps(url!) || !absolutePath(cert!) || !absolutePath(macaroon!)) throw new Error('LND_PROVIDER_CONFIGURATION_INVALID');
  if (alice && (!loopbackHttps(alice[0]!) || !absolutePath(alice[1]!) || !absolutePath(alice[2]!)))
    throw new Error('ALICE_LND_CONFIGURATION_INVALID');
  return { enabled: true, provider: { url: url!, cert: cert!, macaroon: macaroon! },
    alice: alice ? { url: alice[0]!, cert: alice[1]!, macaroon: alice[2]! } : null };
}
function arkRail(env: NodeJS.ProcessEnv): ArkRailConfig {
  if (env.ARK_LAB_E2E_FIXTURE !== undefined && env.ARK_LAB_E2E_FIXTURE !== 'false')
    throw new Error('ARK_LAB_E2E_FIXTURE_FORBIDDEN');
  const execution = optional(env, 'ARK_EXECUTION_ENABLED');
  if (execution !== undefined && !['true', 'false'].includes(execution)) throw new Error('ARK_EXECUTION_ENABLED_INVALID');
  const executionEnabled = execution === 'true';
  const executionOwner = optional(env, 'ARK_EXECUTION_OWNER') ?? null;
  if (executionOwner !== null && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(executionOwner))
    throw new Error('ARK_EXECUTION_OWNER_INVALID');
  if (executionOwner !== null && !executionEnabled) throw new Error('ARK_EXECUTION_OWNER_WITHOUT_EXECUTION');
  const legacyEnabled = optional(env, 'ARK_ENABLED');
  if (legacyEnabled !== undefined && !['true', 'false'].includes(legacyEnabled)) throw new Error('ARK_ENABLED_INVALID');
  const names = ['ARK_NETWORK', 'ARK_OPERATOR_URL', 'ARK_OPERATOR_INFO_URL', 'ARK_EXPECTED_SIGNER_PUBKEY',
    'ARK_SIGNER_PUBKEY', 'ARK_LAB_ROOT', 'ARK_CLI_PATH', 'ARK_LAB_CLI_PATH', 'ARK_STORE_PATH', 'ARK_CONFIRMATION_POLICY'];
  if (legacyEnabled === 'false') {
    if (executionEnabled) throw new Error('ARK_EXECUTION_DISABLED_CONFLICT');
    return { enabled: false };
  }
  if (legacyEnabled !== 'true' && !executionEnabled && !names.some(name => optional(env, name) !== undefined)) return { enabled: false };
  const network = required(env, 'ARK_NETWORK');
  if (network !== 'regtest') throw new Error('ARK_NETWORK_REGTEST_ONLY');
  const operatorInfoUrl = pick(env, 'ARK_OPERATOR_URL', 'ARK_OPERATOR_INFO_URL') ??
    (() => { throw new Error('ARK_OPERATOR_URL_REQUIRED'); })();
  const expectedSignerPubkey = pick(env, 'ARK_EXPECTED_SIGNER_PUBKEY', 'ARK_SIGNER_PUBKEY') ??
    (() => { throw new Error('ARK_EXPECTED_SIGNER_PUBKEY_REQUIRED'); })();
  const labRoot = optional(env, 'ARK_LAB_ROOT');
  const cliPath = pick(env, 'ARK_CLI_PATH', 'ARK_LAB_CLI_PATH');
  const storePath = optional(env, 'ARK_STORE_PATH');
  const confirmationRaw = (optional(env, 'ARK_CONFIRMATION_POLICY') ?? 'disabled').toLowerCase();
  if (!['disabled', 'read-only'].includes(confirmationRaw)) throw new Error('ARK_CONFIRMATION_POLICY_INVALID');
  if (!loopbackHttpEndpoint(operatorInfoUrl) || !/^(02|03)[a-f0-9]{64}$/.test(expectedSignerPubkey) ||
    (labRoot !== undefined && !absolutePath(labRoot)) || (cliPath !== undefined && !absolutePath(cliPath)) ||
    (storePath !== undefined && !absolutePath(storePath))) throw new Error('ARK_CONFIGURATION_INVALID');
  if (executionEnabled) {
    if (executionOwner === null) throw new Error('ARK_EXECUTION_OWNER_REQUIRED');
    if (cliPath === undefined) throw new Error('ARK_EXECUTION_CLI_REQUIRED');
    if (labRoot === undefined) throw new Error('ARK_EXECUTION_LAB_ROOT_REQUIRED');
    if (storePath === undefined) throw new Error('ARK_EXECUTION_STORE_REQUIRED');
  }
  return { enabled: true, operatorInfoUrl, expectedSignerPubkey,
    labRoot: labRoot ?? null, cliPath: cliPath ?? null, storePath: storePath ?? null,
    confirmationPolicy: confirmationRaw as 'disabled' | 'read-only', executionEnabled, executionOwner };
}
function liquidRail(env: NodeJS.ProcessEnv): LiquidRailConfig {
  const execution = optional(env, 'LIQUID_EXECUTION_ENABLED');
  if (execution !== undefined && !['true', 'false'].includes(execution)) throw new Error('LIQUID_EXECUTION_ENABLED_INVALID');
  if (execution === 'true') throw new Error('LIQUID_EXECUTION_FORBIDDEN');
  const legacyEnabled = optional(env, 'LIQUID_ENABLED');
  if (legacyEnabled !== undefined && !['true', 'false'].includes(legacyEnabled)) throw new Error('LIQUID_ENABLED_INVALID');
  const names = ['LIQUID_NETWORK', 'LIQUID_CHAIN_NAME', 'ELEMENTS_RPC_URL', 'LIQUID_RPC_URL',
    'ELEMENTS_WALLET', 'LIQUID_WALLET', 'ELEMENTS_COOKIE_PATH', 'LIQUID_COOKIE_PATH',
    'LIQUID_POLICY_ASSET', 'LIQUID_ASSET_ID', 'LIQUID_PARENT_GENESIS_HASH', 'LIQUID_CONFIRMATION_POLICY'];
  if (legacyEnabled === 'false') return { enabled: false };
  if (legacyEnabled !== 'true' && !names.some(name => optional(env, name) !== undefined)) return { enabled: false };
  const rpcUrl = pick(env, 'ELEMENTS_RPC_URL', 'LIQUID_RPC_URL') ??
    (() => { throw new Error('ELEMENTS_RPC_URL_REQUIRED'); })();
  const cookie = pick(env, 'ELEMENTS_COOKIE_PATH', 'LIQUID_COOKIE_PATH') ??
    (() => { throw new Error('ELEMENTS_COOKIE_PATH_REQUIRED'); })();
  const wallet = pick(env, 'ELEMENTS_WALLET', 'LIQUID_WALLET') ??
    (() => { throw new Error('ELEMENTS_WALLET_REQUIRED'); })();
  const chainName = pick(env, 'LIQUID_NETWORK', 'LIQUID_CHAIN_NAME') ??
    (() => { throw new Error('LIQUID_NETWORK_REQUIRED'); })();
  const policyAsset = (pick(env, 'LIQUID_POLICY_ASSET', 'LIQUID_ASSET_ID') ??
    (() => { throw new Error('LIQUID_POLICY_ASSET_REQUIRED'); })()).toLowerCase();
  const parentGenesisHash = required(env, 'LIQUID_PARENT_GENESIS_HASH').toLowerCase();
  const liquidGenesis = optional(env, 'LIQUID_GENESIS_HASH')?.toLowerCase() ?? null;
  if (liquidGenesis !== null && !/^[a-f0-9]{64}$/.test(liquidGenesis)) throw new Error('LIQUID_CONFIGURATION_INVALID');
  const confirmationRaw = (optional(env, 'LIQUID_CONFIRMATION_POLICY') ?? 'disabled').toLowerCase();
  if (!['disabled', 'read-only'].includes(confirmationRaw)) throw new Error('LIQUID_CONFIRMATION_POLICY_INVALID');
  if (!loopbackHttp(rpcUrl) || !absolutePath(cookie) || !/^[A-Za-z0-9._-]{1,120}$/.test(wallet) ||
    !/^[a-z0-9]+regtest$/.test(chainName) || !/^[a-f0-9]{64}$/.test(policyAsset) || !/^[a-f0-9]{64}$/.test(parentGenesisHash))
    throw new Error('LIQUID_CONFIGURATION_INVALID');
  return { enabled: true, rpcUrl, cookie, wallet, chainName, policyAsset, parentGenesisHash, genesisHash: liquidGenesis,
    confirmationPolicy: confirmationRaw as 'disabled' | 'read-only' };
}

function economicsConfig(env: NodeJS.ProcessEnv): EconomicsConfig {
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const raw = env[name]?.trim(); if (raw === undefined) return fallback;
    if (!/^[0-9]+$/.test(raw)) throw new Error(`${name}_INVALID`);
    const value = Number(raw); if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name}_OUT_OF_RANGE`);
    return value;
  };
  const seconds = (name: string, fallback: number) => integer(name, fallback, 30, 600) * 1_000;
  const fixed = (name: string, expected: number) => {
    const raw = env[name]?.trim(); if (raw === undefined) return expected;
    if ((!/^[0-9]+$/.test(raw) || Number(raw) !== expected)) throw new Error('PROTOCOL_POLICY_IMMUTABLE');
    return expected;
  };
  const quoteMin = integer('QUOTE_MIN_SATS', LEGACY_ECONOMICS.quote.minAmountSats, 10_000, 1_000_000);
  const quoteMax = integer('QUOTE_MAX_SATS', LEGACY_ECONOMICS.quote.maxAmountSats, quoteMin, 1_000_000);
  const invoiceMin = integer('INVOICE_MIN_SATS', LEGACY_ECONOMICS.invoice.minSats, 11_000, 50_000);
  const invoiceMax = integer('INVOICE_MAX_SATS', LEGACY_ECONOMICS.invoice.maxSats, invoiceMin, 50_000);
  const economics: EconomicsConfig = {
    quote: { minAmountSats: quoteMin, maxAmountSats: quoteMax,
      serviceFeeBaseSats: integer('QUOTE_SERVICE_FEE_BASE_SATS', LEGACY_ECONOMICS.quote.serviceFeeBaseSats, 0, 10_000),
      serviceFeeBps: integer('QUOTE_SERVICE_FEE_BPS', LEGACY_ECONOMICS.quote.serviceFeeBps, 0, 1_000),
      fundingReserveSats: integer('QUOTE_FUNDING_RESERVE_SATS', LEGACY_ECONOMICS.quote.fundingReserveSats, 0, 100_000),
      claimFeeSats: integer('QUOTE_CLAIM_FEE_SATS', LEGACY_ECONOMICS.quote.claimFeeSats, 0, 10_000),
      ttlMs: seconds('QUOTE_TTL_SECONDS', LEGACY_ECONOMICS.quote.ttlMs / 1_000) },
    invoice: { minSats: invoiceMin, maxSats: invoiceMax,
      serviceFeeBaseSats: integer('INVOICE_SERVICE_FEE_BASE_SATS', LEGACY_ECONOMICS.invoice.serviceFeeBaseSats, 0, 10_000),
      serviceFeeDivisor: integer('INVOICE_SERVICE_FEE_DIVISOR', LEGACY_ECONOMICS.invoice.serviceFeeDivisor, 1, 10_000),
      fundingReserveSats: integer('INVOICE_FUNDING_RESERVE_SATS', LEGACY_ECONOMICS.invoice.fundingReserveSats, 0, 100_000),
      claimFeeSats: integer('INVOICE_CLAIM_FEE_SATS', LEGACY_ECONOMICS.invoice.claimFeeSats, 0, 10_000),
      ttlMs: seconds('INVOICE_TTL_SECONDS', LEGACY_ECONOMICS.invoice.ttlMs / 1_000) },
    readiness: { confirmations: fixed('CONFIRMATIONS_REQUIRED', LEGACY_ECONOMICS.readiness.confirmations) as 1,
      maxBlocks: fixed('READINESS_MAX_BLOCKS', LEGACY_ECONOMICS.readiness.maxBlocks) as 2,
      timeoutMs: fixed('READINESS_TIMEOUT_MS', LEGACY_ECONOMICS.readiness.timeoutMs) as 90_000 },
  };
  validateEconomics(economics);
  return economics;
}
export function config(env: NodeJS.ProcessEnv = process.env): Config {
  const rawEnvironment = env.APP_ENV?.trim();
  const modeEnvironment = env.APP_MODE?.trim() ? environment(applicationMode(env.APP_MODE)) : undefined;
  const selectedEnvironment = rawEnvironment ? environment(rawEnvironment) : (modeEnvironment ?? 'simulation');
  if (rawEnvironment && modeEnvironment && environment(rawEnvironment) !== modeEnvironment)
    throw new Error('APP_ENVIRONMENT_CONFLICT');
  if (env.ENABLE_LIVE_SWAPS && env.ENABLE_LIVE_SWAPS !== 'false') throw new Error('Live swap orchestration is unavailable in this component milestone');
  for (const flag of ['ENABLE_MAINNET_EXECUTION', 'ALLOW_MAINNET_EXECUTION', 'ALLOW_MAINNET_SIGNING', 'ALLOW_MAINNET_MINING'])
    if (env[flag] && env[flag] !== 'false') throw new Error('MAINNET_EXECUTION_FORBIDDEN');
  const mode: ApplicationMode = selectedEnvironment === 'regtest' ? 'regtest' : 'simulation';
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  const deploymentId = optional(env, 'DEPLOYMENT_ID');
  if (selectedEnvironment !== 'simulation' && !deploymentId) throw new Error('DEPLOYMENT_ID_REQUIRED');
  const migration = env.ALLOW_LEGACY_STATE_MIGRATION?.trim();
  if (migration !== undefined && migration !== 'offline-regtest') throw new Error('STATE_SCOPE_MIGRATION_FLAG_INVALID');
  const allowLegacyOfflineMigration = migration === 'offline-regtest';
  const signetChallenge = selectedEnvironment === 'signet' ? required(env, 'SIGNET_CHALLENGE') : null;
  if (signetChallenge !== null && !/^[0-9a-f]{1,200}$/.test(signetChallenge)) throw new Error('SIGNET_CHALLENGE_INVALID');
  if (deploymentId && !/^[A-Za-z0-9._-]{1,64}$/.test(deploymentId)) throw new Error('DEPLOYMENT_ID_INVALID');
  for (const name of ['ENABLE_REVERSE_EXECUTION', 'FEATURE_REVERSE_EXECUTION', 'ENABLE_FORWARD_EXECUTION',
    'FEATURE_FORWARD_EXECUTION', 'ENABLE_GUEST_EXECUTION', 'FEATURE_GUEST_EXECUTION', 'ENABLE_MINING', 'FEATURE_MINING'])
    if (env[name] && env[name] !== 'false') throw new Error('FEATURE_EXECUTION_DISABLED');
  const exactFlag = (name: string) => {
    const raw = env[name]?.trim(); if (raw === undefined) return undefined;
    if (!['true', 'false'].includes(raw)) throw new Error(`${name}_INVALID`); return raw === 'true';
  };
  const reverseExplicit = exactFlag('REVERSE_SWAP_ENABLED');
  const guestExplicit = exactFlag('GUEST_SWAP_ENABLED');
  const forwardExplicit = exactFlag('FORWARD_SWAP_ENABLED');
  const miningExplicit = exactFlag('REGTEST_AUTO_MINING');
  const liveSwapsExplicit = exactFlag('ENABLE_LIVE_SWAPS');
  const arkExplicit = exactFlag('ARK_ENABLED');
  const arkExecutionExplicit = exactFlag('ARK_EXECUTION_ENABLED');
  const liquidExplicit = exactFlag('LIQUID_ENABLED');
  const liquidExecutionExplicit = exactFlag('LIQUID_EXECUTION_ENABLED');
  const recoveryExplicit = exactFlag('ENABLE_READ_ONLY_RECOVERY');
  const miningPolicyExplicit = optional(env, 'MINING_POLICY')?.toLowerCase();
  const reverseSwapExplicit = reverseExplicit !== undefined;
  const features = { guest: guestExplicit ?? false,
    reverse: reverseExplicit ?? true,
    forward: forwardExplicit ?? false, mining: miningExplicit ?? false };
  const explicitFlags = {
    reverse: reverseExplicit,
    guest: guestExplicit,
    forward: forwardExplicit,
    mining: miningExplicit,
    liveSwaps: liveSwapsExplicit,
    ark: arkExplicit,
    arkExecution: arkExecutionExplicit,
    liquid: liquidExplicit,
    liquidExecution: liquidExecutionExplicit,
    recovery: recoveryExplicit,
    miningPolicy: miningPolicyExplicit,
  };
  if ([guestExplicit, reverseExplicit, forwardExplicit, miningExplicit].some(value => value === true) && selectedEnvironment !== 'regtest')
    throw new Error('FEATURE_REGTEST_ONLY');
  const miningRaw = (env.MINING_POLICY ?? 'disabled').trim().toLowerCase();
  if (!['disabled', 'regtest-only'].includes(miningRaw)) throw new Error('MINING_POLICY_INVALID');
  const miningPolicy = miningRaw as 'disabled' | 'regtest-only';
  if (miningPolicy === 'regtest-only' && (selectedEnvironment !== 'regtest' || mode !== 'regtest')) throw new Error('MINING_POLICY_REGTEST_ONLY');
  const spendRaw = (env.SPEND_POLICY ?? (env.ENABLE_REGTEST_SPENDING === 'true' ? 'regtest-only' : 'disabled')).trim().toLowerCase();
  if (!['disabled', 'regtest-only'].includes(spendRaw)) throw new Error('SPEND_POLICY_INVALID');
  const spendPolicy = spendRaw as 'disabled' | 'regtest-only';
  if (spendPolicy === 'regtest-only' && (selectedEnvironment !== 'regtest' || mode !== 'regtest'))
    throw new Error('SPEND_POLICY_REGTEST_ONLY');
  if (env.ENABLE_READ_ONLY_RECOVERY && !['true', 'false'].includes(env.ENABLE_READ_ONLY_RECOVERY)) throw new Error('Invalid read-only recovery flag');
  let recovery: RecoveryConfig | undefined;
  if (env.ENABLE_READ_ONLY_RECOVERY === 'true') {
    const recoveryRequired = (name: string) => {
      const value = env[name]?.trim(); if (!value) throw new Error('Read-only recovery configuration incomplete'); return value;
    };
    const values = ['RECOVERY_PAYER_REST_URL', 'RECOVERY_PAYER_TLS_CERT_PATH', 'RECOVERY_PAYER_MACAROON_PATH',
      'RECOVERY_PAYER_NODE_PUBKEY', 'RECOVERY_PROVIDER_NODE_PUBKEY'].map(recoveryRequired);
    const [payerUrl, payerCert, payerMacaroon, payerNode, providerNode] = values;
    let endpoint: URL;
    try { endpoint = new URL(payerUrl!); } catch { throw new Error('Read-only recovery configuration invalid'); }
    if (!loopbackHttps(payerUrl!) || !absolutePath(payerCert!) || !absolutePath(payerMacaroon!) ||
      endpoint.origin !== payerUrl || !/^(02|03)[a-f0-9]{64}$/.test(payerNode!) ||
      !/^(02|03)[a-f0-9]{64}$/.test(providerNode!) || payerNode === providerNode)
      throw new Error('Read-only recovery configuration invalid');
    recovery = { payerUrl: payerUrl!, payerCert: payerCert!, payerMacaroon: payerMacaroon!, payerNode: payerNode!, providerNode: providerNode! };
  }
  const authStorePath = optional(env, 'AUTH_STORE_PATH') ?? null;
  const authOriginRaw = optional(env, 'AUTH_ORIGIN');
  let authOrigin: string | null = null;
  if (authOriginRaw !== undefined) {
    try {
      const parsed = new URL(authOriginRaw);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== authOriginRaw) throw new Error();
      authOrigin = authOriginRaw;
    } catch { throw new Error('AUTH_ORIGIN_INVALID'); }
  }
  const refundDestination = optional(env, 'REFUND_DESTINATION') ?? null;
  if (refundDestination) assertRegtestAddress(refundDestination);
  const lndAdminMacaroonPath = optional(env, 'LND_ADMIN_MACAROON_PATH') ?? null;
  if (lndAdminMacaroonPath !== null && !isAbsolute(lndAdminMacaroonPath))
    throw new Error('LND_ADMIN_MACAROON_PATH_INVALID');
  const auth = { storePath: authStorePath, origin: authOrigin };
  const legacy = { refundDestination, lndAdminMacaroonPath };
  const economics = economicsConfig(env);
  const onchain = onchainRail(env); const lightning = lightningRail(env);
  if (recovery && (!onchain.enabled || !lightning.enabled)) throw new Error('RECOVERY_RAILS_REQUIRED');
  const ark = arkRail(env); const liquid = liquidRail(env);
  if (ark.enabled && ark.executionEnabled && selectedEnvironment !== 'regtest' && selectedEnvironment !== 'ark-regtest')
    throw new Error('ARK_EXECUTION_REGTEST_ONLY');
  const directory = env.DATA_DIR?.trim() || './data';
  const bitcoinNetwork = selectedEnvironment === 'regtest' || selectedEnvironment === 'ark-regtest' || selectedEnvironment === 'liquid-regtest'
    ? 'regtest' as const : selectedEnvironment === 'signet' ? 'signet' as const : selectedEnvironment === 'mainnet' ? 'mainnet' as const : null;
  const bitcoinGenesisHash = bitcoinNetwork ? BITCOIN_GENESIS[bitcoinNetwork] : null;
  const chain = selectedEnvironment === 'liquid-regtest'
    ? { kind: 'liquid' as const, name: liquid.enabled ? liquid.chainName : 'liquid-regtest', genesisHash: liquid.enabled ? liquid.genesisHash : null }
    : selectedEnvironment === 'ark-regtest'
      ? { kind: 'ark' as const, name: 'regtest', genesisHash: null }
      : { kind: 'bitcoin' as const, name: selectedEnvironment,
        genesisHash: selectedEnvironment === 'simulation' ? null : BITCOIN_GENESIS[selectedEnvironment] };
  const verification: Partial<Record<RailId, boolean>> = {};
  const capabilities = (verified: Partial<Record<RailId, boolean>> = verification, now = new Date()): Capabilities => {
    const rail = (id: RailId, configured: boolean): { id: RailId; configured: boolean; verified: boolean; available: boolean; reason: RailReason | null } => {
      const isVerified = configured && verified[id] === true;
      return { id, configured, verified: isVerified, available: isVerified,
        reason: !configured ? 'NOT_CONFIGURED' : isVerified ? null : 'NOT_VERIFIED' };
    };
    return { schemaVersion: 1, environment: selectedEnvironment, chain, readOnly: true,
      execution: { enabled: false, policy: spendPolicy,
        reason: spendPolicy === 'regtest-only' ? 'DISABLED' : 'DISABLED' },
      rails: { onchain: rail('onchain', onchain.enabled), lightning: rail('lightning', lightning.enabled),
        ark: rail('ark', ark.enabled), liquid: rail('liquid', liquid.enabled) }, capturedAt: now.toISOString() };
  };
  return {
    environment: selectedEnvironment, mode, network: 'regtest', readOnly: true, chain, bitcoinNetwork, bitcoinGenesisHash,
    deploymentId: deploymentId ?? null, signetChallenge, allowLegacyOfflineMigration, features, reverseSwapExplicit, explicitFlags, miningPolicy, spendPolicy, economics, auth, legacy, rails: { onchain, lightning, ark, liquid },
    bitcoinUrl: onchain.enabled ? onchain.url : '', cookie: onchain.enabled ? onchain.cookie : '',
    wallet: onchain.enabled ? onchain.wallet : '',
    lndUrl: lightning.enabled ? lightning.provider.url : '', cert: lightning.enabled ? lightning.provider.cert : '',
    macaroon: lightning.enabled ? lightning.provider.macaroon : '', aliceLnd: lightning.enabled ? lightning.alice : null,
    directory, port, recovery, capabilities,
  };
}
