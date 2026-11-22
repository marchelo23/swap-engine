import { readFileSync } from 'node:fs';
import { open, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { assertRegtestAddress } from '../src/bitcoin/AddressPolicy.js';
import { config } from '../src/config.js';
import { ReadOnlyBitcoinClient, ReadOnlyLndClient } from '../src/diagnostics/ReadOnlyClients.js';
import { preflight } from '../src/diagnostics/preflight.js';
import { ClaimWallet } from '../src/client/ClaimWallet.js';
import { RefundKeyVault } from '../src/bitcoin/RefundKeyVault.js';
import { SecretVault } from '../src/persistence/SecretVault.js';
import { createReverseTestPlan, reverseRoutingSchema } from '../src/core/ReverseTestPlan.js';
import { QuoteResponse } from '../src/api/schemas.js';

// Operator CLI only. Password arrives over stdin, never argv, environment or output.
const c = config(); const passwordInput = readFileSync(0);
let length = passwordInput.length;
while (length && (passwordInput[length - 1] === 10 || passwordInput[length - 1] === 13)) length--;
const password = passwordInput.subarray(0, length);
let clientVault: SecretVault | undefined; let providerVault: SecretVault | undefined;
let client: ClaimWallet | undefined; let restored: ClaimWallet | undefined;
let step = 'readiness';
try {
  const bitcoin = new ReadOnlyBitcoinClient(c.bitcoinUrl, c.cookie, c.wallet);
  const provider = new ReadOnlyLndClient(c.lndUrl, c.cert, c.macaroon);
  if (!c.aliceLnd) throw new Error('PAYER_LND_REQUIRED');
  const payer = new ReadOnlyLndClient(c.aliceLnd.url, c.aliceLnd.cert, c.aliceLnd.macaroon);
  const reports = await Promise.all([preflight(bitcoin, provider, c.wallet), preflight(bitcoin, payer, c.wallet)]);
  if (reports.some(r => !r.prerequisitesSatisfied)) throw new Error('Node readiness unresolved');
  const nodeSchema = z.object({ identity_pubkey: z.string().regex(/^(02|03)[a-f0-9]{64}$/) });
  const p = nodeSchema.parse(await provider.call('/v1/getinfo')); const a = nodeSchema.parse(await payer.call('/v1/getinfo'));
  step = 'channel';
  const channelSchema = z.object({ channels: z.array(z.object({ active: z.boolean(), chan_id: z.string(), channel_point: z.string(), remote_pubkey: z.string() })) });
  const providerChannels = channelSchema.parse(await provider.call('/v1/channels')).channels.filter(ch => ch.active && ch.remote_pubkey === a.identity_pubkey);
  const payerChannels = channelSchema.parse(await payer.call('/v1/channels')).channels.filter(ch => ch.active && ch.remote_pubkey === p.identity_pubkey);
  if (providerChannels.length !== 1 || payerChannels.length !== 1 || providerChannels[0]!.chan_id !== payerChannels[0]!.chan_id ||
    providerChannels[0]!.channel_point !== payerChannels[0]!.channel_point) throw new Error('Exact direct channel unavailable');
  const routing = reverseRoutingSchema.parse({ channelId: payerChannels[0]!.chan_id, channelPoint: payerChannels[0]!.channel_point,
    bitcoinOrigin: bitcoin.origin, providerOrigin: provider.origin, payerOrigin: payer.origin });
  const tip = z.object({ chain: z.literal('regtest'), blocks: z.number().int().positive() }).parse(await bitcoin.call('getblockchaininfo'));
  step = 'destinations';
  if (!c.aliceLnd) throw new Error('PAYER_LND_REQUIRED');
  // Fixed default external-address inventory from the attested payer; never derive a new address.
  const accounts = z.object({ account_with_addresses: z.array(z.object({ addresses: z.array(z.object({ address: z.string(), is_internal: z.boolean() })) })) })
    .parse(await payer.call('/v2/wallet/addresses?account_name=default'));
  const claimDestination = accounts.account_with_addresses.flatMap(a => a.addresses).find(a => !a.is_internal && a.address.startsWith('bcrt1'))?.address;
  if (!claimDestination) throw new Error('Existing client receiving address unavailable');
  assertRegtestAddress(claimDestination);
  const refundDestination = process.env.REFUND_DESTINATION?.trim();
  if (!refundDestination) throw new Error('REFUND_DESTINATION_REQUIRED');
  assertRegtestAddress(refundDestination);
  z.object({ ismine: z.literal(true) }).parse(await bitcoin.call('getaddressinfo', [refundDestination], true));
  step = 'quote';
  const response = await fetch(`http://127.0.0.1:${c.port}/v1/quotes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"amountSats":50000}', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('Quote unavailable');
  const quote = QuoteResponse.parse(await response.json());
  step = 'custody';
  await mkdir(c.directory, { recursive: true, mode: 0o700 });
  clientVault = await SecretVault.open(join(c.directory, 'client-secrets'), password);
  providerVault = await SecretVault.open(join(c.directory, 'provider-refund-keys'), password);
  passwordInput.fill(0);
  client = ClaimWallet.generate(); await client.backup(clientVault);
  const refunds = new RefundKeyVault(providerVault); const refund = await refunds.create(client.paymentHash);
  restored = await ClaimWallet.restore(clientVault, client.paymentHash);
  if (restored.claimPublicKey !== client.claimPublicKey || await refunds.publicKey(client.paymentHash) !== refund.publicKey) throw new Error('Custody roundtrip failed');
  step = 'contract';
  const plan = createReverseTestPlan(quote, tip.blocks, client.toJSON(), refund.publicKey,
    { claim: claimDestination, refund: refundDestination },
    { provider: p.identity_pubkey, payer: a.identity_pubkey }, routing, c.wallet);
  const path = join(c.directory, 'reverse-test-plan.json');
  step = 'public_plan';
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(plan, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
  const directory = await open(c.directory, 'r'); try { await directory.sync(); } finally { await directory.close(); }
  console.log(JSON.stringify({ status: 'prepared_not_executed', path, plan }));
} catch (error) {
  console.error(JSON.stringify({ status: 'plan_preparation_failed', step, errorType: error instanceof Error ? error.name : 'Unknown' })); process.exitCode = 1;
} finally { passwordInput.fill(0); client?.destroy(); restored?.destroy(); clientVault?.close(); providerVault?.close(); }
