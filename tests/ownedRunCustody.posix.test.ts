import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { provisionAccount } from '../scripts/provision-auth.js';
import { readAccounts } from '../src/auth/store.js';
import { prepareOwnedRunCustody, ownedRunPolicySchema } from '../src/operator/OwnedRunCustody.js';
import { preparationFixture } from './preparationFixture.js';

async function fixture() {
  const f = await preparationFixture(); const run = join(f.directory, 'run'); const backup = join(f.directory, 'backup');
  await mkdir(run, { mode: 0o700 }); await mkdir(backup, { mode: 0o700 });
  const auth = join(f.directory, 'users.json'); await provisionAccount(auth, 'truja503', 'USER', 'synthetic-custody-account-passphrase');
  const [account] = await readAccounts(auth);
  const policy = ownedRunPolicySchema.parse({ ownerUsername: 'truja503', ownerId: account!.id, authStorePath: auth,
    origin: 'http://127.0.0.1:3101', port: 3101, backupDirectory: backup, tipHeight: f.spec.tipHeight,
    providerNode: f.spec.providerNode, payerNode: f.spec.payerNode, routing: f.spec.routing,
    claimDestination: f.spec.claimDestination, refundDestination: f.spec.refundDestination, input: f.spec.input,
    credentialPaths: { bitcoinCookiePath: '/nonexistent/readonly.cookie', providerCertPath: '/nonexistent/provider.cert', providerReadMacaroonPath: '/nonexistent/provider.readonly',
      payerCertPath: '/nonexistent/alice.cert', payerReadMacaroonPath: '/nonexistent/alice.readonly', providerInvoiceMacaroonPath: '/nonexistent/provider.invoices' } });
  const password = Buffer.from('synthetic-custody-encryption-password');
  return { f, run, backup, auth, policy, password, cleanup: f.cleanup };
}

test('owned custody binds the existing account, restores separate encrypted copies and reuses exactly one identity without node calls', { skip: process.platform !== 'linux' }, async () => {
  const x = await fixture(); try {
    const accounts = await readFile(x.auth);
    const first = await prepareOwnedRunCustody(x.run, x.policy, x.password);
    assert.equal(first.status, 'CUSTODY_READY');
    const before = await Promise.all(['spec.json','ui-access.json','custody-intent.json','custody-ready.json'].map(n => readFile(join(x.run,n))));
    assert.deepEqual(await prepareOwnedRunCustody(x.run, x.policy, x.password), first);
    await writeFile(join(x.run, 'prepared-public.json'), '{"status":"synthetic-later-invoice-phase"}', { mode: 0o600 });
    assert.deepEqual(await prepareOwnedRunCustody(x.run, x.policy, x.password), first); // Custody does not claim any node invoice state.
    assert.deepEqual(await Promise.all(['spec.json','ui-access.json','custody-intent.json','custody-ready.json'].map(n => readFile(join(x.run,n)))), before);
    assert.deepEqual(await readFile(x.auth), accounts);
    const spec = JSON.parse(before[0]!.toString()); const ui = JSON.parse(before[1]!.toString());
    assert.equal(ui.ownerId, x.policy.ownerId); assert.equal(spec.payerNode, x.policy.payerNode);
    assert.equal((await readdir(join(x.run, 'client-secrets'))).length, 1);
    assert.equal(JSON.stringify(first).includes(x.password.toString()), false);
    await assert.rejects(prepareOwnedRunCustody(x.run, { ...x.policy, tipHeight: 101 }, x.password));
    await assert.rejects(prepareOwnedRunCustody(x.run, x.policy, Buffer.from('wrong-password')));
  } finally { await x.cleanup(); }
});

test('partial or corrupted custody cannot generate replacement keys or overwrite another attempt', { skip: process.platform !== 'linux' }, async () => {
  const x = await fixture(); try {
    const blocked = join(x.run, 'client-secrets'); await writeFile(blocked, 'synthetic-partial-file', { mode: 0o600 });
    await assert.rejects(prepareOwnedRunCustody(x.run, x.policy, x.password));
    const intent = await readFile(join(x.run, 'custody-intent.json'));
    await assert.rejects(prepareOwnedRunCustody(x.run, x.policy, x.password));
    assert.deepEqual(await readFile(join(x.run, 'custody-intent.json')), intent);
    assert.equal((await readFile(blocked)).toString(), 'synthetic-partial-file');
    assert.deepEqual(await readdir(x.backup), []);
  } finally { await x.cleanup(); }
});

test('unknown owner, foreign origin and nested backup fail before reserving local custody', { skip: process.platform !== 'linux' }, async () => {
  const x = await fixture(); try {
    for (const policy of [{ ...x.policy, ownerUsername: 'another' }, { ...x.policy, ownerId: x.f.spec.id },
      { ...x.policy, origin: 'http://foreign.invalid' }, { ...x.policy, backupDirectory: x.run },
      { ...x.policy, routing: { ...x.policy.routing, payerOrigin: x.policy.routing.providerOrigin } }])
      await assert.rejects(prepareOwnedRunCustody(x.run, policy, x.password));
    assert.deepEqual(await readdir(x.run), []);
  } finally { await x.cleanup(); }
});
