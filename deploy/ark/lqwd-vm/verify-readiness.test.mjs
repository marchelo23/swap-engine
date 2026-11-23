import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, 'verify-readiness.mjs');
const height = 195;
const hash = '3cd3c4ff0a2285577dec6db74b9c57152f5a768f13abfbe32a12c54fa11b8335';
const signer = `02${'11'.repeat(32)}`;

const state = {
  ark: {
    network: 'regtest',
    signerPubkey: signer,
    forfeitAddress: 'bcrt1qtest',
    dust: 330,
  },
  mempoolHeight: String(height),
  mempoolHash: hash,
  nbx: {
    networkType: 'Regtest',
    isFullySynched: true,
    syncHeight: height,
    chainHeight: height,
  },
};

function sendJson(res, value, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

function sendText(res, value, status = 200) {
  res.writeHead(status, { 'content-type': 'text/plain' });
  res.end(value);
}

function startServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () => new Promise(done => {
          if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
          server.close(() => done());
        }),
      });
    });
  });
}

const ark = await startServer((req, res) => {
  if (req.url === '/v1/info') return sendJson(res, state.ark);
  return sendJson(res, { error: 'not found' }, 404);
});

const mempool = await startServer((req, res) => {
  if (req.url === '/api/blocks/tip/height') return sendText(res, state.mempoolHeight);
  if (req.url === '/api/blocks/tip/hash') return sendText(res, state.mempoolHash);
  return sendText(res, 'not found', 404);
});

const nbx = await startServer((req, res) => {
  if (req.url === '/v1/cryptos/BTC/status') return sendJson(res, state.nbx);
  return sendJson(res, { error: 'not found' }, 404);
});

after(async () => {
  await ark.close();
  await mempool.close();
  await nbx.close();
});

function run() {
  const child = spawn(process.execPath, [
    scriptPath,
    '--ark', `http://127.0.0.1:${ark.port}`,
    '--mempool', `http://127.0.0.1:${mempool.port}`,
    '--nbx', `http://127.0.0.1:${nbx.port}`,
    '--expected-height', String(height),
    '--expected-hash', hash,
    '--expected-signer', signer,
    '--expected-dust', '330',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve({ code, stdout, stderr }));
  });
}

test('readiness passes on exact height, hash, signer and sync state', async () => {
  const result = await run();
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'passed');
  assert.deepEqual(report.failures, []);
  assert.equal(report.observed.mempool.height, height);
  assert.equal(report.observed.mempool.hash, hash);
  assert.equal(report.observed.nbxplorer.isFullySynched, true);
});

test('readiness fails on hash mismatch', async () => {
  const original = state.mempoolHash;
  state.mempoolHash = '00'.repeat(32);
  try {
    const result = await run();
    assert.equal(result.code, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, 'failed');
    assert.ok(report.failures.includes('ESPLORA_HASH_MISMATCH'));
  } finally {
    state.mempoolHash = original;
  }
});

test('readiness fails when NBXplorer is not fully synced', async () => {
  const original = state.nbx.isFullySynched;
  state.nbx.isFullySynched = false;
  try {
    const result = await run();
    assert.equal(result.code, 1);
    const report = JSON.parse(result.stdout);
    assert.ok(report.failures.includes('NBX_NOT_FULLY_SYNCHED'));
  } finally {
    state.nbx.isFullySynched = original;
  }
});

test('readiness fails on signer mismatch', async () => {
  const original = state.ark.signerPubkey;
  state.ark.signerPubkey = `03${'22'.repeat(32)}`;
  try {
    const result = await run();
    assert.equal(result.code, 1);
    const report = JSON.parse(result.stdout);
    assert.ok(report.failures.includes('ARK_SIGNER_MISMATCH'));
  } finally {
    state.ark.signerPubkey = original;
  }
});
