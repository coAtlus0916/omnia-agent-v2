import type { OperationInvocationRequest, OperationRegistrationRequest } from '../shared/operation-contracts.js';

export type ConnectorOperation =
  | 'health'
  | 'connect'
  | 'refresh'
  | 'status'
  | 'workspace_authority_read'
  | 'operation_register'
  | 'operation_invoke';

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

interface ConnectorWorkspaceAuthorityReadBase {
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
}

export interface ConnectorWorkspaceAuthorityReadV1 extends ConnectorWorkspaceAuthorityReadBase {
  schemaVersion: 'omnia.workspace-authority-read/v1';
  sectionsPayload: unknown;
  workspaceFacetsPayload: unknown;
}

export interface ConnectorWorkspaceAuthorityReadV2 extends ConnectorWorkspaceAuthorityReadBase {
  schemaVersion: 'omnia.workspace-authority-read/v2';
  facetDirectoryPayload: unknown;
}

export type ConnectorWorkspaceAuthorityRead =
  | ConnectorWorkspaceAuthorityReadV1
  | ConnectorWorkspaceAuthorityReadV2;
