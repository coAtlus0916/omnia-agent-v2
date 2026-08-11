import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const CONNECTOR_NEXT_PRODUCT_ID = 'com.deloitte.omnia-agent.connector-next';
export const CONNECTOR_NEXT_PROTOCOL_ID = 'omnia.connector-next/v3';
export const CONNECTOR_NEXT_SERVER_SCHEMA = 'omnia.connector-next-server/v3';
export const CONNECTOR_NEXT_PACKAGE_SCHEMA = 'omnia.connector-next-package/v1';
export const CONNECTOR_NEXT_UPDATE_SCHEMA = 'omnia.connector-next-update-manifest/v1';
export const CONNECTOR_NEXT_LOG_SCHEMA = 'omnia.connector-next-log/v1';
export const CONNECTOR_NEXT_HEALTH_OPERATION = 'connector.next.system-health.read/v1';
export const CONNECTOR_NEXT_OPERATION_EXECUTE = 'connector.next.operation.execute/v1';
export const CONNECTOR_NEXT_OPERATION_ENVELOPE_SCHEMA = 'omnia.connector-next-operation-envelope/v1';
export const CONNECTOR_NEXT_AGENT_PROCESS = 'OmniaConnectorNextAgent';
export const CONNECTOR_NEXT_UPDATER_PROCESS = 'OmniaConnectorNextUpdater';
export const CONNECTOR_NEXT_BOOTSTRAP_PROCESS = 'OmniaConnectorNextBootstrap';
export const CONNECTOR_NEXT_INSTALLER_PROCESS = 'OmniaConnectorNextInstaller';
export const CONNECTOR_NEXT_SERVER_PROCESS = 'OmniaConnectorNextServer';
export const CONNECTOR_NEXT_STARTUP_ENTRY = 'Omnia Agent Connector Next v3';

export type ConnectorNextEffect = 'read_only' | 'mutation';
export type ConnectorNextLogSource = 'agent' | 'updater' | 'bootstrap' | 'installer' | 'protocol' | 'task' | 'audit';
export type ConnectorNextLogSeverity = 'debug' | 'info' | 'warn' | 'error';

export interface ConnectorNextTarget {
  agentId: string;
  deviceId: string;
  connectorInstanceId: string;
}

export interface ConnectorNextExecutionPrincipal {
  kind: 'os_user';
  subjectHash: string;
  processName: typeof CONNECTOR_NEXT_AGENT_PROCESS | typeof CONNECTOR_NEXT_UPDATER_PROCESS | typeof CONNECTOR_NEXT_BOOTSTRAP_PROCESS | typeof CONNECTOR_NEXT_INSTALLER_PROCESS;
}

export interface ConnectorNextDescriptor extends ConnectorNextTarget {
  productId: typeof CONNECTOR_NEXT_PRODUCT_ID;
  protocolId: typeof CONNECTOR_NEXT_PROTOCOL_ID;
  version: string;
  sequence: number;
  generation: number;
  capabilities: string[];
  executionPrincipal: ConnectorNextExecutionPrincipal;
}

export interface ConnectorNextPackBinding {
  connectorId: string;
  sessionGeneration: number;
  engagementId: string;
  authorityInstanceId: string;
  tenantOrOrgId: string;
  packId: string;
}

export type ConnectorNextOperationCommand =
  | 'pack.session.status'
  | 'pack.session.connect'
  | 'pack.session.refresh'
  | 'pack.workspace-authority.read'
  | 'operation.register'
  | 'operation.invoke'
  | 'shell.feature.snapshot.read'
  | 'shell.feature.action.invoke'
  | 'shell.runtime.restart-with-control';

/**
 * Generic Shell/Core -> Connector Next operation. Feature-specific commands
 * remain inside the signed Operation invocation carried in `input`.
 */
export interface ConnectorNextOperationEnvelope {
  schemaVersion: typeof CONNECTOR_NEXT_OPERATION_ENVELOPE_SCHEMA;
  requestId: string;
  target: ConnectorNextTarget;
  command: ConnectorNextOperationCommand;
  effect: ConnectorNextEffect;
  packBinding?: ConnectorNextPackBinding;
  input: Record<string, unknown>;
}

export interface ConnectorNextJob {
  schemaVersion: 'omnia.connector-next-job/v1';
  jobId: string;
  claimId: string;
  target: ConnectorNextTarget;
  operation: typeof CONNECTOR_NEXT_HEALTH_OPERATION | typeof CONNECTOR_NEXT_OPERATION_EXECUTE;
  effect: ConnectorNextEffect;
  payload: Record<string, unknown>;
  createdAt: string;
  deadlineAt: string;
}

export interface ConnectorNextLogInput {
  recordId: number;
  occurredAt: string;
  source: ConnectorNextLogSource;
  severity: ConnectorNextLogSeverity;
  event: string;
  details: Record<string, unknown>;
}

export interface ConnectorNextPackageFile {
  path: string;
  size: number;
  digest: string;
  contentBase64: string;
}

export interface ConnectorNextPackage {
  schemaVersion: typeof CONNECTOR_NEXT_PACKAGE_SCHEMA;
  productId: typeof CONNECTOR_NEXT_PRODUCT_ID;
  protocolId: typeof CONNECTOR_NEXT_PROTOCOL_ID;
  version: string;
  sequence: number;
  entrypoint: string;
  updaterEntrypoint: string;
  runtimeEntrypoint: string;
  files: ConnectorNextPackageFile[];
}

export interface ConnectorNextUpdateManifestUnsigned {
  schemaVersion: typeof CONNECTOR_NEXT_UPDATE_SCHEMA;
  productId: typeof CONNECTOR_NEXT_PRODUCT_ID;
  protocolId: typeof CONNECTOR_NEXT_PROTOCOL_ID;
  artifactId: string;
  version: string;
  sequence: number;
  minimumUpdaterVersion: string;
  packageDigest: string;
  packageSize: number;
  signingKeyId: string;
  createdAt: string;
}

export interface ConnectorNextUpdateManifest extends ConnectorNextUpdateManifestUnsigned {
  signature: string;
}

export type ConnectorNextUpdateStatus =
  | 'offered'
  | 'downloading'
  | 'verified'
  | 'staged'
  | 'waiting_safe_window'
  | 'activating'
  | 'probation'
  | 'succeeded'
  | 'failed'
  | 'rolled_back';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;

export function assertIdentifier(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new Error(`CONNECTOR_NEXT.INVALID_${name.toUpperCase()}`);
}

export function assertSemver(value: unknown, name = 'version'): asserts value is string {
  if (typeof value !== 'string' || !SEMVER.test(value)) throw new Error(`CONNECTOR_NEXT.INVALID_${name.toUpperCase()}`);
}

export function assertDigest(value: unknown, name = 'digest'): asserts value is string {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(`CONNECTOR_NEXT.INVALID_${name.toUpperCase()}`);
}

export function assertTarget(value: unknown): asserts value is ConnectorNextTarget {
  if (!value || typeof value !== 'object') throw new Error('CONNECTOR_NEXT.INVALID_TARGET');
  const candidate = value as Record<string, unknown>;
  assertIdentifier(candidate.agentId, 'agent_id');
  assertIdentifier(candidate.deviceId, 'device_id');
  assertIdentifier(candidate.connectorInstanceId, 'connector_instance_id');
}

export function sameTarget(left: ConnectorNextTarget, right: ConnectorNextTarget): boolean {
  return left.agentId === right.agentId
    && left.deviceId === right.deviceId
    && left.connectorInstanceId === right.connectorInstanceId;
}

export function samePackBinding(left: ConnectorNextPackBinding, right: ConnectorNextPackBinding): boolean {
  return left.connectorId === right.connectorId
    && left.sessionGeneration === right.sessionGeneration
    && left.engagementId === right.engagementId
    && left.authorityInstanceId === right.authorityInstanceId
    && left.tenantOrOrgId === right.tenantOrOrgId
    && left.packId === right.packId;
}

export function assertPackBinding(value: unknown): asserts value is ConnectorNextPackBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CONNECTOR_NEXT.INVALID_PACK_BINDING');
  const binding = value as Record<string, unknown>;
  assertIdentifier(binding.connectorId, 'connector_id');
  if (!Number.isSafeInteger(binding.sessionGeneration) || Number(binding.sessionGeneration) < 1) throw new Error('CONNECTOR_NEXT.INVALID_SESSION_GENERATION');
  for (const key of ['engagementId', 'authorityInstanceId', 'packId'] as const) {
    if (typeof binding[key] !== 'string' || binding[key].length < 1 || binding[key].length > 512) throw new Error(`CONNECTOR_NEXT.INVALID_${key.toUpperCase()}`);
  }
  if (typeof binding.tenantOrOrgId !== 'string' || binding.tenantOrOrgId.length > 512) throw new Error('CONNECTOR_NEXT.INVALID_TENANT_OR_ORG_ID');
}

export function assertOperationEnvelope(value: unknown): asserts value is ConnectorNextOperationEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CONNECTOR_NEXT.INVALID_OPERATION_ENVELOPE');
  const envelope = value as Record<string, unknown>;
  if (envelope.schemaVersion !== CONNECTOR_NEXT_OPERATION_ENVELOPE_SCHEMA) throw new Error('CONNECTOR_NEXT.INVALID_OPERATION_ENVELOPE_SCHEMA');
  assertIdentifier(envelope.requestId, 'request_id');
  assertTarget(envelope.target);
  if (!['pack.session.status', 'pack.session.connect', 'pack.session.refresh', 'pack.workspace-authority.read', 'operation.register', 'operation.invoke', 'shell.feature.snapshot.read', 'shell.feature.action.invoke', 'shell.runtime.restart-with-control'].includes(String(envelope.command))) {
    throw new Error('CONNECTOR_NEXT.INVALID_OPERATION_COMMAND');
  }
  if (!['read_only', 'mutation'].includes(String(envelope.effect))) throw new Error('CONNECTOR_NEXT.INVALID_OPERATION_EFFECT');
  if (!envelope.input || typeof envelope.input !== 'object' || Array.isArray(envelope.input)) throw new Error('CONNECTOR_NEXT.INVALID_OPERATION_INPUT');
  const actionEffect = (envelope.input as Record<string, unknown>).expectedActionEffect;
  const mutationInvocation = (envelope.command === 'operation.invoke'
    && (envelope.input as Record<string, unknown>).mutationAuthorized === true)
    || (envelope.command === 'shell.feature.action.invoke'
      && ['local_state_write', 'omnia_mutation'].includes(String(actionEffect)))
    || envelope.command === 'shell.runtime.restart-with-control';
  if ((envelope.effect === 'mutation') !== mutationInvocation) throw new Error('CONNECTOR_NEXT.OPERATION_EFFECT_MISMATCH');
  const bindingRequired = ['pack.workspace-authority.read', 'operation.register', 'operation.invoke', 'shell.feature.snapshot.read', 'shell.feature.action.invoke'].includes(String(envelope.command));
  if (bindingRequired || envelope.packBinding !== undefined) assertPackBinding(envelope.packBinding);
}

export function newTarget(prefix = 'ocn'): ConnectorNextTarget {
  return {
    agentId: `${prefix}.agent.${randomUUID()}`,
    deviceId: `${prefix}.device.${randomUUID()}`,
    connectorInstanceId: `${prefix}.instance.${randomUUID()}`
  };
}

export function newEnrollmentCode(): string {
  return `NC3-${randomBytes(18).toString('base64url')}`;
}

export function newAgentToken(): string {
  return `ocn3_${randomBytes(32).toString('base64url')}`;
}

export function sha256(input: string | Buffer): string {
  return `sha256:${createHash('sha256').update(input).digest('hex')}`;
}

export function opaqueHash(input: string): string {
  return createHash('sha256').update(`connector-next/v3\0${input}`).digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

export function unsignedManifest(manifest: ConnectorNextUpdateManifest): ConnectorNextUpdateManifestUnsigned {
  const { signature: _signature, ...unsigned } = manifest;
  return unsigned;
}
