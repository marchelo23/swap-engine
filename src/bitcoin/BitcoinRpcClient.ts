import { readFile } from 'node:fs/promises';
import * as btc from 'bitcoinjs-lib';
import { buildHtlc, type Contract } from './HtlcBuilder.js';
import { BitcoinConfirmationLookup } from './BitcoinConfirmationLookup.js';

export class BitcoinRpcClient {
  get origin(): string { return new URL(this.url).origin; }
  constructor(private url: string, private cookiePath: string, private wallet: string) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) || parsed.username || parsed.password) throw new Error('Bitcoin RPC must use local HTTP and cookie authentication');
  }
  async call<T>(method: string, params: unknown[] = [], wallet = false): Promise<T> {
    const cookie = (await readFile(this.cookiePath, 'utf8')).trim();
    const response = await fetch(`${this.url.replace(/\/$/, '')}${wallet ? `/wallet/${encodeURIComponent(this.wallet)}` : ''}`, {
      method: 'POST', signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Basic ${Buffer.from(cookie).toString('base64')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '1.0', id: 'lqwd', method, params }),
    });
    const body = await response.json() as { result: T; error?: { code: number } };
    if (body.error) throw new Error(`Bitcoin RPC ${method} error ${body.error.code}`);
    if (!response.ok) throw new Error(`Bitcoin RPC HTTP ${response.status}`);
    return body.result;
  }
  async assertRegtest() {
    const info = await this.call<{ chain: string }>('getblockchaininfo');
    if (info.chain !== 'regtest') throw new Error('Only regtest is supported');
    return info;
  }
  async liquidity(): Promise<number> {
    const outputs = await this.call<Array<{ amount: number; spendable: boolean; safe: boolean }>>('listunspent', [1], true);
    return outputs.filter(x => x.spendable && x.safe).reduce((sum, x) => sum + Math.round(x.amount * 1e8), 0);
  }
  /** Returns signed lockup without broadcasting. Persist hex + txid BEFORE sendrawtransaction. */
  async prepareLockup(contract: Contract, amountSats: number) {
    await this.assertRegtest();
    if (!Number.isSafeInteger(amountSats) || amountSats < 1_000 || amountSats > 1_000_000) throw new Error('Invalid lockup amount');
    const htlc = buildHtlc(contract);
    const funded = await this.call<{ psbt: string; fee: number }>('walletcreatefundedpsbt', [[], [{ [htlc.address]: amountSats / 1e8 }], 0,
      { lockUnspents: true, replaceable: false, fee_rate: 2 }], true);
    if (!Number.isFinite(funded.fee) || Math.round(funded.fee * 1e8) > 1000) throw new Error('Funding fee exceeds reserve; inspect reserved UTXOs');
    const signed = await this.call<{ psbt: string }>('walletprocesspsbt', [funded.psbt], true);
    const finalized = await this.call<{ complete: boolean; hex?: string }>('finalizepsbt', [signed.psbt]);
    if (!finalized.complete || !finalized.hex) throw new Error('Incomplete lockup PSBT; inspect reserved UTXOs');
    const tx = btc.Transaction.fromHex(finalized.hex);
    const vout = tx.outs.findIndex(x => Buffer.from(x.script).equals(htlc.output) && x.value === BigInt(amountSats));
    if (vout < 0) throw new Error('Funding output mismatch');
    return { txid: tx.getId(), hex: finalized.hex, vout };
  }
  broadcast(hex: string) { return this.call<string>('sendrawtransaction', [hex]); }
  /** Compatible with SwapPorts.confirmed; errors never count as unconfirmed evidence. */
  confirmed(txid: string) {
    return new BitcoinConfirmationLookup(this).confirmed(txid);
  }
  /** A block hint avoids txindex discovery but undergoes the same evidence checks. */
  confirmedTransaction(txid: string, blockHash: string) {
    return new BitcoinConfirmationLookup(this).confirmed(txid, blockHash);
  }
}
