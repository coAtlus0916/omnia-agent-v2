import { createBridgeServer, type BridgeServerOptions } from './server.js';

const options: BridgeServerOptions = {
  host: process.env.OMNIA_V5_BRIDGE_HOST || '127.0.0.1',
  port: Number(process.env.OMNIA_V5_BRIDGE_PORT || 18785),
  pairingCode: '',
  tokenSecret: String(process.env.OMNIA_V5_BRIDGE_TOKEN_SECRET || ''),
  adminToken: String(process.env.OMNIA_V5_BRIDGE_ADMIN_TOKEN || '')
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
