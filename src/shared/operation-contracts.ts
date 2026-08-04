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

export interface OperationRegistrationResult {
  schemaVersion: 'omnia.operation-registration-result/v1';
  featureId: string;
  featureVersion: string;
  packageId: string;
  packageDigest: string;
  operationIds: string[];
}

export interface OperationInvocationRequest {
  schemaVersion: 'omnia.operation-invocation/v1';
  featureId: string;
  featureVersion: string;
  operationId: string;
  request: Record<string, unknown>;
  operationPackageDigest: string;
  mutationAuthorized: boolean;
}
