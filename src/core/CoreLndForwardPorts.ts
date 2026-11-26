import { address, networks } from 'bitcoinjs-lib';
import { z } from 'zod';
import type { BitcoinRpcClient } from '../bitcoin/BitcoinRpcClient.js';
import type { LndClient } from '../lightning/LndClient.js';
import { trackPaymentPath, type PaymentStreamTransport } from '../lightning/LndPaymentTransport.js';
import type { ForwardPorts } from './ForwardExecutor.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const node = z.string().regex(/^0[23][a-f0-9]{64}$/);
const channel = z.string().regex(/^[1-9][0-9]{0,19}$/).pipe(z.string().refine(v => BigInt(v) <= 0xffffffffffffffffn));
const invoiceFormat = z.string().regex(/^lnbcrt[0-9a-z]{20,4096}$/);
const script = z.string().regex(/^0014[a-f0-9]{40}$/);
const int64 = z.string().regex(/^(0|[1-9][0-9]{0,15})$/).transform(Number).pipe(z.number().int().nonnegative());
const payment = z.object({ status: z.literal('SUCCEEDED'), failure_reason: z.literal('FAILURE_REASON_NONE'),
  payment_hash: hash, payment_preimage: hash, value_msat: int64, fee_msat: int64 });

/** Deliberately limited to one direct regtest channel and a Core provider wallet.
 * Never auto-registers with HTTP. No bitcoin spend or mining methods. */
export class CoreLndForwardPorts implements ForwardPorts {
  constructor(private readonly core: Pick<BitcoinRpcClient, 'call'>,
    private readonly payer: Pick<LndClient, 'call' | 'origin'>, private readonly transport: PaymentStreamTransport,
    private readonly payerNode: string, private readonly payeeNode: string, private readonly channelId: string) {
    node.parse(payerNode); node.parse(payeeNode); channel.parse(channelId);
    if (payerNode === payeeNode || payer.origin !== transport.origin) throw new Error('Invalid forward payer binding');
  }

  private async tip() {
    return z.object({ chain: z.literal('regtest'), bestblockhash: hash, blocks: z.number().int().nonnegative() })
      .parse(await this.core.call('getblockchaininfo'));
  }

  async inspectPayer() {
    const info = z.object({ identity_pubkey: node, synced_to_chain: z.literal(true), version: z.string(),
      wallet_synced: z.boolean().optional(), block_hash: hash, block_height: z.number().int(),
      chains: z.array(z.object({ chain: z.literal('bitcoin'), network: z.literal('regtest') })).length(1) })
      .parse(await this.payer.call('/v1/getinfo'));
    const tip = await this.tip();
    // The isolated v0.20.8-beta build gates synced_to_chain on Wallet.IsSynced()
    // and does not expose wallet_synced. Do not infer it for other builds.
    if (info.identity_pubkey !== this.payerNode || info.block_hash !== tip.bestblockhash || info.block_height !== tip.blocks ||
      (info.wallet_synced !== true && !(info.wallet_synced === undefined && info.version === '0.20.8-beta commit=v0.20.8-beta')))
      throw new Error('Forward payer not synced to the bound Core tip');
    return { network: 'regtest', node: info.identity_pubkey, ready: true };
  }

  decodeInvoice(invoice: string) {
    return this.payer.call(`/v1/payreq/${invoiceFormat.parse(invoice)}`);
  }

  async allocateDeposit() {
    await this.tip();
    const dest = z.string().regex(/^bcrt1q[a-z0-9]{38}$/).parse(await this.core.call('getnewaddress', ['forward', 'bech32'], true));
    const scriptPubKey = script.parse(Buffer.from(address.toOutputScript(dest, networks.regtest)).toString('hex'));
    await this.assertWalletScript(dest, scriptPubKey);
    return { address: dest, scriptPubKey };
  }

  private async assertWalletScript(dest: string, scriptPubKey: string) {
    z.object({ private_keys_enabled: z.literal(true) }).parse(await this.core.call('getwalletinfo', [], true));
    const info = z.object({ scriptPubKey: script, ismine: z.literal(true), iswatchonly: z.literal(false) })
      .parse(await this.core.call('getaddressinfo', [dest], true));
    if (info.scriptPubKey !== scriptPubKey) throw new Error('Forward deposit is not controlled by the Core wallet');
  }

  async inspectDeposit(txid: string, vout: number) {
    hash.parse(txid); z.number().int().min(0).max(0xffffffff).parse(vout);
    const tip = await this.tip();
    const utxo = z.object({ bestblock: hash, coinbase: z.literal(false), confirmations: z.number().int().min(2),
      value: z.number().positive(), scriptPubKey: z.object({ hex: script }) })
      .parse(await this.core.call('gettxout', [txid, vout, true]));
    const scriptPubKey = utxo.scriptPubKey.hex;
    const valueSats = Math.round(utxo.value * 100_000_000);
    if (tip.bestblockhash !== utxo.bestblock || valueSats < 1 || valueSats > 200_100 || valueSats / 100_000_000 !== utxo.value)
      throw new Error('Forward deposit tip or amount invalid');
    await this.assertWalletScript(address.fromOutputScript(Buffer.from(scriptPubKey, 'hex'), networks.regtest), scriptPubKey);
    return { network: 'regtest', txid, vout, scriptPubKey, valueSats, confirmations: utxo.confirmations };
  }

  async send(invoice: string, feeLimitSats: number, beforeSend: () => Promise<void>) {
    invoiceFormat.parse(invoice); z.literal(100).parse(feeLimitSats);
    return this.observe('/v2/router/send', { payment_request: invoice, timeout_seconds: 60, fee_limit_sat: '100',
      max_parts: 16, outgoing_chan_ids: [this.channelId], no_inflight_updates: false, allow_self_payment: false,
      amp: false, cancelable: false }, async () => {
      const { channels } = z.object({ channels: z.array(z.object({ chan_id: channel, active: z.boolean(),
        channel_point: z.string().regex(/^[a-f0-9]{64}:[0-9]{1,10}$/),
        remote_pubkey: node, zero_conf: z.boolean() })).max(1000) }).parse(await this.payer.call('/v1/channels'));
      const matching = channels.filter(c => c.chan_id === this.channelId);
      if (matching.length !== 1 || !matching[0]!.active || matching[0]!.zero_conf === true ||
        matching[0]!.remote_pubkey !== this.payeeNode) throw new Error('Forward channel binding unavailable');
      // LND may still show an active channel after an isolated chain reset.
      const [txid, index] = matching[0]!.channel_point.split(':');
      const tip = await this.tip();
      const funding = z.object({ confirmations: z.number().int().min(6), bestblock: hash, coinbase: z.literal(false),
        scriptPubKey: z.object({ hex: z.string().regex(/^0020[a-f0-9]{64}$/) }) })
        .parse(await this.core.call('gettxout', [txid, z.number().int().min(0).max(0xffffffff).parse(Number(index)), true]));
      if (funding.bestblock !== tip.bestblockhash) throw new Error('Forward channel funding tip changed');
      await beforeSend();
    });
  }

  track(paymentHash: string) {
    return this.observe(trackPaymentPath(paymentHash), undefined);
  }

  private async observe(path: string, body: unknown, guard?: () => Promise<void>) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 75_000);
    try {
      let evidence: unknown;
      await this.transport.stream(path, body, raw => {
        const { status } = z.object({ status: z.enum(['INITIATED', 'IN_FLIGHT', 'SUCCEEDED', 'FAILED']) }).parse(raw);
        if (status === 'FAILED') throw new Error('Forward payment failed; reconcile without resend');
        if (status !== 'SUCCEEDED') return false;
        const p = payment.parse(raw);
        evidence = { status, hash: p.payment_hash, preimage: p.payment_preimage, valueMsat: p.value_msat, feeMsat: p.fee_msat };
        return true;
      }, controller.signal, guard);
      if (!evidence) throw new Error('Forward payment outcome unavailable');
      return evidence;
    } finally { clearTimeout(timer); controller.abort(); }
  }
}
