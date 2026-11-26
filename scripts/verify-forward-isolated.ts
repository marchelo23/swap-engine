// Explicitly spends regtest sats and mines two blocks on the existing iso_rt_* stack.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { unlinkSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BitcoinRpcClient } from '../src/bitcoin/BitcoinRpcClient.js';
import { LndClient } from '../src/lightning/LndClient.js';
import { HttpsLndPaymentTransport } from '../src/lightning/LndPaymentTransport.js';
import { CoreLndForwardPorts } from '../src/core/CoreLndForwardPorts.js';
import { ForwardAdmission } from '../src/core/ForwardAdmission.js';
import { assertPersistentStorage, assertPrivateDirectory } from '../src/persistence/ForwardPayerRegistry.js';
import { Store } from '../src/persistence/Store.js';

const bitcoin = 'iso_rt_bitcoin';
const provider = 'iso_rt_lnd_provider';
const alice = 'iso_rt_lnd_alice';
const secret = '/root/.lnd/data/chain/bitcoin/regtest';
const wallet = 'iso-core-lab';
const docker = (container: string, ...args: string[]) =>
  execFileSync('docker', ['exec', container, ...args], { timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'] });
const btc = (...args: string[]) => docker(bitcoin, 'bitcoin-cli', '-regtest', `-rpcwallet=${wallet}`, ...args).toString().trim();
const lnd = (container: string, ...args: string[]) =>
  JSON.parse(docker(container, 'lncli', '--network=regtest', ...args).toString());

function persistentVerifyRoot(): string {
  const info = userInfo();
  return join(info.homedir, '.local', 'share', 'lqwd-swap-engine', 'forward-isolated-verify');
}

async function verify() {
  if (process.argv[2] !== '--spend-isolated-regtest') throw new Error('Explicit opt-in required');
  for (const container of [bitcoin, provider, alice]) {
    const project = execFileSync('docker', ['inspect', '-f', '{{index .Config.Labels "com.docker.compose.project"}}', container]).toString().trim();
    assert.equal(project, 'swap-engine-iso-regtest');
  }
  assert.equal(JSON.parse(btc('getblockchaininfo')).chain, 'regtest');
  const payer = lnd(provider, 'getinfo');
  const payee = lnd(alice, 'getinfo');
  for (const n of [payer, payee]) assert.deepEqual(n.chains, [{ chain: 'bitcoin', network: 'regtest' }]);
  const channels = lnd(provider, 'listchannels').channels.filter((c: { active: boolean; remote_pubkey: string;
    channel_point: string; zero_conf: boolean }) => {
    if (!c.active || c.zero_conf || c.remote_pubkey !== payee.identity_pubkey) return false;
    const [txid, vout] = c.channel_point.split(':');
    const result = btc('gettxout', txid!, vout!, 'true');
    return result && JSON.parse(result)?.confirmations >= 6;
  });
  assert.equal(channels.length, 1);

  const verifyRoot = persistentVerifyRoot();
  await assertPersistentStorage(verifyRoot);
  await assertPrivateDirectory(verifyRoot, true);
  const directory = join(verifyRoot, 'creds');
  const state = join(verifyRoot, 'state');
  await assertPersistentStorage(directory);
  await assertPersistentStorage(state);
  await assertPrivateDirectory(directory, true);

  let store: Store | undefined;
  let step = 'provisioning and store lease';
  try {
    await Store.provisionFreshForward(state, payer.identity_pubkey);
    store = await Store.openForForward(state, payer.identity_pubkey);

    step = 'credentials and payer binding';
    const copy = (container: string, src: string, name: string) => {
      const target = join(directory, name);
      writeFileSync(target, docker(container, 'cat', src), { mode: 0o600 });
      return target;
    };
    const cookie = copy(bitcoin, '/root/.bitcoin/regtest/.cookie', 'core.cookie');
    const cert = copy(provider, '/root/.lnd/tls.cert', 'payer.cert');
    const readonly = copy(provider, `${secret}/readonly.macaroon`, 'payer.readonly');
    const router = copy(provider, `${secret}/router.macaroon`, 'payer.router');
    const core = new BitcoinRpcClient('http://127.0.0.1:48443', cookie, wallet);
    const url = 'https://127.0.0.1:48080';
    const client = new LndClient(url, cert, readonly);
    const transport = new HttpsLndPaymentTransport(url, cert, router);
    let sends = 0;
    let tracks = 0;
    let observedSuccess = false;
    const ports = new CoreLndForwardPorts(core, client, {
      origin: transport.origin,
      async stream(path, body, onPayment, signal, guard) {
        if (body === undefined) tracks++; else sends++;
        await transport.stream(path, body, onPayment, signal, guard);
        if (body !== undefined) { observedSuccess = true; throw new Error('Simulated lost terminal response'); }
      },
    }, payer.identity_pubkey, payee.identity_pubkey, channels[0].scid, store);
    await ports.inspectPayer();
    step = 'invoice and admission';
    const invoice = lnd(alice, 'addinvoice', '--amt=5000', '--expiry=600');
    const decoded = await client.call<{ payment_hash: string }>(`/v1/payreq/${invoice.payment_request}`);
    let service = new ForwardAdmission(store, ports, payer.identity_pubkey, payee.identity_pubkey);
    await assert.rejects(service.admit('owner-a', invoice.payment_request, 4999), /differs/);
    const admission = await service.admit('owner-a', invoice.payment_request, 5000);
    await assert.rejects(service.admit('owner-b', invoice.payment_request, 5000), /reserved/);
    step = 'funding and confirmations';
    // Self-funded laboratory fixture: the wallet's change and the reserved output are distinct.
    const txid = btc('sendtoaddress', admission.address, (admission.depositSats / 1e8).toFixed(8));
    const raw = JSON.parse(btc('gettransaction', txid)).hex;
    const outputs = JSON.parse(btc('decoderawtransaction', raw)).vout.filter((o: { scriptPubKey: { address?: string } }) =>
      o.scriptPubKey.address === admission.address);
    assert.equal(outputs.length, 1);
    const point = { txid, vout: outputs[0].n };
    await assert.rejects(service.execute('owner-b', admission.id, point), /not found/);
    await assert.rejects(service.execute('owner-a', admission.id, point));
    assert.equal(sends, 0);
    btc('generatetoaddress', '2', btc('getnewaddress'));
    for (let i = 0; ; i++) {
      try { await ports.inspectPayer(); break; }
      catch (e) { if (i === 29) throw e; await delay(500); }
    }
    assert.equal((await ports.inspectDeposit(txid, point.vout)).confirmations, 2);
    step = 'single send with lost response';
    assert.equal(await service.execute('owner-a', admission.id, point), 'UNKNOWN');
    assert.equal(observedSuccess, true);
    step = 'recovery after reopening disk state';
    await store.close();
    store = undefined;
    store = await Store.openForForward(state, payer.identity_pubkey);
    service = new ForwardAdmission(store, ports, payer.identity_pubkey, payee.identity_pubkey);
    await assert.rejects(service.recover('owner-b', admission.id), /not found/);
    await assert.rejects(service.execute('owner-a', admission.id, point), /already journaled/);
    assert.equal(await service.recover('owner-a', admission.id), 'SUCCEEDED');
    assert.equal(await service.recover('owner-a', admission.id), 'SUCCEEDED');
    assert.deepEqual({ sends, tracks }, { sends: 1, tracks: 1 });
    step = 'recipient settlement';
    const settled = lnd(alice, 'lookupinvoice', `--rhash=${decoded.payment_hash}`);
    assert.equal(settled.state, 'SETTLED');
    assert.equal(settled.amt_paid_sat, '5000');
    console.log('Isolated regtest: two confirmations, recipient settled 5000 sats, one send, one track after reopen.');
  } catch {
    throw new Error(`Isolated forward verification failed at: ${step}. Do not resend; retain journal at ${state}`);
  } finally {
    try { await store?.close(); } finally {
      for (const name of ['core.cookie', 'payer.readonly', 'payer.router']) {
        try { unlinkSync(join(directory, name)); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      }
    }
  }
}

verify().catch(error => { console.error(error.message); process.exitCode = 1; });
