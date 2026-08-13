import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { ConnectorNextAgentClient } from '../agent/client.js';
import type { ConnectorNextLogSpool } from '../agent/log-spool.js';
import type { ConnectorNextRuntimeGate } from '../agent/runtime-gate.js';
import type { ConnectorNextPaths } from '../paths.js';
import type { ConnectorNextDescriptor, ConnectorNextUpdateManifest } from '../protocol.js';
import type { ConnectorNextAgentState } from '../agent/state-store.js';
import type { ConnectorNextAgentProcessHost } from './process-host.js';
import {
  manifestDigest,
  parseAndVerifyPackage,
  readCurrentPointer,
  stagePackageImmutable,
  verifyCurrentSlot,
  verifyConnectorNextManifest,
  writeCurrentPointerAtomic,
  type CurrentPointer
} from './package.js';

export interface ConnectorNextGuardianOptions {
  version: string;
  client: ConnectorNextAgentClient;
  descriptor: ConnectorNextDescriptor;
  paths: ConnectorNextPaths;
  gate: ConnectorNextRuntimeGate;
  logs: ConnectorNextLogSpool;
  publisherKeys: Record<string, string>;
  drainTimeoutMs?: number;
  runtimeExecutableOverride?: string;
  probeCandidate?: (entrypoint: string, manifest: ConnectorNextUpdateManifest, mode: 'candidate' | 'probation') => Promise<void>;
  processHost: ConnectorNextAgentProcessHost;
  persistActivatedState: (state: Pick<ConnectorNextAgentState, 'version' | 'sequence' | 'generation'>) => void;
}

function versionAtLeast(current: string, minimum: string): boolean {
  const left = current.split('-')[0]!.split('.').map(Number);
  const right = minimum.split('-')[0]!.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if ((left[index] || 0) > (right[index] || 0)) return true;
    if ((left[index] || 0) < (right[index] || 0)) return false;
  }
  return true;
}

async function defaultProbe(runtimeExecutable: string, entrypoint: string, manifest: ConnectorNextUpdateManifest, mode: 'candidate' | 'probation', context: { offerId: string; generation: number; paths: ConnectorNextPaths; uncertainJobIds: string[] }): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    const child = spawn(runtimeExecutable, [entrypoint, mode === 'candidate' ? '--connector-next-candidate-health' : '--connector-next-probation-health'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        PATH: process.env.PATH || '',
        SystemRoot: process.env.SystemRoot || '',
        OMNIA_CONNECTOR_NEXT_VERSION: manifest.version,
        OMNIA_CONNECTOR_NEXT_SEQUENCE: String(manifest.sequence),
        OMNIA_CONNECTOR_NEXT_ADMISSION: 'health_only',
        OMNIA_CONNECTOR_NEXT_CANDIDATE_OFFER_ID: context.offerId,
        OMNIA_CONNECTOR_NEXT_CANDIDATE_GENERATION: String(context.generation),
        OMNIA_CONNECTOR_NEXT_CANDIDATE_UNCERTAIN_JOB_IDS: JSON.stringify(context.uncertainJobIds),
        OMNIA_CONNECTOR_NEXT_INSTALL_ROOT: context.paths.installRoot,
        OMNIA_CONNECTOR_NEXT_DATA_ROOT: context.paths.dataRoot
      }
    });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    const timer = setTimeout(() => { child.kill(); reject(new Error('CONNECTOR_NEXT.CANDIDATE_HEALTH_TIMEOUT')); }, 15_000);
    child.stdout?.on('data', (chunk) => output.push(Buffer.from(chunk)));
    child.stderr?.on('data', (chunk) => errors.push(Buffer.from(chunk)));
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      try {
        if (code !== 0) throw new Error(`CONNECTOR_NEXT.CANDIDATE_HEALTH_FAILED:${Buffer.concat(errors).toString('utf8').slice(0, 300)}`);
        const report = JSON.parse(Buffer.concat(output).toString('utf8').trim()) as Record<string, unknown>;
        if (report.healthy !== true || report.admission !== 'health_only' || report.productId !== manifest.productId || report.protocolId !== manifest.protocolId || report.version !== manifest.version || report.sequence !== manifest.sequence) {
          throw new Error('CONNECTOR_NEXT.CANDIDATE_HEALTH_IDENTITY_MISMATCH');
        }
        const resolved = report.resolvedUncertainJobIds === undefined ? [] : report.resolvedUncertainJobIds;
        if (!Array.isArray(resolved) || resolved.length > 128
          || resolved.some((jobId) => typeof jobId !== 'string' || !/^ocn3\.job\.[0-9a-f-]{36}$/u.test(jobId))) {
          throw new Error('CONNECTOR_NEXT.CANDIDATE_CLOSURE_INVALID');
        }
        resolve([...new Set(resolved as string[])]);
      } catch (error) { reject(error); }
    });
  });
}

export class ConnectorNextGuardian {
  constructor(private readonly options: ConnectorNextGuardianOptions) {}

  async checkOnce(): Promise<{ status: 'no_offer' | 'updated' | 'blocked' | 'failed'; offerId?: string; pointer?: CurrentPointer; reason?: string }> {
    let offerId = '';
    try {
      const current = readCurrentPointer(this.options.paths.currentPointer);
      const polled = await this.options.client.pollUpdate();
      if (!polled.offer) return { status: 'no_offer' };
      ({ offerId } = polled.offer);
      const { manifest } = polled.offer;
      const publicKey = this.options.publisherKeys[manifest.signingKeyId];
      if (!publicKey) throw new Error('CONNECTOR_NEXT.UPDATE_SIGNING_KEY_UNTRUSTED');
      verifyConnectorNextManifest(manifest, publicKey);
      if (!versionAtLeast(this.options.version, manifest.minimumUpdaterVersion)) throw new Error('CONNECTOR_NEXT.UPDATER_VERSION_TOO_OLD');
      const packageBytes = await this.options.client.downloadUpdate(offerId, manifest.artifactId);
      const packageValue = parseAndVerifyPackage(packageBytes, manifest);

      const recoveringActivation = manifest.sequence === current.sequence
        && manifest.version === current.version
        && ['activating', 'probation'].includes(polled.offer.status);
      if (recoveringActivation) {
        try {
          await this.options.processHost.start(current, offerId);
          if (polled.offer.status === 'activating') await this.options.client.updateStatus(offerId, 'probation', { generation: current.generation, recovered: true });
          await this.options.client.updateStatus(offerId, 'succeeded', { version: current.version, sequence: current.sequence, generation: current.generation, recovered: true });
          this.options.persistActivatedState({ version: current.version, sequence: current.sequence, generation: current.generation });
          this.options.descriptor.version = current.version;
          this.options.descriptor.sequence = current.sequence;
          this.options.descriptor.generation = current.generation;
          this.options.client.updateDescriptor(this.options.descriptor);
          this.options.gate.setAdmission(true);
          this.options.logs.append('updater', 'info', 'update.recovered_after_activation', { offerId, generation: current.generation });
          return { status: 'updated', offerId, pointer: current };
        } catch (error) {
          try { await this.options.processHost.stop(); } catch { /* continue rollback */ }
          const previous = readCurrentPointer(this.options.paths.previousPointer);
          writeCurrentPointerAtomic(this.options.paths.currentPointer, previous);
          try { await this.options.processHost.start(previous); } catch { /* reported in rollback evidence */ }
          await this.options.client.updateStatus(offerId, 'rolled_back', { recovered: true, reason: error instanceof Error ? error.message : String(error) });
          this.options.gate.setAdmission(true);
          return { status: 'failed', offerId, pointer: previous, reason: 'activation_recovery_failed' };
        }
      }
      if (manifest.sequence <= current.sequence) throw new Error('CONNECTOR_NEXT.UPDATE_SEQUENCE_NOT_NEWER');
      if (['offered', 'downloading'].includes(polled.offer.status)) await this.options.client.updateStatus(offerId, 'verified', { packageDigest: manifest.packageDigest });

      const targetSlot: 'a' | 'b' = current.slot === 'a' ? 'b' : 'a';
      const digest = manifestDigest(manifest);
      const candidateRoot = stagePackageImmutable(this.options.paths.slotsRoot, targetSlot, packageValue, digest);
      const entrypoint = path.join(candidateRoot, ...packageValue.entrypoint.split('/'));
      const runtimeExecutable = path.join(candidateRoot, ...packageValue.runtimeEntrypoint.split('/'));
      if (['offered', 'downloading', 'verified'].includes(polled.offer.status)) await this.options.client.updateStatus(offerId, 'staged', { slot: targetSlot, relativeRoot: path.relative(this.options.paths.slotsRoot, candidateRoot), manifestDigest: digest });
      const probe = this.options.probeCandidate
        ? (mode: 'candidate' | 'probation') => this.options.probeCandidate!(entrypoint, manifest, mode)
        : (mode: 'candidate' | 'probation') => defaultProbe(this.options.runtimeExecutableOverride || runtimeExecutable, entrypoint, manifest, mode, {
          offerId, generation: current.generation + 1, paths: this.options.paths,
          uncertainJobIds: this.options.gate.uncertainMutationJobIds()
        });
      const resolvedByCandidate = await probe('candidate') || [];
      for (const jobId of resolvedByCandidate) this.options.gate.resolveMutationAuthoritatively(jobId);
      this.options.logs.append('updater', 'info', 'update.candidate_healthy', { offerId, targetVersion: manifest.version, targetSequence: manifest.sequence });

      let snapshot = this.options.gate.snapshot();
      if (snapshot.uncertainMutation > 0) {
        this.options.gate.setAdmissionMode('read_only_only');
        snapshot = this.options.gate.snapshot();
        await this.options.client.updateStatus(offerId, 'waiting_safe_window', { ...snapshot });
        this.options.logs.append('audit', 'warn', 'update.safe_window_blocked', { offerId, ...snapshot });
        return { status: 'blocked', offerId, reason: 'mutation_uncertain' };
      }

      this.options.gate.setAdmission(false);
      const deadline = Date.now() + (this.options.drainTimeoutMs || 30_000);
      snapshot = this.options.gate.snapshot();
      while (snapshot.activeReadOnly > 0 && snapshot.activeMutation === 0 && snapshot.uncertainMutation === 0 && Date.now() < deadline) {
        await delay(100);
        snapshot = this.options.gate.snapshot();
      }
      if (snapshot.activeMutation > 0 || snapshot.uncertainMutation > 0 || snapshot.activeReadOnly > 0) {
        if (snapshot.uncertainMutation > 0) {
          this.options.gate.setAdmissionMode('read_only_only');
          snapshot = this.options.gate.snapshot();
        }
        await this.options.client.updateStatus(offerId, 'waiting_safe_window', { ...snapshot });
        this.options.logs.append('audit', 'warn', 'update.safe_window_blocked', { offerId, ...snapshot });
        return { status: 'blocked', offerId, reason: snapshot.uncertainMutation > 0 ? 'mutation_uncertain' : snapshot.activeMutation > 0 ? 'mutation_active' : 'read_only_drain_timeout' };
      }

      await this.options.client.updateStatus(offerId, 'activating', { from: current.version, to: manifest.version });
      await this.options.processHost.stop();
      writeCurrentPointerAtomic(this.options.paths.previousPointer, current);
      const next: CurrentPointer = {
        schemaVersion: 'omnia.connector-next-current/v1',
        slot: targetSlot,
        relativeRoot: path.relative(this.options.paths.slotsRoot, candidateRoot).replaceAll('\\', '/'),
        version: manifest.version,
        sequence: manifest.sequence,
        generation: current.generation + 1,
        manifestDigest: digest,
        updatedAt: new Date().toISOString()
      };
      writeCurrentPointerAtomic(this.options.paths.currentPointer, next);
      try {
        await this.options.processHost.start(next, offerId);
        await this.options.client.updateStatus(offerId, 'probation', { generation: next.generation, slot: next.slot, relativeRoot: next.relativeRoot, agentProcess: 'started_and_server_confirmed' });
      } catch (error) {
        try { await this.options.processHost.stop(); } catch { /* continue authoritative rollback */ }
        const rollback = { ...current, updatedAt: new Date().toISOString() };
        writeCurrentPointerAtomic(this.options.paths.currentPointer, rollback);
        try { await this.options.processHost.start(rollback); } catch { /* report rollback process failure below */ }
        await this.options.client.updateStatus(offerId, 'rolled_back', { reason: error instanceof Error ? error.message : String(error), rollbackGeneration: rollback.generation });
        this.options.gate.setAdmission(true);
        this.options.logs.append('updater', 'error', 'update.rolled_back', { offerId, targetVersion: manifest.version });
        return { status: 'failed', offerId, pointer: rollback, reason: 'probation_failed' };
      }
      await this.options.client.updateStatus(offerId, 'succeeded', { version: next.version, sequence: next.sequence, generation: next.generation });
      this.options.persistActivatedState({ version: next.version, sequence: next.sequence, generation: next.generation });
      this.options.descriptor.version = next.version;
      this.options.descriptor.sequence = next.sequence;
      this.options.descriptor.generation = next.generation;
      this.options.client.updateDescriptor(this.options.descriptor);
      this.options.gate.setAdmission(true);
      this.options.logs.append('updater', 'info', 'update.succeeded', { offerId, version: next.version, sequence: next.sequence, generation: next.generation });
      try { await this.options.logs.flush(this.options.client); } catch { /* durable retry under the new generation */ }
      return { status: 'updated', offerId, pointer: next };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (offerId) {
        try { await this.options.client.updateStatus(offerId, 'failed', { reason }); } catch { /* original failure remains authoritative */ }
        this.options.logs.append('updater', 'error', 'update.failed', { offerId, reason });
        return { status: 'failed', offerId, reason };
      }
      // A control-plane poll failure is not an Agent lifecycle failure. The
      // Updater loop will retain the healthy Agent and retry after its bounded
      // delay instead of unwinding through finally and stopping the runtime.
      this.options.logs.append('updater', 'error', 'update.poll_failed', { reason });
      return { status: 'failed', reason };
    }
  }
}

export function resolveCurrentEntrypoint(paths: ConnectorNextPaths): string {
  const pointer = readCurrentPointer(paths.currentPointer);
  const verified = verifyCurrentSlot(paths, pointer);
  return path.join(verified.root, ...verified.identity.entrypoint.split('/'));
}
