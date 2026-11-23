import { config } from '../src/config.js';
import { ReadOnlyBitcoinClient } from '../src/diagnostics/ReadOnlyClients.js';
import { ElementsReadOnlyClient } from '../src/environment/ElementsReadOnlyClient.js';
import { liquidPreflight } from '../src/liquid/preflight.js';

try {
  const c = config();
  const liquid = c.rails.liquid; const bitcoin = c.rails.onchain;
  const report = await liquidPreflight(c, {
    elements: liquid.enabled ? new ElementsReadOnlyClient(liquid.rpcUrl, liquid.cookie, liquid.wallet) : undefined,
    bitcoin: bitcoin.enabled ? new ReadOnlyBitcoinClient(bitcoin.url, bitcoin.cookie, bitcoin.wallet) : undefined,
  });
  console.log(JSON.stringify(report, null, 2));
  // A completed diagnostic is not a successful swap-readiness check.
  process.exitCode = report.route.available ? 0 : 2;
} catch {
  console.error('LIQUID_PREFLIGHT_FAILED: invalid profile or unavailable read-only configuration');
  process.exitCode = 1;
}
