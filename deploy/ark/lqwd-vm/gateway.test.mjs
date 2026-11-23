import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const gatewayPath = join(here, 'rpc-gateway.mjs');
const authUser = 'gateway';
const authPassword = 'secret';
const authorization = `Basic ${Buffer.from(`${authUser}:${authPassword}`).toString('base64')}`;
const cookie = '__cookie__:testcookie';
const cookieAuthorization = `Basic ${Buffer.from(cookie).toString('base64')}`;
const tempDir = mkdtempSync(join(tmpdir(), 'ark-gateway-test-'));
const cookiePath = join(tempDir, 'cookie');
writeFileSync(cookiePath, cookie);

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const baseEnv = {
  ARK_GATEWAY_PROFILE: 'minimal',
  ARK_GATEWAY_LISTEN_HOST: '127.0.0.1',
  ARK_GATEWAY_UPSTREAM_HOST: '127.0.0.1',
  ARK_GATEWAY_COOKIE: cookiePath,
  ARK_GATEWAY_AUTH_USER: authUser,
  ARK_GATEWAY_AUTH_PASSWORD: authPassword,
};

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function closeServer(server) {
  return new Promise(resolve => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(() => resolve());
  });
}

function startMock(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const record = { headers: req.headers, body, parsed: JSON.parse(body) };
      requests.push(record);
      handler(req, res, record);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        requests,
        close: () => closeServer(server),
      });
    });
  });
}

function spawnGateway(env) {
  const child = spawn(process.execPath, [gatewayPath], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.output = '';
  child.stdout.on('data', chunk => { child.output += chunk.toString(); });
  child.stderr.on('data', chunk => { child.output += chunk.toString(); });
  return child;
}

function waitForExit(child, timeoutMs = 3000) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`process did not exit: ${child.output}`)), timeoutMs);
    child.once('exit', code => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function stopGateway(child) {
  if (child.exitCode !== null) return;
  child.kill();
  try {
    await waitForExit(child, 1500);
  } catch {
    child.kill('SIGKILL');
    await waitForExit(child, 1500).catch(() => {});
  }
}

function waitForPort(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error(`gateway did not listen on ${port}`));
        else setTimeout(attempt, 50);
      });
    };
    attempt();
  });
}

async function startGateway(extra = {}) {
  const port = await freePort();
  const child = spawnGateway({
    ...baseEnv,
    ARK_GATEWAY_LISTEN_PORT: String(port),
    ...extra,
  });
  await waitForPort(port);
  return { port, child };
}

function request(port, { path = '/', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method: 'POST',
      agent: false,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        ...headers,
      },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('gateway defenses', async t => {
  const mock = await startMock((req, res, record) => {
    const id = Array.isArray(record.parsed) ? record.parsed.map(item => item.id) : record.parsed.id;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', result: { ok: true }, id }));
  });
  const gateway = await startGateway({ ARK_GATEWAY_UPSTREAM_PORT: String(mock.port) });

  t.after(async () => {
    await stopGateway(gateway.child);
    await mock.close();
  });

  await t.test('allowed method is canonicalized and cookie-injected', async () => {
    const before = mock.requests.length;
    const response = await request(gateway.port, {
      headers: { authorization },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'getblockchaininfo',
        params: [],
        id: 1,
        extra: 'drop',
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(mock.requests.length, before + 1);
    const record = mock.requests.at(-1);
    assert.equal(record.headers.authorization, cookieAuthorization);
    assert.deepEqual(record.parsed, {
      jsonrpc: '2.0',
      method: 'getblockchaininfo',
      params: [],
      id: 1,
    });
    assert.equal(record.body, '{"jsonrpc":"2.0","method":"getblockchaininfo","params":[],"id":1}');
  });

  await t.test('duplicate keys resolve to the last value and are denied', async () => {
    const before = mock.requests.length;
    const body = '{"jsonrpc":"2.0","method":"getblockchaininfo","method":"sendrawtransaction","params":[],"id":2}';
    const response = await request(gateway.port, { headers: { authorization }, body });
    assert.equal(response.status, 403);
    assert.equal(mock.requests.length, before);
  });

  await t.test('duplicate keys are re-serialized to one canonical method', async () => {
    const before = mock.requests.length;
    const body = '{"jsonrpc":"2.0","method":"sendrawtransaction","method":"getblockchaininfo","params":[],"id":3}';
    const response = await request(gateway.port, { headers: { authorization }, body });
    assert.equal(response.status, 200);
    assert.equal(mock.requests.length, before + 1);
    const record = mock.requests.at(-1);
    assert.equal(record.body, '{"jsonrpc":"2.0","method":"getblockchaininfo","params":[],"id":3}');
    assert.equal((record.body.match(/"method"/g) ?? []).length, 1);
  });

  await t.test('missing or wrong Basic auth is rejected', async () => {
    const before = mock.requests.length;
    const missing = await request(gateway.port, {
      body: '{"jsonrpc":"2.0","method":"getblockchaininfo","params":[],"id":4}',
    });
    assert.equal(missing.status, 401);
    const wrong = await request(gateway.port, {
      headers: { authorization: `Basic ${Buffer.from('gateway:wrong').toString('base64')}` },
      body: '{"jsonrpc":"2.0","method":"getblockchaininfo","params":[],"id":5}',
    });
    assert.equal(wrong.status, 401);
    assert.equal(mock.requests.length, before);
  });

  await t.test('non-allowlisted method is rejected', async () => {
    const before = mock.requests.length;
    const response = await request(gateway.port, {
      headers: { authorization },
      body: '{"jsonrpc":"2.0","method":"sendrawtransaction","params":["00"],"id":6}',
    });
    assert.equal(response.status, 403);
    assert.equal(mock.requests.length, before);
  });

  await t.test('wallet paths are rejected', async () => {
    const before = mock.requests.length;
    const response = await request(gateway.port, {
      path: '/wallet/lqwd-lab',
      headers: { authorization },
      body: '{"jsonrpc":"2.0","method":"getblockchaininfo","params":[],"id":7}',
    });
    assert.equal(response.status, 403);
    assert.equal(mock.requests.length, before);
  });

  await t.test('non-JSON content type is rejected', async () => {
    const response = await request(gateway.port, {
      headers: { authorization, 'content-type': 'application/octet-stream' },
      body: '{"jsonrpc":"2.0","method":"getblockchaininfo","params":[],"id":8}',
    });
    assert.equal(response.status, 415);
  });

  await t.test('a batch with one denied method is rejected as a whole', async () => {
    const before = mock.requests.length;
    const body = JSON.stringify([
      { jsonrpc: '2.0', method: 'getblockchaininfo', params: [], id: 9 },
      { jsonrpc: '2.0', method: 'sendrawtransaction', params: ['00'], id: 10 },
    ]);
    const response = await request(gateway.port, { headers: { authorization }, body });
    assert.equal(response.status, 403);
    assert.equal(mock.requests.length, before);
  });

  await t.test('invalid shapes are rejected', async () => {
    const cases = [
      '{"jsonrpc":"2.0","method":"getblockchaininfo","params":[]}',
      '{"jsonrpc":"2.0","params":[],"id":11}',
      '[]',
      '{"jsonrpc":"2.0","method":"getblockchaininfo","params":"bad","id":12}',
      '{"jsonrpc":"1.0","method":"getblockchaininfo","params":[],"id":13}',
      'null',
    ];
    for (const body of cases) {
      const response = await request(gateway.port, { headers: { authorization }, body });
      assert.equal(response.status, 400, body);
    }
  });

  await t.test('wallet RPCs are not in the minimal profile', async () => {
    for (const method of ['listunspent', 'listlockunspent', 'getwalletinfo', 'scantxoutset']) {
      const response = await request(gateway.port, {
        headers: { authorization },
        body: JSON.stringify({ jsonrpc: '2.0', method, params: [], id: 14 }),
      });
      assert.equal(response.status, 403, method);
    }
  });

  await t.test('minimal profile does not allow indexer-only methods', async () => {
    const response = await request(gateway.port, {
      headers: { authorization },
      body: '{"jsonrpc":"2.0","method":"getblockhash","params":[1],"id":15}',
    });
    assert.equal(response.status, 403);
  });

  await t.test('oversized request is rejected', async () => {
    const gatewaySmall = await startGateway({
      ARK_GATEWAY_UPSTREAM_PORT: String(mock.port),
      ARK_GATEWAY_MAX_BODY: '1024',
    });
    try {
      const before = mock.requests.length;
      const response = await request(gatewaySmall.port, {
        headers: { authorization },
        body: 'x'.repeat(2048),
      });
      assert.equal(response.status, 413);
      assert.equal(mock.requests.length, before);
    } finally {
      await stopGateway(gatewaySmall.child);
    }
  });

  await t.test('oversized upstream response is rejected', async () => {
    const big = await startMock((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('x'.repeat(4096));
    });
    const gatewaySmall = await startGateway({
      ARK_GATEWAY_UPSTREAM_PORT: String(big.port),
      ARK_GATEWAY_MAX_RESPONSE: '1024',
    });
    try {
      const response = await request(gatewaySmall.port, {
        headers: { authorization },
        body: '{"jsonrpc":"2.0","method":"getblockchaininfo","params":[],"id":16}',
      });
      assert.equal(response.status, 502);
    } finally {
      await stopGateway(gatewaySmall.child);
      await big.close();
    }
  });

  await t.test('slow upstream times out', async () => {
    const slow = await startMock((req, res) => {
      setTimeout(() => {
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"jsonrpc":"2.0","result":{},"id":17}');
      }, 2000);
    });
    const gatewaySlow = await startGateway({
      ARK_GATEWAY_UPSTREAM_PORT: String(slow.port),
      ARK_GATEWAY_UPSTREAM_TIMEOUT_MS: '1000',
    });
    try {
      const response = await request(gatewaySlow.port, {
        headers: { authorization },
        body: '{"jsonrpc":"2.0","method":"getblockchaininfo","params":[],"id":17}',
      });
      assert.equal(response.status, 504);
    } finally {
      await stopGateway(gatewaySlow.child);
      await slow.close();
    }
  });

  await t.test('indexer profile allows chain reads but not sends or wallets', async () => {
    const gatewayIndexer = await startGateway({
      ARK_GATEWAY_UPSTREAM_PORT: String(mock.port),
      ARK_GATEWAY_PROFILE: 'indexer-readonly',
    });
    try {
      const allowed = await request(gatewayIndexer.port, {
        headers: { authorization },
        body: '{"jsonrpc":"2.0","method":"getblockhash","params":[1],"id":18}',
      });
      assert.equal(allowed.status, 200);
      const send = await request(gatewayIndexer.port, {
        headers: { authorization },
        body: '{"jsonrpc":"2.0","method":"sendrawtransaction","params":["00"],"id":19}',
      });
      assert.equal(send.status, 403);
      const wallet = await request(gatewayIndexer.port, {
        headers: { authorization },
        body: '{"jsonrpc":"2.0","method":"listunspent","params":[],"id":20}',
      });
      assert.equal(wallet.status, 403);
    } finally {
      await stopGateway(gatewayIndexer.child);
    }
  });
});

test('gateway startup fails closed', async t => {
  await t.test('non-loopback bind is rejected', async () => {
    const child = spawnGateway({
      ...baseEnv,
      ARK_GATEWAY_LISTEN_PORT: String(await freePort()),
      ARK_GATEWAY_LISTEN_HOST: '0.0.0.0',
    });
    assert.equal(await waitForExit(child), 1);
    assert.match(child.output, /listen host must be 127\.0\.0\.1/);
  });

  await t.test('non-loopback upstream is rejected', async () => {
    const child = spawnGateway({
      ...baseEnv,
      ARK_GATEWAY_LISTEN_PORT: String(await freePort()),
      ARK_GATEWAY_UPSTREAM_HOST: '192.0.2.1',
    });
    assert.equal(await waitForExit(child), 1);
    assert.match(child.output, /upstream host must be 127\.0\.0\.1/);
  });

  await t.test('missing inbound auth is rejected', async () => {
    const env = { ...baseEnv, ARK_GATEWAY_LISTEN_PORT: String(await freePort()) };
    delete env.ARK_GATEWAY_AUTH_USER;
    const child = spawnGateway(env);
    assert.equal(await waitForExit(child), 1);
    assert.match(child.output, /ARK_GATEWAY_AUTH_USER/);
  });

  await t.test('unknown profile is rejected', async () => {
    const child = spawnGateway({
      ...baseEnv,
      ARK_GATEWAY_LISTEN_PORT: String(await freePort()),
      ARK_GATEWAY_PROFILE: 'wallet',
    });
    assert.equal(await waitForExit(child), 1);
    assert.match(child.output, /ARK_GATEWAY_PROFILE_INVALID/);
  });

  await t.test('unreadable cookie is rejected', async () => {
    const child = spawnGateway({
      ...baseEnv,
      ARK_GATEWAY_LISTEN_PORT: String(await freePort()),
      ARK_GATEWAY_COOKIE: join(tempDir, 'missing'),
    });
    assert.equal(await waitForExit(child), 1);
    assert.match(child.output, /ARK_GATEWAY_COOKIE_UNREADABLE/);
  });
});
