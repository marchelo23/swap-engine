import { Transaction, address, networks } from 'bitcoinjs-lib';
import { z } from 'zod';
import type { Store } from '../persistence/Store.js';
import type { BitcoinRpcClient } from '../bitcoin/BitcoinRpcClient.js';
import { BitcoinConfirmationLookup } from '../bitcoin/BitcoinConfirmationLookup.js';
import type { ApprovedFundingInput } from '../bitcoin/ControlledFunding.js';
import type { LndClient } from '../lightning/LndClient.js';
import { verifyDecodedHoldInvoice } from '../lightning/InvoiceVerification.js';
import { verifyReverseTestPlan } from './ReverseTestPlan.js';
import type { ControlledRunRuntime } from './ControlledReverseBackend.js';
import { buildHtlc } from '../bitcoin/HtlcBuilder.js';
import { terminal } from './SwapTypes.js';
import { ClaimWallet } from '../client/ClaimWallet.js';
import type { SecretVault } from '../persistence/SecretVault.js';
import type { RefundKeyVault } from '../bitcoin/RefundKeyVault.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const script = z.string().regex(/^(?:[a-f0-9]{2})+$/);
const height = z.number().int().nonnegative().max(499999999);
const integer = z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine(v => BigInt(v) <= 0xffffffffffffffffn);
const positive = integer.refine(v => BigInt(v) > 0n);
const pubkey = z.string().regex(/^(02|03)[a-f0-9]{64}$/);
const point = z.string().regex(/^[a-f0-9]{64}:(0|[1-9][0-9]{0,9})$/);
const chainSchema = z.object({ chain: z.literal('regtest'), blocks: height, headers: height,
  bestblockhash: hash, initialblockdownload: z.literal(false) });
const nodeSchema = z.object({ identity_pubkey: pubkey, synced_to_chain: z.literal(true), wallet_synced: z.literal(true),
  block_height: height, block_hash: hash, num_peers: z.number().int().positive(),
  chains: z.array(z.object({ chain: z.literal('bitcoin'), network: z.literal('regtest') })).length(1) });
const constraints = z.object({ chan_reserve_sat: integer, max_pending_amt_msat: positive, min_htlc_msat: integer,
  max_accepted_htlcs: z.number().int().positive().max(65535) });
const channelSchema = z.object({ active: z.boolean(), remote_pubkey: pubkey, chan_id: positive, channel_point: point,
  capacity: positive, local_balance: integer, remote_balance: integer, commit_fee: integer, unsettled_balance: integer,
  pending_htlcs: z.array(z.unknown()).max(1000), local_constraints: constraints, remote_constraints: constraints,
  zero_conf: z.literal(false) });
const channelsSchema = z.object({ channels: z.array(channelSchema).max(1000) });
const utxoSchema = z.object({ txid: hash, vout: z.number().int().nonnegative().max(0xffffffff),
  scriptPubKey: script, amount: z.number(), confirmations: z.number().int().positive(),
  safe: z.boolean(), spendable: z.boolean(), solvable: z.boolean() });
const locksSchema = z.array(z.object({ txid: hash, vout: z.number().int().nonnegative().max(0xffffffff) })).max(1000);
const unspentSchema = z.object({ bestblock: hash, confirmations: z.number().int().positive(), value: z.number(),
  scriptPubKey: z.object({ hex: script }), coinbase: z.boolean() });
const decodedSchema = z.object({ destination: pubkey, payment_hash: hash, num_satoshis: integer, num_msat: integer,
  timestamp: integer, expiry: integer, cltv_expiry: integer });

export type ReadinessScope = { isolationId: string; channelId: string; channelPoint: string;
  bitcoinOrigin: string; providerOrigin: string; payerOrigin: string };
export type ReadinessCustody = (paymentHash: string) => Promise<{ paymentHash: string; claimPublicKey: string; refundPublicKey: string }>;

/** Restore existing encrypted custody only; never create, replace, export or sign with a key. */
export function persistedReadinessCustody(clientVault: SecretVault, refundKeys: Pick<RefundKeyVault, 'publicKey'>): ReadinessCustody {
  return async paymentHash => {
    let client: ClaimWallet | undefined;
    try { client = await ClaimWallet.restore(clientVault, paymentHash);
      return { ...client.toJSON(), refundPublicKey: await refundKeys.publicKey(paymentHash) }; }
    catch { throw new Error('Persisted custody identity unavailable'); }
    finally { client?.destroy(); }
  };
}

function sats(value: number): bigint {
  if (!Number.isFinite(value) || value < 0 || value > 21000000) throw new Error();
  const decimal = value.toFixed(8); const [whole, fraction] = decimal.split('.');
  const result = BigInt(whole!) * 100000000n + BigInt(fraction!);
  if (Number(result) / 100000000 !== value) throw new Error();
  return result;
}
function localOrigin(origin: string, protocol: 'http:' | 'https:') {
  try {
    const url = new URL(origin);
    if (url.origin !== origin || url.protocol !== protocol || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error();
  } catch { throw new Error('Readiness scope origin invalid'); }
}

/** Concrete, bounded read-only inspection for ControlledReverseBackend.inspect.
 * The local immutable scope asserts isolation; these RPCs cannot prove operator isolation.
 */
export function createControlledReadiness(store: Store, id: string, suppliedScope: ReadinessScope,
  bitcoin: Pick<BitcoinRpcClient, 'origin' | 'call'>, provider: Pick<LndClient, 'origin' | 'call' | 'lookup'>,
  payer: Pick<LndClient, 'origin' | 'call'>, custody: ReadinessCustody): ControlledRunRuntime['inspect'] {
  const scope = structuredClone(suppliedScope);
  z.uuid().parse(id); z.uuid().parse(scope.isolationId); positive.parse(scope.channelId); point.parse(scope.channelPoint);
  const [channelTxid, channelVoutText] = scope.channelPoint.split(':'); const channelVout = Number(channelVoutText);
  if (!Number.isSafeInteger(channelVout) || channelVout < 0 || channelVout > 0xffffffff) throw new Error('Invalid channel outpoint');
  localOrigin(scope.bitcoinOrigin, 'http:'); localOrigin(scope.providerOrigin, 'https:'); localOrigin(scope.payerOrigin, 'https:');
  if (bitcoin.origin !== scope.bitcoinOrigin || provider.origin !== scope.providerOrigin || payer.origin !== scope.payerOrigin ||
    scope.providerOrigin === scope.payerOrigin) throw new Error('Readiness endpoints differ from isolated scope');
  const walletMethods = new Set(['getwalletinfo', 'getaddressinfo', 'listunspent', 'listlockunspent']);
  const chainMethods = new Set(['getblockchaininfo', 'getnetworkinfo', 'getmempoolinfo', 'getrawtransaction', 'getblockheader', 'getblockhash', 'gettxout', 'listwallets']);
  const rpc = { call<T>(method: string, params: unknown[] = [], wallet = false): Promise<T> {
    if (!(wallet ? walletMethods : chainMethods).has(method)) return Promise.reject(new Error('Readiness RPC disabled'));
    return bitcoin.call<T>(method, params, wallet);
  } };
  return async (unverified, input: ApprovedFundingInput) => {
    let stage = 'PLAN';
    try {
      input = { txid: input.txid, vout: input.vout };
      const plan = verifyReverseTestPlan(unverified); hash.parse(input.txid);
      for (const key of ['channelId', 'channelPoint', 'bitcoinOrigin', 'providerOrigin', 'payerOrigin'] as const) {
        if (plan.routing[key] !== scope[key]) throw new Error();
      }
      if (!Number.isSafeInteger(input.vout) || input.vout < 0 || input.vout > 0xffffffff) throw new Error();
      const initial = store.read().swaps[id];
      const checkJournal = () => {
        const db = store.read(); const current = db.swaps[id];
        if (bitcoin.origin !== scope.bitcoinOrigin || provider.origin !== scope.providerOrigin || payer.origin !== scope.payerOrigin ||
          !current || current.state !== 'INVOICE_CREATED' || !current.invoice || current.pendingAction || current.clientPayment ||
          current.fundingIntent || current.lockup || current.clientClaimIntent || current.miningIntents?.length ||
          Object.values(db.controlledExecutions ?? {}).some(run => run.swapId === id) ||
          Object.values(db.swaps).some(s => s.id !== id && !terminal.has(s.state)) ||
          JSON.stringify(current) !== JSON.stringify(initial) || JSON.stringify(current.contract) !== JSON.stringify(plan.contract) ||
          JSON.stringify(current.quote) !== JSON.stringify(plan.quote) || plan.createdAt > Date.now() || plan.quote.expiresAt <= Date.now()) throw new Error();
      };
      checkJournal();
      stage = 'NODES';
      const chain = chainSchema.parse(await rpc.call('getblockchaininfo'));
      if (chain.blocks !== chain.headers || chain.blocks < plan.tipHeight || plan.contract.timeoutHeight - chain.blocks < 20 ||
        plan.contract.timeoutHeight - chain.blocks > 40 || plan.invoiceCltvDelta < plan.contract.timeoutHeight - chain.blocks + 40) throw new Error();
      const nodes = async () => {
        const p = nodeSchema.parse(await provider.call('/v1/getinfo')); const a = nodeSchema.parse(await payer.call('/v1/getinfo'));
        if (p.identity_pubkey !== plan.providerNode || a.identity_pubkey !== plan.payerNode ||
          [p, a].some(n => n.block_height !== chain.blocks || n.block_hash !== chain.bestblockhash)) throw new Error();
        return [p, a];
      };
      await nodes();
      stage = 'WALLET';
      if (!z.array(z.string()).max(1000).parse(await rpc.call('listwallets')).includes(plan.wallet)) throw new Error();
      const walletInfo = async () => {
        const wallet = z.object({ walletname: z.string(), private_keys_enabled: z.literal(true), scanning: z.literal(false),
          external_signer: z.literal(false).optional(), unlocked_until: z.number().int().nonnegative().optional() })
          .parse(await rpc.call('getwalletinfo', [], true));
        if (wallet.walletname !== plan.wallet || (wallet.unlocked_until !== undefined && wallet.unlocked_until <= Math.floor(Date.now() / 1000) + 60)) throw new Error();
        return wallet;
      };
      const wallet = await walletInfo();
      const inventory = async () => {
        const locks = locksSchema.parse(await rpc.call('listlockunspent', [], true));
        const coins = z.array(utxoSchema).max(1000).parse(await rpc.call('listunspent', [1, 9999999, [], false, { maximumCount: 1000 }], true));
        if (coins.length === 1000 || new Set(coins.map(c => `${c.txid}:${c.vout}`)).size !== coins.length) throw new Error();
        return { locks: locks.sort((a, b) => `${a.txid}:${a.vout}`.localeCompare(`${b.txid}:${b.vout}`)),
          coins: coins.sort((a, b) => `${a.txid}:${a.vout}`.localeCompare(`${b.txid}:${b.vout}`)) };
      };
      const walletCoins = await inventory();
      const selected = walletCoins.coins.filter(c => c.txid === input.txid && c.vout === input.vout);
      if (selected.length !== 1 || !selected[0]!.safe || !selected[0]!.spendable || !selected[0]!.solvable ||
        walletCoins.locks.some(l => l.txid === input.txid && l.vout === input.vout)) throw new Error();
      stage = 'UTXO';
      const previous = await new BitcoinConfirmationLookup(rpc).confirmed(input.txid);
      const tx = Transaction.fromHex(previous.hex); const output = tx.outs[input.vout];
      if (!output || output.script.length !== 22 || output.script[0] !== 0 || output.script[1] !== 20 ||
        output.value > BigInt(Number.MAX_SAFE_INTEGER) || output.value < BigInt(plan.quote.amountSats + plan.quote.fundingReserveSats + 10000) ||
        sats(selected[0]!.amount) !== output.value || selected[0]!.scriptPubKey !== Buffer.from(output.script).toString('hex') ||
        selected[0]!.confirmations !== previous.confirmations) throw new Error();
      const unspent = async () => {
        const coin = unspentSchema.parse(await rpc.call('gettxout', [input.txid, input.vout, true]));
        if (coin.bestblock !== chain.bestblockhash || coin.confirmations !== previous.confirmations ||
          (coin.coinbase && coin.confirmations < 101) || sats(coin.value) !== output.value || coin.scriptPubKey.hex !== selected[0]!.scriptPubKey) throw new Error();
        return coin;
      };
      const coin = await unspent();
      const ownership = async () => {
        const result = [];
        for (const destination of [address.fromOutputScript(output.script, networks.regtest), plan.refundDestination]) {
          const own = z.object({ ismine: z.literal(true), solvable: z.literal(true), scriptPubKey: script })
            .parse(await rpc.call('getaddressinfo', [destination], true));
          if (own.scriptPubKey !== Buffer.from(address.toOutputScript(destination, networks.regtest)).toString('hex')) throw new Error();
          result.push(own);
        }
        return result;
      };
      const owners = await ownership();
      stage = 'FEES';
      const fees = async () => {
        const relay = z.object({ relayfee: z.number() }).parse(await rpc.call('getnetworkinfo'));
        const mempool = z.object({ mempoolminfee: z.number() }).parse(await rpc.call('getmempoolinfo'));
        return { relay: sats(relay.relayfee).toString(), mempool: sats(mempool.mempoolminfee).toString() };
      };
      const feeSnapshot = await fees();
      const feePerKvB = BigInt(feeSnapshot.relay) > BigInt(feeSnapshot.mempool) ? BigInt(feeSnapshot.relay) : BigInt(feeSnapshot.mempool);
      if (feePerKvB > 2000n) throw new Error(); // Existing funding policy is fixed at 2 sat/vB.
      const model = new Transaction(); model.version = 2; model.addInput(tx.getHash(), input.vout);
      model.addOutput(buildHtlc(plan.contract).output, BigInt(plan.quote.amountSats));
      model.addOutput(address.toOutputScript(plan.refundDestination, networks.regtest), 1000n);
      model.setWitness(0, [Buffer.alloc(73), Buffer.alloc(33)]);
      if (BigInt(model.virtualSize()) * 2n > BigInt(plan.quote.fundingReserveSats)) throw new Error();
      const claim = new Transaction(); claim.version = 2; claim.addInput(Buffer.alloc(32), 0);
      claim.addOutput(address.toOutputScript(plan.claimDestination, networks.regtest), BigInt(plan.quote.amountSats - plan.quote.claimFeeSats));
      claim.setWitness(0, [Buffer.alloc(73), Buffer.alloc(32), Buffer.from([1]), buildHtlc(plan.contract).witnessScript]);
      if ((BigInt(claim.virtualSize()) * feePerKvB + 999n) / 1000n > BigInt(plan.quote.claimFeeSats)) throw new Error();
      stage = 'LIQUIDITY';
      const channels = async () => {
        const p = channelsSchema.parse(await provider.call('/v1/channels')); const a = channelsSchema.parse(await payer.call('/v1/channels'));
        const active = [p, a].map(view => view.channels.filter(c => c.active));
        if (active.some(list => list.length !== 1)) throw new Error();
        const [incoming, outgoing] = active.map(list => list[0]!);
        if (incoming!.chan_id !== scope.channelId || outgoing!.chan_id !== scope.channelId ||
          incoming!.channel_point !== scope.channelPoint || outgoing!.channel_point !== scope.channelPoint ||
          incoming!.remote_pubkey !== plan.payerNode || outgoing!.remote_pubkey !== plan.providerNode || incoming!.capacity !== outgoing!.capacity ||
          [incoming!, outgoing!].some(c => c.pending_htlcs.length || BigInt(c.unsettled_balance) !== 0n ||
            BigInt(c.local_balance) + BigInt(c.remote_balance) > BigInt(c.capacity))) throw new Error();
        const need = BigInt(plan.quote.invoiceSats + plan.routingFeeLimitSats);
        if (BigInt(outgoing!.local_balance) - BigInt(outgoing!.local_constraints.chan_reserve_sat) - BigInt(outgoing!.commit_fee) < need ||
          BigInt(incoming!.remote_balance) - BigInt(incoming!.remote_constraints.chan_reserve_sat) - BigInt(incoming!.commit_fee) < need) throw new Error();
        for (const c of [incoming!, outgoing!]) for (const limit of [c.local_constraints, c.remote_constraints]) {
          if (BigInt(limit.min_htlc_msat) > BigInt(plan.quote.invoiceSats) * 1000n || BigInt(limit.max_pending_amt_msat) < need * 1000n) throw new Error();
        }
        return [incoming, outgoing];
      };
      const channelViews = await channels();
      const channelTx = await new BitcoinConfirmationLookup(rpc).confirmed(channelTxid!);
      const channelOutput = Transaction.fromHex(channelTx.hex).outs[channelVout];
      if (!channelOutput || channelOutput.value !== BigInt(channelViews[0]!.capacity) || channelOutput.script.length !== 34 ||
        ![0, 81].includes(channelOutput.script[0]!) || channelOutput.script[1] !== 32) throw new Error();
      const channelUnspent = async () => {
        const live = unspentSchema.parse(await rpc.call('gettxout', [channelTxid, channelVout, true]));
        if (live.bestblock !== chain.bestblockhash || live.confirmations !== channelTx.confirmations || live.coinbase ||
          sats(live.value) !== channelOutput.value || live.scriptPubKey.hex !== Buffer.from(channelOutput.script).toString('hex')) throw new Error();
        return live;
      };
      const channelCoin = await channelUnspent();
      stage = 'INVOICE';
      const invoice = await provider.lookup(plan.contract.paymentHash);
      if (invoice.state !== 'OPEN' || invoice.r_hash !== Buffer.from(plan.contract.paymentHash, 'hex').toString('base64') ||
        invoice.value !== String(plan.quote.invoiceSats) || invoice.amt_paid_sat !== '0' || invoice.payment_request !== initial!.invoice ||
        invoice.htlcs?.some(h => h.state === 'ACCEPTED' || h.state === 'SETTLED')) throw new Error();
      const decoded = decodedSchema.parse(await payer.call(`/v1/payreq/${invoice.payment_request}`));
      verifyDecodedHoldInvoice(invoice.payment_request, decoded, { paymentHash: plan.contract.paymentHash, payeePublicKey: plan.providerNode,
        invoiceSats: plan.quote.invoiceSats, minFinalCltv: plan.invoiceCltvDelta });
      stage = 'CUSTODY';
      const keys = await custody(plan.contract.paymentHash);
      if (keys.paymentHash !== plan.contract.paymentHash || keys.claimPublicKey !== plan.contract.claimPublicKey || keys.refundPublicKey !== plan.contract.refundPublicKey) throw new Error();
      stage = 'CHANGED';
      await nodes();
      if (JSON.stringify(await channels()) !== JSON.stringify(channelViews) || JSON.stringify(await inventory()) !== JSON.stringify(walletCoins) ||
        JSON.stringify(await walletInfo()) !== JSON.stringify(wallet) || JSON.stringify(await ownership()) !== JSON.stringify(owners) ||
        JSON.stringify(await unspent()) !== JSON.stringify(coin) || JSON.stringify(await fees()) !== JSON.stringify(feeSnapshot) ||
        JSON.stringify(await channelUnspent()) !== JSON.stringify(channelCoin) ||
        JSON.stringify(await provider.lookup(plan.contract.paymentHash)) !== JSON.stringify(invoice) ||
        JSON.stringify(chainSchema.parse(await rpc.call('getblockchaininfo'))) !== JSON.stringify(chain)) throw new Error();
      checkJournal();
      return { network: 'regtest', isolationId: scope.isolationId, providerNode: plan.providerNode, payerNode: plan.payerNode,
        tipHeight: chain.blocks, paymentHash: keys.paymentHash, claimPublicKey: keys.claimPublicKey, refundPublicKey: keys.refundPublicKey,
        funding: { ...input, confirmed: true, safe: true, spendable: true, valueSats: Number(output.value) }, decodedInvoice: decoded };
    } catch { throw new Error(`Controlled readiness unverified: ${stage}`); }
  };
}
