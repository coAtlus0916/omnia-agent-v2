import type { ConnectionSnapshot, WorkspaceObservation } from '../../shared/contracts.js';
import type {
  OperationInvocationRequest,
  OperationRegistrationRequest,
  OperationRegistrationResult
} from '../../shared/operation-contracts.js';

export interface WorkspaceAuthorityExpectation {
  connectorId: string;
  sessionGeneration: number;
  authorityInstanceId: string;
  tenantOrOrgId: string;
  packId: string;
  engagementId: string;
}

export interface ConnectorTransport {
  readonly mode: 'remote';
  start(): Promise<void>;
  stop(): Promise<void>;
  unavailableSnapshot(reason: string): ConnectionSnapshot;
  load(): Promise<ConnectionSnapshot>;
  connect(): Promise<ConnectionSnapshot>;
  cancelConnect(): Promise<void>;
  refresh(): Promise<ConnectionSnapshot>;
  lightRead(expected: WorkspaceAuthorityExpectation): Promise<WorkspaceObservation>;
  registerOperation(input: OperationRegistrationRequest): Promise<OperationRegistrationResult>;
  invokeOperation(input: OperationInvocationRequest): Promise<unknown>;
}
