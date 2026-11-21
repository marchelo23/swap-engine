import { readFileSync } from 'node:fs';
import { resolve, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkedJSON, operatorStopped } from '../src/operator/OperatorFiles.js';
import { prepareOwnedRunCustody } from '../src/operator/OwnedRunCustody.js';

/** Local client/operator custody only; this command has no invoice/payment/node capability. */
export async function runOwnedCustodyCLI(args: string[]) {
  if (args.length === 1 && args[0] === '--help') return { help: '--prepare-owned-custody --run-dir ABS --policy-sha256 SHA; vault password on stdin; no node actions' };
  if (process.platform !== 'linux' || args.length !== 5 || args[0] !== '--prepare-owned-custody' || args[1] !== '--run-dir' ||
    !isAbsolute(args[2] ?? '') || args[3] !== '--policy-sha256' || !/^[a-f0-9]{64}$/.test(args[4] ?? '')) throw operatorStopped();
  const directory = resolve(args[2]!); const policy = await checkedJSON(join(directory, 'owner-policy.json'), args[4]!);
  const password = readFileSync(0);
  try {
    let length = password.length; while (length && [10,13].includes(password[length-1]!)) length--;
    if (length < 8 || length > 4096) throw operatorStopped();
    return await prepareOwnedRunCustody(directory, policy, password.subarray(0,length));
  } finally { password.fill(0); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  void runOwnedCustodyCLI(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result)+'\n'))
    .catch(() => { process.stderr.write('OWNED_CUSTODY_STOPPED: retain artifacts; no automatic regeneration or invoice retry\n'); process.exitCode=1; });
