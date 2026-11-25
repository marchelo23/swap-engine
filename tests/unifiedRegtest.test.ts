import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createUnifiedRegtestServer } from '../scripts/serve-unified-regtest.js';

async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

test('one origin serves the existing Admin session and the capability-only Guest API', async t => {
  const observed: { target: string; url?: string; origin?: string; cookie?: string; authorization?: string }[] = [];
  const backend = (target: string) => createServer((req, res) => {
    observed.push({ target, url: req.url, origin: req.headers.origin, cookie: req.headers.cookie,
      authorization: req.headers.authorization });
    req.resume();
    res.writeHead(200, { 'set-cookie': ['session=fixture; Path=/; HttpOnly'], 'content-type': 'application/json' });
    res.end('{}');
  });
  const admin = backend('admin');
  const guest = backend('guest');
  const adminOrigin = `http://127.0.0.1:${await listen(admin)}`;
  const guestOrigin = `http://127.0.0.1:${await listen(guest)}`;
  const browserOrigin = 'http://127.0.0.1:31998';
  const gateway = createUnifiedRegtestServer({ browserOrigin, adminOrigin, guestOrigin });
  const port = await listen(gateway);
  t.after(() => Promise.all([gateway, admin, guest].map(server => new Promise<void>(resolve => server.close(() => resolve())))));
  const send = (path: string, method: string, origin?: string) => new Promise<{ code?: number; cookie?: string[] }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method,
      headers: { host: '127.0.0.1:31998', cookie: 'session=admin', authorization: 'Bearer recovery',
        ...(origin ? { origin } : {}) } }, res => {
      res.resume();
      res.on('end', () => resolve({ code: res.statusCode, cookie: res.headers['set-cookie'] }));
    });
    req.on('error', reject);
    req.end();
  });

  assert.equal((await send('/v1/auth/session', 'GET')).code, 200);
  assert.ok((await send('/v1/reverse/preparations', 'POST', browserOrigin)).cookie);
  assert.deepEqual(await send('/v1/guest/quotes/id/prepare', 'POST', browserOrigin), { code: 200, cookie: undefined });
  assert.equal((await send('/v1/guest/estimate?amountSats=50000', 'GET')).code, 200);
  assert.equal((await send('/v1/reverse/preparations', 'POST', 'https://other.example')).code, 403);
  assert.equal((await send('/v1/guest/quotes', 'POST')).code, 403);
  assert.deepEqual(observed, [
    { target: 'admin', url: '/v1/auth/session', origin: undefined, cookie: 'session=admin', authorization: undefined },
    { target: 'admin', url: '/v1/reverse/preparations', origin: adminOrigin, cookie: 'session=admin', authorization: undefined },
    { target: 'guest', url: '/v1/guest/quotes/id/prepare', origin: guestOrigin, cookie: undefined, authorization: 'Bearer recovery' },
    { target: 'guest', url: '/v1/guest/estimate?amountSats=50000', origin: undefined, cookie: undefined, authorization: 'Bearer recovery' },
  ]);
});
