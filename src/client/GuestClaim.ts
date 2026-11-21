import * as secp from '@noble/secp256k1';
import { Transaction, address, networks, opcodes, payments, script } from 'bitcoinjs-lib';
import type { GuestRecoveryBundle } from './GuestRecovery.js';

const webcrypto = globalThis.crypto;
if (!webcrypto?.subtle) throw new Error('Web Crypto is required');
const pubkey = /^(02|03)[a-f0-9]{64}$/;
const hex32 = /^[a-f0-9]{64}$/;

function bytesFromHex(value: string): Uint8Array {
  if (!/^(?:[a-f0-9]{2})+$/.test(value)) throw new Error('Invalid hex');
  return Uint8Array.from(value.match(/../g) ?? [], part => Number.parseInt(part, 16));
}
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await webcrypto.subtle.digest('SHA-256', bytes as unknown as BufferSource)));
}

export type GuestClaimEvidence = { hex: string; txid: string; fundingTxid: string; fundingVout: number; outputSats: number };

function htlc(bundle: GuestRecoveryBundle) {
  if (!pubkey.test(bundle.claimPublicKey) || !pubkey.test(bundle.refundPublicKey) || bundle.claimPublicKey === bundle.refundPublicKey)
    throw new Error('Invalid recovery claim keys');
  if (!Number.isSafeInteger(bundle.timeoutHeight) || bundle.timeoutHeight < 1 || bundle.timeoutHeight >= 500_000_000)
    throw new Error('Invalid recovery timelock');
  if (!hex32.test(bundle.paymentHash)) throw new Error('Invalid recovery payment hash');
  const witnessScript = Uint8Array.from(script.compile([
    opcodes.OP_IF, opcodes.OP_SIZE, script.number.encode(32), opcodes.OP_EQUALVERIFY,
    opcodes.OP_SHA256, bytesFromHex(bundle.paymentHash), opcodes.OP_EQUALVERIFY,
    bytesFromHex(bundle.claimPublicKey), opcodes.OP_CHECKSIG,
    opcodes.OP_ELSE, script.number.encode(bundle.timeoutHeight), opcodes.OP_CHECKLOCKTIMEVERIFY,
    opcodes.OP_DROP, bytesFromHex(bundle.refundPublicKey), opcodes.OP_CHECKSIG, opcodes.OP_ENDIF,
  ]));
  const payment = payments.p2wsh({ redeem: { output: witnessScript }, network: networks.regtest });
  if (!payment.output || !payment.address) throw new Error('Recovery HTLC construction failed');
  if (payment.address !== bundle.htlcAddress || hex(witnessScript) !== bundle.witnessScript)
    throw new Error('Recovery contract does not match the server evidence');
  return { witnessScript, output: payment.output };
}

/** Reconstructs and validates the exact HTLC from the recovery bundle. */
export function validateGuestClaimBundle(bundle: GuestRecoveryBundle): { output: Uint8Array; witnessScript: Uint8Array } {
  const built = htlc(bundle);
  try { address.toOutputScript(bundle.destination, networks.regtest); } catch { throw new Error('Invalid recovery destination'); }
  if (!/^bcrt1[0-9a-z]{20,}$/.test(bundle.destination)) throw new Error('Invalid recovery destination');
  if (!Number.isSafeInteger(bundle.amountSats) || !Number.isSafeInteger(bundle.claimFeeSats) ||
    bundle.claimFeeSats < 1 || bundle.amountSats - bundle.claimFeeSats < 546) throw new Error('Invalid recovery claim amount');
  return built;
}

/** Signs the claim locally from the confirmed funding transaction returned by
 * GET /v1/guest/quotes/:id. Private keys and the preimage never leave the browser. */
export async function signGuestClaim(bundle: GuestRecoveryBundle, lockupHex: string,
  fundingTxid: string, fundingVout: number): Promise<GuestClaimEvidence> {
  const built = validateGuestClaimBundle(bundle);
  if (!hex32.test(fundingTxid) || !Number.isSafeInteger(fundingVout) || fundingVout < 0) throw new Error('Invalid funding evidence');
  if (await sha256Hex(bytesFromHex(bundle.preimage)) !== bundle.paymentHash) throw new Error('Preimage does not match payment hash');
  const funding = Transaction.fromHex(lockupHex);
  if (funding.getId() !== fundingTxid) throw new Error('Funding transaction identity mismatch');
  const prevout = funding.outs[fundingVout];
  if (!prevout || prevout.value !== BigInt(bundle.amountSats) || !same(prevout.script, built.output))
    throw new Error('Funding outpoint or contract mismatch');
  const privateKey = bytesFromHex(bundle.claimPrivateKey);
  if (hex(secp.getPublicKey(privateKey, true)) !== bundle.claimPublicKey) throw new Error('Claim key does not match recovery');
  const tx = new Transaction(); tx.version = 2; tx.locktime = 0;
  tx.addInput(funding.getHash(), fundingVout, 0xfffffffe);
  tx.addOutput(address.toOutputScript(bundle.destination, networks.regtest), BigInt(bundle.amountSats - bundle.claimFeeSats));
  const digest = tx.hashForWitnessV0(0, built.witnessScript, prevout.value, Transaction.SIGHASH_ALL);
  const compact = await secp.signAsync(digest, privateKey, { prehash: false, format: 'compact' });
  const signature = script.signature.encode(compact, Transaction.SIGHASH_ALL);
  tx.setWitness(0, [signature, bytesFromHex(bundle.preimage), new Uint8Array([1]), built.witnessScript]);
  return { hex: tx.toHex(), txid: tx.getId(), fundingTxid, fundingVout, outputSats: bundle.amountSats - bundle.claimFeeSats };
}
