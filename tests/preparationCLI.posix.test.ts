import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, stat, lstat, chmod, link, unlink, rename, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { readinessFixture } from './readinessFixture.js';
import { SecretVault } from '../src/persistence/SecretVault.js';
import { BitcoinConfirmationLookup } from '../src/bitcoin/BitcoinConfirmationLookup.js';
import { HttpsLndInvoiceTransport, type InvoiceTransportIO } from '../src/lightning/LndInvoiceTransport.js';
import { createLndReversePreparation } from '../src/core/LndReversePreparation.js';
import { preparationDigest, type PreparationSpec } from '../src/core/ReversePreparation.js';
import { runPreparationCLI, type PreparationCLIIO } from '../scripts/prepare-controlled-reverse.js';

const posix = process.platform !== 'win32';
const password = 'synthetic-posix-cli-passphrase';

async function lifecycleFixture() {
  const x = await readinessFixture(); const directory = join(x.f.directory, 'operator-run'); await mkdir(directory, { mode: 0o700 });
  const spec: PreparationSpec = { id: randomUUID(), isolationId: x.scope.isolationId, tipHeight: 100,
    providerNode: x.plan.providerNode, payerNode: x.plan.payerNode, routing: x.plan.routing,
    client: { paymentHash: x.keys.paymentHash, claimPublicKey: x.keys.claimPublicKey }, refundPublicKey: x.keys.refundPublicKey,
    claimDestination: x.plan.claimDestination, refundDestination: x.plan.refundDestination, input: { ...x.input, valueSats: 100000 } };
  const approval = { id: spec.id, scope: 'isolated-regtest-invoice-only', specDigest: preparationDigest(spec), expiresAt: Date.now() + 120000 };
  const vaultPassword = Buffer.from(password); const client = await SecretVault.open(join(directory, 'client-secrets'), vaultPassword);
  const refund = await SecretVault.open(join(directory, 'provider-refund-keys'), vaultPassword); vaultPassword.fill(0);
  try {
    const material = Buffer.from(JSON.stringify({ privateKey: Buffer.from(x.f.claimKey.privateKey!).toString('hex'), preimage: x.f.preimage }));
    try { await client.create('client', spec.client.paymentHash, material); } finally { material.fill(0); }
    await refund.create('refund', spec.client.paymentHash, x.f.refundKey.privateKey!);
  } finally { client.close(); refund.close(); }
  const specPath = join(directory, 'spec.json'); const approvalPath = join(directory, 'preparation-approval.json');
  const bytes = Buffer.from(JSON.stringify(spec));
  const credentials = { bitcoinCookiePath: join(directory, 'synthetic.cookie'), providerCertPath: join(directory, 'synthetic.cert'),
    providerReadMacaroonPath: join(directory, 'synthetic-read.macaroon'), providerInvoiceMacaroonPath: join(directory, 'synthetic-write.macaroon'),
    payerCertPath: join(directory, 'synthetic.cert'), payerReadMacaroonPath: join(directory, 'synthetic-read.macaroon') };
  for (const [name, value] of [['spec.json', spec], ['preparation-approval.json', approval], ['credential-paths.json', credentials]] as const) {
    await writeFile(join(directory, name), JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  }
  const checksum = createHash('sha256').update(bytes).digest('hex');
  let exists = false; let posts = 0; let loseReply = false; let passwordReads = 0; let assemblies = 0; let suppliedPassword = password;
  const loads: string[] = []; const modes: string[] = [];
  const transportIO = (role: string): InvoiceTransportIO => ({
    credentials: async () => { loads.push(role); return { ca: Buffer.from('synthetic-ca'), macaroon: Buffer.from(role) }; },
    request: (url, options, callback) => {
      assert.equal(url.origin, spec.routing.providerOrigin);
      const req = new EventEmitter() as ClientRequest; const res = new PassThrough();
      req.destroy = () => { res.destroy(); return req; };
      req.end = ((body?: string) => {
        if (options.method === 'POST') {
          assert.equal(role, 'write'); assert.equal(url.pathname, '/v2/invoices/hodl');
          assert.equal(JSON.parse(body!).value, '50750'); posts++; exists = true;
        } else { assert.equal(role, 'read'); assert.equal(url.pathname, '/v1/invoice/' + spec.client.paymentHash); }
        Object.assign(res, { statusCode: exists ? 200 : 404, headers: { 'content-type': 'application/json' } });
        callback(res as unknown as IncomingMessage);
        queueMicrotask(() => {
          if (options.method === 'POST' && loseReply) res.destroy(new Error('synthetic-lost-reply'));
          else res.end(JSON.stringify(options.method === 'POST' ? { payment_request: x.invoiceWire.payment_request } : exists ? x.invoiceWire :
            { code: 5, message: 'unable to locate invoice', details: [] }));
        });
        return req;
      }) as ClientRequest['end']; return req;
    },
  });
  const io: PreparationCLIIO = { readPassword: () => { passwordReads++; return Buffer.from(suppliedPassword); },
    assemble: (store, currentSpec, native, authority, mode) => {
      assemblies++; modes.push(mode ?? 'recover');
      const provider = { ...x.provider, assertRegtest: async () => ({ chains: [{ chain: 'bitcoin', network: 'regtest' }], synced_to_chain: true }) };
      return createLndReversePreparation(store, currentSpec, {
        bitcoin: { ...x.bitcoin, confirmed: id => new BitcoinConfirmationLookup(x.bitcoin).confirmed(id) }, provider,
        payer: { ...x.payer, assertRegtest: provider.assertRegtest }, custody: native.custody,
        invoices: new HttpsLndInvoiceTransport(currentSpec.routing.providerOrigin, '', '', undefined,
          { reader: transportIO('read'), ...(mode === 'prepare' ? { writer: transportIO('write') } : {}) }),
      }, authority, mode);
    } };
  const args = (mode: 'prepare' | 'recover', revision = 0) => [mode === 'prepare' ? '--prepare-invoice-only' : '--recover-invoice-only',
    '--run-dir', directory, '--spec-sha256', checksum, ...(mode === 'recover' ? ['--expected-revision', String(revision)] : [])];
  const db = async () => JSON.parse(await readFile(join(directory, 'store/state.json'), 'utf8'));
  return { x, directory, spec, approval, specPath, approvalPath, args, io, db, loads, modes,
    posts: () => posts, passwordReads: () => passwordReads, assemblies: () => assemblies,
    lose: () => { loseReply = true; }, setPassword: (value: string) => { suppliedPassword = value; },
    lockReleased: () => assert.rejects(lstat(join(directory, 'store/engine.lock')), { code: 'ENOENT' }), cleanup: x.f.cleanup };
}

test('POSIX CLI creates private durable artifacts, reuses an identical result and performs lookup-only recovery', { skip: !posix }, async () => {
  const f = await lifecycleFixture();
  try {
    const keyPath = join(f.directory, 'client-secrets', `client-${f.spec.client.paymentHash}.vault`); const encrypted = await readFile(keyPath);
    await runPreparationCLI(f.args('prepare'), f.io); await f.lockReleased();
    const publicPath = join(f.directory, 'prepared-public.json'); const first = await readFile(publicPath);
    const result = JSON.parse(first.toString()); const db = await f.db();
    assert.equal(result.status, 'PREPARED_UNPAID_NOT_AUTHORIZED'); assert.equal(f.posts(), 1);
    assert.deepEqual(result.plan.quote, db.swaps[result.request.swapId].quote);
    assert.equal((await stat(publicPath)).mode & 0o777, 0o600); assert.equal((await stat(join(f.directory, 'store'))).mode & 0o777, 0o700);
    assert.equal(first.includes(Buffer.from(f.x.f.preimage)), false);
    await runPreparationCLI(f.args('prepare'), f.io); assert.deepEqual(await readFile(publicPath), first);
    const writers = f.loads.filter(role => role === 'write').length;
    await runPreparationCLI(f.args('recover', result.request.expectedRevision), f.io);
    assert.equal(f.loads.filter(role => role === 'write').length, writers); assert.equal(f.posts(), 1);
    assert.deepEqual(await readFile(keyPath), encrypted); await f.lockReleased();
    assert.deepEqual(f.modes, ['prepare', 'prepare', 'recover']);
  } finally { await f.cleanup(); }
});

test('POSIX CLI lost-reply lifecycle closes its lock and recovers with one mock creation across new invocations', { skip: !posix }, async () => {
  const f = await lifecycleFixture();
  try {
    f.lose(); await assert.rejects(runPreparationCLI(f.args('prepare'), f.io)); await f.lockReleased();
    const db = await f.db(); const record = db.reversePreparations[f.spec.id]; const swap = db.swaps[record.swapId];
    assert.equal(record.status, 'UNKNOWN'); assert.equal(swap.pendingAction, 'CREATE_INVOICE');
    await assert.rejects(runPreparationCLI(f.args('prepare'), f.io)); assert.equal(f.posts(), 1);
    await assert.rejects(runPreparationCLI(f.args('recover', swap.revision + 1), f.io));
    await runPreparationCLI(f.args('recover', swap.revision), f.io); await f.lockReleased();
    assert.equal(f.posts(), 1); assert.equal(f.loads.filter(role => role === 'write').length, 1);
    assert.equal((await f.db()).reversePreparations[f.spec.id].status, 'READY');
  } finally { await f.cleanup(); }
});

test('POSIX CLI refuses unsafe files, links, wrong checksums and expired authority before password or transport', { skip: !posix }, async () => {
  const f = await lifecycleFixture();
  try {
    await chmod(f.specPath, 0o644); await assert.rejects(runPreparationCLI(f.args('prepare'), f.io)); await chmod(f.specPath, 0o600);
    const args = f.args('prepare'); args[4] = '00'.repeat(32); await assert.rejects(runPreparationCLI(args, f.io));
    await writeFile(f.approvalPath, JSON.stringify({ ...f.approval, expiresAt: 1 })); await assert.rejects(runPreparationCLI(f.args('prepare'), f.io));
    await writeFile(f.approvalPath, JSON.stringify(f.approval));
    const alias = join(f.directory, 'spec-alias.json'); await link(f.specPath, alias); await assert.rejects(runPreparationCLI(f.args('prepare'), f.io)); await unlink(alias);
    await rename(f.specPath, alias); await symlink(alias, f.specPath); await assert.rejects(runPreparationCLI(f.args('prepare'), f.io));
    await unlink(f.specPath); await rename(alias, f.specPath);
    await chmod(f.directory, 0o755); await assert.rejects(runPreparationCLI(f.args('prepare'), f.io)); await chmod(f.directory, 0o700);
    assert.equal(f.passwordReads(), 0); assert.equal(f.assemblies(), 0); assert.equal(f.posts(), 0);
  } finally { await f.cleanup(); }
});

test('POSIX CLI preserves an existing writer lock and does not replace unavailable custody', { skip: !posix }, async () => {
  const f = await lifecycleFixture();
  try {
    const store = join(f.directory, 'store'); await mkdir(store, { mode: 0o700 }); const lock = join(store, 'engine.lock');
    await writeFile(lock, 'synthetic-existing-writer', { mode: 0o600 });
    await assert.rejects(runPreparationCLI(f.args('prepare'), f.io)); assert.equal(await readFile(lock, 'utf8'), 'synthetic-existing-writer');
    assert.equal(f.assemblies(), 0); await unlink(lock); // Remove only this test's own synthetic lock.
    f.setPassword('incorrect-synthetic-password'); await assert.rejects(runPreparationCLI(f.args('prepare'), f.io)); await f.lockReleased();
    assert.equal(f.posts(), 0); assert.equal(Object.keys((await f.db()).quotes).length, 0);
  } finally { await f.cleanup(); }
});

test('POSIX CLI preserves a conflicting public artifact and never repeats mock creation', { skip: !posix }, async () => {
  const f = await lifecycleFixture();
  try {
    const artifact = join(f.directory, 'prepared-public.json'); await writeFile(artifact, 'synthetic-existing-artifact', { mode: 0o600 });
    await assert.rejects(runPreparationCLI(f.args('prepare'), f.io)); await f.lockReleased();
    assert.equal(await readFile(artifact, 'utf8'), 'synthetic-existing-artifact'); assert.equal(f.posts(), 1);
    await assert.rejects(runPreparationCLI(f.args('prepare'), f.io)); assert.equal(f.posts(), 1);
    assert.equal((await f.db()).reversePreparations[f.spec.id].status, 'READY');
  } finally { await f.cleanup(); }
});
