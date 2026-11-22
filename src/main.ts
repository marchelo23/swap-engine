import { isAbsolute, join, resolve } from 'node:path';
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
import { checkedJSON } from './operator/OperatorFiles.js';
import { createOwnedRuntimeFactory, ownedRuntimePolicySchema } from './operator/OwnedPreparationRuntime.js';
import { createOwnedPreparation } from './api/ownedPreparation.js';
import { createArkLabCliRunner, createArkRegtestCliPort, type ArkRegtestPort } from './ark/ArkAdapter.js';

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
    operations?: () => Promise<OperationsBalances>; ark?: ArkRegtestPort };
};

/** Real app entrypoint, also exercised offline with mock node/operator adapters. */
export async function startApplication(env: NodeJS.ProcessEnv = process.env, args: string[] = [], dependencies: Dependencies = {}) {
  const c = config(env); const ownedArgs = ownedStartupArguments(args, c.mode);
  const operatorArgs = ownedArgs ? undefined : controlledStartupArguments(args, c.mode);
  let liquidity: () => Promise<Balances>; let diagnostics: (() => ReturnType<typeof preflight>) | undefined;
  let operations: (() => Promise<OperationsBalances>) | undefined;
  let ark: ArkRegtestPort | undefined;
  if (dependencies.reads) ({ liquidity, diagnostics, operations, ark } = dependencies.reads);
  else if (c.mode === 'regtest') {
    const bitcoin = new ReadOnlyBitcoinClient(c.bitcoinUrl, c.cookie, c.wallet);
    const lnd = new ReadOnlyLndClient(c.lndUrl, c.cert, c.macaroon);
    const alice = c.aliceLnd ? new ReadOnlyLndClient(c.aliceLnd.url, c.aliceLnd.cert, c.aliceLnd.macaroon) : null;
    liquidity = async () => {
      await Promise.all([bitcoin.assertRegtest(), lnd.assertRegtest()]);
      const [onchainSats, incomingSats] = await Promise.all([bitcoin.liquidity(), lnd.incomingLiquidity()]);
      return { onchainSats, incomingSats };
    };
    diagnostics = () => preflight(bitcoin, lnd, c.wallet, c.mode);
    operations = () => collectOperationsBalances({ bitcoin, provider: lnd, alice });
    const cli = c.arkCliBinaryPath ? createArkLabCliRunner(c.arkCliBinaryPath, { e2eFixture: c.arkCliE2eFixture }) : undefined;
    ark = createArkRegtestCliPort({ cli, operatorInfoUrl: c.arkOperatorInfoUrl, labRoot: c.arkLabRoot });
  } else liquidity = async () => { throw new Error('SIMULATION_MODE_HAS_NO_NODE_CONNECTIVITY'); };
  const store = await Store.open(c.directory);
  try {
    await recoverInterruptedReverseRuns(store);
    const server = createApi(new SwapManager(store), liquidity, diagnostics, c.mode,
      { operations, ark, arkStorePath: c.mode === 'regtest' ? join(c.directory, 'ark-swaps.json') : undefined, auth: { storePath: env.AUTH_STORE_PATH, origin: env.AUTH_ORIGIN } });
    if (ownedArgs) {
      let factory: Awaited<ReturnType<typeof createOwnedRuntimeFactory>> | undefined;
      try {
        const policy = ownedRuntimePolicySchema.parse(await checkedJSON(ownedArgs.path, ownedArgs.hash));
        // One Sessions instance, one catalog writer, exact account store and same browser origin.
        if (policy.authStorePath !== env.AUTH_STORE_PATH || policy.origin !== env.AUTH_ORIGIN || policy.port !== (dependencies.port ?? c.port)) throw new Error('OWNED_STARTUP_REJECTED');
        factory = await createOwnedRuntimeFactory(policy, server.controlled.operatorIO.sessions);
        server.controlled.installPreparation(await createOwnedPreparation(store, server.controlled.operatorIO.sessions, factory,
          { mode: 'regtest', ownerId: policy.ownerId, ownerUsername: 'truja503', origin: policy.origin, profileDigest: ownedArgs.hash }));
      } catch {
        await factory?.close?.();
        console.error('OWNED_PREPARATION_STOPPED: preserve runs; no automatic invoice or payment retry');
      }
    }
    await new Promise<void>((ready, reject) => { server.once('error', reject); server.listen(dependencies.port ?? c.port, '127.0.0.1', () => { server.off('error', reject); ready(); }); });
    // Failed readiness leaves the app usable with controlled execution closed; never retry.
    const runtime = operatorArgs ? (dependencies.operator ?? runOperatorCLI)(operatorArgs, server.controlled.operatorIO) : undefined;
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
