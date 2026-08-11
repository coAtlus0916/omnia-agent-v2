import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import {
  CONNECTOR_NEXT_HEALTH_OPERATION,
  type ConnectorNextOperationEnvelope,
  type ConnectorNextTarget,
  type ConnectorNextUpdateManifest,
} from '../../connector-next/protocol.js';
import type { ConnectorDeliveryAck, ConnectorDeliveryStatusRequest, ConnectorDeliveryStatusResult } from '../../shared/connector-delivery.js';

export interface ConnectorNextControlClientOptions {
  serverUrl: string;
  controlToken: string;
  fetchImpl?: typeof fetch;
}

export class ConnectorNextControlClient {
  private readonly fetchImpl: typeof fetch;
  private readonly base: URL;

  constructor(private readonly options: ConnectorNextControlClientOptions) {
    if (!options.controlToken) throw new Error('CONNECTOR_NEXT.CONTROL_TOKEN_REQUIRED');
    this.fetchImpl = options.fetchImpl || fetch;
    this.base = new URL(options.serverUrl.endsWith('/') ? options.serverUrl : `${options.serverUrl}/`);
    const localLoopback = ['127.0.0.1', '::1', 'localhost'].includes(this.base.hostname);
    if (this.base.protocol !== 'https:' && !localLoopback) throw new Error('CONNECTOR_NEXT.HTTPS_REQUIRED');
  }

  private async request<T>(route: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(new URL(route.replace(/^\//, ''), this.base), {
      ...init,
      headers: { authorization: `Bearer ${this.options.controlToken}`, 'content-type': 'application/json', ...(init.headers || {}) }
    });
    const payload = await response.json() as T & { error?: { code?: string } };
    if (!response.ok) throw new Error(payload.error?.code || `CONNECTOR_NEXT.HTTP_${response.status}`);
    return payload;
  }

  /** Shell/Core entrypoint: generates and persists a one-time enrollment for an exact three-part identity. */
  createEnrollment(target: ConnectorNextTarget): Promise<{ sessionId: string; enrollmentCode: string; target: ConnectorNextTarget; expiresAt: string }> {
    return this.request('enrollments', { method: 'POST', body: JSON.stringify({ target, ttlSeconds: 600 }) });
  }

  getEnrollment(sessionId: string): Promise<Record<string, unknown>> {
    return this.request(`enrollments/${encodeURIComponent(sessionId)}`);
  }

  getConnectorIdentity(target: ConnectorNextTarget): Promise<Record<string, unknown>> {
    const query = new URLSearchParams({
      agentId: target.agentId,
      deviceId: target.deviceId,
      connectorInstanceId: target.connectorInstanceId
    });
    return this.request(`connectors/identity?${query.toString()}`);
  }

  enqueueSystemHealthRead(target: ConnectorNextTarget, payload: Record<string, unknown> = {}): Promise<{ jobId: string }> {
    return this.request('jobs', { method: 'POST', body: JSON.stringify({ target, operation: CONNECTOR_NEXT_HEALTH_OPERATION, payload, deadlineSeconds: 60 }) });
  }

  enqueueOperation(envelope: ConnectorNextOperationEnvelope, deadlineSeconds = 120): Promise<{ jobId: string }> {
    return this.request('operations', { method: 'POST', body: JSON.stringify({ envelope, deadlineSeconds }) });
  }

  async waitForJob(jobId: string, timeoutMs = 120_000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    let retryDelayMs = 100;
    while (Date.now() < deadline) {
      try {
        const remaining = deadline - Date.now();
        // The control plane can run more than one server process.  Its in-memory
        // completion event is only a same-process latency hint, so a 20-second
        // long poll added a full 20-second step whenever enqueue/wait and Agent
        // completion landed on different processes.  Keep SQLite as the durable
        // authority and keep cross-process observation latency bounded.  This
        // is a latency poll only; the durable job state remains authoritative.
        const job = await this.getJob(jobId, Math.min(100, Math.max(1, remaining)));
        if (job.status === 'succeeded' || job.status === 'failed') return job;
        retryDelayMs = 100;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const retryable = error instanceof TypeError || /CONNECTOR_NEXT\.HTTP_(?:502|503|504)/u.test(message);
        if (!retryable) throw error;
        if (Date.now() + retryDelayMs >= deadline) break;
        await delay(retryDelayMs);
        retryDelayMs = Math.min(1_000, retryDelayMs * 2);
      }
    }
    throw new Error('CONNECTOR_NEXT.OPERATION_TIMEOUT');
  }

  getJob(jobId: string, waitMs = 0): Promise<Record<string, unknown>> {
    const boundedWait = Number.isFinite(waitMs) ? Math.max(0, Math.min(25_000, Math.trunc(waitMs))) : 0;
    const suffix = boundedWait > 0 ? `?waitMs=${boundedWait}` : '';
    return this.request(`jobs/${encodeURIComponent(jobId)}${suffix}`);
  }

  deliveryStatus(input: ConnectorDeliveryStatusRequest): Promise<ConnectorDeliveryStatusResult> {
    return this.request('deliveries/status', { method: 'POST', body: JSON.stringify(input) });
  }

  acknowledgeDelivery(input: ConnectorDeliveryAck): Promise<{ acknowledged: true; clearedMutationCount: number }> {
    return this.request('deliveries/ack', { method: 'POST', body: JSON.stringify(input) });
  }

  queryLogs(target: ConnectorNextTarget, filters: { version?: string; generation?: number; after?: number; limit?: number } = {}): Promise<{ records: Record<string, unknown>[] }> {
    const query = new URLSearchParams({ agentId: target.agentId, deviceId: target.deviceId, connectorInstanceId: target.connectorInstanceId });
    if (filters.version) query.set('version', filters.version);
    if (filters.generation !== undefined) query.set('generation', String(filters.generation));
    if (filters.after !== undefined) query.set('after', String(filters.after));
    if (filters.limit !== undefined) query.set('limit', String(filters.limit));
    return this.request(`logs?${query.toString()}`);
  }

  registerUpdateArtifact(manifest: ConnectorNextUpdateManifest, packageBytes: Buffer): Promise<{ artifactId: string }> {
    const encodedManifest = Buffer.from(JSON.stringify(manifest)).toString('base64url');
    if (encodedManifest.length > 8_192) throw new Error('CONNECTOR_NEXT.UPDATE_MANIFEST_TOO_LARGE');
    const target = new URL('updates/artifacts', this.base);
    const request = target.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      const outbound = request(target, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.controlToken}`,
          'content-type': 'application/octet-stream',
          'content-length': String(packageBytes.length),
          'x-connector-next-manifest': encodedManifest
        }
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.once('error', reject);
        response.once('end', () => {
          try {
            const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { artifactId?: string; error?: { code?: string } };
            if ((response.statusCode || 500) >= 300 || !payload.artifactId) throw new Error(payload.error?.code || `CONNECTOR_NEXT.HTTP_${response.statusCode || 500}`);
            resolve({ artifactId: payload.artifactId });
          } catch (error) { reject(error); }
        });
      });
      outbound.setTimeout(120_000, () => outbound.destroy(new Error('CONNECTOR_NEXT.UPDATE_UPLOAD_TIMEOUT')));
      outbound.once('error', reject);
      outbound.end(packageBytes);
    });
  }

  offerUpdate(target: ConnectorNextTarget, artifactId: string): Promise<{ offerId: string; manifest: ConnectorNextUpdateManifest; status: string }> {
    return this.request('updates/offers', { method: 'POST', body: JSON.stringify({ target, artifactId }) });
  }

  getUpdateOffer(offerId: string): Promise<Record<string, unknown>> {
    return this.request(`updates/offers/${encodeURIComponent(offerId)}`);
  }
}
