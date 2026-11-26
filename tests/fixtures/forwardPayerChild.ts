import { createHash } from 'node:crypto';
import { createTestForwardLeaseToken } from '../../src/persistence/ForwardPayerRegistry.js';
import { Store } from '../../src/persistence/Store.js';
import { ForwardAdmission } from '../../src/core/ForwardAdmission.js';

const [mode, storeDir, payerNode, registryDir] = process.argv.slice(2);
if (!mode || !storeDir || !payerNode || !registryDir) {
  process.stderr.write('ERR:missing-args\n');
  process.exit(2);
}

const testToken = createTestForwardLeaseToken();
const payeeNode = '03' + 'bb'.repeat(32);
const preimage = '77'.repeat(32);
const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
const invoice = 'lnbcrt' + 'f'.repeat(40);
const deposit = { txid: 'dd'.repeat(32), vout: 0, scriptPubKey: '0014' + 'ee'.repeat(20), valueSats: 5100 };

async function waitStdinClose() {
  await new Promise<void>(resolve => {
    process.stdin.resume();
    process.stdin.on('data', chunk => {
      if (chunk.toString().includes('close')) resolve();
    });
  });
}

try {
  if (mode === 'hold' || mode === 'admit-and-hold' || mode === 'try-provision-and-open') {
    await Store.provisionFreshForwardWithTestToken(testToken, storeDir, payerNode, registryDir);
  }
  const store = await Store.openForForwardWithTestToken(testToken, storeDir, payerNode, registryDir);
  if (mode === 'hold') {
    process.stdout.write('LOCKED\n');
    await waitStdinClose();
    await store.close();
    process.stdout.write('CLOSED\n');
  } else if (mode === 'admit-and-hold') {
    const service = new ForwardAdmission(store, {
      inspectPayer: async () => ({ network: 'regtest', node: payerNode, ready: true }),
      decodeInvoice: async () => ({
        destination: payeeNode, payment_hash: paymentHash, num_satoshis: '5000', num_msat: '5000000',
        timestamp: String(Math.floor(Date.now() / 1000)), expiry: '600', cltv_expiry: '40',
      }),
      allocateDeposit: async () => ({ address: 'bcrt1q' + 'c'.repeat(38), scriptPubKey: deposit.scriptPubKey }),
      inspectDeposit: async () => ({ ...deposit, network: 'regtest', confirmations: 2 }),
      send: async (_inv, _limit, beforeSend) => { await beforeSend(); throw new Error('lost response'); },
      track: async () => { throw new Error('unused'); },
    }, payerNode, payeeNode, testToken);
    const adm = await service.admit('owner-1', invoice, 5000, 'child-key-1');
    const status = await service.execute('owner-1', adm.id, { txid: deposit.txid, vout: deposit.vout });
    process.stdout.write(`ADMITTED:${adm.id}:${status}\n`);
    await waitStdinClose();
    await store.close();
    process.stdout.write('CLOSED\n');
  } else if (mode === 'try-open' || mode === 'try-provision-and-open') {
    process.stdout.write('OPENED\n');
    await store.close();
  } else if (mode === 'recover-check') {
    const payments = Object.keys(store.read().forwardPayments ?? {}).length;
    process.stdout.write(`PAYMENTS:${payments}\n`);
    await store.close();
  } else {
    await store.close();
    process.stderr.write('ERR:unknown-mode\n');
    process.exit(2);
  }
} catch (error) {
  process.stderr.write(`ERR:${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
