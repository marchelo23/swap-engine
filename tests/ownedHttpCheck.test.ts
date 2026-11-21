import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { checkOwnedHttp } from '../scripts/check-owned-http.js';

test('operator HTTP acceptance uses a real cookie/CSRF contract and never submits a valid preparation or financial request', async () => {
  const owner = randomUUID(); const archive = randomUUID(); const calls: Array<{ path: string; body?: unknown }> = [];
  const password = Buffer.from('synthetic-admin-password'); const csrf = 'ab'.repeat(32);
  const io = { password: () => password, fetch: (async (url: URL, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined; const path = url.pathname; calls.push({ path, body });
    const headers = init.headers as Record<string, string>; let value: unknown = {}; let status = 200;
    if (path === '/v1/health') value = { mode: 'regtest', network: 'regtest', liveSwapsEnabled: false };
    else if (path === '/v1/auth/login') {
      assert.equal(body.username, 'truja503'); assert.equal(body.password, 'synthetic-admin-password');
      return new Response(JSON.stringify({ user: { id: owner, username: 'truja503', role: 'ADMIN' }, csrfToken: csrf, expiresAt: Date.now() + 60000 }),
        { status: 200, headers: { 'set-cookie': 'swap_session=' + 'cd'.repeat(32) + '; HttpOnly; SameSite=Strict' } });
    } else if (path === '/v1/reverse/availability') {
      status = headers.cookie ? 200 : 401; value = { controlledReverseConfigured: true, preparationAvailable: true, preparedSwapIds: [archive] };
    } else if (path === '/v1/auth/session') assert.equal(headers['x-csrf-token'], csrf);
    else if (path === '/v1/swaps/' + archive) value = { id: archive, state: 'COMPLETED', payment: { status: 'SUCCEEDED', valueSats: 50750 },
      funding: { txid: '11'.repeat(32) }, claim: { txid: '22'.repeat(32), netSats: 49500 } };
    else if (path === '/v1/operations/balances') value = { core: { confirmedSats: 100 }, provider: { confirmedSats: 200, localSats: 300 }, alice: { confirmedSats: 400, localSats: 500 } };
    else { assert.equal(path, '/v1/reverse/preparations'); assert.deepEqual(body, { amountSats: 0 }); status = headers.origin !== 'http://127.0.0.1:3101' || headers['x-csrf-token'] !== csrf ? 403 : 400; }
    return new Response(JSON.stringify(value), { status });
  }) as typeof fetch };
  const result = await checkOwnedHttp(['--check-http-readonly', '--origin', 'http://127.0.0.1:3101', '--owner-id', owner, '--archive-id', archive], io);
  assert.equal(result.status, 'ADMIN_HTTP_VERIFIED_NO_PREPARATION_OR_PAYMENT'); assert.equal(result.fourBalancesVerified, true);
  assert.ok(password.every(v => v === 0)); assert.equal(calls.filter(c => c.path === '/v1/reverse/preparations').length, 3);
  assert.equal(calls.some(c => c.path === '/v1/swaps/reverse'), false); assert.equal(JSON.stringify(result).includes(csrf), false);
});

test('operator HTTP check rejects invalid arguments/origins and a live/mainnet gate before reading any password', async () => {
  let passwordReads = 0;
  const io = { password: () => { passwordReads++; throw Error('No password read'); }, fetch: (async () => new Response(JSON.stringify({ mode: 'mainnet', network: 'bitcoin', liveSwapsEnabled: true }))) as typeof fetch };
  await assert.rejects(checkOwnedHttp([], io));
  await assert.rejects(checkOwnedHttp(['--check-http-readonly', '--origin', 'http://external.example:3101', '--owner-id', randomUUID(), '--archive-id', randomUUID()], io));
  await assert.rejects(checkOwnedHttp(['--check-http-readonly', '--origin', 'http://127.0.0.1:3101', '--owner-id', randomUUID(), '--archive-id', randomUUID()], io));
  assert.equal(passwordReads, 0);
});
