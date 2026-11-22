import { config } from '../src/config.js';
import { BitcoinRpcClient } from '../src/bitcoin/BitcoinRpcClient.js';
import { LndClient } from '../src/lightning/LndClient.js';
import { runRegtestDiagnostics } from '../src/diagnostics/RegtestDiagnostics.js';

const c = config();
const bitcoin = c.rails.onchain.enabled ? new BitcoinRpcClient(c.rails.onchain.url, c.rails.onchain.cookie, c.rails.onchain.wallet) : null;
const provider = c.rails.lightning.enabled ? new LndClient(c.rails.lightning.provider.url, c.rails.lightning.provider.cert, c.rails.lightning.provider.macaroon) : null;
const alice = c.rails.lightning.enabled && c.rails.lightning.alice
  ? new LndClient(c.rails.lightning.alice.url, c.rails.lightning.alice.cert, c.rails.lightning.alice.macaroon) : null;

const report = await runRegtestDiagnostics({ bitcoin, provider, alice });
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;
