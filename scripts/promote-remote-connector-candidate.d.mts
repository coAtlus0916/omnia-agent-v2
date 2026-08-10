export const REMOTE_CONNECTOR_RELEASE: Readonly<{
  product: 'omnia-agent-v5-remote-connector';
  platform: 'win32-x64';
  channel: 'stable';
  version: '0.3.35';
  sequence: 38;
  supervisorVersion: '0.1.6';
  keyId: 'v5-remote-connector-release-2026-01';
}>;

export interface RemoteConnectorPromotionOptions {
  workspaceRoot?: string;
  publicKeyPem?: string;
  failAt?: string;
}

export interface RemoteConnectorPromotionResult {
  ok: true;
  version: '0.3.35';
  sequence: 38;
  supervisorVersion: '0.1.6';
  archiveSha256: string;
  archiveSize: number;
  release: string;
  publicArchive: string;
  stableManifest: string;
  journal: string;
  phase: string;
  resumed: boolean;
}

export function promoteRemoteConnectorCandidate(
  options?: RemoteConnectorPromotionOptions
): RemoteConnectorPromotionResult;
