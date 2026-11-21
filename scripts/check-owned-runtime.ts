import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createOwnedRuntimeFactory } from '../src/operator/OwnedPreparationRuntime.js';
import { checkedJSON, operatorStopped } from '../src/operator/OperatorFiles.js';

/** Read-only operator compatibility check. Never opens a run store or creates keys/invoices. */
export async function checkOwnedRuntime(args: string[]) {
  if (args.length !== 5 || args[0] !== '--check-owned-runtime' || args[1] !== '--policy-path' || !isAbsolute(args[2] ?? '') ||
    args[3] !== '--policy-sha256' || !/^[a-f0-9]{64}$/.test(args[4] ?? '')) throw operatorStopped();
  const factory = await createOwnedRuntimeFactory(await checkedJSON(args[2]!, args[4]!), { get: async () => undefined, verifyCsrf: () => false });
  try { return await factory.preflight!(); } finally { await factory.close?.(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  void checkOwnedRuntime(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch(() => { process.stderr.write('OWNED_PROFILE_CHECK_STOPPED: no invoice or payment attempted\n'); process.exitCode = 1; });
