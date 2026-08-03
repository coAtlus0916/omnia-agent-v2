import type { ManagedState } from './managed-state.js';
import { compareVersions, type UpdateManifest } from './release-contract.js';

export function workerStatusAllowsActivation(
  status: Record<string, unknown> | null,
  product: string,
  now = Date.now()
): boolean {
  return Boolean(
    status
    && status.schemaVersion === 'omnia.v5.remote-connector-status/v1'
    && status.product === product
    && Number.isFinite(Date.parse(String(status.heartbeatAt || '')))
    && now - Date.parse(String(status.heartbeatAt)) < 5_000
    && Number(status.activeOperations || 0) === 0
    && Number(status.uncertainOperations || 0) === 0
  );
}

export function assertUpdateSequenceAdmitted(manifest: UpdateManifest, state: ManagedState): void {
  if (manifest.sequence <= state.highestSequence) {
    throw new Error('v5 Remote Connector update sequence is stale or a downgrade.');
  }
  const blocked = state.blocked[manifest.version];
  if (blocked && manifest.sequence <= blocked.sequence) {
    throw new Error('v5 Remote Connector release is blocked after a failed probation.');
  }
  if (compareVersions(manifest.version, state.current) <= 0) {
    throw new Error('v5 Remote Connector update version is not newer than the managed current version.');
  }
}
