import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import {
  BRIDGE_PRODUCT,
  BRIDGE_PROTOCOL,
  BRIDGE_SCHEMA,
  BRIDGE_VERSION,
  type BridgeEnvelope,
  type BridgePairingSessionRequest,
  type BridgePairRequest,
  type BridgePairResponse
} from '../shared/bridge-contracts.js';
import { BridgeBindingStore } from './binding-store.js';

interface TokenPayload {
  role: 'shell' | 'connector';
  pairId: string;
  exp: number;
  generation?: number;
  product?: string;
  protocol?: string;
  deviceId?: string;
}

interface SocketIdentity extends TokenPayload {
  generation: number;
  connectorVersion: string;
  protocol: string;
}

export interface BridgeServerOptions {
  host: string;
  port: number;
  tokenSecret: string;
  statePath?: string;
  buildIdentity?: string;
  heartbeatIntervalMs?: number;
  staleSocketTimeoutMs?: number;
}

const connectorVersionCompatible = (value: string): boolean => {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)$/);
  return Boolean(match && Number(match[1]) === 0 && Number(match[2]) === 3 && Number(match[3]) >= 4);
};

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const validIdentity = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$/.test(value);
const validPairId = (value: string) => /^[A-Za-z0-9][A-Za-z0-9_.-]{2,79}$/.test(value);

function signToken(payload: TokenPayload, secret: string): string {
  const body = encode(payload);
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
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

function bearer(req: IncomingMessage): string {
  return String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
}

export function createBridgeServer(options: BridgeServerOptions) {
  if (options.tokenSecret.length < 32) throw new Error('Bridge token secret must contain at least 32 characters.');
  const startedAt = new Date().toISOString();
  const buildIdentity = options.buildIdentity || process.env.OMNIA_V5_BRIDGE_BUILD_ID || `bridge-${BRIDGE_VERSION}`;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
  const staleSocketTimeoutMs = options.staleSocketTimeoutMs ?? 45_000;
  if (heartbeatIntervalMs < 10 || staleSocketTimeoutMs <= heartbeatIntervalMs) {
    throw new Error('Bridge heartbeat timing is invalid.');
  }
  const statePath = options.statePath || path.join(os.tmpdir(), `omnia-v5-bridge-${process.pid}-${randomUUID()}.json`);
  const store = new BridgeBindingStore(statePath);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  const connectors = new Map<string, WebSocket>();
  const shells = new Map<string, Set<WebSocket>>();
  const requestOwners = new Map<string, { owner: WebSocket; pairId: string; timer: NodeJS.Timeout }>();
  const sessionRate = new Map<string, number[]>();

  const socketFresh = (socket: WebSocket | undefined) => Boolean(
    socket
    && socket.readyState === WebSocket.OPEN
    && (socket as any).isAlive === true
    && Date.now() - Number((socket as any).lastPongAt || 0) <= staleSocketTimeoutMs
  );
  const bindingState = (pairId: string, online = socketFresh(connectors.get(pairId))) => {
    const binding = store.binding(pairId);
    return {
      schemaVersion: BRIDGE_SCHEMA,
      kind: 'state' as const,
      connectorOnline: online && binding?.lifecycle === 'active',
      bridgeVersion: BRIDGE_VERSION,
      protocol: BRIDGE_PROTOCOL,
      connectorId: binding?.connectorId || '',
      connectorVersion: binding?.connectorVersion || '',
      generation: binding?.generation || 0,
      message: online ? 'Remote Connector 在线。' : 'Remote Connector 离线。'
    };
  };
  const notifyShells = (pairId: string) => {
    const value = JSON.stringify(bindingState(pairId));
    for (const shell of shells.get(pairId) || []) if (shell.readyState === WebSocket.OPEN) shell.send(value);
  };
  const notifyConnectorCommitted = (pairId: string, generation: number) => {
    const connector = connectors.get(pairId);
    if (connector?.readyState === WebSocket.OPEN) connector.send(JSON.stringify({
      schemaVersion: BRIDGE_SCHEMA, kind: 'binding_committed', pairId, generation
    }));
  };

  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/health') {
      const fresh = [...connectors.values()].filter(socketFresh).length;
      json(res, 200, {
        schemaVersion: BRIDGE_SCHEMA,
        ok: true,
        product: 'omnia-agent-v5-bridge',
        version: BRIDGE_VERSION,
        buildIdentity,
        protocol: BRIDGE_PROTOCOL,
        startedAt,
        onlineConnectors: fresh
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/pairing/sessions') {
      try {
        const key = String(req.socket.remoteAddress || 'unknown');
        const now = Date.now();
        const attempts = (sessionRate.get(key) || []).filter((value) => value > now - 60_000);
        if (attempts.length >= 5) {
          json(res, 429, { code: 'BRIDGE.PAIRING_RATE_LIMITED', message: '链接码请求过于频繁。' });
          return;
        }
        attempts.push(now);
        sessionRate.set(key, attempts);
        const input = await readJson(req) as BridgePairingSessionRequest;
        if (
          input.schemaVersion !== BRIDGE_SCHEMA
          || input.product !== BRIDGE_PRODUCT
          || input.protocol !== BRIDGE_PROTOCOL
          || !validIdentity(input.shellNonce)
        ) {
          json(res, 400, { code: 'BRIDGE.INVALID_PAIRING_SESSION', message: '链接会话无效。' });
          return;
        }
        const replacementPairId = String(input.replacementPairId || '');
        if (replacementPairId) {
          const identity = verifyToken(bearer(req), options.tokenSecret);
          if (identity.role !== 'shell' || identity.pairId !== replacementPairId) throw new Error('unauthorized replacement');
          const active = store.binding(replacementPairId);
          if (!active || active.lifecycle !== 'active') throw new Error('replacement is not active');
        }
        const session = store.createSession(replacementPairId);
        json(res, 201, {
          schemaVersion: BRIDGE_SCHEMA,
          product: BRIDGE_PRODUCT,
          protocol: BRIDGE_PROTOCOL,
          ...session
        });
      } catch {
        json(res, 401, { code: 'BRIDGE.PAIRING_SESSION_REJECTED', message: '无法创建链接会话。' });
      }
      return;
    }

    const pollMatch = req.method === 'GET'
      ? String(req.url || '').match(/^\/v1\/pairing\/sessions\/(pairing-[0-9a-f-]+)$/i)
      : null;
    if (pollMatch) {
      const secret = String(req.headers.authorization || '').replace(/^Pairing\s+/i, '');
      const result = store.session(pollMatch[1]!, secret);
      if (!result) {
        json(res, 401, { code: 'BRIDGE.PAIRING_POLL_UNAUTHORIZED', message: '链接会话凭据无效。' });
        return;
      }
      const binding = result.binding;
      json(res, result.state === 'expired' ? 410 : 200, {
        schemaVersion: BRIDGE_SCHEMA,
        product: BRIDGE_PRODUCT,
        protocol: BRIDGE_PROTOCOL,
        state: result.state,
        expiresAt: result.expiresAt,
        ...(['candidate', 'matched'].includes(result.state) && binding?.readyAt ? {
          pairId: binding.pairId,
          generation: binding.generation,
          connector: {
            connectorId: binding.connectorId,
            name: binding.connectorName,
            version: binding.connectorVersion,
            platform: binding.platform
          },
          token: signToken({
            role: 'shell', pairId: binding.pairId, generation: binding.generation,
            deviceId: binding.connectorId, product: BRIDGE_PRODUCT, protocol: BRIDGE_PROTOCOL,
            exp: Date.now() + 365 * 24 * 60 * 60_000
          }, options.tokenSecret)
        } : {})
      });
      return;
    }

    const commitPairingMatch = req.method === 'POST'
      ? String(req.url || '').match(/^\/v1\/pairing\/sessions\/([A-Za-z0-9_.-]+)\/commit$/)
      : null;
    if (commitPairingMatch) {
      const proof = String(req.headers.authorization || '').replace(/^Pairing\s+/i, '');
      const pending = store.session(commitPairingMatch[1]!, proof);
      if (pending?.state === 'candidate' && pending.binding) {
        const binding = pending.binding;
        const candidateSocket = connectors.get(binding.pairId);
        const candidateIdentity = (candidateSocket as any)?.identity as SocketIdentity | undefined;
        const candidateHealthy = socketFresh(candidateSocket)
          && candidateIdentity?.role === 'connector'
          && candidateIdentity.pairId === binding.pairId
          && candidateIdentity.generation === binding.generation
          && candidateIdentity.protocol === BRIDGE_PROTOCOL
          && connectorVersionCompatible(candidateIdentity.connectorVersion)
          && candidateIdentity.connectorVersion === binding.connectorVersion
          && candidateIdentity.deviceId === binding.connectorId;
        if (!candidateHealthy) {
          json(res, 409, { code: 'BRIDGE.PAIRING_CANDIDATE_OFFLINE', message: '候选 Connector 已断开、过期或身份不匹配；旧 binding 保持 active。' });
          return;
        }
      }
      const committed = store.commitSession(commitPairingMatch[1]!, proof);
      if (!committed) {
        json(res, 409, { code: 'BRIDGE.PAIRING_COMMIT_REJECTED', message: '候选尚未 ready、已过期或 old generation 已变化。' });
        return;
      }
      if (committed.replacesPairId) {
        connectors.get(committed.replacesPairId)?.close(4003, 'binding superseded');
        for (const socket of shells.get(committed.replacesPairId) || []) socket.close(4003, 'binding superseded');
        notifyShells(committed.replacesPairId);
      }
      notifyConnectorCommitted(committed.pairId, committed.generation);
      notifyShells(committed.pairId);
      json(res, 200, { schemaVersion: BRIDGE_SCHEMA, state: 'matched', pairId: committed.pairId, generation: committed.generation });
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/pair') {
      try {
        const input = await readJson(req) as BridgePairRequest;
        if (
          input.schemaVersion !== BRIDGE_SCHEMA
          || input.role !== 'connector'
          || input.product !== BRIDGE_PRODUCT
          || input.protocol !== BRIDGE_PROTOCOL
          || !validIdentity(input.connectorId)
          || !connectorVersionCompatible(String(input.connectorVersion || ''))
        ) throw new Error('invalid pairing request');
        const binding = store.consumeCode({
          pairingCode: input.pairingCode,
          connectorId: input.connectorId,
          connectorName: String(input.name || '').trim().slice(0, 160) || 'Omnia Agent v5 Remote Connector',
          connectorVersion: String(input.connectorVersion).trim().slice(0, 40),
          platform: String(input.platform || '').trim().slice(0, 160),
          protocol: input.protocol
        });
        const expiresAt = Date.now() + 365 * 24 * 60 * 60_000;
        const response: BridgePairResponse = {
          schemaVersion: BRIDGE_SCHEMA,
          token: signToken({
            role: 'connector', pairId: binding.pairId, generation: binding.generation,
            deviceId: binding.connectorId, product: BRIDGE_PRODUCT, protocol: BRIDGE_PROTOCOL,
            exp: expiresAt
          }, options.tokenSecret),
          pairId: binding.pairId,
          generation: binding.generation,
          expiresAt: new Date(expiresAt).toISOString()
        };
        json(res, 200, response);
      } catch {
        json(res, 401, { code: 'BRIDGE.PAIRING_REJECTED', message: '链接码无效、已过期或已使用。' });
      }
      return;
    }

    const cancelPairingMatch = req.method === 'DELETE'
      ? String(req.url || '').match(/^\/v1\/pairing\/sessions\/([A-Za-z0-9_.-]+)$/)
      : null;
    if (cancelPairingMatch) {
      const proof = String(req.headers.authorization || '').replace(/^Pairing\s+/i, '');
      const beforeCancel = store.session(cancelPairingMatch[1]!, proof);
      const state = store.cancelSession(cancelPairingMatch[1]!, proof);
      if (!state) json(res, 401, { code: 'BRIDGE.PAIRING_UNAUTHORIZED', message: '配对会话证明无效。' });
      else if (state === 'matched') json(res, 409, { schemaVersion: BRIDGE_SCHEMA, state, message: '候选已激活；必须完成或清理该 binding。' });
      else if (state === 'expired') json(res, 410, { schemaVersion: BRIDGE_SCHEMA, state });
      else {
        if (beforeCancel?.binding?.pairId) connectors.get(beforeCancel.binding.pairId)?.close(4003, 'pairing cancelled');
        json(res, 200, { schemaVersion: BRIDGE_SCHEMA, state });
      }
      return;
    }

    const revokeMatch = req.method === 'DELETE'
      ? String(req.url || '').match(/^\/v1\/bindings\/([A-Za-z0-9_.-]+)$/)
      : null;
    if (revokeMatch) {
      try {
        const identity = verifyToken(bearer(req), options.tokenSecret);
        if (identity.role !== 'shell' || identity.pairId !== revokeMatch[1]) throw new Error('unauthorized');
        if (!store.revoke(revokeMatch[1]!)) throw new Error('not found');
        connectors.get(revokeMatch[1]!)?.close(4003, 'binding revoked');
        for (const socket of shells.get(revokeMatch[1]!) || []) socket.close(4003, 'binding revoked');
        json(res, 200, { schemaVersion: BRIDGE_SCHEMA, revoked: true });
      } catch {
        json(res, 401, { code: 'BRIDGE.REVOKE_REJECTED', message: '解除绑定失败。' });
      }
      return;
    }

    json(res, 404, { code: 'BRIDGE.NOT_FOUND', message: '路由不存在。' });
  });

  server.on('upgrade', (req, socket, head) => {
    try {
      const url = new URL(req.url || '/', 'http://bridge.invalid');
      if (url.pathname !== '/v1/connect') throw new Error('route');
      const token = bearer(req);
      const payload = verifyToken(token, options.tokenSecret);
      const presentedProtocol = String(req.headers['x-omnia-protocol'] || payload.protocol || '');
      const connectorVersion = String(req.headers['x-omnia-connector-version'] || '');
      const connectorId = String(req.headers['x-omnia-connector-id'] || payload.deviceId || '');
      if (presentedProtocol !== BRIDGE_PROTOCOL) throw new Error('protocol');
      if (payload.role === 'connector' && !connectorVersionCompatible(connectorVersion)) throw new Error('connector version');
      let binding = store.binding(payload.pairId);
      if (
        !binding
        && payload.role === 'connector'
        && (!payload.protocol || payload.protocol === 'omnia.v5.remote-connector/v1')
        && presentedProtocol === BRIDGE_PROTOCOL
        && validIdentity(connectorId)
        && connectorVersion
      ) {
        binding = store.importLegacy({
          pairId: payload.pairId,
          connectorId,
          connectorName: 'Omnia Agent v5 Remote Connector',
          connectorVersion,
          platform: '',
          protocol: BRIDGE_PROTOCOL
        });
      }
      if (!binding || binding.lifecycle === 'revoked') throw new Error('binding');
      if (payload.generation && payload.generation !== binding.generation) throw new Error('generation');
      if (payload.role === 'connector' && binding.connectorId !== connectorId) throw new Error('device');
      const identity: SocketIdentity = {
        ...payload,
        generation: binding.generation,
        connectorVersion: connectorVersion || binding.connectorVersion,
        protocol: presentedProtocol
      };
      wss.handleUpgrade(req, socket, head, (ws) => {
        (ws as any).identity = identity;
        wss.emit('connection', ws, req);
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : '';
      const status = /protocol|connector version/.test(reason) ? '426 Upgrade Required'
        : /binding|generation|device/.test(reason) ? '403 Forbidden' : '401 Unauthorized';
      socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    }
  });

  wss.on('connection', (ws) => {
    const identity = (ws as any).identity as SocketIdentity;
    (ws as any).isAlive = true;
    (ws as any).lastPongAt = Date.now();
    ws.on('pong', () => {
      (ws as any).isAlive = true;
      (ws as any).lastPongAt = Date.now();
      if (identity.role === 'connector') store.touch(identity.pairId);
    });
    if (identity.role === 'connector') {
      const activated = store.markReady(identity.pairId);
      const currentBinding = store.binding(identity.pairId);
      if (!activated && currentBinding?.lifecycle !== 'active') { ws.close(4003, 'binding inactive'); return; }
      connectors.get(identity.pairId)?.close(4001, 'replaced');
      connectors.set(identity.pairId, ws);
      if (currentBinding?.lifecycle === 'active') notifyConnectorCommitted(currentBinding.pairId, currentBinding.generation);
      notifyShells(identity.pairId);
    } else {
      const group = shells.get(identity.pairId) || new Set<WebSocket>();
      group.add(ws);
      shells.set(identity.pairId, group);
      ws.send(JSON.stringify(bindingState(identity.pairId)));
    }

    ws.on('message', (data) => {
      let envelope: BridgeEnvelope;
      try { envelope = JSON.parse(data.toString()) as BridgeEnvelope; } catch { ws.close(1003, 'invalid json'); return; }
      if (envelope.schemaVersion !== BRIDGE_SCHEMA) return;
      if (identity.role === 'shell' && envelope.kind === 'command') {
        const connector = connectors.get(identity.pairId);
        if (!socketFresh(connector)) {
          ws.send(JSON.stringify({ schemaVersion: BRIDGE_SCHEMA, kind: 'result', response: {
            schemaVersion: 'omnia.connector-ipc/v1', id: envelope.request.id, ok: false,
            error: { code: 'REMOTE.CONNECTOR_OFFLINE', message: 'Remote Connector 离线。', retryable: true }
          }}));
          return;
        }
        if (requestOwners.has(envelope.request.id)) {
          ws.send(JSON.stringify({ schemaVersion: BRIDGE_SCHEMA, kind: 'result', response: {
            schemaVersion: 'omnia.connector-ipc/v1', id: envelope.request.id, ok: false,
            error: { code: 'REMOTE.DUPLICATE_IN_FLIGHT', message: '相同 request ID 已在执行。', retryable: true }
          }}));
          return;
        }
        const parsed = Date.parse(envelope.deadlineAt || '');
        const deadline = Number.isFinite(parsed) ? Math.min(parsed, Date.now() + 185_000) : Date.now() + 95_000;
        const timer = setTimeout(() => {
          requestOwners.delete(envelope.request.id);
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ schemaVersion: BRIDGE_SCHEMA, kind: 'result', response: {
            schemaVersion: 'omnia.connector-ipc/v1', id: envelope.request.id, ok: false,
            error: envelope.request.operation === 'operation_invoke'
              ? { code: 'REMOTE.MUTATION_UNCERTAIN', message: 'Remote Operation 已超过 Bridge 期限；effect 状态未知，禁止自动重放。', retryable: false }
              : { code: 'REMOTE.DEADLINE_EXCEEDED', message: 'Bridge 命令超过期限。', retryable: true }
          }}));
        }, Math.max(1_000, deadline - Date.now()));
        timer.unref();
        requestOwners.set(envelope.request.id, { owner: ws, pairId: identity.pairId, timer });
        connector!.send(JSON.stringify(envelope));
      } else if (identity.role === 'shell' && envelope.kind === 'cancel') {
        const pending = requestOwners.get(envelope.requestId);
        if (!pending || pending.owner !== ws || pending.pairId !== identity.pairId) return;
        clearTimeout(pending.timer);
        requestOwners.delete(envelope.requestId);
        const connector = connectors.get(identity.pairId);
        if (socketFresh(connector)) connector!.send(JSON.stringify(envelope));
      } else if (identity.role === 'connector' && envelope.kind === 'result') {
        const pending = requestOwners.get(envelope.response.id);
        if (!pending || pending.pairId !== identity.pairId) return;
        clearTimeout(pending.timer);
        requestOwners.delete(envelope.response.id);
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
          if (pending.owner.readyState === WebSocket.OPEN) pending.owner.send(JSON.stringify({ schemaVersion: BRIDGE_SCHEMA, kind: 'result', response: {
            schemaVersion: 'omnia.connector-ipc/v1', id, ok: false,
            error: { code: 'REMOTE.CONNECTOR_DISCONNECTED', message: 'Remote Connector 在命令执行期间断开；effect 状态未知，禁止自动重试。', retryable: false }
          }}));
        }
        notifyShells(identity.pairId);
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

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!socketFresh(ws)) {
        const identity = (ws as any).identity as SocketIdentity | undefined;
        if (identity?.role === 'connector') notifyShells(identity.pairId);
        ws.terminate();
        continue;
      }
      (ws as any).isAlive = false;
      ws.ping();
    }
  }, heartbeatIntervalMs);
  heartbeat.unref();

  return {
    server,
    async listen(): Promise<{ host: string; port: number }> {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port, options.host, () => { server.off('error', reject); resolve(); });
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Bridge did not bind a TCP address.');
      return { host: options.host, port: address.port };
    },
    async close(): Promise<void> {
      clearInterval(heartbeat);
      for (const pending of requestOwners.values()) clearTimeout(pending.timer);
      requestOwners.clear();
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

export const _test = { signToken, verifyToken, validPairId, connectorVersionCompatible };
