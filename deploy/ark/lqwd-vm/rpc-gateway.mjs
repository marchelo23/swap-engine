#!/usr/bin/env node
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';

const PROFILES = {
  minimal: [
    'getblockchaininfo',
    'getrawtransaction',
    'gettxout',
  ],
  'indexer-readonly': [
    'getbestblockhash',
    'getblock',
    'getblockchaininfo',
    'getblockcount',
    'getblockfilter',
    'getblockhash',
    'getblockheader',
    'getchaintips',
    'getindexinfo',
    'getmempoolentry',
    'getmempoolinfo',
    'getnetworkinfo',
    'getrawmempool',
    'getrawtransaction',
    'gettxout',
  ],
};

function fail(message) {
  console.error(message);
  process.exit(1);
}

function integer(value, fallback, min, max, label) {
  const number = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    fail(`${label} must be an integer between ${min} and ${max}`);
  }
  return number;
}

function loopback(value, label) {
  if (value !== '127.0.0.1') fail(`${label} must be 127.0.0.1`);
  return value;
}

const profile = process.env.ARK_GATEWAY_PROFILE ?? 'minimal';
const allowed = PROFILES[profile];
if (!allowed) fail(`ARK_GATEWAY_PROFILE_INVALID: ${profile}`);
const allowedSet = new Set(allowed);
const listenHost = loopback(process.env.ARK_GATEWAY_LISTEN_HOST ?? '127.0.0.1', 'listen host');
const listenPort = integer(process.env.ARK_GATEWAY_LISTEN_PORT, 18446, 1, 65535, 'listen port');
const upstreamHost = loopback(process.env.ARK_GATEWAY_UPSTREAM_HOST ?? '127.0.0.1', 'upstream host');
const upstreamPort = integer(process.env.ARK_GATEWAY_UPSTREAM_PORT, 18443, 1, 65535, 'upstream port');
const cookiePath = process.env.ARK_GATEWAY_COOKIE ?? join(homedir(), '.bitcoin', 'regtest', '.cookie');
const authUser = process.env.ARK_GATEWAY_AUTH_USER;
const authPassword = process.env.ARK_GATEWAY_AUTH_PASSWORD;
if (!authUser || !authPassword) fail('ARK_GATEWAY_AUTH_USER and ARK_GATEWAY_AUTH_PASSWORD are required');
if (authUser.includes(':')) fail('ARK_GATEWAY_AUTH_USER must not contain a colon');
const expectedAuthorization = `Basic ${Buffer.from(`${authUser}:${authPassword}`).toString('base64')}`;
const maxBody = integer(process.env.ARK_GATEWAY_MAX_BODY, 65536, 1024, 1048576, 'max body');
const maxResponse = integer(process.env.ARK_GATEWAY_MAX_RESPONSE, 8388608, 1024, 33554432, 'max response');
const timeoutMs = integer(process.env.ARK_GATEWAY_UPSTREAM_TIMEOUT_MS, 15000, 1000, 60000, 'upstream timeout');
const maxBatch = 100;

try {
  readFileSync(cookiePath, 'utf8');
} catch {
  fail(`ARK_GATEWAY_COOKIE_UNREADABLE: ${cookiePath}`);
}

function authorized(req) {
  const value = req.headers.authorization;
  if (typeof value !== 'string') return false;
  const actual = Buffer.from(value);
  const expected = Buffer.from(expectedAuthorization);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function canonicalize(parsed) {
  const items = Array.isArray(parsed) ? parsed : [parsed];
  if (items.length === 0 || items.length > maxBatch) return null;
  const out = [];
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    if (typeof item.method !== 'string' || item.method.length === 0) return null;
    if (item.jsonrpc !== undefined && item.jsonrpc !== '2.0') return null;
    if (item.params !== undefined && item.params !== null && typeof item.params !== 'object') return null;
    if (item.id === undefined) return null;
    if (item.id !== null && typeof item.id !== 'string' && typeof item.id !== 'number') return null;
    out.push({
      jsonrpc: '2.0',
      method: item.method,
      params: item.params ?? [],
      id: item.id,
    });
  }
  return {
    body: JSON.stringify(Array.isArray(parsed) ? out : out[0]),
    methods: out.map(item => item.method),
  };
}

function reject(res, status, message, code = -32601, headers = {}) {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json', connection: 'close', ...headers });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

function log(...parts) {
  console.log(`${new Date().toISOString()} ${parts.join(' ')}`);
}

const server = http.createServer((req, res) => {
  log(`request=${req.method} path=${req.url}`);
  if (req.method !== 'POST') {
    reject(res, 405, 'POST required', -32600);
    return;
  }
  log('auth-check');
  if (!authorized(req)) {
    log('auth=denied status=denied');
    reject(res, 401, 'unauthorized', -32600, { 'www-authenticate': 'Basic realm="ark-lqwd-vm"' });
    return;
  }
  log('auth-ok');
  if (req.url !== '/') {
    log(`path=${req.url} status=denied`);
    reject(res, 403, 'path not allowed');
    return;
  }
  const contentType = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    reject(res, 415, 'application/json required', -32600);
    return;
  }
  log('content-type-ok');
  let body = '';
  let bytes = 0;
  let tooLarge = false;
  req.on('aborted', () => log('request=aborted'));
  req.on('close', () => log('request=close'));
  req.on('error', error => log(`request=error ${error.message}`));
  req.setEncoding('utf8');
  req.setTimeout(timeoutMs, () => {
    log('request=timeout status=denied');
    if (res.headersSent || res.writableEnded) return;
    reject(res, 408, 'request timeout', -32600);
    req.destroy();
  });
  req.on('data', chunk => {
    log(`data=${chunk.length}`);
    if (tooLarge) return;
    bytes += Buffer.byteLength(chunk);
    if (bytes > maxBody) {
      tooLarge = true;
      log('body=too_large status=denied');
      req.pause();
      reject(res, 413, 'request too large', -32600);
      return;
    }
    body += chunk;
  });
  req.on('end', () => {
    log('body-end');
    req.setTimeout(0);
    if (tooLarge) return;
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      reject(res, 400, 'invalid JSON-RPC body', -32600);
      return;
    }
    const canonical = canonicalize(parsed);
    if (!canonical) {
      reject(res, 400, 'invalid JSON-RPC shape', -32600);
      return;
    }
    const denied = canonical.methods.filter(name => !allowedSet.has(name));
    if (denied.length > 0) {
      log(`method=${denied.join(',')} status=denied`);
      reject(res, 403, 'method not allowed by read-only gateway');
      return;
    }
    let authorization;
    try {
      authorization = `Basic ${Buffer.from(readFileSync(cookiePath, 'utf8').trim()).toString('base64')}`;
    } catch {
      log('cookie=unavailable status=error');
      reject(res, 503, 'core cookie unavailable');
      return;
    }
    let timer;
    let timedOut = false;
    const upstream = http.request({
      host: upstreamHost,
      port: upstreamPort,
      path: '/',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(canonical.body),
        connection: 'close',
        authorization,
      },
    }, up => {
      const chunks = [];
      let responseBytes = 0;
      let responseTooLarge = false;
      up.on('data', chunk => {
        responseBytes += chunk.length;
        if (responseBytes > maxResponse) {
          responseTooLarge = true;
          up.destroy(new Error('response too large'));
          return;
        }
        chunks.push(chunk);
      });
      up.on('end', () => {
        clearTimeout(timer);
        if (res.headersSent || res.writableEnded) return;
        const buffer = Buffer.concat(chunks);
        const headers = { ...up.headers };
        delete headers['transfer-encoding'];
        headers['content-length'] = String(buffer.length);
        log(`method=${canonical.methods.join(',')} status=${up.statusCode ?? 0} bytes=${buffer.length}`);
        res.writeHead(up.statusCode ?? 502, headers);
        res.end(buffer);
      });
      up.on('error', () => {
        clearTimeout(timer);
        if (timedOut || res.headersSent || res.writableEnded) return;
        if (responseTooLarge) {
          log(`method=${canonical.methods.join(',')} status=response_too_large`);
          reject(res, 502, 'core response too large');
        } else {
          log(`method=${canonical.methods.join(',')} status=upstream_error`);
          reject(res, 502, 'core upstream unavailable');
        }
      });
    });
    timer = setTimeout(() => {
      timedOut = true;
      if (!res.headersSent && !res.writableEnded) {
        log(`method=${canonical.methods.join(',')} status=timeout`);
        reject(res, 504, 'core upstream timeout');
      }
      upstream.destroy();
    }, timeoutMs);
    upstream.on('close', () => clearTimeout(timer));
    upstream.on('error', () => {
      clearTimeout(timer);
      if (timedOut || res.headersSent || res.writableEnded) return;
      log(`method=${canonical.methods.join(',')} status=upstream_error`);
      reject(res, 502, 'core upstream unavailable');
    });
    upstream.end(canonical.body);
  });
});

server.requestTimeout = timeoutMs;
server.headersTimeout = Math.min(10000, timeoutMs);
server.keepAliveTimeout = 5000;
server.on('clientError', (error, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(listenPort, listenHost, () => {
  log(`listening=${listenHost}:${listenPort} upstream=${upstreamHost}:${upstreamPort} profile=${profile} auth=basic maxBody=${maxBody} maxResponse=${maxResponse} timeoutMs=${timeoutMs} cookie=${cookiePath}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
