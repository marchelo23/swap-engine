import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOwnedCustodyCLI } from '../scripts/prepare-owned-custody.js';

test('owned custody CLI help and malformed requests cannot read a password, create custody or reach nodes', async () => {
  const help = await runOwnedCustodyCLI(['--help']);
  assert.ok('help' in help); assert.match(help.help, /no node actions/);
  for (const args of [[], ['--prepare-owned-custody'], ['--execute'], ['--help','extra'],
    ['--prepare-owned-custody','--run-dir','relative','--policy-sha256','ab'.repeat(32)],
    ['--prepare-owned-custody','--run-dir',process.cwd(),'--policy-sha256','not-a-hash'],
    ['--prepare-owned-custody','--run-dir',process.cwd(),'--policy-sha256','ab'.repeat(32),'--pay']]) {
    await assert.rejects(runOwnedCustodyCLI(args));
  }
});
