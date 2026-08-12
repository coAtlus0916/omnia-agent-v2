import type { ConnectorNextDescriptor } from '../protocol.js';
import { randomUUID } from 'node:crypto';
import { redactConnectorNextDetails } from '../redaction.js';
import { ConnectorNextAgentClient } from './client.js';
import { executeConnectorNextReadOnlyJob } from './executor.js';
import { ConnectorNextLogSpool } from './log-spool.js';
import { ConnectorNextRuntimeGate } from './runtime-gate.js';
import type { ConnectorNextPackOperationExecutor } from './pack-operation-host.js';
import { assertConnectorDeliveryContext, canonicalConnectorResponse, connectorResultDigest } from '../../shared/connector-delivery.js';

export interface ConnectorNextAgentRuntimeOptions {
  client: ConnectorNextAgentClient;
  descriptor: ConnectorNextDescriptor;
  logs: ConnectorNextLogSpool;
  gate: ConnectorNextRuntimeGate;
  packOperations?: ConnectorNextPackOperationExecutor;
  executionGeneration?: string;
}

const PRE_EFFECT_MUTATION_ERRORS = new Set([
  'CONNECTOR_NEXT.SHELL_RESTART_CONFIRMATION_INVALID',
  'CONNECTOR_NEXT.SHELL_PROCESS_NOT_FOUND',
  'CONNECTOR_NEXT.SHELL_PROCESS_AMBIGUOUS'
]);

function mutationFailureEffectState(error: unknown): 'not_started' | 'unknown' {
  if (error && typeof error === 'object'
    && (error as { effectState?: unknown }).effectState === 'not_started') return 'not_started';
  const code = error instanceof Error ? (error.message.split(':', 1)[0] || '') : '';
  return PRE_EFFECT_MUTATION_ERRORS.has(code) ? 'not_started' : 'unknown';
}

function durableFailureResult(
  job: NonNullable<Awaited<ReturnType<ConnectorNextAgentClient['pollJob']>>['job']>,
  descriptor: ConnectorNextDescriptor,
  executionGeneration: string,
  error: unknown,
  effectState: 'not_started' | 'unknown'
): Record<string, unknown> | null {
  if (job.operation !== 'connector.next.operation.execute/v1') return null;
  const envelope = job.payload as Record<string, unknown>;
  if (envelope.command !== 'operation.invoke') return null;
  const invocation = envelope.input as Record<string, unknown> | undefined;
  if (!invocation?.deliveryContext) return null;
  assertConnectorDeliveryContext(invocation.deliveryContext);
  if (!/^[a-f0-9]{48}$/u.test(executionGeneration)) throw new Error('CONNECTOR_NEXT.EXECUTION_GENERATION_INVALID');
  const message = error instanceof Error ? error.message : String(error);
  const code = effectState === 'not_started'
    ? 'CONNECTOR_NEXT.MUTATION_NOT_STARTED'
    : 'CONNECTOR_NEXT.OPERATION_JOB_FAILED';
  const wireError = { code, message, retryable: false };
  const wireResponse = {
    schemaVersion: 'omnia.connector-ipc/v1',
    id: invocation.deliveryContext.requestId,
    ok: false,
    error: wireError
  };
  return {
    schemaVersion: 'omnia.connector-next-operation-result/v1',
    requestId: envelope.requestId,
    command: envelope.command,
    target: envelope.target,
    descriptor: {
      productId: descriptor.productId,
      protocolId: descriptor.protocolId,
      version: descriptor.version,
      sequence: descriptor.sequence,
      generation: descriptor.generation,
      executionPrincipal: descriptor.executionPrincipal
    },
    completedAt: new Date().toISOString(),
    value: {
      schemaVersion: 'omnia.connector-next-durable-delivery/v1',
      ok: false,
      error: wireError,
      wireResponse: JSON.parse(canonicalConnectorResponse(wireResponse)),
      witness: {
        schemaVersion: 'omnia.connector-delivery-witness/v1',
        requestId: invocation.deliveryContext.requestId,
        resultDigest: connectorResultDigest(wireResponse),
        sessionGeneration: invocation.deliveryContext.sessionGeneration,
        executionGeneration
      }
    }
  };
}

export class ConnectorNextAgentRuntime {
  constructor(private readonly options: ConnectorNextAgentRuntimeOptions) {}

  private async executeWithDeadline(
    job: NonNullable<Awaited<ReturnType<ConnectorNextAgentClient['pollJob']>>['job']>,
    effective: 'read_only' | 'mutation'
  ): Promise<unknown> {
    const execution = executeConnectorNextReadOnlyJob(
      job,
      this.options.descriptor,
      this.options.packOperations,
      this.options.executionGeneration || ''
    );
    // A mutation must retain the existing end-to-end uncertainty semantics;
    // racing it would let work continue after Core had observed a timeout.
    if (effective === 'mutation') return execution;
    const deadlineAt = Date.parse(job.deadlineAt);
    const remainingMs = Number.isFinite(deadlineAt) ? Math.max(1, deadlineAt - Date.now()) : 1;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        execution,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('CONNECTOR_NEXT.READ_ONLY_JOB_DEADLINE_EXCEEDED')), remainingMs);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async executeJob(job: Awaited<ReturnType<ConnectorNextAgentClient['pollJob']>>['job']): Promise<string | undefined> {
    if (!job) return undefined;
    const effective = job.operation === 'connector.next.operation.execute/v1'
      && (job.payload as Record<string, unknown>).effect === 'mutation' ? 'mutation' : 'read_only';
    let jobLeaseId = '';
    try {
      jobLeaseId = this.options.gate.begin(job.jobId, effective);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'CONNECTOR_NEXT.ADMISSION_CLOSED') throw error;
      await this.options.client.completeJob(job, {
        ok: false,
        error: { code: 'CONNECTOR_NEXT.ADMISSION_CLOSED', details: { message: error.message }, effectState: 'not_started' }
      });
      return job.jobId;
    }
    this.options.logs.append('task', 'info', 'job.started', { jobId: job.jobId, operation: job.operation, version: this.options.descriptor.version, generation: this.options.descriptor.generation });
    try {
      const result = await this.executeWithDeadline(job, effective);
      await this.options.client.completeJob(job, { ok: true, result });
      this.options.gate.complete(jobLeaseId);
      this.options.logs.append('task', 'info', 'job.succeeded', { jobId: job.jobId, operation: job.operation });
    } catch (error) {
      const effectState = effective === 'mutation' ? mutationFailureEffectState(error) : 'not_started';
      if (effective === 'mutation' && effectState === 'unknown') this.options.gate.markUncertain(jobLeaseId);
      else this.options.gate.complete(jobLeaseId);
      const safe = redactConnectorNextDetails({ message: error instanceof Error ? error.message : String(error) });
      const durableFailure = durableFailureResult(
        job,
        this.options.descriptor,
        this.options.executionGeneration || '',
        error,
        effectState
      );
      if (durableFailure) await this.options.client.completeJob(job, { ok: true, result: durableFailure });
      else await this.options.client.completeJob(job, { ok: false, error: { code: 'CONNECTOR_NEXT.OPERATION_JOB_FAILED', details: safe, effectState } });
      this.options.logs.append('task', 'error', 'job.failed', { jobId: job.jobId, ...safe });
    }
    return job.jobId;
  }

  async runBatch(maxConcurrency = 8): Promise<{ executedJobIds: string[]; flushedLogs: number }> {
    const concurrency = Number.isInteger(maxConcurrency) ? Math.max(1, Math.min(8, maxConcurrency)) : 8;
    let flushedLogs = 0;
    try { flushedLogs = await this.options.logs.flush(this.options.client); } catch { /* durable rows remain for retry */ }
    let jobs: Awaited<ReturnType<ConnectorNextAgentClient['pollJobs']>>['jobs'] = [];
    try {
      const pollLeaseId = this.options.gate.begin(`ocn3.poll.${randomUUID()}`, 'read_only');
      // Completion events are process-local while the durable queue is shared
      // by all control-plane instances. Bound cross-process pickup latency to
      // 100ms so normal work is not paced by a one-second idle long poll.
      try { jobs = (await this.options.client.pollJobs(concurrency, 100)).jobs; }
      finally { this.options.gate.complete(pollLeaseId); }
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'CONNECTOR_NEXT.ADMISSION_CLOSED') throw error;
    }
    const executed = await Promise.all(jobs.map((job) => this.executeJob(job)));
    try { flushedLogs += await this.options.logs.flush(this.options.client); } catch { /* retry next loop */ }
    return { executedJobIds: executed.filter((jobId): jobId is string => Boolean(jobId)), flushedLogs };
  }

  async runOnce(): Promise<{ executedJobId?: string; flushedLogs: number }> {
    const result = await this.runBatch(1);
    return { ...(result.executedJobIds[0] ? { executedJobId: result.executedJobIds[0] } : {}), flushedLogs: result.flushedLogs };
  }
}
