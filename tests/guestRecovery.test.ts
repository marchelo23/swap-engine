import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Transaction, payments, networks } from 'bitcoinjs-lib';
import { setup } from './helpers.js';
import { buildHtlc } from '../src/bitcoin/HtlcBuilder.js';
import { createClaim } from '../src/bitcoin/ClaimManager.js';
import { createGuestRecoveryBundle, createGuestRecoverySecrets, decryptGuestRecovery,
  encryptGuestRecovery, generateGuestRecoveryIdentity, parseEncryptedRecovery, recoveryCommitment,
  serializeEncryptedRecovery } from '../src/client/GuestRecovery.js';

test('recovery module generates browser material, encrypts before invoice and exposes no plaintext secrets', async () => {
  const identity = await generateGuestRecoveryIdentity();
  assert.match(identity.capabilityToken, /^[A-Za-z0-9_-]{43}$/);
  assert.match(identity.paymentHash, /^[a-f0-9]{64}$/);
  assert.match(identity.claimPublicKey, /^(02|03)[a-f0-9]{64}$/);
  assert.match(identity.preimage, /^[a-f0-9]{64}$/);
  const destination = payments.p2wpkh({ pubkey: Buffer.from(identity.claimPublicKey, 'hex'), network: networks.regtest }).address!;
  const quote = { id: randomUUID(), destination, amountSats: 49250, invoiceSats: 50000,
    serviceFeeSats: 750, claimFeeSats: 500, fundingReserveSats: 1000 };
  const secrets = await createGuestRecoverySecrets(identity, quote);
  const passphrase = 'correct horse battery staple';
  const envelope = await encryptGuestRecovery(secrets, passphrase);
  const exported = serializeEncryptedRecovery(envelope);
  for (const secret of [identity.capabilityToken, identity.preimage, identity.claimPrivateKey])
    assert.equal(exported.includes(secret), false);
  const commitment = await recoveryCommitment(envelope);
  assert.match(commitment, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify({ recoveryCommitment: commitment }).includes(identity.preimage), false);
  assert.deepEqual(await decryptGuestRecovery(parseEncryptedRecovery(exported), passphrase), secrets);
  await assert.rejects(decryptGuestRecovery(envelope, 'wrong passphrase'));
  await assert.rejects(decryptGuestRecovery({ ...envelope, ciphertext: (envelope.ciphertext[0] === 'A' ? 'B' : 'A') + envelope.ciphertext.slice(1) }, passphrase));
  const source = await readFile('src/client/GuestRecovery.ts', 'utf8');
  assert.equal(source.includes("from 'node:"), false);
  assert.ok(source.includes('crypto.subtle'));
});

test('full recovery bundle adds public contract fields and reconstructs the claim', async () => {
  const f = await setup();
  try {
    const identity = await generateGuestRecoveryIdentity();
    const destination = payments.p2wpkh({ pubkey: Buffer.from(identity.claimPublicKey, 'hex'), network: networks.regtest }).address!;
    const quote = { id: randomUUID(), destination, amountSats: 49250, invoiceSats: 50000,
      serviceFeeSats: 750, claimFeeSats: 500, fundingReserveSats: 1000 };
    const secrets = await createGuestRecoverySecrets(identity, quote);
    const contract = { paymentHash: identity.paymentHash, claimPublicKey: identity.claimPublicKey,
      refundPublicKey: f.contract.refundPublicKey, timeoutHeight: f.contract.timeoutHeight };
    const htlc = buildHtlc(contract);
    const bundle = await createGuestRecoveryBundle(secrets, { swapId: randomUUID(), refundPublicKey: contract.refundPublicKey,
      timeoutHeight: contract.timeoutHeight, htlcAddress: htlc.address, witnessScript: htlc.witnessScript.toString('hex') });
    const passphrase = 'another strong passphrase';
    const envelope = await encryptGuestRecovery(bundle, passphrase);
    const decrypted = await decryptGuestRecovery(envelope, passphrase);
    assert.deepEqual(decrypted, bundle);
    const tx = new Transaction(); tx.version = 2; tx.addInput(new Uint8Array(32).fill(1), 0);
    tx.addOutput(htlc.output, 50000n);
    const claim = createClaim({ contract, lockupTxHex: tx.toHex(), vout: 0, destination,
      feeSats: 500, privateKey: Buffer.from(bundle.claimPrivateKey, 'hex') }, bundle.preimage);
    assert.match(claim.getId(), /^[a-f0-9]{64}$/);
    assert.equal(bundle.paymentHash, identity.paymentHash);
  } finally { await f.cleanup(); }
});
