import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { parsePreparationCommand, dispatchPreparation } from '../scripts/prepare-controlled-reverse.js';

test('operator CLI has no default action and refuses implicit execution, duplicate flags and stale-shaped inputs', () => {
  assert.deepEqual(parsePreparationCommand(['--help']), { mode: 'help' });
  const base = ['--prepare-invoice-only', '--run-dir', resolve('data/tests/not-created'), '--spec-sha256', 'ab'.repeat(32)];
  assert.equal(parsePreparationCommand(base).mode, 'prepare');
  for (const args of [[], ['--execute'], base.slice(0, 3), [...base, '--execute'], [...base, '--run-dir', '/tmp/other'],
    [...base.slice(0, 4), 'bad'], [base[0]!, '--run-dir', 'relative', '--spec-sha256', 'ab'.repeat(32)],
    ['--recover-invoice-only', ...base.slice(1)],
    ...['-1', '01', '1.5', 'NaN', '9007199254740992'].map(revision => ['--recover-invoice-only', ...base.slice(1), '--expected-revision', revision])]) {
    assert.throws(() => parsePreparationCommand(args));
  }
});

test('lookup recovery dispatch cannot fall back to preparation or execution', async () => {
  let creates = 0; let lookups = 0;
  const command = parsePreparationCommand(['--recover-invoice-only', '--run-dir', resolve('data/tests/not-created'),
    '--spec-sha256', 'ab'.repeat(32), '--expected-revision', '7']); assert.notEqual(command.mode, 'help');
  if (command.mode === 'help') throw Error();
  await dispatchPreparation(command, { prepare: async () => { creates++; throw Error(); }, recover: async revision => {
    assert.equal(revision, 7); lookups++; return undefined as never;
  } });
  assert.equal(creates, 0); assert.equal(lookups, 1);
  assert.throws(() => dispatchPreparation({ mode: 'execute' } as never, { prepare: async () => { creates++; return undefined as never; },
    recover: async () => undefined as never }));
  assert.equal(creates, 0);
  const prepare = parsePreparationCommand(['--prepare-invoice-only', '--run-dir', resolve('data/tests/not-created'), '--spec-sha256', 'ab'.repeat(32)]);
  if (prepare.mode === 'help') throw Error();
  assert.throws(() => dispatchPreparation(prepare, { recover: async () => undefined as never }));
});

test('CLI help and rejected command paths run without credentials or node transports and suppress supplied data', async () => {
  const run = promisify(execFile);
  const script = resolve('scripts/prepare-controlled-reverse.ts');
  const help = await run(process.execPath, ['--import', 'tsx', script, '--help']); assert.match(help.stdout, /Invoice only; no execution/);
  await assert.rejects(run(process.execPath, ['--import', 'tsx', script, '--unknown-secret-value']), error => {
    const result = error as Error & { stderr: string };
    return result.stderr.includes('PREPARATION_STOPPED') && !result.stderr.includes('unknown-secret-value');
  });
});
