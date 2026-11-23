import { readFile } from 'node:fs/promises';

const reads = new Set(['getblockchaininfo', 'getblockhash', 'getsidechaininfo', 'getwalletinfo', 'getnetworkinfo',
  'getblock', 'listunspent']);

/** Read-only Elements JSON-RPC client. It has no signing, funding, broadcast or
 * wallet-mutation method and rejects anything outside the exact read allowlist. */
export class ElementsReadOnlyClient {
  constructor(private readonly url: string, private readonly cookiePath: string,
    private readonly wallet: string) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) ||
      parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash)
      throw new Error('ELEMENTS_RPC_CONFIGURATION_INVALID');
    if (!wallet) throw new Error('ELEMENTS_WALLET_REQUIRED');
  }
  get origin() { return new URL(this.url).origin; }
  async call<T>(method: string, params: unknown[] = [], wallet = false): Promise<T> {
    if (!reads.has(method)) throw new Error('READ_ONLY_MODE: Elements operation disabled');
    const cookie = (await readFile(this.cookiePath, 'utf8')).trim();
    const response = await fetch(`${this.url.replace(/\/$/, '')}${wallet ? `/wallet/${encodeURIComponent(this.wallet)}` : ''}`, {
      method: 'POST', signal: AbortSignal.timeout(15_000), redirect: 'error',
      headers: { authorization: `Basic ${Buffer.from(cookie).toString('base64')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '1.0', id: 'lqwd-elements', method, params }),
    });
    const body = await response.json() as { result: T; error?: { code: number } };
    if (body.error) throw new Error(`Elements RPC ${method} error ${body.error.code}`);
    if (!response.ok) throw new Error(`Elements RPC HTTP ${response.status}`);
    return body.result;
  }
}
