import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { assertRegtestAddress } from '../src/bitcoin/AddressPolicy.js';
import { config } from '../src/config.js';
import { ReadOnlyBitcoinClient, ReadOnlyLndClient } from '../src/diagnostics/ReadOnlyClients.js';
import { LndClient } from '../src/lightning/LndClient.js';
import { Store } from '../src/persistence/Store.js';
import { SwapManager } from '../src/core/SwapManager.js';
import { SwapCoordinator } from '../src/core/SwapCoordinator.js';
import { invoiceOnlyPorts } from '../src/core/InvoiceOnlyPorts.js';
import { verifyReverseTestPlan } from '../src/core/ReverseTestPlan.js';
import { SecretVault } from '../src/persistence/SecretVault.js';
import { RefundKeyVault } from '../src/bitcoin/RefundKeyVault.js';
import { ClaimWallet } from '../src/client/ClaimWallet.js';
import { preflight } from '../src/diagnostics/preflight.js';
import { QuoteResponse } from '../src/api/schemas.js';

const args = process.argv.slice(2);
if (args[0] !== '--approved-create-invoice-only' || args[1] !== '--plan-sha256' || !/^[a-f0-9]{64}$/.test(args[2] ?? '') || args.length !== 3) {
  console.error('Requires explicit approval: --approved-create-invoice-only --plan-sha256 <reviewed-checksum>. Never pays or funds.'); process.exitCode = 1;
} else {
  const c = config(); const password = readFileSync(0);
  let n = password.length; while (n && (password[n - 1] === 10 || password[n - 1] === 13)) n--;
  let clientVault: SecretVault | undefined; let providerVault: SecretVault | undefined; let client: ClaimWallet | undefined; let store: Store | undefined;
  try {
    const bytes = await readFile(join(c.directory, 'reverse-test-plan.json'));
    if (createHash('sha256').update(bytes).digest('hex') !== args[2]) throw new Error('Approved plan checksum mismatch');
    const plan = verifyReverseTestPlan(JSON.parse(bytes.toString()));
    clientVault = await SecretVault.open(join(c.directory, 'client-secrets'), password.subarray(0, n));
    providerVault = await SecretVault.open(join(c.directory, 'provider-refund-keys'), password.subarray(0, n)); password.fill(0);
    client = await ClaimWallet.restore(clientVault, plan.contract.paymentHash);
    if (client.claimPublicKey !== plan.contract.claimPublicKey || await new RefundKeyVault(providerVault).publicKey(plan.contract.paymentHash) !== plan.contract.refundPublicKey) throw new Error('Durable key identity mismatch');
    const bitcoin = new ReadOnlyBitcoinClient(c.bitcoinUrl, c.cookie, c.wallet);
    const refundDestination = process.env.REFUND_DESTINATION?.trim();
    if (!refundDestination || !c.aliceLnd || plan.wallet !== c.wallet ||
      plan.routing.bitcoinOrigin !== new URL(c.bitcoinUrl).origin ||
      plan.routing.providerOrigin !== new URL(c.lndUrl).origin ||
      plan.routing.payerOrigin !== new URL(c.aliceLnd.url).origin ||
      plan.refundDestination !== refundDestination) throw new Error('PLAN_BINDING_MISMATCH');
    assertRegtestAddress(refundDestination);
    z.object({ ismine: z.literal(true) }).parse(await bitcoin.call('getaddressinfo', [refundDestination], true));
    class InvoiceCreationClient extends LndClient {
      override call<T>(path: string, body?: unknown): Promise<T> {
        const allowedGet = body === undefined && (path === '/v1/getinfo' || path === '/v1/channels' || path === '/v1/state' || /^\/v1\/invoice\/[a-f0-9]{64}$/.test(path));
        if (!allowedGet && !(body !== undefined && path === '/v2/invoices/hodl')) return Promise.reject(new Error('Invoice-only RPC denied'));
        return super.call<T>(path, body);
      }
    }
    const adminMacaroon = process.env.LND_ADMIN_MACAROON_PATH?.trim();
    if (!adminMacaroon || !isAbsolute(adminMacaroon) || !c.aliceLnd) throw new Error('LEGACY_ACTION_CREDENTIALS_REQUIRED');
    const provider = new InvoiceCreationClient(c.lndUrl, c.cert, adminMacaroon);
    const payer = new ReadOnlyLndClient(c.aliceLnd.url, c.aliceLnd.cert, c.aliceLnd.macaroon);
    const readiness = await Promise.all([preflight(bitcoin, provider, c.wallet), preflight(bitcoin, payer, c.wallet)]);
    if (readiness.some(r => !r.prerequisitesSatisfied)) throw new Error('Readiness unresolved');
    store = await Store.open(join(c.directory, 'approved-reverse-test')); const manager = new SwapManager(store);
    let swap = Object.values(store.read().swaps).find(s => s.contract.paymentHash === plan.contract.paymentHash);
    if (!swap) {
      const response = await fetch(`http://127.0.0.1:${c.port}/v1/quotes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"amountSats":50000}', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('Quote unavailable');
      const quote = QuoteResponse.parse(await response.json());
      for (const key of ['amountSats', 'invoiceSats', 'serviceFeeSats', 'claimFeeSats', 'fundingReserveSats'] as const) if (quote[key] !== plan.quote[key]) throw new Error('Quote budget changed');
      await store.transaction(db => { db.quotes[quote.id] = quote; });
      const ports = invoiceOnlyPorts(bitcoin, provider, payer, plan);
      swap = await manager.create(quote.id, 'approved-' + plan.contract.paymentHash, plan.contract, await ports.tip(),
        { onchainSats: await bitcoin.liquidity(), incomingSats: await provider.incomingLiquidity() });
    }
    if (swap.state === 'QUOTED' && swap.quote.expiresAt <= Date.now()) throw new Error('Stored quote expired; manual review required');
    const result = await new SwapCoordinator(store, invoiceOnlyPorts(bitcoin, provider, payer, plan)).issueInvoice(swap.id);
    if (result.state !== 'INVOICE_CREATED') throw new Error('Invoice outcome unresolved; do not retry creation');
    const summary = { check: 'approved_unpaid_hold_invoice', status: 'passed', swapId: result.id, paymentHash: plan.contract.paymentHash,
      planSha256: args[2],
      invoiceSats: result.quote.invoiceSats, address: plan.address, refundHeight: plan.contract.timeoutHeight,
      noPaymentInitiated: true, broadcast: false };
    await writeFile(join(c.directory, 'invoice-only-evidence.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify(summary));
  } catch (error) {
    console.error(JSON.stringify({ check: 'approved_unpaid_hold_invoice', status: 'failed', errorType: error instanceof Error ? error.name : 'Unknown' })); process.exitCode = 1;
  } finally { password.fill(0); client?.destroy(); clientVault?.close(); providerVault?.close(); await store?.close(); }
}
