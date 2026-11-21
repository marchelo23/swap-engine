import { BitcoinRpcClient } from '../src/bitcoin/BitcoinRpcClient.js';
import { minerConfigFromEnv } from '../src/regtest-mining/Config.js';
import {
  getMinerStatus,
  pauseMiner,
  resumeMiner,
  runMinerOnce,
  MinerError,
} from '../src/regtest-mining/RegtestMiner.js';
import { MiningLockedError } from '../src/regtest-mining/MiningLock.js';

function print(value: unknown): void {
  console.log(JSON.stringify(value));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? '--once';
  if (command === '--help') {
    print({
      usage: [
        '--once                 mine exactly one block unless paused or locked',
        '--on-demand            explicit one-block confirmation; ignores pause but not the shared lock',
        '--status               print sanitized miner status',
        '--pause [reason]       pause timer mining for expiration tests',
        '--resume               resume timer mining',
        '--help',
      ],
      network: 'regtest',
      note: 'Never run for another chain; swap/recovery must use the same mining lock for deadline coordination.',
    });
    return;
  }

  const config = minerConfigFromEnv();
  const rpc = new BitcoinRpcClient(config.bitcoinUrl, config.cookie, config.wallet);

  if (command === '--status') {
    print(await getMinerStatus(config));
    return;
  }
  if (command === '--pause') {
    const reason = args[1] ?? 'operator-pause';
    print(await pauseMiner(config, reason));
    return;
  }
  if (command === '--resume') {
    print(await resumeMiner(config));
    return;
  }
  if (command === '--once' || command === '--on-demand') {
    const result = await runMinerOnce(rpc, config, {
      owner: command === '--on-demand' ? 'on-demand' : 'timer',
      ignorePause: command === '--on-demand',
    });
    print(result);
    if (result.status === 'failed') process.exitCode = 1;
    return;
  }
  throw new MinerError('INVALID_COMMAND');
}

main().catch(error => {
  if (error instanceof MiningLockedError) {
    print({ status: 'locked', lockOwner: error.info?.owner ?? null });
    return;
  }
  if (error instanceof MinerError) {
    print({ status: 'failed', failure: error.code });
    process.exitCode = 1;
    return;
  }
  print({ status: 'failed', failure: 'MINER_CONFIGURATION_OR_RPC_ERROR' });
  process.exitCode = 1;
});
