import {
  type ConnectorNextDescriptor,
  type ConnectorNextJob,
  type ConnectorNextLogInput,
  type ConnectorNextUpdateManifest,
  type ConnectorNextUpdateStatus
} from '../protocol.js';

export interface ConnectorNextAgentClientOptions {
  serverUrl: string;
  descriptor: ConnectorNextDescriptor;
  token?: string;
  fetchImpl?: typeof fetch;
}

export class ConnectorNextAgentClient {
  private readonly base: URL;
  private readonly fetchImpl: typeof fetch;
  private token: string;

  constructor(private readonly options: ConnectorNextAgentClientOptions) {
    this.base = new URL(options.serverUrl.endsWith('/') ? options.serverUrl : `${options.serverUrl}/`);
    const localLoopback = ['127.0.0.1', '::1', 'localhost'].includes(this.base.hostname);
    if (this.base.protocol !== 'https:' && !localLoopback) throw new Error('CONNECTOR_NEXT.HTTPS_REQUIRED');
    this.fetchImpl = options.fetchImpl || fetch;
    this.token = options.token || '';
  }

  updateDescriptor(descriptor: ConnectorNextDescriptor): void {
    this.options.descriptor = descriptor;
  }

  setToken(token: string): void {
    this.token = token;
  }

  private async json<T>(route: string, value: Record<string, unknown>, authenticated = true): Promise<T> {
    const response = await this.fetchImpl(new URL(route.replace(/^\//, ''), this.base), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify(value)
    });
    const payload = await response.json() as T & { error?: { code?: string } };
    if (!response.ok) throw new Error(payload.error?.code || `CONNECTOR_NEXT.HTTP_${response.status}`);
    return payload;
  }

  async enroll(enrollmentCode: string): Promise<{ token: string; version: string; generation: number }> {
    const response = await this.json<{ token: string; version: string; generation: number }>('enrollments/consume', {
      enrollmentCode,
      descriptor: this.options.descriptor
    }, false);
    this.token = response.token;
    return response;
  }

  pollJob(): Promise<{ job: ConnectorNextJob | null }> {
    return this.json('agent/jobs/poll', { descriptor: this.options.descriptor });
  }

  pollJobs(maximum: number, waitMs = 1_000): Promise<{ jobs: ConnectorNextJob[] }> {
    const limit = Number.isInteger(maximum) ? Math.max(1, Math.min(8, maximum)) : 1;
    const boundedWait = Number.isFinite(waitMs) ? Math.max(0, Math.min(5_000, Math.trunc(waitMs))) : 1_000;
    return this.json('agent/jobs/poll-batch', {
      descriptor: this.options.descriptor,
      maximum: limit,
      waitMs: boundedWait
    });
  }

  completeJob(job: ConnectorNextJob, outcome: { ok: true; result: unknown } | { ok: false; error: unknown }): Promise<{ accepted: true }> {
    return this.json(`agent/jobs/${encodeURIComponent(job.jobId)}/result`, { descriptor: this.options.descriptor, claimId: job.claimId, ...outcome });
  }

  uploadLogs(records: ConnectorNextLogInput[]): Promise<{ ackedRecordIds: number[] }> {
    return this.json('agent/logs/batches', { descriptor: this.options.descriptor, records });
  }

  pollUpdate(): Promise<{ offer: { offerId: string; manifest: ConnectorNextUpdateManifest; status: ConnectorNextUpdateStatus } | null }> {
    return this.json('agent/updates/poll', { descriptor: this.options.descriptor });
  }

  confirmIdentity(): Promise<{ accepted: true; version: string; sequence: number; generation: number }> {
    return this.json('agent/identity', { descriptor: this.options.descriptor });
  }

  candidateHeartbeat(offerId: string, phase: 'candidate' | 'probation', uncertainJobIds: string[] = [], gateDiagnostics: Array<{
    source: string;
    pathHash: string;
    existed: boolean;
    uncertainJobIds: string[];
  }> = []): Promise<{ accepted: true; offerId: string; phase: string; generation: number; notStartedJobIds: string[]; resolvedUncertainJobIds?: string[] }> {
    return this.json(`agent/updates/${encodeURIComponent(offerId)}/candidate-heartbeat`, { descriptor: this.options.descriptor, phase, uncertainJobIds, gateDiagnostics });
  }

  async downloadUpdate(offerId: string, artifactId: string): Promise<Buffer> {
    const response = await this.fetchImpl(new URL(`agent/updates/artifacts/${encodeURIComponent(artifactId)}/download`, this.base), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ descriptor: this.options.descriptor, offerId })
    });
    if (!response.ok) {
      const payload = await response.json() as { error?: { code?: string } };
      throw new Error(payload.error?.code || `CONNECTOR_NEXT.HTTP_${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  updateStatus(offerId: string, status: ConnectorNextUpdateStatus, details: Record<string, unknown> = {}): Promise<{ accepted: true }> {
    return this.json(`agent/updates/${encodeURIComponent(offerId)}/status`, { descriptor: this.options.descriptor, status, details });
  }
}
