import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, chmod, readFile, writeFile, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Transaction } from 'bitcoinjs-lib';
import { SecretVault, sealSecret, openSecret } from '../src/persistence/SecretVault.js';
import { RefundKeyVault } from '../src/bitcoin/RefundKeyVault.js';
import { ClaimWallet } from '../src/client/ClaimWallet.js';
import { buildHtlc } from '../src/bitcoin/HtlcBuilder.js';
import { verifyHtlcSpend } from '../src/bitcoin/SpendEvidence.js';
import { fixture } from './helpers.js';

const password = Buffer.from('offline-vault-fixture-passphrase');
const secret = Buffer.from('synthetic-private-material-for-offline-tests');
const id = 'ab'.repeat(32);
const context = `regtest:client:${id}`;
const posix = process.platform !== 'win32';

test('secret envelopes authenticate password, role/id and network without plaintext serialization', () => {
  const record = sealSecret(secret, password, context);
  assert.deepEqual(openSecret(record, password, context), secret);
  assert.ok(!record.includes(secret.toString()) && !record.includes(password.toString()));
  assert.throws(() => openSecret(record, Buffer.from('incorrect-fixture-password'), context), /authentication failed/);
  assert.throws(() => openSecret(record, password, `regtest:refund:${id}`), /authentication failed/);
  assert.throws(() => openSecret(record, password, `regtest:client:${'cd'.repeat(32)}`), /authentication failed/);
  assert.throws(() => openSecret(record, password, 'mainnet:client:unsafe'), /authentication failed/);
});

test('secret envelopes reject corruption, truncation, noncanonical encoding and invalid limits', () => {
  const record = JSON.parse(sealSecret(secret, password, context));
  for (const field of ['salt', 'nonce', 'tag', 'ciphertext']) {
    const changed = { ...record }; const bytes = Buffer.from(changed[field], 'base64'); bytes[0] = bytes[0]! ^ 1; changed[field] = bytes.toString('base64');
    assert.throws(() => openSecret(JSON.stringify(changed), password, context), /authentication failed/);
  }
  for (const bad of ['', '{}', JSON.stringify({ ...record, network: 'mainnet' }), JSON.stringify({ ...record, nonce: 'AA==' }),
    JSON.stringify({ ...record, tag: record.tag + '=' })]) assert.throws(() => openSecret(bad, password, context));
  assert.throws(() => sealSecret(Buffer.alloc(0), password, context));
  assert.throws(() => sealSecret(secret, Buffer.from('short'), context));
});

test('vault explicitly refuses Windows without verified ACL support', { skip: posix }, async () => {
  await assert.rejects(SecretVault.open('data/tests/unused-vault', password), /POSIX/);
});

test('POSIX vault enforces private modes and refuses unsafe directories, records and symlinks', { skip: !posix }, async () => {
  await mkdir('data/tests', { recursive: true }); const directory = await mkdtemp(join(process.cwd(), 'data/tests/vault-'));
  const root = join(directory, 'keys'); const vault = await SecretVault.open(root, password);
  try {
    await vault.create('client', id, secret);
    const path = join(root, `client-${id}.vault`);
    assert.equal((await stat(root)).mode & 0o777, 0o700); assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await vault.read('client', id), secret);
    const original = await readFile(path);
    await assert.rejects(vault.create('client', id, Buffer.from('replacement')), { code: 'EEXIST' });
    assert.deepEqual(await readFile(path), original);
    await chmod(path, 0o644); await assert.rejects(vault.read('client', id), /permissions/); await chmod(path, 0o600);
    await writeFile(path, 'corrupt'); await assert.rejects(vault.read('client', id), /authentication/);
    await unlink(path); const target = join(directory, 'target'); await writeFile(target, original, { mode: 0o600 });
    await symlink(target, path); await assert.rejects(vault.read('client', id));
    await assert.rejects(vault.read('client', '../bad'), /identifier/);
    const unsafe = join(directory, 'unsafe'); await mkdir(unsafe, { mode: 0o755 });
    await chmod(unsafe, 0o755); // A restrictive process umask must not turn the unsafe fixture into a safe directory.
    await assert.rejects(SecretVault.open(unsafe, password), /permissions/);
  } finally { vault.close(); await rm(directory, { recursive: true, force: true }); }
});

test('client and refund custody survive a vault reopen without exposing private keys', { skip: !posix }, async () => {
  await mkdir('data/tests', { recursive: true }); const directory = await mkdtemp(join(process.cwd(), 'data/tests/custody-'));
  let vault = await SecretVault.open(join(directory, 'keys'), password); const client = ClaimWallet.generate();
  let restored: ClaimWallet | undefined;
  try {
    await client.backup(vault);
    const refundKeys = new RefundKeyVault(vault); const refund = await refundKeys.create(client.paymentHash);
    await assert.rejects(refundKeys.create(client.paymentHash), { code: 'EEXIST' });
    const publicRequest = client.toJSON(); client.destroy(); vault.close();
    vault = await SecretVault.open(join(directory, 'keys'), password);
    restored = await ClaimWallet.restore(vault, publicRequest.paymentHash);
    assert.deepEqual(restored.toJSON(), publicRequest);
    assert.equal(await new RefundKeyVault(vault).publicKey(publicRequest.paymentHash), refund.publicKey);
    const f = fixture(); const contract = { ...f.contract, ...publicRequest, refundPublicKey: refund.publicKey };
    const funding = Transaction.fromHex(f.tx.toHex()); funding.outs[0]!.script = buildHtlc(contract).output;
    const spend = { contract, lockupTxHex: funding.toHex(), vout: 0, destination: f.destination, feeSats: 500 };
    const claim = restored.signClaim(spend);
    assert.equal(verifyHtlcSpend(claim.toHex(), claim.getId(), funding.toHex(), 0, contract).kind, 'claim');
    const refundTx = await new RefundKeyVault(vault).signRefund(publicRequest.paymentHash, spend, 130);
    assert.equal(verifyHtlcSpend(refundTx.toHex(), refundTx.getId(), funding.toHex(), 0, contract).kind, 'refund');
  } finally { client.destroy(); restored?.destroy(); vault.close(); await rm(directory, { recursive: true, force: true }); }
});
