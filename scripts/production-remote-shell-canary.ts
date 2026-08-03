import {
  pairWaitingConnector,
  pairWithBridge,
  RemoteConnectorTransport
} from '../src/main/connector/remote-connector-transport.ts';

const bridgeUrl = String(process.env.CANARY_BRIDGE || '');
const pairingCode = String(process.env.CANARY_SHELL_CODE || '');
const connectorId = String(process.env.CANARY_CONNECTOR_ID || '');
if (!bridgeUrl || (!pairingCode && !connectorId)) {
  throw new Error('Production Shell canary requires Bridge URL and a waiting Connector identity.');
}

let paired: { pairId: string; token: string };
if (pairingCode) {
  paired = await pairWithBridge({ bridgeUrl, pairingCode, role: 'shell', name: 'v5 production acceptance' });
} else {
  const deadline = Date.now() + 20_000;
  while (true) {
    try {
      paired = await pairWaitingConnector({ bridgeUrl, connectorId });
      break;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}
const transport = new RemoteConnectorTransport(() => ({
  bridgeUrl,
  pairId: paired.pairId,
  token: paired.token
}));

try {
  await transport.start();
  let snapshot = await transport.load();
  const deadline = Date.now() + 20_000;
  while (!snapshot.adapterAvailable && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    snapshot = await transport.load();
  }
  const ok = (
    snapshot.transport === 'remote'
    && snapshot.adapter === 'v5_remote_connector'
    && snapshot.remoteAvailable
  );
  process.stdout.write(`${JSON.stringify({
    ok,
    transport: snapshot.transport,
    adapter: snapshot.adapter,
    adapterAvailable: snapshot.adapterAvailable,
    remoteAvailable: snapshot.remoteAvailable,
    connectorVersion: snapshot.connectorVersion,
    status: snapshot.status,
    connectedToOmnia: snapshot.connected
  })}\n`);
  if (!ok) process.exitCode = 1;
} finally {
  await transport.stop();
}
