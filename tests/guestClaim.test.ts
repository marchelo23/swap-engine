import { randomBytes, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Transaction, payments, networks } from 'bitcoinjs-lib';
import { setup } from './helpers.js';
import { buildHtlc } from '../src/bitcoin/HtlcBuilder.js';
import { createClaim } from '../src/bitcoin/ClaimManager.js';
import { verifyHtlcSpend } from '../src/bitcoin/SpendEvidence.js';
import { createGuestRecoveryBundle, createGuestRecoverySecrets, generateGuestRecoveryIdentity } from '../src/client/GuestRecovery.js';
import { signGuestClaim, validateGuestClaimBundle } from '../src/client/GuestClaim.js';

test('browser-local guest claim reconstructs the exact HTLC and signs the confirmed outpoint', async () => {
  const f = await setup();
  try {
    const identity = await generateGuestRecoveryIdentity();
    const destination = payments.p2wpkh({ pubkey: Buffer.from(identity.claimPublicKey, 'hex'), network: networks.regtest }).address!;
    const quote = { id: randomUUID(), destination, amountSats: 49_250, invoiceSats: 50_000,
      serviceFeeSats: 750, claimFeeSats: 500, fundingReserveSats: 1000 };
    const secrets = await createGuestRecoverySecrets(identity, quote);
    const contract = { paymentHash: identity.paymentHash, claimPublicKey: identity.claimPublicKey,
      refundPublicKey: f.contract.refundPublicKey, timeoutHeight: f.contract.timeoutHeight };
    const htlc = buildHtlc(contract);
    const bundle = await createGuestRecoveryBundle(secrets, { swapId: randomUUID(),
      refundPublicKey: contract.refundPublicKey, timeoutHeight: contract.timeoutHeight,
      htlcAddress: htlc.address, witnessScript: htlc.witnessScript.toString('hex') });
    const funding = new Transaction(); funding.version = 2; funding.addInput(randomBytes(32), 0);
    funding.addOutput(htlc.output, BigInt(quote.amountSats));
    const expected = createClaim({ contract, lockupTxHex: funding.toHex(), vout: 0, destination,
      feeSats: quote.claimFeeSats, privateKey: Buffer.from(bundle.claimPrivateKey, 'hex') }, bundle.preimage);
    assert.deepEqual(validateGuestClaimBundle(bundle).output, htlc.output);
    const claim = await signGuestClaim(bundle, funding.toHex(), funding.getId(), 0);
    assert.equal(claim.txid, expected.getId()); assert.equal(claim.hex, expected.toHex());
    assert.equal(claim.outputSats, quote.amountSats - quote.claimFeeSats);
    assert.equal(verifyHtlcSpend(claim.hex, claim.txid, funding.toHex(), 0, contract).kind, 'claim');
    await assert.rejects(signGuestClaim(bundle, funding.toHex(), 'ab'.repeat(32), 0), /identity mismatch/i);
    await assert.rejects(signGuestClaim(bundle, funding.toHex(), funding.getId(), 1), /outpoint|contract/i);
    await assert.rejects(signGuestClaim({ ...bundle, htlcAddress: f.destination }, funding.toHex(), funding.getId(), 0),
      /does not match/i);
  } finally { await f.cleanup(); }
});
