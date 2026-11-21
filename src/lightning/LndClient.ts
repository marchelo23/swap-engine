import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { hex32 } from '../bitcoin/HtlcBuilder.js';
import { parseLndInvoice } from './InvoiceParser.js';

export type Invoice = {
  state: 'OPEN' | 'ACCEPTED' | 'SETTLED' | 'CANCELED'; r_hash: string;
  value: string; amt_paid_sat: string; payment_request: string;
  htlcs?: Array<{ state: string; expiration_height: number; amt_msat: string }>;
};

/** Uses local LND REST with certificate validation. Never disables TLS verification. */
export class LndClient {
  /** Public endpoint identity only; credentials and local paths are never exposed. */
  get origin(): string { return new URL(this.url).origin; }
  constructor(private url: string, private certPath: string, private macaroonPath: string) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || parsed.username || parsed.password) throw new Error('LND must use loopback HTTPS');
  }
  private async credentials() {
    const [ca, macaroon] = await Promise.all([readFile(this.certPath), readFile(this.macaroonPath)]);
    return { ca, headers: { 'Grpc-Metadata-macaroon': macaroon.toString('hex'), 'content-type': 'application/json' } };
  }
  async call<T>(path: string, body?: unknown): Promise<T> {
    const credentials = await this.credentials();
    return new Promise((resolve, reject) => {
      const req = https.request(new URL(path, this.url), { ...credentials, method: body === undefined ? 'GET' : 'POST', timeout: 15_000 }, res => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { data += chunk; if (data.length > 2_000_000) req.destroy(new Error('Oversized LND response')); });
        res.on('error', reject);
        res.on('end', () => {
          if ((res.statusCode ?? 500) >= 400) return reject(new Error(`LND HTTP ${res.statusCode}`));
          try { resolve(JSON.parse(data) as T); } catch { reject(new Error('Invalid LND JSON')); }
        });
      });
      req.on('timeout', () => req.destroy(new Error('LND timeout: outcome must be reconciled')));
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  async assertRegtest() {
    const info = await this.call<{ chains: Array<{ chain: string; network: string }>; synced_to_chain: boolean }>('/v1/getinfo');
    if (!info.synced_to_chain || info.chains.length !== 1 || info.chains[0]?.chain !== 'bitcoin' || info.chains[0]?.network !== 'regtest') throw new Error('LND must be synced to Bitcoin regtest');
    return info;
  }
  addHoldInvoice(hash: string, sats: number, expirySeconds: number, cltvDelta: number) {
    if (!Number.isSafeInteger(sats) || sats < 1 || !Number.isInteger(expirySeconds) || expirySeconds < 60 || expirySeconds > 3600 || !Number.isInteger(cltvDelta) || cltvDelta < 80 || cltvDelta > 2016) throw new Error('Invalid hold invoice limits');
    return this.call<{ payment_request: string }>('/v2/invoices/hodl', { hash: hex32(hash).toString('base64'), value: String(sats), expiry: String(expirySeconds), cltv_expiry: String(cltvDelta), memo: 'LQWD regtest reverse swap' });
  }
  async lookup(hash: string) { hex32(hash); return parseLndInvoice(await this.call(`/v1/invoice/${hash}`)); }
  settle(preimage: string) { return this.call('/v2/invoices/settle', { preimage: hex32(preimage).toString('base64') }); }
  cancel(hash: string) { return this.call('/v2/invoices/cancel', { payment_hash: hex32(hash).toString('base64') }); }
  async incomingLiquidity(): Promise<number> {
    const { channels } = await this.call<{ channels: Array<{ active: boolean; remote_balance: string; remote_constraints: { chan_reserve_sat: string }; pending_htlcs: Array<{ incoming: boolean; amount: string }> }> }>('/v1/channels');
    return channels.filter(x => x.active).reduce((sum, x) => sum + Math.max(0,
      Number(x.remote_balance) - Number(x.remote_constraints.chan_reserve_sat) - x.pending_htlcs.filter(h => h.incoming).reduce((n, h) => n + Number(h.amount), 0)), 0);
  }
  /** Streaming state updates. Reconnect + lookup reconciliation belongs to the caller. */
  async subscribe(hash: string, onInvoice: (invoice: Invoice) => void, signal: AbortSignal): Promise<void> {
    const encoded = hex32(hash).toString('base64url');
    const credentials = await this.credentials();
    return new Promise((resolve, reject) => {
      const req = https.get(new URL(`/v2/invoices/subscribe/${encoded}`, this.url), { ...credentials, signal }, res => {
        if (res.statusCode !== 200) { res.resume(); reject(new Error(`LND subscription HTTP ${res.statusCode}`)); return; }
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          buffer += chunk;
          if (buffer.length > 2_000_000) { req.destroy(new Error('Oversized LND stream frame')); return; }
          let newline: number;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line) as { result?: unknown; error?: unknown };
              if (event.error || !event.result) throw new Error('LND stream error');
              onInvoice(parseLndInvoice(event.result));
            } catch { req.destroy(new Error('Invalid LND stream event')); return; }
          }
        });
        res.on('end', () => buffer.trim() ? reject(new Error('Truncated LND stream')) : resolve());
        res.on('error', reject);
      });
      req.on('error', reject);
    });
  }
}
