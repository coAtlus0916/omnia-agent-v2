export interface ConnectorBinding {
  connectorId: string;
  sessionGeneration: number;
  engagementId: string;
  authorityInstanceId?: string;
  tenantOrOrgId?: string;
  packId?: string;
}

export interface OperationRegistrationRequest {
  schemaVersion: 'omnia.operation-registration/v1';
  featureId: string;
  featureVersion: string;
  operationPackage: unknown;
}

export interface OperationRegistrationCommitRequest {
  schemaVersion: 'omnia.operation-registration-commit/v1';
  featureId: string;
  featureVersion: string;
  operationPackageDigest: string;
  registrationToken: string;
}

export interface OperationRegistrationFinalizeRequest {
  schemaVersion: 'omnia.operation-registration-finalize/v1';
  featureId: string;
  featureVersion: string;
  operationPackageDigest: string;
  registrationToken: string;
}

export interface OperationRegistrationAbortRequest {
  schemaVersion: 'omnia.operation-registration-abort/v1';
  featureId: string;
  featureVersion: string;
  operationPackageDigest: string;
  registrationToken: string;
}

export type OperationRegistrationCommand =
  | OperationRegistrationRequest
  | OperationRegistrationCommitRequest
  | OperationRegistrationFinalizeRequest
  | OperationRegistrationAbortRequest;

export interface OperationRegistrationResult {
  schemaVersion: 'omnia.operation-registration-result/v1';
  featureId: string;
  featureVersion: string;
  packageId: string;
  packageDigest: string;
  operationIds: string[];
  registrationState: 'prepared' | 'committed' | 'aborted';
  registrationToken: string;
  replacedPackageDigests: string[];
}

export interface OperationInvocationRequest {
  schemaVersion: 'omnia.operation-invocation/v1';
  featureId: string;
  featureVersion: string;
  operationId: string;
  request: Record<string, unknown>;
  operationPackageDigest: string;
  mutationAuthorized: boolean;
  deliveryContext?: import('./connector-delivery.js').ConnectorDeliveryContext;
  /**
   * Optional exact identity of an earlier response-lost mutation. Connector
   * uncertainty is cleared only when this invocation is read-only and its
   * signed handler returns a matching omnia.connector-reconcile-proof/v1.
   */
  reconcileOf?: {
    requestId: string;
    featureId: string;
    featureVersion: string;
    runId: string;
    commandId: string;
    operationId: string;
    operationPackageDigest: string;
    connectorId: string;
    sessionGeneration: number;
    executionGeneration: string;
  };
}
