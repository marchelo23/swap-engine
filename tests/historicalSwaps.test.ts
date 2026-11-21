import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { provisionAccount } from '../scripts/provision-auth.js';
import { createApi } from '../src/api/server.js';
import { historicalSwaps } from '../src/api/historicalSwaps.js';
import { setup } from './helpers.js';

test('history is ADMIN-only, validated, sanitized and does not alter swap state', async t => {
  const f = await setup(); t.after(f.cleanup);
  await mkdir(join(process.cwd(), 'data'), { recursive: true });
  const directory = await mkdtemp(join(process.cwd(), 'data', 'history-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const authPath = join(directory, `${randomUUID()}.json`);
  const password = randomBytes(24).toString('base64url');
  await provisionAccount(authPath, 'member', 'USER', password);
  await provisionAccount(authPath, 'operator', 'ADMIN', password);
  let evidence: unknown = historicalSwaps(); let reads = 0;
  const server = createApi(f.manager, async () => { throw new Error('unused'); }, undefined, 'simulation',
    { auth: { storePath: authPath }, history: () => { reads++; return evidence; } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = async (username: string) => {
    const res = await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username, password }) });
    assert.equal(res.status, 200); return res.headers.get('set-cookie')!.split(';')[0]!;
  };
  const get = (cookie?: string) => fetch(`${base}/v1/admin/swaps/historical`, { headers: cookie ? { cookie } : {} });
  const before = JSON.stringify(f.store.read());
  assert.equal((await get()).status, 401);
  const user = await login('member'); assert.equal((await get(user)).status, 403); assert.equal(reads, 0);
  const admin = await login('operator'); const response = await get(admin);
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = await response.json(); assert.deepEqual(result, historicalSwaps());
  assert.equal(result.swaps[0]!.verificationStatus, 'UNVERIFIED');
  assert.equal(result.swaps[0]!.amountSats, 50000); assert.equal(result.swaps[0]!.confirmationEvidence, null);
  assert(!JSON.stringify(result).includes(password)); assert(!JSON.stringify(result).includes(admin));
  for (const invalid of [undefined, null, {}, { network: 'regtest', swaps: [{ ...historicalSwaps().swaps[0], privateKey: 'secret' }] }]) {
    evidence = invalid; const rejected = await get(admin);
    assert.equal(rejected.status, 503); assert.deepEqual(await rejected.json(), { error: 'HISTORICAL_EVIDENCE_UNAVAILABLE' });
  }
  assert.equal(JSON.stringify(f.store.read()), before);
});
