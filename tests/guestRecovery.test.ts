import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from './helpers.js';
import { buildHtlc } from '../src/bitcoin/HtlcBuilder.js';
import { createClaim } from '../src/bitcoin/ClaimManager.js';
import { createGuestRecoveryBundle, parseGuestRecoveryBundle, recoveryCommitment,
  serializeGuestRecoveryBundle, type GuestRecoveryInput } from '../src/client/GuestRecovery.js';

function inputFor(f: Awaited<ReturnType<typeof setup>>): GuestRecoveryInput {
  const htlc = buildHtlc(f.contract);
  return { capabilityToken: randomBytes(32).toString('base64url'), paymentHash: f.contract.paymentHash,
    claimPublicKey: f.contract.claimPublicKey, claimPrivateKey: Buffer.from(f.claimKey.privateKey!).toString('hex'),
    preimage: f.preimage, destination: f.destination, refundPublicKey: f.contract.refundPublicKey,
    timeoutHeight: f.contract.timeoutHeight, htlcAddress: htlc.address, witnessScript: htlc.witnessScript.toString('hex') };
}

test('recovery bundle round-trips and its commitment contains no client secret', async () => {
  const f = await setup();
  try {
    const input = inputFor(f); const bundle = createGuestRecoveryBundle(input);
    const serialized = serializeGuestRecoveryBundle(bundle);
    assert.deepEqual(parseGuestRecoveryBundle(serialized), bundle);
    const commitment = recoveryCommitment(bundle);
    assert.match(commitment, /^[a-f0-9]{64}$/);
    const requestBody = JSON.stringify({ recoveryCommitment: commitment });
    for (const secret of [bundle.capabilityToken, bundle.preimage, bundle.claimPrivateKey])
      assert.equal(requestBody.includes(secret), false);
    // The client-held material reconstructs the exact claim without any provider secret.
    const claim = createClaim({ contract: f.contract, lockupTxHex: f.tx.toHex(), vout: 0,
      destination: bundle.destination, feeSats: 500, privateKey: Buffer.from(bundle.claimPrivateKey, 'hex') }, bundle.preimage);
    assert.match(claim.getId(), /^[a-f0-9]{64}$/);
    assert.equal(bundle.paymentHash, f.contract.paymentHash);
  } finally { await f.cleanup(); }
});

test('recovery bundle rejects mismatched secrets, destination, HTLC and malformed documents', async () => {
  const f = await setup();
  try {
    const input = inputFor(f); createGuestRecoveryBundle(input);
    const invalid: GuestRecoveryInput[] = [
      { ...input, preimage: '00'.repeat(32) },
      { ...input, claimPrivateKey: Buffer.from(f.refundKey.privateKey!).toString('hex') },
      { ...input, destination: 'bc1q' + 'a'.repeat(38) },
      { ...input, timeoutHeight: input.timeoutHeight + 1 },
      { ...input, htlcAddress: 'bcrt1q' + 'a'.repeat(40) },
      { ...input, witnessScript: '00' },
      { ...input, capabilityToken: 'short' },
    ];
    for (const value of invalid) assert.throws(() => createGuestRecoveryBundle(value));
    const bundle = createGuestRecoveryBundle(input);
    assert.throws(() => parseGuestRecoveryBundle(JSON.stringify({ ...bundle, extra: true })));
    assert.throws(() => parseGuestRecoveryBundle(JSON.stringify({ ...bundle, version: 2 })));
    assert.throws(() => parseGuestRecoveryBundle(JSON.stringify({ ...bundle, network: 'mainnet' })));
    assert.throws(() => parseGuestRecoveryBundle('{not-json'));
  } finally { await f.cleanup(); }
});
