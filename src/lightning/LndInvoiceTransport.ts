import https from 'node:https';
import { readFile } from 'node:fs/promises';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { z } from 'zod';
import { parseLndInvoice } from './InvoiceParser.js';
import type { Invoice } from './LndClient.js';
import type { PreparationAdapters } from '../core/ReversePreparation.js';

export type InvoiceTransportIO = {
  credentials(): Promise<{ ca: Buffer; macaroon: Buffer }>;
  request(url: URL, options: https.RequestOptions, callback: (response: IncomingMessage) => void): ClientRequest;
};
type Request = Parameters<PreparationAdapters['createInvoice']>[0];
export type InvoiceLookup = { status: 'ABSENT' } | { status: 'PRESENT'; invoice: Invoice };
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const requestSchema = z.object({ hash, sats: z.union([z.number().int().min(11000).max(50000), z.literal(50750)]), expirySeconds: z.literal(3600), cltvDelta: z.literal(80) }).strict();
const absentSchema = z.object({ code: z.literal(5), message: z.enum(['unable to locate invoice', 'there are no existing invoices']),
  details: z.array(z.never()).length(0).optional() }).strict();
const uncertain = () => new Error('LND invoice evidence unavailable or outcome uncertain; reconcile without retry');

/** LND v0.21.6: exact unary hold-invoice POST and hash-only GET. No redirects/retries.
 * Read and mutation credentials are separate; omitting writer disables creation.
 */
export class HttpsLndInvoiceTransport {
  private readonly endpoint: URL;
  private readonly reader: InvoiceTransportIO;
  private readonly writer?: InvoiceTransportIO;
  get origin(): string { return this.endpoint.origin; }
  constructor(url: string, certPath: string, readMacaroonPath: string, writeMacaroonPath?: string,
    io?: { reader: InvoiceTransportIO; writer?: InvoiceTransportIO }, private readonly deadlineMs = 30000) {
    try { this.endpoint = new URL(url); } catch { throw uncertain(); }
    if (this.endpoint.protocol !== 'https:' || !['localhost', '127.0.0.1', '[::1]'].includes(this.endpoint.hostname) ||
      this.endpoint.username || this.endpoint.password || this.endpoint.pathname !== '/' || this.endpoint.search || this.endpoint.hash ||
      !Number.isSafeInteger(deadlineMs) || deadlineMs < 10 || deadlineMs > 60000) throw uncertain();
    const makeIO = (path: string): InvoiceTransportIO => ({
      credentials: async () => { const [ca, macaroon] = await Promise.all([readFile(certPath), readFile(path)]); return { ca, macaroon }; },
      request: (target, options, callback) => https.request(target, options, callback),
    });
    this.reader = io?.reader ?? makeIO(readMacaroonPath);
    this.writer = io ? io.writer : writeMacaroonPath ? makeIO(writeMacaroonPath) : undefined;
  }
  async create(value: Request, beforeRequest: () => Promise<void>, signal?: AbortSignal): Promise<{ payment_request: string }> {
    try {
      const request = requestSchema.parse(value);
      if (!this.writer || typeof beforeRequest !== 'function') throw uncertain();
      // Snapshot the fixed wire body before any asynchronous credential or guard work.
      const body = JSON.stringify({ hash: Buffer.from(request.hash, 'hex').toString('base64'), value: String(request.sats), expiry: '3600',
        cltv_expiry: '80', memo: 'LQWD regtest reverse swap' });
      const response = await this.unary('/v2/invoices/hodl', body, this.writer, beforeRequest, signal);
      if (response.status !== 200 || !response.json || typeof response.json !== 'object' ||
        'code' in response.json || 'error' in response.json) throw uncertain();
      return z.object({ payment_request: z.string().regex(/^lnbcrt[0-9a-z]{20,4096}$/) }).parse(response.json);
    } catch { throw uncertain(); }
  }
  async lookup(paymentHash: string, signal?: AbortSignal): Promise<InvoiceLookup> {
    try {
      hash.parse(paymentHash);
      const response = await this.unary(`/v1/invoice/${paymentHash}`, undefined, this.reader, undefined, signal);
      if (response.status === 404 && absentSchema.safeParse(response.json).success) return { status: 'ABSENT' };
      if (response.status !== 200 || !response.json || typeof response.json !== 'object' ||
        'code' in response.json || 'error' in response.json) throw uncertain();
      const invoice = parseLndInvoice(response.json);
      if (invoice.r_hash !== Buffer.from(paymentHash, 'hex').toString('base64')) throw uncertain();
      return { status: 'PRESENT', invoice };
    } catch { throw uncertain(); }
  }
  private unary(path: string, body: string | undefined, io: InvoiceTransportIO, beforeRequest?: () => Promise<void>, signal?: AbortSignal)
    : Promise<{ status: number; json: unknown }> {
    return new Promise((resolve, reject) => {
      let request: ClientRequest | undefined; let response: IncomingMessage | undefined; let done = false; let bytes = 0; let content = '';
      const stop = (result?: { status: number; json: unknown }) => {
        if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        request?.destroy(); response?.destroy(); if (result) resolve(result); else reject(uncertain());
      };
      const abort = () => stop(); const timer = setTimeout(abort, this.deadlineMs);
      signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) { stop(); return; }
      void Promise.resolve().then(() => io.credentials()).then(async credentials => {
        if (done || signal?.aborted) return;
        await beforeRequest?.();
        if (done || signal?.aborted) return;
        request = io.request(new URL(path, this.endpoint), { method: body === undefined ? 'GET' : 'POST', ca: credentials.ca,
          rejectUnauthorized: true, timeout: 15000, headers: { 'Grpc-Metadata-macaroon': credentials.macaroon.toString('hex'),
            'content-type': 'application/json' } }, res => {
          response = res; if (done) { res.destroy(); return; }
          if (!/^application\/json(?:\s*;.*)?$/i.test(String(res.headers['content-type'] ?? ''))) { stop(); return; }
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            if (done) return; bytes += Buffer.byteLength(chunk);
            if (bytes > 262144) { stop(); return; } content += chunk;
          });
          res.on('end', () => {
            if (done) return;
            try { stop({ status: res.statusCode ?? 0, json: JSON.parse(content) }); } catch { stop(); }
          });
          res.on('error', abort); res.on('aborted', abort); res.on('close', abort);
        });
        request.on('error', abort); request.on('timeout', abort); request.end(body);
      }).catch(abort);
    });
  }
}
