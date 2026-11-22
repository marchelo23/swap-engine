import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApi } from './api/server.js';
import { ReadOnlyBitcoinClient, ReadOnlyLndClient } from './diagnostics/ReadOnlyClients.js';
import { preflight } from './diagnostics/preflight.js';
import type { Balances } from './liquidity/LiquidityManager.js';
import { collectOperationsBalances, type OperationsBalances } from './operations/Balances.js';
import { Store } from './persistence/Store.js';
import { SwapManager } from './core/SwapManager.js';
import { config, type ApplicationMode } from './config.js';
import { recoverInterruptedReverseRuns } from './api/reverseRecovery.js';
import { parseOperatorCommand, runOperatorCLI } from '../scripts/run-controlled-reverse.js';
import { isAbsolute, join } from 'node:path';
import { checkedJSON, protectedBytes } from './operator/OperatorFiles.js';
import { createOwnedRuntimeFactory, ownedRuntimePolicySchema, type OwnedRuntimePolicy } from './operator/OwnedPreparationRuntime.js';
import { createOwnedPreparation } from './api/ownedPreparation.js';
import { assertStateScope } from './environment/StateScope.js';
import { assertOperatorBinding, type OperatorBindingExpectation } from './environment/OperatorBinding.js';
import { preparationSpecSchema } from './core/ReversePreparation.js';
import { readPathsSchema } from '../scripts/run-controlled-reverse.js';
import { attestStartup, type StartupScope } from './environment/StartupAttestation.js';
import { ElementsReadOnlyClient } from './environment/ElementsReadOnlyClient.js';

function sameOrigin(url: string, origin: string) { try { return new URL(url).origin === origin; } catch { return false; } }
function assertOwnedPolicyBinding(policy: OwnedRuntimePolicy, c: ReturnType<typeof config>, identity: StartupScope | undefined) {
  if (!identity || !identity.verified.onchain || !identity.verified.lightning || !identity.providerNode || !identity.payerNode)
    throw new Error('OWNED_POLICY_IDENTITY_UNAVAILABLE');
  if (!c.rails.onchain.enabled || !c.rails.lightning.enabled || !c.rails.lightning.alice)
    throw new Error('OWNED_POLICY_RAILS_NOT_CONFIGURED');
  if (policy.wallet !== identity.wallet) throw new Error('OWNED_POLICY_WALLET_MISMATCH');
  const providerOrigin = new URL(c.rails.lightning.provider.url).origin;
  const payerOrigin = new URL(c.rails.lightning.alice.url).origin;
  if (!sameOrigin(c.rails.onchain.url, policy.routing.bitcoinOrigin) || policy.routing.providerOrigin !== providerOrigin ||
    policy.routing.payerOrigin !== payerOrigin || policy.providerNode !== identity.providerNode ||
    policy.payerNode !== identity.payerNode || policy.credentialPaths.bitcoinCookiePath !== c.rails.onchain.cookie ||
    policy.credentialPaths.providerCertPath !== c.rails.lightning.provider.cert ||
    policy.credentialPaths.providerReadMacaroonPath !== c.rails.lightning.provider.macaroon ||
    policy.credentialPaths.payerCertPath !== c.rails.lightning.alice.cert ||
    policy.credentialPaths.payerReadMacaroonPath !== c.rails.lightning.alice.macaroon)
    throw new Error('OWNED_POLICY_IDENTITY_MISMATCH');
}

function operatorPolicy(c: ReturnType<typeof config>, identity: StartupScope): OperatorBindingExpectation {
  if (!identity.providerNode || !identity.payerNode || !c.rails.onchain.enabled ||
    !c.rails.lightning.enabled || !c.rails.lightning.alice || !c.bitcoinGenesisHash) throw new Error('OPERATOR_BINDING_UNAVAILABLE');
  return { wallet: identity.wallet, genesisHash: c.bitcoinGenesisHash,
    bitcoinOrigin: new URL(c.rails.onchain.url).origin, providerOrigin: new URL(c.rails.lightning.provider.url).origin,
    payerOrigin: new URL(c.rails.lightning.alice.url).origin, providerNode: identity.providerNode, payerNode: identity.payerNode,
    bitcoinCookiePath: c.rails.onchain.cookie, providerCertPath: c.rails.lightning.provider.cert,
    providerReadMacaroonPath: c.rails.lightning.provider.macaroon, payerCertPath: c.rails.lightning.alice.cert,
    payerReadMacaroonPath: c.rails.lightning.alice.macaroon };
}

export function ownedStartupArguments(args: string[], mode: ApplicationMode) {
  if (args[0] !== '--owned-regtest') return undefined;
  if (mode !== 'regtest' || args.length !== 5 || args[1] !== '--policy-path' || !isAbsolute(args[2] ?? '') ||
    args[3] !== '--policy-sha256' || !/^[a-f0-9]{64}$/.test(args[4] ?? '')) throw new Error('OWNED_STARTUP_REJECTED');
  return { path: args[2]!, hash: args[4]! };
}

/** Only native reviewed serve modes can be installed; no action or credential comes from HTTP. */
export function controlledStartupArguments(args: string[], mode: ApplicationMode): string[] | undefined {
  if (!args.length) return undefined;
  if (mode !== 'regtest' || args[0] !== '--controlled-reverse') throw new Error('CONTROLLED_STARTUP_REJECTED');
  const operatorArgs = args.slice(1); const command = parseOperatorCommand(operatorArgs);
  if (command.mode !== 'serve' && command.mode !== 'serve-status') throw new Error('CONTROLLED_STARTUP_REJECTED');
  return operatorArgs;
}

type Dependencies = {
  operator?: typeof runOperatorCLI;
  port?: number;
  reads?: { liquidity: () => Promise<Balances>; diagnostics?: () => ReturnType<typeof preflight>;
    operations?: () => Promise<OperationsBalances> };
  identity?: StartupScope;
};

/** Real app entrypoint, also exercised offline with mock node/operator adapters. */
export async function startApplication(env: NodeJS.ProcessEnv = process.env, args: string[] = [], dependencies: Dependencies = {}) {
  const c = config(env); const ownedArgs = ownedStartupArguments(args, c.mode);
  const operatorArgs = ownedArgs ? undefined : controlledStartupArguments(args, c.mode);
  const reverseMutationAllowed = c.spendPolicy === 'regtest-only' && c.features.reverse;
  if (ownedArgs && !reverseMutationAllowed) throw new Error('OWNED_EXECUTION_DISABLED');
  if (operatorArgs && parseOperatorCommand(operatorArgs).mode === 'serve' && !reverseMutationAllowed)
    throw new Error('CONTROLLED_EXECUTION_DISABLED');
  let liquidity: () => Promise<Balances>; let diagnostics: (() => ReturnType<typeof preflight>) | undefined;
  let operations: (() => Promise<OperationsBalances>) | undefined;
  let bitcoin: ReadOnlyBitcoinClient | null = null; let lnd: ReadOnlyLndClient | null = null;
  let alice: ReadOnlyLndClient | null = null; let liquid: ElementsReadOnlyClient | null = null;
  if (dependencies.reads) ({ liquidity, diagnostics, operations } = dependencies.reads);
  else if (c.bitcoinNetwork && (c.rails.onchain.enabled || c.rails.lightning.enabled)) {
    bitcoin = c.rails.onchain.enabled ? new ReadOnlyBitcoinClient(c.rails.onchain.url, c.rails.onchain.cookie, c.rails.onchain.wallet) : null;
    lnd = c.rails.lightning.enabled ? new ReadOnlyLndClient(c.rails.lightning.provider.url, c.rails.lightning.provider.cert, c.rails.lightning.provider.macaroon) : null;
    alice = c.rails.lightning.enabled && c.rails.lightning.alice
      ? new ReadOnlyLndClient(c.rails.lightning.alice.url, c.rails.lightning.alice.cert, c.rails.lightning.alice.macaroon) : null;
    if (c.mode === 'regtest') {
      liquidity = async () => {
        if (!bitcoin || !lnd) throw new Error('NODE_RAILS_NOT_CONFIGURED');
        await Promise.all([bitcoin.assertRegtest(), lnd.assertRegtest()]);
        const [onchainSats, incomingSats] = await Promise.all([bitcoin.liquidity(), lnd.incomingLiquidity()]);
        return { onchainSats, incomingSats };
      };
    } else liquidity = async () => { throw new Error('NON_REGTEST_LIQUIDITY_DISABLED'); };
    const bitcoinClient = bitcoin; const lndClient = lnd;
    diagnostics = c.mode === 'regtest' && bitcoinClient && lndClient ? () => preflight(bitcoinClient, lndClient,
      c.rails.onchain.enabled ? c.rails.onchain.wallet : c.wallet, c.mode) : undefined;
    operations = () => collectOperationsBalances({ bitcoin, provider: lnd, alice });
  } else liquidity = async () => { throw new Error('SIMULATION_MODE_HAS_NO_NODE_CONNECTIVITY'); };
  if (!dependencies.reads && c.rails.liquid.enabled) liquid = new ElementsReadOnlyClient(
    c.rails.liquid.rpcUrl, c.rails.liquid.cookie, c.rails.liquid.wallet);
  let identity = dependencies.identity;
  if (!identity && (c.rails.onchain.enabled || c.rails.lightning.enabled || c.rails.liquid.enabled)) {
    identity = await attestStartup(c, { bitcoin, provider: lnd, alice, liquid });
  }
  if (operatorArgs && !dependencies.operator) {
    const command = parseOperatorCommand(operatorArgs);
    if (command.mode === 'serve') {
      if (!identity || !identity.providerNode || !identity.payerNode || !c.rails.onchain.enabled ||
        !c.rails.lightning.enabled || !c.rails.lightning.alice) throw new Error('OPERATOR_BINDING_UNAVAILABLE');
      const spec = preparationSpecSchema.parse(await checkedJSON(join(command.directory, 'spec.json'), command.checksum));
      const paths = readPathsSchema.parse(JSON.parse((await protectedBytes(join(command.directory, 'credential-paths.json'))).toString('utf8')));
      assertOperatorBinding(spec, paths, { wallet: identity.wallet, genesisHash: c.bitcoinGenesisHash!, bitcoinOrigin: new URL(c.rails.onchain.url).origin,
        providerOrigin: new URL(c.rails.lightning.provider.url).origin, payerOrigin: new URL(c.rails.lightning.alice.url).origin,
        providerNode: identity.providerNode, payerNode: identity.payerNode, bitcoinCookiePath: c.rails.onchain.cookie,
        providerCertPath: c.rails.lightning.provider.cert, providerReadMacaroonPath: c.rails.lightning.provider.macaroon,
        payerCertPath: c.rails.lightning.alice.cert, payerReadMacaroonPath: c.rails.lightning.alice.macaroon });
    }
  }
  await assertStateScope(c.directory, { environment: c.environment,
    deploymentId: c.deploymentId ?? 'simulation', genesisHash: identity?.genesisHash ?? null,
    wallet: identity?.wallet ?? '', bitcoinOrigin: identity?.bitcoinOrigin ?? null,
    providerOrigin: identity?.providerOrigin ?? null, payerOrigin: identity?.payerOrigin ?? null,
    providerNode: identity?.providerNode ?? null, payerNode: identity?.payerNode ?? null,
    liquidOrigin: identity?.liquidOrigin ?? null, liquidWallet: identity?.liquidWallet ?? null,
    liquidGenesisHash: identity?.liquidGenesisHash ?? null, liquidChainName: identity?.liquidChainName ?? null,
    liquidPolicyAsset: identity?.liquidPolicyAsset ?? null, liquidParentGenesisHash: identity?.liquidParentGenesisHash ?? null },
  { allowLegacyOfflineMigration: c.allowLegacyOfflineMigration });
  const store = await Store.open(c.directory);
  try {
    await recoverInterruptedReverseRuns(store);
    const server = createApi(new SwapManager(store), liquidity, diagnostics, c.mode,
      { operations, auth: { storePath: env.AUTH_STORE_PATH, origin: env.AUTH_ORIGIN }, capabilities: () => c.capabilities(identity?.verified ?? {}), environment: c.environment });
    if (ownedArgs) {
      let factory: Awaited<ReturnType<typeof createOwnedRuntimeFactory>> | undefined;
      try {
        const policy = ownedRuntimePolicySchema.parse(await checkedJSON(ownedArgs.path, ownedArgs.hash));
        assertOwnedPolicyBinding(policy, c, identity);
        // One Sessions instance, one catalog writer, exact account store and same browser origin.
        if (policy.authStorePath !== env.AUTH_STORE_PATH || policy.origin !== env.AUTH_ORIGIN || policy.port !== (dependencies.port ?? c.port)) throw new Error('OWNED_STARTUP_REJECTED');
        factory = await createOwnedRuntimeFactory(policy, server.controlled.operatorIO.sessions);
        server.controlled.installPreparation(await createOwnedPreparation(store, server.controlled.operatorIO.sessions, factory,
          { mode: 'regtest', ownerId: policy.ownerId, ownerUsername: policy.ownerUsername, origin: policy.origin, profileDigest: ownedArgs.hash }));
      } catch {
        await factory?.close?.();
        console.error('OWNED_PREPARATION_STOPPED: preserve runs; no automatic invoice or payment retry');
      }
    }
    await new Promise<void>((ready, reject) => { server.once('error', reject); server.listen(dependencies.port ?? c.port, '127.0.0.1', () => { server.off('error', reject); ready(); }); });
    // Failed readiness leaves the app usable with controlled execution closed; never retry.
    const runtime = operatorArgs
      ? dependencies.operator
        ? dependencies.operator(operatorArgs, server.controlled.operatorIO)
        : runOperatorCLI(operatorArgs, server.controlled.operatorIO, operatorPolicy(c, identity!))
      : undefined;
    void runtime?.catch(() => { console.error('CONTROLLED_RUNTIME_STOPPED: preserve intents; reconcile without retry'); });
    let shutdown: Promise<void> | undefined;
    return { server, store, runtime, mode: c.mode,
      close(): Promise<void> {
        return shutdown ??= (async () => {
          const stopped = new Promise<void>(done => server.close(() => done()));
          await server.controlled.close(); await runtime?.catch(() => {}); await stopped; await store.close();
        })();
      } };
  } catch (error) { await store.close(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void startApplication(process.env, process.argv.slice(2)).then(app => {
    const address = app.server.address();
    console.log(JSON.stringify({ event: 'api_listening', host: '127.0.0.1', port: address && typeof address === 'object' ? address.port : null, mode: app.mode, readOnly: true, liveSwapsEnabled: false }));
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
      void app.close().catch(() => { console.error('APPLICATION_SHUTDOWN_UNCERTAIN'); process.exitCode = 1; });
    });
  }).catch(() => { console.error('APPLICATION_STARTUP_REJECTED'); process.exitCode = 1; });
}
