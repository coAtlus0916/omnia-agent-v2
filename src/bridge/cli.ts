import { createBridgeServer, type BridgeServerOptions } from './server.js';
import path from 'node:path';

const options: BridgeServerOptions = {
  host: process.env.OMNIA_V5_BRIDGE_HOST || '127.0.0.1',
  port: Number(process.env.OMNIA_V5_BRIDGE_PORT || 18785),
  tokenSecret: String(process.env.OMNIA_V5_BRIDGE_TOKEN_SECRET || ''),
  statePath: process.env.OMNIA_V5_BRIDGE_STATE_PATH || (process.platform === 'win32'
    ? path.join(process.cwd(), 'data', 'bindings.json')
    : '/var/lib/omnia-agent-v5-bridge/bindings.json'),
  buildIdentity: process.env.OMNIA_V5_BRIDGE_BUILD_ID || 'bridge-0.4.4'
};

async function main(): Promise<void> {
  const bridge = createBridgeServer(options);
  const address = await bridge.listen();
  process.stdout.write(`Omnia Agent v5 Bridge listening on ${address.host}:${address.port}\n`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void bridge.close().finally(() => process.exit(0));
    });
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Bridge startup failed.'}\n`);
  process.exitCode = 1;
});
