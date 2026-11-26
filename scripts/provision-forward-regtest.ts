import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readAccounts } from '../src/auth/store.js';
import {
  forwardRegtestPolicySchema,
  forwardStateScope,
  type ForwardRegtestPolicy,
} from '../src/forward/ForwardRegtestProfile.js';
import { checkedJSON, protectedBytes } from '../src/operator/OperatorFiles.js';
import type { StateScope } from '../src/environment/StateScope.js';
import { Store } from '../src/persistence/Store.js';

const hex64 = /^[a-f0-9]{64}$/;

export type ProvisionForwardCommand =
  | { mode: 'help' }
  | { mode: 'fresh'; policyPath: string; policySha256: string }
  | { mode: 'consolidated'; policyPath: string; policySha256: string; bundleDirectory: string; manifestSha256: string };

const usage = 'Offline only. --fresh --policy-path <abs> --policy-sha256 <64-hex> (or omit --fresh), or --consolidated --policy-path <abs> --policy-sha256 <64-hex> --bundle-dir <abs> --manifest-sha256 <64-hex>.';

export function parseProvisionForwardCommand(args: string[]): ProvisionForwardCommand {
  if (args.length === 1 && args[0] === '--help') return { mode: 'help' };
  const normalized = args[0] === '--fresh' ? args.slice(1) : args;
  if (normalized.length === 4 && normalized[0] === '--policy-path' && isAbsolute(normalized[1] ?? '') &&
    normalized[2] === '--policy-sha256' && hex64.test(normalized[3] ?? '')) {
    return { mode: 'fresh', policyPath: normalized[1]!, policySha256: normalized[3]! };
  }
  if (args.length === 9 && args[0] === '--consolidated' && args[1] === '--policy-path' && isAbsolute(args[2] ?? '') &&
    args[3] === '--policy-sha256' && hex64.test(args[4] ?? '') && args[5] === '--bundle-dir' && isAbsolute(args[6] ?? '') &&
    args[7] === '--manifest-sha256' && hex64.test(args[8] ?? '')) {
    return {
      mode: 'consolidated',
      policyPath: args[2]!,
      policySha256: args[4]!,
      bundleDirectory: args[6]!,
      manifestSha256: args[8]!,
    };
  }
  throw new Error('FORWARD_PROVISION_ARGS_INVALID');
}

export type ProvisionForwardIO = {
  provisionFresh?: (directory: string, payerNode: string, stateScope: StateScope) => Promise<{ storeId: string; directory: string }>;
  provisionConsolidated?: (
    directory: string,
    payerNode: string,
    bundleDirectory: string,
    manifestSha256: string,
    stateScope: StateScope,
  ) => Promise<{ storeId: string; directory: string }>;
  log?: (line: string) => void;
  error?: (line: string) => void;
};

async function loadAndVerifyPolicy(policyPath: string, policySha256: string): Promise<ForwardRegtestPolicy> {
  const raw = await checkedJSON(policyPath, policySha256);
  const policy = forwardRegtestPolicySchema.parse(raw);
  const authBytes = await protectedBytes(policy.authStorePath, true);
  authBytes.fill(0);
  const accounts = await readAccounts(policy.authStorePath);
  const owner = accounts.find(a => a.id === policy.ownerId);
  if (!owner || owner.role !== 'ADMIN' || owner.username !== policy.ownerUsername) {
    throw new Error('FORWARD_OWNER_UNAUTHORIZED');
  }
  return policy;
}

/** Explicit audited offline provisioning for a new or consolidated forward Store with complete StateScope. */
export async function runProvisionForwardCLI(args: string[], io: ProvisionForwardIO = {}): Promise<number> {
  const log = io.log ?? ((line: string) => console.log(line));
  const err = io.error ?? ((line: string) => console.error(line));
  try {
    const command = parseProvisionForwardCommand(args);
    if (command.mode === 'help') {
      log(usage);
      return 0;
    }
    const policy = await loadAndVerifyPolicy(command.policyPath, command.policySha256);
    const scope = forwardStateScope(policy);
    const fresh = io.provisionFresh ?? ((dir, node, s) => Store.provisionFreshForward(dir, node, s));
    const consolidated = io.provisionConsolidated ?? ((dir, node, bundle, sha, s) =>
      Store.provisionConsolidatedForward(dir, node, bundle, sha, s));
    const result = command.mode === 'fresh'
      ? await fresh(policy.dataDir, policy.payerNode, scope)
      : await consolidated(policy.dataDir, policy.payerNode, command.bundleDirectory, command.manifestSha256, scope);
    log(JSON.stringify({ event: 'forward_store_provisioned', mode: command.mode, storeId: result.storeId, deploymentId: policy.deploymentId }));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'FORWARD_PROVISION_FAILED';
    err(`FORWARD_PROVISION_REJECTED: ${message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void runProvisionForwardCLI(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
