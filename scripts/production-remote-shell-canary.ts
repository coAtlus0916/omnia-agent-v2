import {
  beginPairingSession,
  inspectBridgePairingCapability,
  pollPairingSession,
  RemoteConnectorTransport
} from '../src/main/connector/remote-connector-transport.ts';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const bridgeUrl = String(process.env.CANARY_BRIDGE || '');
if (!bridgeUrl) throw new Error('Production Shell canary requires CANARY_BRIDGE.');
if (!process.stderr.isTTY) {
  throw new Error('Production Shell canary is interactive: run it in a private TTY so the one-time link code is never captured by redirected logs.');
}

const bridgeCapability = await inspectBridgePairingCapability({ bridgeUrl });
if (!bridgeCapability.canCreateSession) {
  throw new Error(`${bridgeCapability.reasonCode}: ${bridgeCapability.reason}`);
}

const session = await beginPairingSession({ bridgeUrl });
const interactiveConsole = process.platform === 'win32' ? 'CONOUT$' : '/dev/tty';
const consoleHandle = fs.openSync(interactiveConsole, 'w');
try {
  fs.writeSync(consoleHandle, `仅在公司电脑 Remote Connector 输入这次性链接码（不要复制到日志）：${session.pairingCode}\n`);
} finally {
  fs.closeSync(consoleHandle);
}
const pairingSessionHash = createHash('sha256').update(session.sessionId).digest('hex');
let paired: { pairId: string; token: string; generation: number } | null = null;
const pairingDeadline = Date.now() + 10 * 60_000;
while (Date.now() < pairingDeadline) {
  const result = await pollPairingSession({
    bridgeUrl,
    sessionId: session.sessionId,
    pollSecret: session.pollSecret
  });
  if (result.state === 'matched' && result.pairId && result.token && result.generation) {
    paired = { pairId: result.pairId, token: result.token, generation: result.generation };
    break;
  }
  if (result.state === 'expired') throw new Error('Canary pairing code expired.');
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}
if (!paired) throw new Error('Production Connector did not complete pairing within ten minutes.');

const transport = new RemoteConnectorTransport(() => ({ bridgeUrl, ...paired! }));
try {
  await transport.start();
  let snapshot = await transport.connect();
  const deadline = Date.now() + 10 * 60_000;
  while (!snapshot.connected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    snapshot = await transport.load();
  }
  const ok = snapshot.transport === 'remote'
    && snapshot.adapter === 'v5_remote_connector'
    && snapshot.connectorOnline
    && snapshot.connected
    && Boolean(snapshot.engagementId && snapshot.engagementName);
  if (!ok || !snapshot.engagementId) throw new Error('Production Remote Connector did not reach a verified Pack identity.');
  const verifiedEngagementId = snapshot.engagementId;
  const refresh = await transport.refresh();
  if (!refresh.connected || refresh.engagementId !== verifiedEngagementId) {
    throw new Error('refresh changed or lost the verified Pack identity.');
  }
  const observation = await transport.lightRead(verifiedEngagementId);
  if (observation.engagementId !== verifiedEngagementId) {
    throw new Error('workspace_light_read returned a different Engagement identity.');
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    transport: snapshot.transport,
    adapter: snapshot.adapter,
    bridgeOnline: snapshot.bridgeOnline,
    connectorOnline: snapshot.connectorOnline,
    connectorVersion: snapshot.connectorVersion,
    status: snapshot.status,
    connectedToOmnia: snapshot.connected,
    engagementId: snapshot.engagementId,
    engagementName: snapshot.engagementName,
    refreshIdentityPreserved: true,
    workspaceLightReadIdentityPreserved: true,
    pairingSessionHash
  })}\n`);
} finally {
  await transport.stop();
}
