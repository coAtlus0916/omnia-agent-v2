import type { ConnectorRequest, ConnectorResponse } from '../connector/contracts.js';

export const BRIDGE_SCHEMA = 'omnia.v5.bridge/v1' as const;
export const BRIDGE_PRODUCT = 'omnia-agent-v5' as const;
export const BRIDGE_PROTOCOL = 'omnia.v5.remote-connector/v1' as const;
export const DEFAULT_V5_BRIDGE_URL = 'https://agent.labcaspian.com/v5-bridge/' as const;

export interface BridgeWaitingConnector {
  connectorId: string;
  name: string;
  platform: string;
  startedAt: string;
}

export interface BridgeConnectorRegistrationRequest {
  schemaVersion: typeof BRIDGE_SCHEMA;
  product: typeof BRIDGE_PRODUCT;
  protocol: typeof BRIDGE_PROTOCOL;
  connectorId: string;
  name: string;
  platform: string;
}

export interface BridgeConnectorRegistrationResponse {
  schemaVersion: typeof BRIDGE_SCHEMA;
  leaseId: string;
  leaseSecret: string;
  expiresAt: string;
}

export interface BridgeDiscoverySessionRequest {
  schemaVersion: typeof BRIDGE_SCHEMA;
  product: typeof BRIDGE_PRODUCT;
  protocol: typeof BRIDGE_PROTOCOL;
  shellNonce: string;
  connectorId?: string;
}

export interface BridgeDiscoverySessionResponse {
  schemaVersion: typeof BRIDGE_SCHEMA;
  product: typeof BRIDGE_PRODUCT;
  protocol: typeof BRIDGE_PROTOCOL;
  sessionId: string;
  pairId: string;
  connector: BridgeWaitingConnector;
  confirmationCode: string;
  token: string;
  expiresAt: string;
}

export interface BridgeConnectorLeaseResult {
  schemaVersion: typeof BRIDGE_SCHEMA;
  state: 'waiting' | 'matched' | 'expired' | 'cancelled';
  sessionId?: string;
  pairId?: string;
  confirmationCode?: string;
  token?: string;
  expiresAt?: string;
}

export interface BridgePairRequest {
  schemaVersion: typeof BRIDGE_SCHEMA;
  role: 'shell' | 'connector';
  pairingCode: string;
  name: string;
}

export interface BridgePairResponse {
  schemaVersion: typeof BRIDGE_SCHEMA;
  token: string;
  pairId: string;
  expiresAt: string;
}

export interface BridgeCommandEnvelope {
  schemaVersion: typeof BRIDGE_SCHEMA;
  kind: 'command';
  request: ConnectorRequest;
  deadlineAt: string;
}

export interface BridgeCancelEnvelope {
  schemaVersion: typeof BRIDGE_SCHEMA;
  kind: 'cancel';
  requestId: string;
  reason: string;
}

export interface BridgeResultEnvelope {
  schemaVersion: typeof BRIDGE_SCHEMA;
  kind: 'result';
  response: ConnectorResponse;
}

export interface BridgeStateEnvelope {
  schemaVersion: typeof BRIDGE_SCHEMA;
  kind: 'state';
  connectorOnline: boolean;
  message: string;
}

export type BridgeEnvelope = BridgeCommandEnvelope | BridgeCancelEnvelope | BridgeResultEnvelope | BridgeStateEnvelope;
