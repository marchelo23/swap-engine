import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireMiningLock, MiningLockedError } from '../src/regtest-mining/MiningLock.js';
import {
  getMinerStatus,
  pauseMiner,
  resumeMiner,
  runMinerOnce,
  type MinerConfig,
} from '../src/regtest-mining/RegtestMiner.js';

function hashFor(height: number): string {
  return height.toString(16).padStart(64, '0');
}

class MockRpc {
  chain = 'regtest';
  blocks = 139;
  headers = 139;
  initialblockdownload = false;
  wallets = ['lqwd-lab'];
  wallet = 'lqwd-lab';
  address = 'bcrt1qtestaddress0000000000000000000000000000';
  addressOwned = true;
  ambiguous = false;
  getnewaddressCalls = 0;
  mineCalls = 0;
  bestblockhash = hashFor(139);

  async call<T>(method: string, params: unknown[] = [], wallet = false): Promise<T> {
    switch (method) {
      case 'getblockchaininfo':
        return { chain: this.chain, blocks: this.blocks, headers: this.headers,
          bestblockhash: this.bestblockhash, initialblockdownload: this.initialblockdownload } as T;
      case 'listwallets':
        return this.wallets as T;
      case 'getwalletinfo':
        assert.equal(wallet, true);
        return { walletname: this.wallet } as T;
      case 'getaddressinfo':
        assert.equal(wallet, true);
        return { address: params[0], ismine: this.addressOwned, iswatchonly: false, solvable: true } as T;
      case 'getnewaddress':
        assert.equal(wallet, true);
        this.getnewaddressCalls++;
        return this.address as T;
      case 'generatetoaddress': {
        assert.equal(wallet, true);
        assert.deepEqual(params, [1, this.address]);
        this.mineCalls++;
        this.blocks++;
        this.headers = Math.max(this.headers, this.blocks);
        const hash = hashFor(this.blocks);
        this.bestblockhash = this.ambiguous ? hashFor(this.blocks + 100) : hash;
        return [hash] as T;
      }
      default:
        throw new Error(`Unexpected RPC ${method}`);
    }
  }
}

async function fixture() {
  await mkdir('data/tests', { recursive: true });
  const dir = await mkdtemp(join(process.cwd(), 'data', 'tests', 'miner-'));
  let now = 1_800_000_000_000;
  const config: MinerConfig = {
    bitcoinUrl: 'http://127.0.0.1:18443',
    cookie: '/unused',
    wallet: 'lqwd-lab',
    dataDir: dir,
    addressFile: join(dir, 'mining-address'),
    stateFile: join(dir, 'status.json'),
    logFile: join(dir, 'miner.log'),
    lockFile: join(dir, 'miner.lock'),
    pauseFile: join(dir, 'pause.json'),
    addressLabel: 'lqwd-regtest-miner',
    lockTtlMs: 60_000,
    now: () => now,
  };
  return {
    dir, config, rpc: new MockRpc(),
    advance(ms: number) { now += ms; },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test('first run persists one wallet-owned address and mines exactly one block', async () => {
  const f = await fixture(); try {
    const first = await runMinerOnce(f.rpc, f.config);
    assert.equal(first.status, 'mined');
    if (first.status !== 'mined') return;
    assert.equal(first.height, 140);
    assert.equal(first.blockHash, hashFor(140));
    assert.equal(first.blocksMined, 1);
    assert.equal(f.rpc.getnewaddressCalls, 1);
    assert.equal((await readFile(f.config.addressFile, 'utf8')).trim(), f.rpc.address);

    f.advance(10 * 60_000);
    const second = await runMinerOnce(f.rpc, f.config);
    assert.equal(second.status, 'mined');
    if (second.status !== 'mined') return;
    assert.equal(second.height, 141);
    assert.equal(second.blocksMined, 2);
    assert.equal(f.rpc.getnewaddressCalls, 1);
    assert.equal(f.rpc.mineCalls, 2);
    const status = await getMinerStatus(f.config);
    assert.equal(status.blocksMined, 2);
    assert.equal(status.lastHeight, 141);
    assert.equal(status.coinbaseMaturityHeight, 241);
    assert.match(await readFile(f.config.logFile, 'utf8'), /"event":"mined"/);
  } finally { await f.cleanup(); }
});

test('wrong chain, IBD and missing wallet abort before generatetoaddress', async () => {
  const cases: Array<{ name: string; change: (rpc: MockRpc) => void; failure: string }> = [
    { name: 'mainnet', change: rpc => { rpc.chain = 'main'; }, failure: 'CORE_WRONG_CHAIN' },
    { name: 'IBD', change: rpc => { rpc.initialblockdownload = true; }, failure: 'CORE_NOT_READY' },
    { name: 'headers', change: rpc => { rpc.headers = 100; }, failure: 'CORE_NOT_READY' },
    { name: 'wallet', change: rpc => { rpc.wallets = []; }, failure: 'WALLET_NOT_LOADED' },
  ];
  for (const c of cases) {
    const f = await fixture(); try {
      c.change(f.rpc);
      const result = await runMinerOnce(f.rpc, f.config);
      assert.equal(result.status, 'failed', c.name);
      if (result.status === 'failed') assert.equal(result.failure, c.failure, c.name);
      assert.equal(f.rpc.mineCalls, 0, c.name);
      assert.equal((await getMinerStatus(f.config)).failures, 1, c.name);
    } finally { await f.cleanup(); }
  }
});

test('rejects an existing address not owned by the wallet without creating another', async () => {
  const f = await fixture(); try {
    await writeFile(f.config.addressFile, `${f.rpc.address}\n`, { mode: 0o600 });
    f.rpc.addressOwned = false;
    const result = await runMinerOnce(f.rpc, f.config);
    assert.equal(result.status, 'failed');
    if (result.status === 'failed') assert.equal(result.failure, 'ADDRESS_NOT_OWNED');
    assert.equal(f.rpc.getnewaddressCalls, 0);
    assert.equal(f.rpc.mineCalls, 0);
  } finally { await f.cleanup(); }
});

test('ambiguous mining evidence is recorded once without retry', async () => {
  const f = await fixture(); try {
    f.rpc.ambiguous = true;
    const result = await runMinerOnce(f.rpc, f.config);
    assert.equal(result.status, 'failed');
    if (result.status === 'failed') assert.equal(result.failure, 'AMBIGUOUS_MINE');
    assert.equal(f.rpc.mineCalls, 1);
    assert.equal((await getMinerStatus(f.config)).failures, 1);
  } finally { await f.cleanup(); }
});

test('pause blocks timer mining while explicit on-demand mines one block', async () => {
  const f = await fixture(); try {
    await pauseMiner(f.config, 'expiry-test');
    const paused = await runMinerOnce(f.rpc, f.config);
    assert.equal(paused.status, 'paused');
    assert.equal(f.rpc.mineCalls, 0);
    assert.equal((await getMinerStatus(f.config)).paused, true);

    const onDemand = await runMinerOnce(f.rpc, f.config, { ignorePause: true, owner: 'on-demand' });
    assert.equal(onDemand.status, 'mined');
    assert.equal(f.rpc.mineCalls, 1);

    await resumeMiner(f.config);
    assert.equal((await getMinerStatus(f.config)).paused, false);
  } finally { await f.cleanup(); }
});

test('shared mining lock blocks a second miner until released', async () => {
  const f = await fixture(); try {
    const release = await acquireMiningLock(f.config.lockFile, { owner: 'swap', ttlMs: 60_000, now: f.config.now });
    try {
      const blocked = await runMinerOnce(f.rpc, f.config);
      assert.equal(blocked.status, 'locked');
      if (blocked.status === 'locked') assert.equal(blocked.lockOwner, 'swap');
      assert.equal(f.rpc.mineCalls, 0);
    } finally { await release(); }
    const mined = await runMinerOnce(f.rpc, f.config);
    assert.equal(mined.status, 'mined');
  } finally { await f.cleanup(); }
});

test('stale mining lock from a dead PID is recovered', async () => {
  const f = await fixture(); try {
    await writeFile(f.config.lockFile, JSON.stringify({ pid: 999999, owner: 'dead', acquiredAt: 1, expiresAt: 2 }) + '\n', { mode: 0o600 });
    const release = await acquireMiningLock(f.config.lockFile, { owner: 'miner', ttlMs: 60_000, now: f.config.now });
    await release();
    const status = await getMinerStatus(f.config);
    assert.equal(status.blocksMined, 0);
  } finally { await f.cleanup(); }
});

test('deploy units are oneshot, 10-minute and regtest-only', async () => {
  const service = await readFile(join(process.cwd(), 'deploy', 'regtest-block-miner.service'), 'utf8');
  const timer = await readFile(join(process.cwd(), 'deploy', 'regtest-block-miner.timer'), 'utf8');
  const env = await readFile(join(process.cwd(), 'deploy', 'regtest-miner.env.example'), 'utf8');
  assert.match(service, /Type=oneshot/);
  assert.match(service, /--once/);
  assert.match(service, /Restart=no/);
  assert.match(timer, /OnUnitActiveSec=10min/);
  assert.match(timer, /Persistent=true/);
  assert.match(env, /BITCOIN_RPC_URL=http:\/\/127\.0\.0\.1:18443/);
  assert.doesNotMatch(env, /mainnet|testnet|signet/i);
});
