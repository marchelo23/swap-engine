import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { GuestAdmission } from '../src/guest/GuestAdmission.js';
import { setup } from './helpers.js';

test('guest admission binds exact public terms, stores only a capability hash and survives reopen', async () => {
  const f = await setup();
  let originalClosed = false;
  try {
    const service = new GuestAdmission(f.store, () => 1000);
    const token = randomBytes(32).toString('base64url'); const auth = `Bearer ${token}`;
    const input = { destination: f.destination, amountSats: 50000, paymentHash: f.contract.paymentHash, claimPublicKey: f.contract.claimPublicKey };
    const result = await service.reserve(auth, 'guest-request-1', input);
    assert.equal(result.invoiceSats, 50000); assert.equal(result.amountSats - result.claimFeeSats, 48750);
    assert.equal(result.status, 'QUOTED'); assert.equal(result.expiresAt, 121000);
    assert.deepEqual(await service.reserve(auth, 'guest-request-1', input), result);
    await assert.rejects(service.reserve(auth, 'guest-request-1', { ...input, amountSats: 25000 }), /conflict/);
    await assert.rejects(service.reserve(auth, 'guest-request-2', input), /already used/);
    assert.equal(service.status(result.id, `Bearer ${randomBytes(32).toString('base64url')}`), undefined);
    assert.equal(service.status(result.id, undefined), undefined);
    assert.deepEqual(service.status(result.id, auth), result);
    const disk = await readFile(join(f.directory, 'state.json'), 'utf8');
    assert.equal(disk.includes(token), false); assert.equal(disk.includes(f.preimage), false);
    await f.store.close(); originalClosed = true;
    const { Store } = await import('../src/persistence/Store.js'); const reopened = await Store.open(f.directory);
    try { assert.deepEqual(new GuestAdmission(reopened, () => 1000).status(result.id, auth), result); }
    finally { await reopened.close(); }
  } finally { if (originalClosed) await rm(f.directory, { recursive: true, force: true }); else await f.cleanup(); }
});

test('concurrent replays reserve one admission and do not admit private material or invalid destinations', async () => {
  const f = await setup();
  try {
    const service = new GuestAdmission(f.store); const auth = `Bearer ${randomBytes(32).toString('base64url')}`;
    const input = { destination: f.destination, amountSats: 25000, paymentHash: f.contract.paymentHash, claimPublicKey: f.contract.claimPublicKey };
    const [a, b] = await Promise.all([service.reserve(auth, 'guest-request-3', input), service.reserve(auth, 'guest-request-3', input)]);
    assert.equal(a.id, b.id); assert.equal(Object.keys(f.store.read().guestAdmissions ?? {}).length, 1);
    for (const value of [{ ...input, destination: 'bc1q' + 'a'.repeat(38) }, { ...input, destination: 'bcrt1invalid' },
      { ...input, amountSats: 50001 }, { ...input, claimPublicKey: '02' + '00'.repeat(32) }, { ...input, preimage: f.preimage }]) {
      await assert.rejects(service.reserve(`Bearer ${randomBytes(32).toString('base64url')}`, 'guest-request-4', value));
    }
    for (const bad of ['', 'Bearer short', `Bearer ${auth.slice(7)}=`, `Bearer ${auth.slice(7)} extra`])
      await assert.rejects(service.reserve(bad, 'guest-request-5', input));
    assert.equal(Object.keys(f.store.read().guestAdmissions ?? {}).length, 1);
  } finally { await f.cleanup(); }
});

test('competing amounts for the same capability and idempotency key cannot both be admitted', async () => {
  const f = await setup();
  try {
    const service = new GuestAdmission(f.store); const auth = `Bearer ${randomBytes(32).toString('base64url')}`;
    const common = { destination: f.destination, paymentHash: f.contract.paymentHash, claimPublicKey: f.contract.claimPublicKey };
    const outcomes = await Promise.allSettled([25000, 50000].map(amountSats => service.reserve(auth, 'guest-racing-amount', { ...common, amountSats })));
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter(result => result.status === 'rejected').length, 1);
    assert.equal(Object.keys(f.store.read().guestAdmissions ?? {}).length, 1);
  } finally { await f.cleanup(); }
});

test('expired guest quote remains expired on retrieval and idempotent replay', async () => {
  const f = await setup();
  try {
    let now = 1000;
    const service = new GuestAdmission(f.store, () => now);
    const auth = `Bearer ${randomBytes(32).toString('base64url')}`;
    const input = { destination: f.destination, amountSats: 25000, paymentHash: f.contract.paymentHash, claimPublicKey: f.contract.claimPublicKey };
    const quote = await service.reserve(auth, 'guest-expiry-test', input);
    now = quote.expiresAt - 1;
    assert.equal(service.status(quote.id, auth)?.status, 'QUOTED');
    now = quote.expiresAt;
    assert.equal(service.status(quote.id, auth)?.status, 'EXPIRED');
    assert.equal((await service.reserve(auth, 'guest-expiry-test', input)).status, 'EXPIRED');
    assert.equal(Object.keys(f.store.read().guestAdmissions ?? {}).length, 1);
    now = Number.NaN;
    assert.throws(() => service.status(quote.id, auth), /Invalid clock/);
    await assert.rejects(service.reserve(auth, 'guest-expiry-test', input), /Invalid clock/);
  } finally { await f.cleanup(); }
});
