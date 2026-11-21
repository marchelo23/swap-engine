import { withMiningLock } from '../../src/mining/MiningLock.js';

const lockFile = process.argv[2];
if (!lockFile) { process.stderr.write('missing lock file\n'); process.exit(2); }
await withMiningLock(async () => {
  process.stdout.write('locked\n');
  await new Promise(() => {});
}, { lockFile });
