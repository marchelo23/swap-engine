import { existsSync } from 'node:fs';
import { DEFAULT_ARK_LAB_CLI, DEFAULT_ARK_LAB_ROOT } from './ark/ArkAdapter.js';

export type ApplicationMode = 'simulation' | 'regtest';

const modeAliases: Record<string, ApplicationMode> = {
  simulation: 'simulation',
  simulated: 'simulation',
  regtest: 'regtest',
  'regtest-read-only': 'regtest',
  'regtest-readonly': 'regtest',
};

const rejectedMainnetModes = new Set(['mainnet', 'main', 'bitcoin', 'btc', 'live', 'production']);

export function applicationMode(value: string | undefined = process.env.APP_MODE): ApplicationMode {
  const normalized = (value ?? 'simulation').trim().toLowerCase();
  if (rejectedMainnetModes.has(normalized)) throw new Error('Mainnet is rejected; only simulation and regtest read-only modes are supported');
  const mode = modeAliases[normalized];
  if (!mode) throw new Error('Invalid application mode; expected simulation or regtest');
  return mode;
}

export function config(env: NodeJS.ProcessEnv = process.env) {
  if (env.ENABLE_LIVE_SWAPS && env.ENABLE_LIVE_SWAPS !== 'false') throw new Error('Live swap orchestration is unavailable in this component milestone');
  const mode = applicationMode(env.APP_MODE);
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  if (env.ENABLE_READ_ONLY_RECOVERY && !['true', 'false'].includes(env.ENABLE_READ_ONLY_RECOVERY)) throw new Error('Invalid read-only recovery flag');
  let recovery: { payerUrl: string; payerCert: string; payerMacaroon: string; payerNode: string; providerNode: string } | undefined;
  if (env.ENABLE_READ_ONLY_RECOVERY === 'true') {
    const required = (name: string) => { const value = env[name]; if (!value?.trim()) throw new Error('Read-only recovery configuration incomplete'); return value; };
    recovery = { payerUrl: required('RECOVERY_PAYER_REST_URL'), payerCert: required('RECOVERY_PAYER_TLS_CERT_PATH'),
      payerMacaroon: required('RECOVERY_PAYER_MACAROON_PATH'), payerNode: required('RECOVERY_PAYER_NODE_PUBKEY'),
      providerNode: required('RECOVERY_PROVIDER_NODE_PUBKEY') };
    let endpoint: URL;
    try { endpoint = new URL(recovery.payerUrl); } catch { throw new Error('Read-only recovery configuration invalid'); }
    if (endpoint.protocol !== 'https:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash || endpoint.pathname !== '/' ||
      !/^(02|03)[a-f0-9]{64}$/.test(recovery.payerNode) || !/^(02|03)[a-f0-9]{64}$/.test(recovery.providerNode) ||
      recovery.payerNode === recovery.providerNode) throw new Error('Read-only recovery configuration invalid');
  }
  const aliceUrl = env.ALICE_LND_REST_URL;
  const aliceCert = env.ALICE_LND_TLS_CERT_PATH;
  const aliceMacaroon = env.ALICE_LND_MACAROON_PATH;
  if ((aliceUrl || aliceCert || aliceMacaroon) && !(aliceUrl && aliceCert && aliceMacaroon)) {
    throw new Error('Alice LND requires a loopback HTTPS endpoint, TLS certificate path and read-only macaroon path');
  }
  return {
    mode, network: 'regtest' as const, readOnly: true as const,
    bitcoinUrl: env.BITCOIN_RPC_URL ?? 'http://127.0.0.1:18443',
    cookie: env.BITCOIN_COOKIE_PATH ?? '/home/truja/.bitcoin/regtest/.cookie',
    wallet: env.BITCOIN_WALLET ?? 'lqwd-lab',
    lndUrl: env.LND_REST_URL ?? 'https://127.0.0.1:8080',
    cert: env.LND_TLS_CERT_PATH ?? '/home/truja/.lnd/tls.cert',
    macaroon: env.LND_MACAROON_PATH ?? '/home/truja/.lnd/data/chain/bitcoin/regtest/readonly.macaroon',
    aliceLnd: aliceUrl && aliceCert && aliceMacaroon ? { url: aliceUrl, cert: aliceCert, macaroon: aliceMacaroon } : null,
    arkOperatorInfoUrl: env.ARK_OPERATOR_INFO_URL ?? 'http://127.0.0.1:37070/v1/info',
    arkCliBinaryPath: env.ARK_LAB_CLI_PATH ?? (existsSync(DEFAULT_ARK_LAB_CLI) ? DEFAULT_ARK_LAB_CLI : undefined),
    arkCliE2eFixture: env.ARK_LAB_E2E_FIXTURE === 'true',
    arkLabRoot: env.ARK_LAB_ROOT ?? (existsSync(DEFAULT_ARK_LAB_ROOT) ? DEFAULT_ARK_LAB_ROOT : undefined),
    directory: env.DATA_DIR ?? './data', port, recovery,
  };
}
