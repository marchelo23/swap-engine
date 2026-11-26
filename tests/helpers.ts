import { createHmac, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as btc from 'bitcoinjs-lib';
import { ECPairFactory } from 'ecpair';
import * as ecc from 'tiny-secp256k1';
import { buildHtlc, sha256 } from '../src/bitcoin/HtlcBuilder.js';
import { Store } from '../src/persistence/Store.js';
import { SwapManager } from '../src/core/SwapManager.js';
import type { Invoice } from '../src/lightning/LndClient.js';
import type { SwapPorts } from '../src/core/SwapCoordinator.js';
import { provisionAccount } from '../scripts/provision-auth.js';
import { SessionResponse } from '../src/api/schemas.js';

export async function testAccount(directory: string, role: 'USER' | 'ADMIN') {
  const storePath = join(directory, 'test-auth.json');
  const username = 'test-operator';
  const password = randomBytes(24).toString('base64url');
  await provisionAccount(storePath, username, role, password);
  return {
    storePath, username, password,
    async headers(origin: string) {
      const response = await fetch(`${origin}/v1/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ username, password }),
      });
      assert.equal(response.status, 200);
      const { csrfToken } = SessionResponse.parse(await response.json());
      return { origin, cookie: response.headers.get('set-cookie')!.split(';')[0]!, 'x-csrf-token': csrfToken };
    },
  };
}

export const keys = ECPairFactory(ecc);
/** Operator fixtures need a private canonical path, even when the checkout is
 * group-writable. Keep the production ancestor/ownership guards unchanged. */
export async function privateTestDirectory(prefix: string) {
  if (!/^[a-z0-9-]+$/.test(prefix)) throw new Error('Invalid test directory prefix');
  return mkdtemp(join(await realpath(tmpdir()), `lqwd-${prefix}-`));
}
export function routingFixture(channelPoint = 'ef'.repeat(32) + ':0') {
  return { channelId: '12345', channelPoint, bitcoinOrigin: 'http://127.0.0.1:18443',
    providerOrigin: 'https://127.0.0.1:8080', payerOrigin: 'https://127.0.0.1:8081' };
}

function encodeVarint(n: number): Buffer {
  const bytes: number[] = [];
  let v = n >>> 0;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
  return Buffer.from(bytes);
}

function encodePbField(fieldNum: number, data: Buffer): Buffer {
  return Buffer.concat([encodeVarint((fieldNum << 3) | 2), encodeVarint(data.length), data]);
}

export function buildLndMacaroon(
  ops: Array<{ entity: string; actions: string[] }>,
  caveats: string[] = [],
  options: { location?: string; nonce?: Buffer; storageId?: Buffer; rootKey?: Buffer } = {},
): Buffer {
  const idBody = Buffer.concat([
    encodePbField(1, options.nonce ?? randomBytes(16)),
    encodePbField(2, options.storageId ?? Buffer.from([0x00, 0x00, 0x00, 0x00])),
    ...ops.map(op => encodePbField(3, Buffer.concat([
      encodePbField(1, Buffer.from(op.entity, 'utf8')),
      ...op.actions.map(action => encodePbField(2, Buffer.from(action, 'utf8'))),
    ]))),
  ]);
  const identifier = Buffer.concat([Buffer.from([0x03]), idBody]);
  const rootKey = options.rootKey ?? Buffer.from('101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f', 'hex');
  const derivedKey = createHmac('sha256', Buffer.from('macaroons-key-generator', 'utf8')).update(rootKey).digest();
  let sig = createHmac('sha256', derivedKey).update(identifier).digest();
  for (const caveat of caveats) {
    sig = createHmac('sha256', sig).update(Buffer.from(caveat, 'utf8')).digest();
  }
  const pkt = (type: number, data: Buffer) => Buffer.concat([Buffer.from([type]), encodeVarint(data.length), data]);
  const caveatPackets = caveats.flatMap(c => [pkt(2, Buffer.from(c, 'utf8')), Buffer.from([0x00])]);
  return Buffer.concat([
    Buffer.from([0x02]),
    pkt(1, Buffer.from(options.location ?? 'lnd', 'utf8')),
    pkt(2, identifier),
    Buffer.from([0x00]),
    ...caveatPackets,
    Buffer.from([0x00]),
    pkt(6, sig),
  ]);
}
export function fixture() {
  const claimKey = keys.makeRandom(); const refundKey = keys.makeRandom();
  const preimage = randomBytes(32).toString('hex');
  const contract = { paymentHash: sha256(Buffer.from(preimage, 'hex')).toString('hex'), claimPublicKey: Buffer.from(claimKey.publicKey).toString('hex'), refundPublicKey: Buffer.from(refundKey.publicKey).toString('hex'), timeoutHeight: 130 };
  const htlc = buildHtlc(contract);
  const tx = new btc.Transaction(); tx.version = 2;
  tx.addInput(randomBytes(32), 0); tx.addOutput(htlc.output, 50_000n);
  const destination = btc.payments.p2wpkh({ pubkey: claimKey.publicKey, network: btc.networks.regtest }).address!;
  return { claimKey, refundKey, preimage, contract, htlc, tx, destination,
    spend: { contract, lockupTxHex: tx.toHex(), vout: 0, destination, feeSats: 500, privateKey: claimKey.privateKey! } };
}
export async function setup(sourceAmountSats?: number) {
  const directory = await privateTestDirectory('fixture');
  const store = await Store.open(directory); const manager = new SwapManager(store); const f = fixture();
  const quote = sourceAmountSats === undefined ? await manager.quote(50_000) : await manager.quoteInvoice(sourceAmountSats);
  if (sourceAmountSats !== undefined) { f.tx.outs[0]!.value = BigInt(quote.amountSats); f.spend.lockupTxHex = f.tx.toHex(); }
  const swap = await manager.create(quote.id, 'request-1234', f.contract, 100, { onchainSats: 1_000_000, incomingSats: 1_000_000 });
  let invoiceState: Invoice['state'] = 'ACCEPTED';
  const ledger = new Map<string, { hex: string; confirmations: number }>();
  const calls = { funding: 0, broadcast: 0, settle: 0 };
  const ports: SwapPorts = {
    assertRegtest: async () => {}, // Explicitly fake regtest port; never contacts nodes.
    invoice: async () => ({ state: invoiceState, r_hash: Buffer.from(f.contract.paymentHash, 'hex').toString('base64'), value: String(quote.invoiceSats), amt_paid_sat: String(quote.invoiceSats), payment_request: 'test-invoice', htlcs: [{ state: 'ACCEPTED', expiration_height: 210, amt_msat: String(quote.invoiceSats * 1000) }] }),
    createInvoice: async () => 'test-invoice',
    prepareLockup: async () => { calls.funding++; return { txid: f.tx.getId(), hex: f.tx.toHex(), vout: 0 }; },
    broadcast: async hex => { calls.broadcast++; const tx = btc.Transaction.fromHex(hex); ledger.set(tx.getId(), { hex, confirmations: 0 }); return tx.getId(); },
    settle: async () => { calls.settle++; invoiceState = 'SETTLED'; },
    cancel: async () => { invoiceState = 'CANCELED'; }, tip: async () => 100,
    confirmed: async id => ledger.get(id) ?? { hex: '', confirmations: 0 },
  };
  return { ...f, directory, store, manager, quote, swap, ports, ledger, calls,
    cleanup: async () => { await store.close(); await rm(directory, { recursive: true, force: true }); } };
}
