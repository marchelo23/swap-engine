import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { privateTestDirectory } from './helpers.js';
import { protectedBytes } from '../src/operator/OperatorFiles.js';

test('operator fixtures isolate secrets from shared checkouts while runtime guards still reject writable ancestors', { skip: process.platform !== 'linux' }, async () => {
  const previous = process.umask(0o002); let directory: string | undefined;
  try {
    directory = await privateTestDirectory('isolation');
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.ok(directory.startsWith((await realpath(tmpdir())) + '/'));
    const privateFile = join(directory, 'private-record'); await writeFile(privateFile, 'synthetic-test-only', { mode: 0o600 });
    assert.equal((await protectedBytes(privateFile)).toString(), 'synthetic-test-only');
    const shared = join(directory, 'shared'); await mkdir(shared); await chmod(shared, 0o775);
    const unsafe = join(shared, 'record'); await writeFile(unsafe, 'synthetic-test-only', { mode: 0o600 });
    await assert.rejects(protectedBytes(unsafe), /OPERATOR_STOPPED/);
  } finally {
    process.umask(previous); if (directory) await rm(directory, { recursive: true, force: true });
  }
});
