import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function loopbackOrigin(value: string | undefined) {
  const url = new URL(value ?? '');
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.origin !== value)
    throw new Error('Expected an explicit HTTP origin on 127.0.0.1 with a port');
  return url;
}

export function createUnifiedRegtestServer(options: { browserOrigin: string; adminOrigin: string; guestOrigin: string }) {
  const browser = loopbackOrigin(options.browserOrigin);
  const admin = loopbackOrigin(options.adminOrigin);
  const guest = loopbackOrigin(options.guestOrigin);
  if (new Set([browser.origin, admin.origin, guest.origin]).size !== 3)
    throw new Error('Browser, Admin and Guest require distinct origins');

  return createServer((req, res) => {
    const reject = (status: number, error: string) => {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error }));
    };
    if (req.headers.host !== browser.host || (req.headers.origin && req.headers.origin !== browser.origin))
      return reject(403, 'ORIGIN_FORBIDDEN');
    if (!req.url?.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\'))
      return reject(400, 'INVALID_PATH');
    const method = req.method ?? '';
    if (!['GET', 'HEAD', 'POST'].includes(method)) return reject(405, 'METHOD_NOT_ALLOWED');
    if (method === 'POST' && req.headers.origin !== browser.origin) return reject(403, 'ORIGIN_FORBIDDEN');
    const url = new URL(req.url, browser);
    const isGuest = url.pathname.startsWith('/v1/guest/');
    const target = isGuest ? guest : admin;
    const headers: IncomingHttpHeaders = { host: target.host };
    for (const key of ['accept', 'content-type', 'content-length', 'idempotency-key']) {
      if (req.headers[key] !== undefined) headers[key] = req.headers[key];
    }
    for (const key of isGuest ? ['authorization'] : ['cookie', 'x-csrf-token']) {
      if (req.headers[key] !== undefined) headers[key] = req.headers[key];
    }
    if (req.headers.origin) headers.origin = target.origin;

    const upstream = request(target, { method, path: url.pathname + url.search, headers }, response => {
      const outgoing: IncomingHttpHeaders = {};
      for (const key of ['content-type', 'content-length', 'cache-control', 'content-security-policy',
        'x-content-type-options', 'retry-after', 'www-authenticate']) {
        if (response.headers[key] !== undefined) outgoing[key] = response.headers[key];
      }
      if (!isGuest && response.headers['set-cookie']) outgoing['set-cookie'] = response.headers['set-cookie'];
      res.writeHead(response.statusCode ?? 502, outgoing);
      response.on('error', () => res.destroy());
      response.pipe(res);
    });
    upstream.setTimeout(90_000, () => upstream.destroy());
    upstream.on('error', () => reject(502, isGuest ? 'GUEST_UNAVAILABLE' : 'ADMIN_UNAVAILABLE'));
    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
    req.on('error', () => upstream.destroy());
    req.pipe(upstream);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const browser = loopbackOrigin(process.env.UNIFIED_BROWSER_ORIGIN);
  const server = createUnifiedRegtestServer({
    browserOrigin: browser.origin,
    adminOrigin: loopbackOrigin(process.env.UNIFIED_ADMIN_ORIGIN).origin,
    guestOrigin: loopbackOrigin(process.env.UNIFIED_GUEST_ORIGIN).origin,
  });
  server.listen(Number(browser.port), browser.hostname);
}
