import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { timingSafeEqual } from 'node:crypto';
import {
  CONNECTOR_NEXT_PRODUCT_ID,
  CONNECTOR_NEXT_OPERATION_EXECUTE,
  CONNECTOR_NEXT_PROTOCOL_ID,
  CONNECTOR_NEXT_SERVER_PROCESS,
  CONNECTOR_NEXT_SERVER_SCHEMA,
  type ConnectorNextDescriptor,
  type ConnectorNextTarget,
  type ConnectorNextUpdateManifest,
  assertTarget,
  assertOperationEnvelope,
  sha256
} from '../protocol.js';
import { verifyConnectorNextManifest } from '../updater/package.js';
import { ConnectorNextServerStore } from './store.js';

export interface ConnectorNextServerOptions {
  store: ConnectorNextServerStore;
  controlToken: string;
  publisherKeys: Record<string, string>;
  host?: string;
  port?: number;
  tls?: { key: string | Buffer; cert: string | Buffer };
}

const BASE = '/connector-next/v3';

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const bytes = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(bytes.length), 'cache-control': 'no-store' });
  res.end(bytes);
}

function bearer(req: IncomingMessage): string {
  const value = req.headers.authorization;
  if (!value?.startsWith('Bearer ')) throw new Error('CONNECTOR_NEXT.AUTHENTICATION_FAILED');
  return value.slice(7);
}

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function body(req: IncomingMessage, maximum = 2 * 1024 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > maximum) throw new Error('CONNECTOR_NEXT.REQUEST_TOO_LARGE');
    chunks.push(bytes);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CONNECTOR_NEXT.INVALID_REQUEST');
  return value as Record<string, unknown>;
}

async function binaryBody(req: IncomingMessage, maximum: number): Promise<Buffer> {
  const contentLength = Number(req.headers['content-length'] || 0);
  if (!Number.isInteger(contentLength) || contentLength < 1 || contentLength > maximum) throw new Error('CONNECTOR_NEXT.REQUEST_TOO_LARGE');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > maximum) throw new Error('CONNECTOR_NEXT.REQUEST_TOO_LARGE');
    chunks.push(bytes);
  }
  if (size !== contentLength) throw new Error('CONNECTOR_NEXT.REQUEST_SIZE_MISMATCH');
  return Buffer.concat(chunks, size);
}

function descriptorFrom(value: unknown): ConnectorNextDescriptor {
  if (!value || typeof value !== 'object') throw new Error('CONNECTOR_NEXT.INVALID_DESCRIPTOR');
  return value as ConnectorNextDescriptor;
}

function errorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('AUTHENTICATION') || message.includes('FENCE')) return 401;
  if (message.includes('NOT_FOUND')) return 404;
  if (message.includes('CONFLICT') || message.includes('MISMATCH') || message.includes('IMMUTABILITY') || message.includes('TRANSITION')) return 409;
  return 400;
}

export function createConnectorNextServer(options: ConnectorNextServerOptions) {
  if (options.controlToken.length < 24) throw new Error('CONNECTOR_NEXT.CONTROL_TOKEN_TOO_SHORT');
  const host = options.host || '127.0.0.1';
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(host);
  if (!loopback && !options.tls) throw new Error('CONNECTOR_NEXT.SERVER_TLS_REQUIRED');
  const startedAt = new Date().toISOString();
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url || '/', 'http://connector-next.invalid');
      if (req.method === 'GET' && url.pathname === `${BASE}/health`) {
        sendJson(res, 200, { schemaVersion: CONNECTOR_NEXT_SERVER_SCHEMA, productId: CONNECTOR_NEXT_PRODUCT_ID, protocolId: CONNECTOR_NEXT_PROTOCOL_ID, processName: CONNECTOR_NEXT_SERVER_PROCESS, startedAt });
        return;
      }

      const control = () => {
        if (!equalSecret(bearer(req), options.controlToken)) throw new Error('CONNECTOR_NEXT.AUTHENTICATION_FAILED');
      };
      const authenticate = (payload: Record<string, unknown>, expectedProcess: ConnectorNextDescriptor['executionPrincipal']['processName'] = 'OmniaConnectorNextAgent'): ConnectorNextDescriptor => {
        const descriptor = descriptorFrom(payload.descriptor);
        options.store.authenticate(bearer(req), descriptor, expectedProcess);
        return descriptor;
      };

      if (req.method === 'POST' && url.pathname === `${BASE}/enrollments`) {
        control();
        const payload = await body(req);
        assertTarget(payload.target);
        sendJson(res, 201, options.store.createEnrollment(payload.target, Number(payload.ttlSeconds || 600)));
        return;
      }
      const enrollmentMatch = url.pathname.match(/^\/connector-next\/v3\/enrollments\/([^/]+)$/);
      if (req.method === 'GET' && enrollmentMatch?.[1]) {
        control();
        sendJson(res, 200, options.store.enrollmentStatus(decodeURIComponent(enrollmentMatch[1])));
        return;
      }
      if (req.method === 'POST' && url.pathname === `${BASE}/enrollments/consume`) {
        const payload = await body(req);
        sendJson(res, 200, options.store.consumeEnrollment(String(payload.enrollmentCode || ''), descriptorFrom(payload.descriptor)));
        return;
      }
      if (req.method === 'GET' && url.pathname === `${BASE}/connectors/identity`) {
        control();
        const target: ConnectorNextTarget = {
          agentId: url.searchParams.get('agentId') || '',
          deviceId: url.searchParams.get('deviceId') || '',
          connectorInstanceId: url.searchParams.get('connectorInstanceId') || ''
        };
        sendJson(res, 200, options.store.connectorIdentity(target));
        return;
      }
      if (req.method === 'POST' && url.pathname === `${BASE}/jobs`) {
        control();
        const payload = await body(req);
        assertTarget(payload.target);
        if (!payload.payload || typeof payload.payload !== 'object' || Array.isArray(payload.payload)) throw new Error('CONNECTOR_NEXT.INVALID_JOB_PAYLOAD');
        sendJson(res, 201, options.store.enqueueReadOnlyJob(payload.target, String(payload.operation), payload.payload as Record<string, unknown>, Number(payload.deadlineSeconds || 60)));
        return;
      }
      if (req.method === 'POST' && url.pathname === `${BASE}/operations`) {
        control();
        const payload = await body(req);
        assertOperationEnvelope(payload.envelope);
        sendJson(res, 201, options.store.enqueueReadOnlyJob(
          payload.envelope.target,
          CONNECTOR_NEXT_OPERATION_EXECUTE,
          payload.envelope as unknown as Record<string, unknown>,
          Number(payload.deadlineSeconds || 120)
        ));
        return;
      }
      if (req.method === 'POST' && url.pathname === `${BASE}/deliveries/status`) {
        control();
        sendJson(res, 200, options.store.deliveryStatus(await body(req) as never));
        return;
      }
      if (req.method === 'POST' && url.pathname === `${BASE}/deliveries/ack`) {
        control();
        sendJson(res, 200, options.store.acknowledgeDelivery(await body(req) as never));
        return;
      }
      if (req.method === 'POST' && url.pathname === `${BASE}/deliveries/authoritative-closure`) {
        control();
        sendJson(res, 200, options.store.recordAuthoritativeClosure(await body(req)));
        return;
      }
      const jobMatch = url.pathname.match(/^\/connector-next\/v3\/jobs\/([^/]+)$/);
      if (req.method === 'GET' && jobMatch?.[1]) {
        control();
        const waitMs = Number(url.searchParams.get('waitMs') || 0);
        sendJson(res, 200, await options.store.waitForJob(
          decodeURIComponent(jobMatch[1]),
          Number.isFinite(waitMs) ? waitMs : 0
        ));
        return;
      }
      if (req.method === 'POST' && url.pathname === `${BASE}/agent/jobs/poll-batch`) {
        const payload = await body(req);
        const descriptor = authenticate(payload, 'OmniaConnectorNextAgent');
        sendJson(res, 200, { jobs: await options.store.waitAndClaimJobs(
          descriptor,
          Number(payload.maximum || 1),
          Number(payload.waitMs || 0)
        ) });
        return;
      }
      if (req.method === 'POST' && url.pathname === `${BASE}/agent/jobs/poll`) {
        const payload = await body(req);
        const descriptor = authenticate(payload, 'OmniaConnectorNextAgent');
        sendJson(res, 200, { job: options.store.claimJob(descriptor) });
        return;
      }
      if (req.method === 'POST' && url.pathname === `${BASE}/agent/identity`) {
        const payload = await body(req);
        const processName = descriptorFrom(payload.descriptor).executionPrincipal?.processName;
        if (!['OmniaConnectorNextAgent', 'OmniaConnectorNextUpdater', 'OmniaConnectorNextBootstrap', 'OmniaConnectorNextInstaller'].includes(processName)) {
          throw new Error('CONNECTOR_NEXT.EXECUTION_PRINCIPAL_FENCE_REJECTED');
        }
        const descriptor = authenticate(payload, processName);
        const recoveredReadOnlyJobs = processName === 'OmniaConnectorNextAgent'
          ? options.store.recoverInterruptedReadOnlyJobs(descriptor)
          : 0;
        sendJson(res, 200, {
          accepted: true,
          version: descriptor.version,
          sequence: descriptor.sequence,
          generation: descriptor.generation,
          recoveredReadOnlyJobs
        });
        return;
      }
      const resultMatch = url.pathname.match(/^\/connector-next\/v3\/agent\/jobs\/([^/]+)\/result$/);
      if (req.method === 'POST' && resultMatch?.[1]) {
        const payload = await body(req);
        const descriptor = authenticate(payload, 'OmniaConnectorNextAgent');
        const outcome = payload.ok === true ? { ok: true as const, result: payload.result } : { ok: false as const, error: payload.error };
        options.store.completeJob(descriptor, decodeURIComponent(resultMatch[1]), String(payload.claimId || ''), outcome);
        sendJson(res, 200, { accepted: true });
        return;
      }
      if (req.method === 'POST' && url.pathname === `${BASE}/agent/logs/batches`) {
        const payload = await body(req);
        const processName = descriptorFrom(payload.descriptor).executionPrincipal?.processName;
        if (!['OmniaConnectorNextAgent', 'OmniaConnectorNextUpdater', 'OmniaConnectorNextBootstrap', 'OmniaConnectorNextInstaller'].includes(processName)) {
          throw new Error('CONNECTOR_NEXT.EXECUTION_PRINCIPAL_FENCE_REJECTED');
        }
        const descriptor = authenticate(payload, processName);
        if (!Array.isArray(payload.records)) throw new Error('CONNECTOR_NEXT.INVALID_LOG_BATCH');
        sendJson(res, 200, { ackedRecordIds: options.store.ingestLogs(descriptor, payload.records as never[]) });
        return;
      }
      if (req.method === 'GET' && url.pathname === `${BASE}/logs`) {
        control();
        const target: ConnectorNextTarget = {
          agentId: url.searchParams.get('agentId') || '',
          deviceId: url.searchParams.get('deviceId') || '',
          connectorInstanceId: url.searchParams.get('connectorInstanceId') || ''
        };
        sendJson(res, 200, { records: options.store.queryLogs(target, {
          ...(url.searchParams.get('version') ? { version: url.searchParams.get('version')! } : {}),
          ...(url.searchParams.has('generation') ? { generation: Number(url.searchParams.get('generation')) } : {}),
          ...(url.searchParams.has('after') ? { after: Number(url.searchParams.get('after')) } : {}),
          ...(url.searchParams.has('limit') ? { limit: Number(url.searchParams.get('limit')) } : {}),
          ...(url.searchParams.get('since') ? { since: url.searchParams.get('since')! } : {}),
          ...(url.searchParams.get('until') ? { until: url.searchParams.get('until')! } : {})
        }) });
        return;
      }
      if (req.method === 'POST' && url.pathname === `${BASE}/updates/artifacts`) {
        control();
        const encodedManifest = req.headers['x-connector-next-manifest'];
        if (typeof encodedManifest !== 'string' || encodedManifest.length > 8_192) throw new Error('CONNECTOR_NEXT.UPDATE_MANIFEST_HEADER_INVALID');
        const manifest = JSON.parse(Buffer.from(encodedManifest, 'base64url').toString('utf8')) as ConnectorNextUpdateManifest;
        const publicKey = options.publisherKeys[manifest?.signingKeyId];
        if (!publicKey) throw new Error('CONNECTOR_NEXT.UPDATE_SIGNING_KEY_UNTRUSTED');
        verifyConnectorNextManifest(manifest, publicKey);
        const packageBytes = await binaryBody(req, 128 * 1024 * 1024);
        if (packageBytes.length !== manifest.packageSize || sha256(packageBytes) !== manifest.packageDigest) throw new Error('CONNECTOR_NEXT.UPDATE_PACKAGE_DIGEST_MISMATCH');
        options.store.registerArtifact(manifest, packageBytes);
        sendJson(res, 201, { artifactId: manifest.artifactId });
        return;
      }
      if (req.method === 'POST' && url.pathname === `${BASE}/updates/offers`) {
        control();
        const payload = await body(req);
        assertTarget(payload.target);
        sendJson(res, 201, options.store.createUpdateOffer(payload.target, String(payload.artifactId || '')));
        return;
      }
      const offerGet = url.pathname.match(/^\/connector-next\/v3\/updates\/offers\/([^/]+)$/);
      if (req.method === 'GET' && offerGet?.[1]) {
        control();
        sendJson(res, 200, options.store.getUpdateOffer(decodeURIComponent(offerGet[1])));
        return;
      }
      if (req.method === 'POST' && url.pathname === `${BASE}/agent/updates/poll`) {
        const payload = await body(req);
        const descriptor = authenticate(payload, 'OmniaConnectorNextUpdater');
        sendJson(res, 200, { offer: options.store.pollUpdate(descriptor) });
        return;
      }
      const candidateHeartbeatMatch = url.pathname.match(/^\/connector-next\/v3\/agent\/updates\/([^/]+)\/candidate-heartbeat$/);
      if (req.method === 'POST' && candidateHeartbeatMatch?.[1]) {
        const payload = await body(req);
        const descriptor = descriptorFrom(payload.descriptor);
        sendJson(res, 200, options.store.confirmCandidateHeartbeat(
          bearer(req),
          descriptor,
          decodeURIComponent(candidateHeartbeatMatch[1]),
          payload.phase === 'probation' ? 'probation' : 'candidate',
          Array.isArray(payload.uncertainJobIds) ? payload.uncertainJobIds : [],
          Array.isArray(payload.gateDiagnostics) ? payload.gateDiagnostics : []
        ));
        return;
      }
      const downloadMatch = url.pathname.match(/^\/connector-next\/v3\/agent\/updates\/artifacts\/([^/]+)\/download$/);
      if (req.method === 'POST' && downloadMatch?.[1]) {
        const payload = await body(req);
        const descriptor = authenticate(payload, 'OmniaConnectorNextUpdater');
        const bytes = options.store.downloadArtifact(descriptor, String(payload.offerId || ''), decodeURIComponent(downloadMatch[1]));
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length), 'cache-control': 'no-store' });
        res.end(bytes);
        return;
      }
      const updateStatusMatch = url.pathname.match(/^\/connector-next\/v3\/agent\/updates\/([^/]+)\/status$/);
      if (req.method === 'POST' && updateStatusMatch?.[1]) {
        const payload = await body(req);
        const descriptor = authenticate(payload, 'OmniaConnectorNextUpdater');
        options.store.updateOfferStatus(descriptor, decodeURIComponent(updateStatusMatch[1]), payload.status as never, (payload.details || {}) as Record<string, unknown>);
        sendJson(res, 200, { accepted: true });
        return;
      }
      sendJson(res, 404, { error: { code: 'CONNECTOR_NEXT.ROUTE_NOT_FOUND' } });
    } catch (error) {
      sendJson(res, errorStatus(error), { error: { code: error instanceof Error ? error.message : 'CONNECTOR_NEXT.INTERNAL' } });
    }
  };
  const server = options.tls ? createHttpsServer(options.tls, handler) : createHttpServer(handler);
  return {
    server,
    async listen(): Promise<{ host: string; port: number; baseUrl: string }> {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port ?? 43173, host, () => { server.off('error', reject); resolve(); });
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('CONNECTOR_NEXT.SERVER_ADDRESS_UNAVAILABLE');
      const urlHost = address.address.includes(':') ? `[${address.address}]` : address.address;
      return { host: address.address, port: address.port, baseUrl: `${options.tls ? 'https' : 'http'}://${urlHost}:${address.port}${BASE}` };
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}
