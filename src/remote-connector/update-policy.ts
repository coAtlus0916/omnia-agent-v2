import type { ManagedState } from './managed-state.js';
import { compareVersions, type UpdateManifest } from './release-contract.js';

export function workerLifecycleAllowsActivation(workerStarted: boolean, workerHasStarted: boolean): boolean {
  return workerStarted === false && workerHasStarted === false;
}

export function workerHeartbeatRecoveryDecision(input: {
  expectedPid: number;
  statusPid: number;
  heartbeatAt: string;
  workerStartedAt: number;
  staleSince: number;
  loopGapMs: number;
  now: number;
  startupGraceMs: number;
  heartbeatFreshMs: number;
  recoveryDelayMs: number;
}): { fresh: boolean; staleSince: number; recover: boolean } {
  const heartbeatTime = Date.parse(input.heartbeatAt);
  const heartbeatAge = input.now - heartbeatTime;
  const fresh = input.expectedPid > 0
    && input.statusPid === input.expectedPid
    && Number.isFinite(heartbeatTime)
    && heartbeatAge >= -input.heartbeatFreshMs
    && heartbeatAge < input.heartbeatFreshMs;
  if (fresh) return { fresh: true, staleSince: 0, recover: false };
  if (input.now - input.workerStartedAt < input.startupGraceMs) {
    return { fresh: false, staleSince: 0, recover: false };
  }
  const staleSince = input.staleSince || input.now;
  // A single long loop gap may start a new recovery window after suspend/resume,
  // but it must not erase an already observed stale interval. Otherwise any
  // repeatedly slow side task can postpone Worker recovery forever.
  if (input.loopGapMs > input.heartbeatFreshMs && input.staleSince === 0) {
    return { fresh: false, staleSince, recover: false };
  }
  return {
    fresh: false,
    staleSince,
    recover: input.now - staleSince >= input.recoveryDelayMs
  };
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
