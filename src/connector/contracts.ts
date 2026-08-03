import type { OperationInvocationRequest, OperationRegistrationRequest } from '../shared/operation-contracts.js';

export type ConnectorOperation =
  | 'health'
  | 'connect'
  | 'refresh'
  | 'status'
  | 'workspace_light_read'
  | 'recording_command'
  | 'operation_register'
  | 'operation_invoke';

export type RecordingCommandKind =
  | 'status'
  | 'start'
  | 'stop_export'
  | 'cancel'
  | 'capture_current_gra_catalog';

export interface RecordingCommandRequest {
  schemaVersion: 'omnia.v5.recording-command/v1';
  featureId: 'omnia.recording';
  featureVersion: string;
  kind: RecordingCommandKind;
  connectorBinding: {
    connectorId: string;
    sessionGeneration: number;
    engagementId: string;
  };
  recordingId?: string;
}

export interface ConnectorRequest {
  schemaVersion: 'omnia.connector-ipc/v1';
  id: string;
  operation: ConnectorOperation;
  payload: Record<string, unknown>;
}

export interface ConnectorResponse {
  schemaVersion: 'omnia.connector-ipc/v1';
  id: string;
  ok: boolean;
  value?: unknown;
  error?: { code: string; message: string; retryable: boolean };
}

export interface ConnectorConnection {
  status: 'not_connected' | 'opening' | 'waiting' | 'checking' | 'connected' | 'error';
  connected: boolean;
  connecting: boolean;
  connectorId: string;
  connectorName: string;
  connectorVersion: string;
  sessionGeneration: number;
  engagementId: string;
  engagementName: string;
  clientName: string;
  checkedAt: string;
  message: string;
}

export type ConnectorOperationPayload = OperationRegistrationRequest | OperationInvocationRequest;

export interface ConnectorWorkspaceLightRead {
  schemaVersion: 'omnia.workspace-light-read/v1';
  profile: 'workspace_light_read';
  authorityId: string;
  engagementId: string;
  source: 'omnia_authority_api';
  sections: Array<{ id: string; name: string; order: number }>;
  workspaces: Array<{ id: string; parentSectionId: string; name: string; status: string }>;
}
