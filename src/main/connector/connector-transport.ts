import type { ConnectionSnapshot, WorkspaceObservation } from '../../shared/contracts.js';
import type {
  OperationInvocationRequest,
  OperationRegistrationRequest,
  OperationRegistrationResult
} from '../../shared/operation-contracts.js';
import type { RecordingCommandRequest } from '../../connector/contracts.js';

export interface ConnectorTransport {
  readonly mode: 'local' | 'remote';
  start(): Promise<void>;
  stop(): Promise<void>;
  unavailableSnapshot(reason: string): ConnectionSnapshot;
  load(): Promise<ConnectionSnapshot>;
  connect(): Promise<ConnectionSnapshot>;
  cancelConnect(): Promise<void>;
  refresh(): Promise<ConnectionSnapshot>;
  lightRead(expectedEngagementId: string): Promise<WorkspaceObservation>;
  recordingCommand(input: RecordingCommandRequest): Promise<unknown>;
  registerOperation(input: OperationRegistrationRequest): Promise<OperationRegistrationResult>;
  invokeOperation(input: OperationInvocationRequest): Promise<unknown>;
}
