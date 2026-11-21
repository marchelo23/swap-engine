import { createOperatorApi as createApi } from './operatorServer.js';
import type { OwnedReverseApi } from './ownedReverse.js';
import type { Store } from '../persistence/Store.js';
import { SwapManager } from '../core/SwapManager.js';

/** Explicit operator gateway lifecycle. Never mounted by default application startup. */
export async function serveOwnedReverse(store: Store, owned: OwnedReverseApi, port: number,
  stopClient: () => void): Promise<{ status: string }> {
  const server = createApi(new SwapManager(store), async () => { throw new Error('Global balances unavailable'); }, undefined, undefined, undefined, owned);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  try {
    await new Promise<void>(resolve => {
      let closing = false;
      const close = () => {
        if (closing) return; closing = true; stopClient();
        server.close(() => { void owned.drain().then(() => resolve()); });
      };
      process.once('SIGINT', close); process.once('SIGTERM', close);
      server.once('close', () => { process.off('SIGINT', close); process.off('SIGTERM', close); });
      process.stdout.write(JSON.stringify({ event: 'owned_regtest_api_listening', host: '127.0.0.1', port,
        liveSwapsEnabled: false, controlledExecution: 'explicit-owner-approval' }) + '\n');
    });
    return { status: 'OWNED_REGTEST_API_STOPPED' };
  } finally { stopClient(); await owned.drain(); }
}
