import fs from 'node:fs';
import path from 'node:path';
import { CONNECTOR_NEXT_SERVER_PROCESS } from '../protocol.js';
import { ConnectorNextServerStore } from './store.js';
import { createConnectorNextServer } from './server.js';

async function main(): Promise<void> {
process.title = CONNECTOR_NEXT_SERVER_PROCESS;
const dataRoot = path.resolve(process.env.OMNIA_CONNECTOR_NEXT_SERVER_DATA_ROOT || path.join(process.cwd(), 'connector-next-server-data-v3'));
const controlToken = process.env.OMNIA_CONNECTOR_NEXT_CONTROL_TOKEN || '';
const publisherKeyId = process.env.OMNIA_CONNECTOR_NEXT_PUBLISHER_KEY_ID || '';
const publisherPublicKey = process.env.OMNIA_CONNECTOR_NEXT_PUBLISHER_PUBLIC_KEY || '';
const tlsKeyFile = process.env.OMNIA_CONNECTOR_NEXT_SERVER_TLS_KEY_FILE || '';
const tlsCertFile = process.env.OMNIA_CONNECTOR_NEXT_SERVER_TLS_CERT_FILE || '';
if (Boolean(tlsKeyFile) !== Boolean(tlsCertFile)) throw new Error('CONNECTOR_NEXT.SERVER_TLS_CONFIGURATION_INCOMPLETE');
const store = new ConnectorNextServerStore(path.join(dataRoot, 'connector-next-server-v3.sqlite'));
const runtime = createConnectorNextServer({
  store,
  controlToken,
  publisherKeys: publisherKeyId && publisherPublicKey ? { [publisherKeyId]: publisherPublicKey.replaceAll('\\n', '\n') } : {},
  host: process.env.OMNIA_CONNECTOR_NEXT_SERVER_HOST || '127.0.0.1',
  port: Number(process.env.OMNIA_CONNECTOR_NEXT_SERVER_PORT || 43173),
  ...(tlsKeyFile && tlsCertFile ? { tls: { key: fs.readFileSync(tlsKeyFile), cert: fs.readFileSync(tlsCertFile) } } : {})
});
const address = await runtime.listen();
process.stdout.write(`${JSON.stringify({ event: 'connector_next.server.listening', ...address })}\n`);

const stop = async () => {
  await runtime.close();
  store.close();
  process.exit(0);
};
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
