import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import {
  BRIDGE_PRODUCT,
  BRIDGE_PROTOCOL,
  BRIDGE_SCHEMA,
  type BridgeEnvelope,
  type BridgeConnectorRegistrationRequest,
  type BridgeDiscoverySessionRequest,
  type BridgePairRequest,
  type BridgePairResponse
} from '../shared/bridge-contracts.js';

interface TokenPayload {
  role: 'shell' | 'connector';
  pairId: string;
  exp: number;
  product?: typeof BRIDGE_PRODUCT;
  protocol?: typeof BRIDGE_PROTOCOL;
  deviceId?: string;
  sessionId?: string;
}

export interface BridgeServerOptions {
  host: string;
  port: number;
  pairingCode: string;
  tokenSecret: string;
  adminToken?: string;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signToken(payload: TokenPayload, secret: string): string {
  const body = encode(payload);
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function verifyToken(token: string, secret: string): TokenPayload {
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra) throw new Error('invalid token');
  const expected = createHmac('sha256', secret).update(body).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('invalid token');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
  if (!['shell', 'connector'].includes(payload.role) || !validPairId(payload.pairId) || payload.exp <= Date.now()) {
    throw new Error('expired token');
  }
  return payload;
}

function validPairId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{2,79}$/.test(value);
}

function validIdentity(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$/.test(value);
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 16 * 1024) throw new Error('request too large');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

export function createBridgeServer(options: BridgeServerOptions) {
  const adminToken = options.adminToken || options.pairingCode;
  if (adminToken.length < 20) throw new Error('Bridge admin token must contain at least 20 characters.');
  if (options.tokenSecret.length < 32) throw new Error('Bridge token secret must contain at least 32 characters.');
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  const connectors = new Map<string, WebSocket>();
  const shells = new Map<string, Set<WebSocket>>();
  const requestOwners = new Map<string, {
    owner: WebSocket;
    pairId: string;
    timer: NodeJS.Timeout;
  }>();
  const pairingCodes = new Map<string, {
    pairId: string;
    role: 'shell' | 'connector';
    expiresAt: number;
    consumed: boolean;
  }>();
  const waitingConnectors = new Map<string, {
    leaseId: string;
    leaseSecretHash: string;
    connectorId: string;
    name: string;
    platform: string;
    startedAt: string;
    expiresAt: number;
    matched: null | {
      sessionId: string;
      pairId: string;
      confirmationCode: string;
      token: string;
      expiresAt: string;
    };
  }>();
  const hashCode = (value: string) => createHash('sha256').update(value).digest('hex');
  const authorizedAdmin = (req: IncomingMessage) => {
    const presented = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const actual = Buffer.from(presented);
    const expected = Buffer.from(adminToken);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/health') {
      json(res, 200, {
        schemaVersion: BRIDGE_SCHEMA,
        ok: true,
        product: 'omnia-agent-v5-bridge',
        onlineConnectors: connectors.size
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/discovery/connectors') {
      try {
        const input = await readJson(req) as BridgeConnectorRegistrationRequest;
        if (
          input.schemaVersion !== BRIDGE_SCHEMA
          || input.product !== BRIDGE_PRODUCT
          || input.protocol !== BRIDGE_PROTOCOL
          || !validIdentity(input.connectorId)
          || typeof input.name !== 'string'
          || !input.name.trim()
          || input.name.length > 160
          || typeof input.platform !== 'string'
          || !input.platform.trim()
          || input.platform.length > 160
        ) {
          json(res, 400, { code: 'BRIDGE.INVALID_CONNECTOR_IDENTITY', message: 'Connector 等待匹配身份无效。' });
          return;
        }
        const leaseId = `lease-${randomUUID()}`;
        const leaseSecret = randomBytes(32).toString('base64url');
        const expiresAt = Date.now() + 2 * 60 * 1000;
        for (const [id, candidate] of waitingConnectors) {
          if (candidate.connectorId === input.connectorId) waitingConnectors.delete(id);
        }
        waitingConnectors.set(leaseId, {
          leaseId,
          leaseSecretHash: hashCode(leaseSecret),
          connectorId: input.connectorId,
          name: input.name.trim(),
          platform: input.platform.trim(),
          startedAt: new Date().toISOString(),
          expiresAt,
          matched: null
        });
        json(res, 201, {
          schemaVersion: BRIDGE_SCHEMA,
          leaseId,
          leaseSecret,
          expiresAt: new Date(expiresAt).toISOString()
        });
      } catch {
        json(res, 400, { code: 'BRIDGE.INVALID_REQUEST', message: 'Connector 等待匹配请求无效。' });
      }
      return;
    }
    const leaseMatch = req.method === 'GET'
      ? String(req.url || '').match(/^\/v1\/discovery\/connectors\/(lease-[0-9a-f-]+)$/i)
      : null;
    if (leaseMatch) {
      const lease = waitingConnectors.get(leaseMatch[1]!);
      const presented = String(req.headers.authorization || '').replace(/^Pairing\s+/i, '');
      if (!lease || hashCode(presented) !== lease.leaseSecretHash) {
        json(res, 401, { code: 'BRIDGE.LEASE_UNAUTHORIZED', message: '等待匹配 lease 无效。' });
        return;
      }
      if (lease.expiresAt <= Date.now()) {
        waitingConnectors.delete(lease.leaseId);
        json(res, 410, { schemaVersion: BRIDGE_SCHEMA, state: 'expired' });
        return;
      }
      if (!lease.matched) {
        json(res, 200, { schemaVersion: BRIDGE_SCHEMA, state: 'waiting', expiresAt: new Date(lease.expiresAt).toISOString() });
        return;
      }
      waitingConnectors.delete(lease.leaseId);
      json(res, 200, { schemaVersion: BRIDGE_SCHEMA, state: 'matched', ...lease.matched });
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/discovery/sessions') {
      try {
        const input = await readJson(req) as BridgeDiscoverySessionRequest;
        if (
          input.schemaVersion !== BRIDGE_SCHEMA
          || input.product !== BRIDGE_PRODUCT
          || input.protocol !== BRIDGE_PROTOCOL
          || !validIdentity(input.shellNonce)
          || (input.connectorId !== undefined && !validIdentity(input.connectorId))
        ) {
          json(res, 400, { code: 'BRIDGE.INVALID_DISCOVERY_SESSION', message: 'Remote 匹配会话身份无效。' });
          return;
        }
        const now = Date.now();
        const available = [...waitingConnectors.values()].filter((candidate) => {
          if (candidate.expiresAt <= now || candidate.matched) return false;
          return !input.connectorId || candidate.connectorId === input.connectorId;
        });
        if (available.length === 0) {
          json(res, 409, { code: 'REMOTE.NO_WAITING_CONNECTOR', message: '没有发现正在等待匹配的 v5 Remote Connector。请先在公司电脑双击 Start。', candidates: [] });
          return;
        }
        if (available.length > 1) {
          json(res, 409, {
            code: 'REMOTE.MULTIPLE_WAITING_CONNECTORS',
            message: '发现多个待匹配 Connector，请在 Agent 中选择与公司电脑名称一致的设备。',
            candidates: available.map(({ connectorId, name, platform, startedAt }) => ({ connectorId, name, platform, startedAt }))
          });
          return;
        }
        const candidate = available[0]!;
        const sessionId = `session-${randomUUID()}`;
        const pairId = `v5-pair-${randomUUID()}`;
        const confirmationCode = String(randomInt(0, 1_000_000)).padStart(6, '0');
        const expiresAtMs = Date.now() + 180 * 24 * 60 * 60 * 1000;
        const tokenBase = {
          pairId,
          exp: expiresAtMs,
          product: BRIDGE_PRODUCT,
          protocol: BRIDGE_PROTOCOL,
          deviceId: candidate.connectorId,
          sessionId
        };
        candidate.matched = {
          sessionId,
          pairId,
          confirmationCode,
          token: signToken({ role: 'connector', ...tokenBase }, options.tokenSecret),
          expiresAt: new Date(expiresAtMs).toISOString()
        };
        json(res, 201, {
          schemaVersion: BRIDGE_SCHEMA,
          product: BRIDGE_PRODUCT,
          protocol: BRIDGE_PROTOCOL,
          sessionId,
          pairId,
          connector: {
            connectorId: candidate.connectorId,
            name: candidate.name,
            platform: candidate.platform,
            startedAt: candidate.startedAt
          },
          confirmationCode,
          token: signToken({ role: 'shell', ...tokenBase }, options.tokenSecret),
          expiresAt: new Date(expiresAtMs).toISOString()
        });
      } catch {
        json(res, 400, { code: 'BRIDGE.INVALID_REQUEST', message: 'Remote 匹配会话请求无效。' });
      }
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/pair') {
      try {
        const input = await readJson(req) as BridgePairRequest;
        const codeRecord = pairingCodes.get(hashCode(String(input.pairingCode || '')));
        if (
          input.schemaVersion !== BRIDGE_SCHEMA
          || !['shell', 'connector'].includes(input.role)
          || !codeRecord
          || codeRecord.consumed
          || codeRecord.expiresAt < Date.now()
          || codeRecord.role !== input.role
        ) {
          json(res, 401, { code: 'BRIDGE.PAIRING_REJECTED', message: '配对信息无效。' });
          return;
        }
        codeRecord.consumed = true;
        const expiresAt = Date.now() + 180 * 24 * 60 * 60 * 1000;
        const response: BridgePairResponse = {
          schemaVersion: BRIDGE_SCHEMA,
          token: signToken({ role: input.role, pairId: codeRecord.pairId, exp: expiresAt }, options.tokenSecret),
          pairId: codeRecord.pairId,
          expiresAt: new Date(expiresAt).toISOString()
        };
        json(res, 200, response);
      } catch {
        json(res, 400, { code: 'BRIDGE.INVALID_REQUEST', message: '配对请求无效。' });
      }
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/admin/pairing-bundles') {
      if (!authorizedAdmin(req)) {
        json(res, 401, { code: 'BRIDGE.ADMIN_UNAUTHORIZED', message: '管理员身份验证失败。' });
        return;
      }
      const pairId = `pair-${randomUUID()}`;
      const expiresAt = Date.now() + 10 * 60 * 1000;
      const shellCode = randomBytes(12).toString('base64url');
      const connectorCode = randomBytes(12).toString('base64url');
      pairingCodes.set(hashCode(shellCode), { pairId, role: 'shell', expiresAt, consumed: false });
      pairingCodes.set(hashCode(connectorCode), { pairId, role: 'connector', expiresAt, consumed: false });
      json(res, 201, {
        schemaVersion: BRIDGE_SCHEMA,
        pairId,
        shellCode,
        connectorCode,
        expiresAt: new Date(expiresAt).toISOString()
      });
      return;
    }
    json(res, 404, { code: 'BRIDGE.NOT_FOUND', message: '路由不存在。' });
  });

  server.on('upgrade', (req, socket, head) => {
    try {
      const url = new URL(req.url || '/', 'http://bridge.invalid');
      if (url.pathname !== '/v1/connect') throw new Error('route');
      const authorization = String(req.headers.authorization || '');
      const match = authorization.match(/^Bearer\s+(.+)$/i);
      if (!match) throw new Error('authorization');
      const identity = verifyToken(match[1]!, options.tokenSecret);
      wss.handleUpgrade(req, socket, head, (ws) => {
        (ws as any).identity = identity;
        wss.emit('connection', ws, req);
      });
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
    }
  });

  wss.on('connection', (ws) => {
    const identity = (ws as any).identity as TokenPayload;
    if (identity.role === 'connector') {
      connectors.get(identity.pairId)?.close(4001, 'replaced');
      connectors.set(identity.pairId, ws);
      for (const shell of shells.get(identity.pairId) || []) {
        shell.send(JSON.stringify({
          schemaVersion: BRIDGE_SCHEMA,
          kind: 'state',
          connectorOnline: true,
          message: 'Remote Connector 在线。'
        }));
      }
    } else {
      const group = shells.get(identity.pairId) || new Set<WebSocket>();
      group.add(ws);
      shells.set(identity.pairId, group);
      ws.send(JSON.stringify({
        schemaVersion: BRIDGE_SCHEMA,
        kind: 'state',
        connectorOnline: connectors.get(identity.pairId)?.readyState === WebSocket.OPEN,
        message: connectors.has(identity.pairId) ? 'Remote Connector 在线。' : 'Remote Connector 离线。'
      }));
    }
    ws.on('message', (data) => {
      let envelope: BridgeEnvelope;
      try { envelope = JSON.parse(data.toString()) as BridgeEnvelope; } catch { ws.close(1003, 'invalid json'); return; }
      if (envelope.schemaVersion !== BRIDGE_SCHEMA) return;
      if (identity.role === 'shell' && envelope.kind === 'command') {
        const connector = connectors.get(identity.pairId);
        if (!connector || connector.readyState !== WebSocket.OPEN) {
          ws.send(JSON.stringify({
            schemaVersion: BRIDGE_SCHEMA,
            kind: 'result',
            response: {
              schemaVersion: 'omnia.connector-ipc/v1',
              id: envelope.request.id,
              ok: false,
              error: { code: 'REMOTE.CONNECTOR_OFFLINE', message: 'Remote Connector 离线。', retryable: true }
            }
          }));
          return;
        }
        const existing = requestOwners.get(envelope.request.id);
        if (existing) {
          ws.send(JSON.stringify({
            schemaVersion: BRIDGE_SCHEMA,
            kind: 'result',
            response: {
              schemaVersion: 'omnia.connector-ipc/v1',
              id: envelope.request.id,
              ok: false,
              error: { code: 'REMOTE.DUPLICATE_IN_FLIGHT', message: '相同 request ID 已在执行，未重复分发。', retryable: true }
            }
          }));
          return;
        }
        const requestedDeadline = Date.parse(envelope.deadlineAt || '');
        const maximumDeadline = Date.now() + 185_000;
        const deadline = Number.isFinite(requestedDeadline)
          ? Math.min(Math.max(requestedDeadline, Date.now() + 1_000), maximumDeadline)
          : Date.now() + 95_000;
        const timer = setTimeout(() => {
          requestOwners.delete(envelope.request.id);
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({
            schemaVersion: BRIDGE_SCHEMA,
            kind: 'result',
            response: {
              schemaVersion: 'omnia.connector-ipc/v1',
              id: envelope.request.id,
              ok: false,
              error: { code: 'REMOTE.DEADLINE_EXCEEDED', message: 'Bridge 命令超过 95 秒期限。', retryable: true }
            }
          }));
        }, Math.max(1_000, deadline - Date.now()));
        timer.unref();
        requestOwners.set(envelope.request.id, { owner: ws, pairId: identity.pairId, timer });
        connector.send(JSON.stringify(envelope));
      } else if (identity.role === 'shell' && envelope.kind === 'cancel') {
        const pending = requestOwners.get(envelope.requestId);
        if (!pending || pending.owner !== ws || pending.pairId !== identity.pairId) return;
        clearTimeout(pending.timer);
        requestOwners.delete(envelope.requestId);
        const connector = connectors.get(identity.pairId);
        if (connector?.readyState === WebSocket.OPEN) connector.send(JSON.stringify(envelope));
      } else if (identity.role === 'connector' && envelope.kind === 'result') {
        const pending = requestOwners.get(envelope.response.id);
        if (!pending || pending.pairId !== identity.pairId) return;
        requestOwners.delete(envelope.response.id);
        clearTimeout(pending.timer);
        if (pending.owner.readyState === WebSocket.OPEN) pending.owner.send(JSON.stringify(envelope));
      }
    });
    ws.on('close', () => {
      if (identity.role === 'connector' && connectors.get(identity.pairId) === ws) {
        connectors.delete(identity.pairId);
        for (const [id, pending] of requestOwners) {
          if (pending.pairId !== identity.pairId) continue;
          clearTimeout(pending.timer);
          requestOwners.delete(id);
          if (pending.owner.readyState === WebSocket.OPEN) pending.owner.send(JSON.stringify({
            schemaVersion: BRIDGE_SCHEMA,
            kind: 'result',
            response: {
              schemaVersion: 'omnia.connector-ipc/v1',
              id,
              ok: false,
              error: { code: 'REMOTE.CONNECTOR_DISCONNECTED', message: 'Remote Connector 在命令执行期间断开。', retryable: true }
            }
          }));
        }
        for (const shell of shells.get(identity.pairId) || []) {
          if (shell.readyState === WebSocket.OPEN) shell.send(JSON.stringify({
            schemaVersion: BRIDGE_SCHEMA,
            kind: 'state',
            connectorOnline: false,
            message: 'Remote Connector 离线。'
          }));
        }
      } else {
        shells.get(identity.pairId)?.delete(ws);
      }
      for (const [id, pending] of requestOwners) {
        if (pending.owner !== ws) continue;
        clearTimeout(pending.timer);
        requestOwners.delete(id);
      }
    });
  });

  return {
    server,
    async listen(): Promise<{ host: string; port: number }> {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port, options.host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Bridge did not bind a TCP address.');
      return { host: options.host, port: address.port };
    },
    async close(): Promise<void> {
      for (const socket of wss.clients) socket.close(1001, 'shutdown');
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

export const _test = { signToken, verifyToken, validPairId };
