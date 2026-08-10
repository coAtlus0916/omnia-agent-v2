import type { ConnectionSnapshot, WorkspaceObservation } from '../../shared/contracts.js';
import type {
  OperationInvocationRequest,
  OperationRegistrationCommand,
  OperationRegistrationResult
} from '../../shared/operation-contracts.js';
import type {
  ConnectorDeliveryAck,
  ConnectorDeliveryStatusRequest,
  ConnectorDeliveryStatusResult,
  ConnectorDeliveryWitness
} from '../../shared/connector-delivery.js';

export interface ConnectorInvocationDelivery {
  ok: boolean;
  value: unknown;
  error?: { code: string; message: string; retryable: boolean };
  wireResponse: Record<string, unknown>;
  witness: ConnectorDeliveryWitness;
}

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
  registerOperation(input: OperationRegistrationCommand): Promise<OperationRegistrationResult>;
  invokeOperation(input: OperationInvocationRequest): Promise<unknown>;
  /** Authenticated Connector generation explicitly supports durable witnesses. */
  supportsDurableDelivery?(): boolean;
  invokeOperationWithWitness?(input: OperationInvocationRequest): Promise<ConnectorInvocationDelivery>;
  deliveryStatus?(input: ConnectorDeliveryStatusRequest): Promise<ConnectorDeliveryStatusResult>;
  acknowledgeDelivery?(input: ConnectorDeliveryAck): Promise<{ acknowledged: true; clearedMutationCount: number }>;
}
