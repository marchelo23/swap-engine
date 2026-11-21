import https from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';

export type PaymentStreamTransport = {
  readonly origin: string;
  stream(path: string, body: unknown | undefined, onPayment: (payment: unknown) => boolean, signal: AbortSignal, beforeRequest?: () => void | Promise<void>): Promise<void>;
};
export type PaymentTransportIO = {
  credentials(): Promise<{ ca: Buffer; macaroon: Buffer }>;
  request(url: URL, options: https.RequestOptions, callback: (response: IncomingMessage) => void): ClientRequest;
};

export function trackPaymentPath(hash: string) {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid payment hash');
  return `/v2/router/track/${encodeURIComponent(Buffer.from(hash, 'hex').toString('base64'))}?no_inflight_updates=false`;
}

/** Exact LND Router REST stream transport. TLS verification stays enabled; no reconnect/retry. */
export class HttpsLndPaymentTransport implements PaymentStreamTransport {
  get origin(): string { return this.endpoint.origin; }
  private readonly endpoint: URL;
  private readonly io: PaymentTransportIO;
  constructor(url: string, certPath: string, macaroonPath: string, io?: PaymentTransportIO) {
    try { this.endpoint = new URL(url); } catch { throw new Error('Controlled payer endpoint invalid'); }
    if (this.endpoint.protocol !== 'https:' || !['127.0.0.1', 'localhost', '[::1]'].includes(this.endpoint.hostname) ||
      this.endpoint.username || this.endpoint.password || this.endpoint.pathname !== '/' || this.endpoint.search || this.endpoint.hash) {
      throw new Error('Controlled payer requires a loopback HTTPS endpoint');
    }
    this.io = io ?? {
      credentials: async () => { const [ca, macaroon] = await Promise.all([readFile(certPath), readFile(macaroonPath)]); return { ca, macaroon }; },
      request: (target, options, callback) => https.request(target, options, callback),
    };
  }
  stream(path: string, body: unknown | undefined, onPayment: (payment: unknown) => boolean, signal: AbortSignal, beforeRequest?: () => void | Promise<void>): Promise<void> {
    const parsedBody = z.object({ payment_request: z.string().regex(/^lnbcrt[0-9a-z]{20,4096}$/),
      timeout_seconds: z.literal(60), fee_limit_sat: z.enum(['0', '100']), max_parts: z.literal(16),
      outgoing_chan_ids: z.array(z.string().regex(/^[1-9][0-9]{0,19}$/).refine(v => BigInt(v) <= 0xffffffffffffffffn)).length(1),
      no_inflight_updates: z.literal(false), allow_self_payment: z.literal(false), amp: z.literal(false), cancelable: z.literal(false) }).strict().safeParse(body);
    let allowed = path === '/v2/router/send' && parsedBody.success;
    if (!allowed && body === undefined && path.startsWith('/v2/router/track/')) {
      try {
        const encoded = path.slice('/v2/router/track/'.length).split('?')[0]!;
        const bytes = Buffer.from(decodeURIComponent(encoded), 'base64');
        allowed = bytes.length === 32 && path === trackPaymentPath(bytes.toString('hex'));
      } catch { /* Unsupported path remains forbidden. */ }
    }
    if (!allowed) return Promise.reject(new Error('Controlled payer transport operation disabled'));
    return new Promise((resolve, reject) => {
      let request: ClientRequest | undefined; let response: IncomingMessage | undefined;
      let finished = false; let buffered = ''; let bytes = 0; let frames = 0;
      const finish = (ok: boolean) => {
        if (finished) return; finished = true;
        signal.removeEventListener('abort', abort);
        request?.destroy(); response?.destroy();
        if (ok) resolve(); else reject(new Error('LND payment stream uncertain; reconcile existing payment'));
      };
      const abort = () => finish(false);
      if (signal.aborted) return finish(false);
      signal.addEventListener('abort', abort, { once: true });
      // Listeners are installed before credentials load. A stopped client cannot later send.
      void Promise.resolve().then(() => this.io.credentials()).then(async credentials => {
        if (finished || signal.aborted) return;
        await beforeRequest?.();
        if (finished || signal.aborted) return;
        request = this.io.request(new URL(path, this.endpoint), { method: body === undefined ? 'GET' : 'POST',
          ca: credentials.ca, rejectUnauthorized: true, timeout: 15000,
          headers: { 'Grpc-Metadata-macaroon': credentials.macaroon.toString('hex'), 'content-type': 'application/json' } }, res => {
          response = res;
          if (finished) { res.destroy(); return; }
          if (res.statusCode !== 200) return finish(false);
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            if (finished) return;
            bytes += Buffer.byteLength(chunk); buffered += chunk;
            if (bytes > 2_000_000 || Buffer.byteLength(buffered) > 262144) return finish(false);
            let newline: number;
            while (!finished && (newline = buffered.indexOf('\n')) >= 0) {
              const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
              if (!line.trim()) continue;
              try {
                if (++frames > 128) return finish(false);
                const event = JSON.parse(line) as { result?: unknown; error?: unknown };
                if (event.error !== undefined || event.result === undefined) return finish(false);
                if (onPayment(event.result)) return finish(true);
              } catch { return finish(false); }
            }
          });
          res.on('end', () => finish(false)); // EOF, including a truncated frame, never proves success.
          res.on('error', () => finish(false)); res.on('aborted', () => finish(false));
          res.on('close', () => finish(false));
        });
        request.on('error', () => finish(false)); request.on('timeout', () => finish(false));
        request.end(body === undefined ? undefined : JSON.stringify(parsedBody.data));
      }).catch(() => finish(false));
    });
  }
}
