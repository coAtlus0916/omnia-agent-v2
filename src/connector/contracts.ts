import type { OperationInvocationRequest, OperationRegistrationRequest } from '../shared/operation-contracts.js';

export type ConnectorOperation =
  | 'health'
  | 'connect'
  | 'refresh'
  | 'status'
  | 'workspace_authority_read'
  | 'recording_command'
  | 'operation_register'
  | 'operation_invoke';

export type RecordingCommandKind =
  | 'status'
  | 'start'
  | 'pause'
  | 'resume'
  | 'stop'
  | 'export'
  | 'export_chunk'
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
  chunkIndex?: number;
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
  status:
    | 'not_connected'
    | 'browser_starting'
    | 'waiting_login'
    | 'waiting_pack'
    | 'waiting_authorization'
    | 'identifying_pack'
    | 'connected'
    | 'target_closed'
    | 'multiple_targets'
    | 'identity_changed'
    | 'error';
  connected: boolean;
  connecting: boolean;
  connectorId: string;
  connectorName: string;
  connectorVersion: string;
  sessionGeneration: number;
  authorityInstanceId?: string;
  tenantOrOrgId?: string;
  packId?: string;
  engagementId: string;
  engagementName: string;
  clientName: string;
  checkedAt: string;
  message: string;
}

export type ConnectorOperationPayload = OperationRegistrationRequest | OperationInvocationRequest;

export interface ConnectorWorkspaceAuthorityRead {
  schemaVersion: 'omnia.workspace-authority-read/v1';
  profile: 'workspace_authority_read';
  engagementId: string;
  source: 'omnia_authority_api';
  connectorBinding: {
    connectorId: string;
    sessionGeneration: number;
    engagementId: string;
    authorityInstanceId: string;
    tenantOrOrgId: string;
    packId: string;
  };
  sectionsPayload: unknown;
  workspaceFacetsPayload: unknown;
}
