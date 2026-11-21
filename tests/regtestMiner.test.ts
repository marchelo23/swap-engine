import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

test('regtest miner deployment uses kernel flock and existing release path', async () => {
  const script = await readFile('scripts/regtest-block-miner.sh', 'utf8');
  const service = await readFile('deploy/regtest-block-miner.service', 'utf8');
  const timer = await readFile('deploy/regtest-block-miner.timer', 'utf8');
  assert.match(script, /exec 9>>"\$LOCK_FILE"/);
  assert.match(script, /flock -n 9/);
  assert.doesNotMatch(script, /rm -f "\$LOCK_FILE"/);
  assert.match(script, /generatetoaddress 1/);
  assert.match(script, /pending\.json/);
  assert.match(script, /getblockhash "\$pre_height"/);
  assert.match(script, /previousblockhash/);
  assert.match(script, /scriptPubKey\.address/);
  assert.match(script, /sync_path "\$tmp"/);
  assert.match(script, /sync_path "\$DATA_DIR"/);
  assert.match(script, /sync_path "\$ADDRESS_FILE"/);
  assert.match(script, /\.blocksMined = \(if \.lastBlockHash == \$hash/);
  assert.match(script, /rm -f "\$PENDING_FILE"\s*\n\s*sync_path "\$DATA_DIR"/);
  assert.match(service, /Type=oneshot/);
  assert.match(service, /%h\/deployments\/lqwd-swap-engine-434f519\/scripts\/regtest-block-miner\.sh/);
  assert.match(timer, /OnUnitActiveSec=10min/);
  assert.match(timer, /Persistent=true/);
});

test('regtest miner adversarial Bash/flock tests', { skip: process.platform !== 'linux' ? 'Linux/flock only' : false }, () => {
  const result = spawnSync('bash', ['tests/regtestMiner.sh'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
