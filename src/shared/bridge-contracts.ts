import type { ConnectorRequest, ConnectorResponse } from '../connector/contracts.js';

export const BRIDGE_SCHEMA = 'omnia.v5.bridge/v1' as const;
export const BRIDGE_PRODUCT = 'omnia-agent-v5' as const;
export const BRIDGE_PROTOCOL = 'omnia.v5.remote-connector/v2' as const;
export const BRIDGE_VERSION = '0.4.1' as const;
export const DEFAULT_V5_BRIDGE_URL = 'https://agent.labcaspian.com/v5-bridge/' as const;

export interface BridgePairingSessionRequest {
  schemaVersion: typeof BRIDGE_SCHEMA;
  product: typeof BRIDGE_PRODUCT;
  protocol: typeof BRIDGE_PROTOCOL;
  shellNonce: string;
  replacementPairId?: string;
}

export interface BridgePairingSessionResponse {
  schemaVersion: typeof BRIDGE_SCHEMA;
  product: typeof BRIDGE_PRODUCT;
  protocol: typeof BRIDGE_PROTOCOL;
  sessionId: string;
  pairingCode: string;
  pollSecret: string;
  expiresAt: string;
}

export interface BridgePairingPollResponse {
  schemaVersion: typeof BRIDGE_SCHEMA;
  product: typeof BRIDGE_PRODUCT;
  protocol: typeof BRIDGE_PROTOCOL;
  state: 'waiting' | 'candidate' | 'matched' | 'expired';
  pairId?: string;
  token?: string;
  expiresAt?: string;
  generation?: number;
  connector?: {
    connectorId: string;
    name: string;
    version: string;
    platform: string;
  };
}

export interface BridgePairRequest {
  schemaVersion: typeof BRIDGE_SCHEMA;
  role: 'shell' | 'connector';
  pairingCode: string;
  name: string;
  connectorId?: string;
  connectorVersion?: string;
  platform?: string;
  product?: typeof BRIDGE_PRODUCT;
  protocol?: typeof BRIDGE_PROTOCOL;
}

export interface BridgePairResponse {
  schemaVersion: typeof BRIDGE_SCHEMA;
  token: string;
  pairId: string;
  expiresAt: string;
  generation: number;
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
  bridgeVersion: typeof BRIDGE_VERSION;
  protocol: typeof BRIDGE_PROTOCOL;
  connectorId: string;
  connectorVersion: string;
  generation: number;
  message: string;
}

export interface BridgeBindingCommittedEnvelope {
  schemaVersion: typeof BRIDGE_SCHEMA;
  kind: 'binding_committed';
  pairId: string;
  generation: number;
}

export type BridgeEnvelope = BridgeCommandEnvelope | BridgeCancelEnvelope | BridgeResultEnvelope | BridgeStateEnvelope | BridgeBindingCommittedEnvelope;
