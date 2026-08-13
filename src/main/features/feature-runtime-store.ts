import { randomUUID } from 'node:crypto';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AppError } from '../../shared/errors.js';
import type { ProductPaths } from '../paths.js';
import type { FeatureReviewValidationCommit } from '../../shared/feature-contracts.js';
import type {
  FeatureWorkerInterruption,
  FeatureWorkerInterruptionResult,
  FeatureWorkerPortContext
} from './worker-supervisor.js';

function now(): string { return new Date().toISOString(); }

const FEATURE_ISSUE_TYPES = new Set([
  'missing', 'conflict', 'ambiguous', 'invalid_enum', 'digest_mismatch',
  'contract_mismatch', 'visual_unverified', 'quality_warning'
]);
const FEATURE_ISSUE_STATES = new Set(['needs_input', 'resolved', 'waived', 'blocking']);

function featureIssueIdentity(value: Record<string, any>): { issueType: string; state: string } {
  const issueType = String(value.issueType || '');
  const state = String(value.state || 'needs_input');
  if (!FEATURE_ISSUE_TYPES.has(issueType)) throw new Error(`Feature issue type is invalid: ${issueType || '(empty)'}.`);
  if (!FEATURE_ISSUE_STATES.has(state)) throw new Error(`Feature issue state is invalid: ${state || '(empty)'}.`);
  return { issueType, state };
}

function object(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is invalid.`);
  return value as Record<string, any>;
}
function returnAuthorityBinding(value: unknown, label: string): Record<string, any> {
  const binding = object(value, label);
  return { ...binding, tenantOrOrgId: String(binding.tenantOrOrgId || '') };
}
function normalizedExternalIdentity(value: unknown): string {
  return String(value || '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('en-US');
}
function canonical(value: unknown): string {
  if (value === null || ['boolean', 'string', 'number'].includes(typeof value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!value || typeof value !== 'object') throw new Error('Canonical payload contains an unsupported value.');
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

export type FeatureRuntimeStorePermission = 'read' | 'local_write' | 'omnia_mutation';
export type FeatureRuntimeStoreOwner =
  | 'feature_context'
  | 'feature_private_store'
  | 'current_run'
  | 'current_run_optional_command'
  | 'optional_current_run'
  | 'same_feature_run'
  | 'optional_same_feature_run'
  | 'current_command'
  | 'same_feature_command'
  | 'same_feature_artifact';

export interface FeatureRuntimeStorePortPolicy {
  permission: FeatureRuntimeStorePermission;
  owner: FeatureRuntimeStoreOwner;
  identityField?: 'runId' | 'predecessorRunId';
}

/**
 * Core-owned Store capabilities. Signed Feature contracts may select a strict
 * subset of these methods, but cannot invent methods or weaken their mutation
 * and owner requirements. The policy is deliberately Feature-ID agnostic.
 */
export const FEATURE_RUNTIME_STORE_PORT_POLICIES: Readonly<Record<string, FeatureRuntimeStorePortPolicy>> = Object.freeze({
  upsertManagedContent: { permission: 'local_write', owner: 'feature_context' },
  readArtifactBytes: { permission: 'read', owner: 'same_feature_artifact' },
  readManagedAssetBytes: { permission: 'read', owner: 'feature_context' },
  createProcessingRun: { permission: 'local_write', owner: 'feature_context' },
  createSuccessorProcessingRun: { permission: 'local_write', owner: 'same_feature_run', identityField: 'predecessorRunId' },
  loadProcessingRun: { permission: 'read', owner: 'optional_same_feature_run' },
  finishProcessingRun: { permission: 'local_write', owner: 'current_run' },
  failProcessingRun: { permission: 'local_write', owner: 'same_feature_run' },
  beginPythonInputTransfer: { permission: 'local_write', owner: 'current_run' },
  appendPythonInputTransferChunk: { permission: 'local_write', owner: 'feature_context' },
  commitPythonInputTransfer: { permission: 'local_write', owner: 'feature_context' },
  abortPythonInputTransfer: { permission: 'local_write', owner: 'feature_context' },
  openPythonArtifactHandle: { permission: 'read', owner: 'current_run' },
  createPythonJsonInputHandle: { permission: 'local_write', owner: 'current_run' },
  createPythonOutputHandle: { permission: 'local_write', owner: 'current_run' },
  readPythonJsonHandle: { permission: 'read', owner: 'feature_context' },
  commitPythonOutputHandle: { permission: 'local_write', owner: 'feature_context' },
  releasePythonArtifactHandles: { permission: 'local_write', owner: 'feature_context' },
  commitArtifact: { permission: 'local_write', owner: 'current_run' },
  inspectLegacyReturnRecovery: { permission: 'read', owner: 'optional_same_feature_run' },
  authorizeLegacyReturnRecovery: { permission: 'local_write', owner: 'same_feature_run' },
  recordLegacyReturnRecoveryOutcome: { permission: 'local_write', owner: 'same_feature_command' },
  closeLegacyPartialReturn: { permission: 'local_write', owner: 'same_feature_run' },
  closeLegacyFrozenInputRecovery: { permission: 'local_write', owner: 'same_feature_run' },
  proveOwnedCreatedObject: { permission: 'read', owner: 'feature_context' },
  beginStandaloneArtifactTransfer: { permission: 'local_write', owner: 'feature_context' },
  appendStandaloneArtifactTransferChunk: { permission: 'local_write', owner: 'feature_context' },
  commitStandaloneArtifactTransfer: { permission: 'local_write', owner: 'feature_context' },
  abortStandaloneArtifactTransfer: { permission: 'local_write', owner: 'feature_context' },
  commitStandaloneArtifact: { permission: 'local_write', owner: 'feature_context' },
  recordTemplateMetadata: { permission: 'local_write', owner: 'current_run' },
  loadLatestRun: { permission: 'read', owner: 'feature_context' },
  loadOpenRun: { permission: 'read', owner: 'feature_context' },
  createMutationRun: { permission: 'local_write', owner: 'feature_context' },
  transitionRun: { permission: 'local_write', owner: 'current_run' },
  recordFieldRevisions: { permission: 'local_write', owner: 'current_run' },
  recordIssues: { permission: 'local_write', owner: 'current_run' },
  loadRunReview: { permission: 'read', owner: 'current_run' },
  applyIssueRevisions: { permission: 'local_write', owner: 'current_run' },
  commitReviewValidation: { permission: 'local_write', owner: 'current_run' },
  returnRunToReview: { permission: 'local_write', owner: 'current_run' },
  restartRun: { permission: 'local_write', owner: 'current_run' },
  prepareReturnIntent: { permission: 'local_write', owner: 'current_run' },
  approveReturnIntent: { permission: 'omnia_mutation', owner: 'feature_context' },
  prepareReturnCommand: { permission: 'omnia_mutation', owner: 'current_run' },
  bindMutationReservationEvidence: { permission: 'omnia_mutation', owner: 'current_command' },
  prepareDeletionCommand: { permission: 'omnia_mutation', owner: 'current_run' },
  freezeReturnEvidenceSpec: { permission: 'local_write', owner: 'current_command' },
  recordReturnEvidence: { permission: 'local_write', owner: 'current_command' },
  projectVerifiedReturn: { permission: 'local_write', owner: 'current_command' },
  projectVerifiedDeletion: { permission: 'local_write', owner: 'current_command' },
  projectVerifiedDeletionCascade: { permission: 'local_write', owner: 'current_command' },
  finishReturn: { permission: 'local_write', owner: 'current_run' },
  recordBootstrapCapabilityEvidence: { permission: 'omnia_mutation', owner: 'current_run' },
  getCapabilityEvidenceState: { permission: 'read', owner: 'feature_context' },
  validateReturnAuthority: { permission: 'read', owner: 'current_run' },
  loadReturnProgress: { permission: 'read', owner: 'current_run' },
  saveReturnReconcileSpec: { permission: 'local_write', owner: 'current_command' },
  loadReturnReconcileSpec: { permission: 'read', owner: 'current_run_optional_command' },
  savePlan: { permission: 'local_write', owner: 'feature_private_store' },
  compareAndSwapPlan: { permission: 'local_write', owner: 'feature_private_store' },
  loadPlan: { permission: 'read', owner: 'feature_private_store' },
  appendEvidence: { permission: 'local_write', owner: 'feature_private_store' }
});

export function isFeatureRuntimeStorePort(method: string): boolean {
  return Object.prototype.hasOwnProperty.call(FEATURE_RUNTIME_STORE_PORT_POLICIES, method);
}

const MAX_RUNTIME_PLAN_BYTES = 1024 * 1024;
const MAX_RUNTIME_PLAN_DEPTH = 64;

function assertRuntimePlanJson(value: unknown, depth = 0): void {
  if (depth > MAX_RUNTIME_PLAN_DEPTH) {
    throw new AppError('FEATURE.PLAN_CAS_INVALID', 'Feature plan exceeds the maximum JSON nesting depth.');
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new AppError('FEATURE.PLAN_CAS_INVALID', 'Feature plan contains a non-JSON-safe number.');
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertRuntimePlanJson(item, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new AppError('FEATURE.PLAN_CAS_INVALID', 'Feature plan must contain only plain JSON values.');
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new AppError('FEATURE.PLAN_CAS_INVALID', 'Feature plan contains a non-JSON property.');
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!key) throw new AppError('FEATURE.PLAN_CAS_INVALID', 'Feature plan contains an empty property name.');
    assertRuntimePlanJson(item, depth + 1);
  }
}

function serializeRuntimePlan(plan: Record<string, unknown>): string {
  assertRuntimePlanJson(plan);
  const encoded = JSON.stringify(plan);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_RUNTIME_PLAN_BYTES) {
    throw new AppError('FEATURE.PLAN_PAYLOAD_TOO_LARGE', 'Feature plan exceeds the 1 MiB Runtime Store limit.');
  }
  return encoded;
}

function runtimePlanRevision(plan: Record<string, unknown>): number {
  if (!Object.prototype.hasOwnProperty.call(plan, 'storeRevision')) return 0;
  if (!Number.isSafeInteger(plan.storeRevision) || Number(plan.storeRevision) < 1) {
    throw new AppError('FEATURE.PLAN_STORE_CORRUPT', 'Stored Feature plan has an invalid storeRevision.');
  }
  return Number(plan.storeRevision);
}

function canonicalDigest(value: unknown): string {
  return crypto.createHash('sha256').update(canonical(value)).digest('hex');
}

function sha256FileSync(filename: string): string {
  const handle = fs.openSync(filename, 'r');
  const digest = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const length = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (length === 0) break;
      digest.update(buffer.subarray(0, length));
    }
  } finally { fs.closeSync(handle); }
  return digest.digest('hex');
}

function exactRecordKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new Error(`${label} contains an unexpected or missing field.`);
  }
}

interface GraCascadeRiskIdentity {
  riskId: string;
  riskRiskScopeId: string;
  riskScopeId: string;
  updatedOn: string;
}
interface GraCascadeControlIdentity {
  controlId: string;
  workItemId: string;
  updatedOn: string;
}
interface GraCascadeRiskControlIdentity {
  riskId: string;
  riskRiskScopeId: string;
  riskScopeId: string;
  controlId: string;
}
interface GraCascadeIdentitySnapshot {
  schemaVersion: 'omnia.delete.gra-cascade-snapshot/v1';
  assessment: { riskAssessmentId: string; workItemId: string; workspaceId: string; updatedOn: string };
  risks: GraCascadeRiskIdentity[];
  controls: GraCascadeControlIdentity[];
  riskControls: GraCascadeRiskControlIdentity[];
}

function parseGraCascadeSnapshot(value: unknown, requireDeleted: boolean): {
  identity: GraCascadeIdentitySnapshot;
  snapshotDigest: string;
} {
  const snapshot = object(value, requireDeleted ? 'Deletion cascade readback snapshot' : 'Frozen deletion cascade snapshot');
  exactRecordKeys(snapshot, ['schemaVersion', 'assessment', 'risks', 'controls', 'riskControls', 'snapshotDigest'], 'Deletion cascade snapshot');
  if (snapshot.schemaVersion !== 'omnia.delete.gra-cascade-snapshot/v1') {
    throw new Error('Deletion cascade snapshot schema is invalid.');
  }
  const assessment = object(snapshot.assessment, 'Deletion cascade assessment identity');
  exactRecordKeys(assessment, ['riskAssessmentId', 'workItemId', 'workspaceId', 'updatedOn'], 'Deletion cascade assessment identity');
  const assessmentIdentity = {
    riskAssessmentId: String(assessment.riskAssessmentId || ''),
    workItemId: String(assessment.workItemId || ''),
    workspaceId: String(assessment.workspaceId || ''),
    updatedOn: String(assessment.updatedOn || '')
  };
  if (Object.values(assessmentIdentity).some((field) => !field)) throw new Error('Deletion cascade assessment identity is incomplete.');
  const parseRows = <T extends object>(
    raw: unknown,
    fields: string[],
    label: string,
    key: (row: T) => string
  ): T[] => {
    if (!Array.isArray(raw) || raw.length > 2_000) throw new Error(`${label} inventory is invalid.`);
    const rows = raw.map((entry) => {
      const row = object(entry, label);
      const statusFields = requireDeleted
        ? ['deleted', 'absent'].filter((field) => Object.prototype.hasOwnProperty.call(row, field))
        : [];
      exactRecordKeys(row, [...fields, ...statusFields], label);
      if (requireDeleted) {
        if (statusFields.length !== 1 || (row.deleted !== true && row.absent !== true)) {
          throw new Error(`${label} is not proven deleted or absent by authoritative readback.`);
        }
      }
      const identity = Object.fromEntries(fields.map((field) => [field, String(row[field] || '')])) as T;
      if (Object.values(identity).some((field) => !field)) throw new Error(`${label} identity is incomplete.`);
      return identity;
    });
    const sorted = [...rows].sort((left, right) => key(left).localeCompare(key(right)));
    const keys = sorted.map(key);
    if (new Set(keys).size !== keys.length) throw new Error(`${label} contains a duplicate identity.`);
    if (canonical(rows) !== canonical(sorted)) throw new Error(`${label} is not in canonical order.`);
    return rows;
  };
  const risks = parseRows<GraCascadeRiskIdentity>(snapshot.risks,
    ['riskId', 'riskRiskScopeId', 'riskScopeId', 'updatedOn'], 'Deletion cascade Risk',
    (row) => `${row.riskId}\u0000${row.riskRiskScopeId}`);
  const controls = parseRows<GraCascadeControlIdentity>(snapshot.controls,
    ['controlId', 'workItemId', 'updatedOn'], 'Deletion cascade Control',
    (row) => `${row.controlId}\u0000${row.workItemId}`);
  const riskControls = parseRows<GraCascadeRiskControlIdentity>(snapshot.riskControls,
    ['riskId', 'riskRiskScopeId', 'riskScopeId', 'controlId'],
    'Deletion cascade Risk-Control',
    (row) => `${row.riskId}\u0000${row.riskRiskScopeId}\u0000${row.riskScopeId}\u0000${row.controlId}`);
  const identity: GraCascadeIdentitySnapshot = {
    schemaVersion: 'omnia.delete.gra-cascade-snapshot/v1',
    assessment: assessmentIdentity,
    risks,
    controls,
    riskControls
  };
  const snapshotDigest = String(snapshot.snapshotDigest || '');
  if (!/^[0-9a-f]{64}$/u.test(snapshotDigest) || canonicalDigest(identity) !== snapshotDigest) {
    throw new Error('Deletion cascade snapshot digest does not match its exact identity inventory.');
  }
  return { identity, snapshotDigest };
}

export class FeatureRuntimeStore {
  private readonly pythonArtifactHandles = new Map<string, {
    featureId: string;
    featureVersion: string;
    runId: string;
    filename: string;
    access: 'read' | 'write';
    kind: string;
    mediaType: string;
    originalName: string;
    maxBytes: number;
  }>();
  private readonly standaloneArtifactTransfers = new Map<string, {
    featureId: string;
    featureVersion: string;
    kind: 'result' | 'evidence';
    surfaceId: string;
    engagementId: string;
    originalName: string;
    mediaType: string;
    sourceRef: string;
    expectedSizeBytes: number;
    expectedSha256: string;
    chunkCount: number;
    nextChunkIndex: number;
    receivedBytes: number;
    filename: string;
    digest: ReturnType<typeof crypto.createHash>;
  }>();
  private readonly pythonInputTransfers = new Map<string, {
    featureId: string;
    featureVersion: string;
    runId: string;
    originalName: string;
    mediaType: string;
    expectedSizeBytes: number;
    expectedSha256: string;
    chunkCount: number;
    nextChunkIndex: number;
    receivedBytes: number;
    filename: string;
    digest: ReturnType<typeof crypto.createHash>;
  }>();

  constructor(
    private readonly core: DatabaseSync,
    private readonly paths: ProductPaths
  ) {}

  private currentActivationOwnsRun(runId: string, context: FeatureWorkerPortContext): boolean {
    return Boolean(this.core.prepare(`
      WITH RECURSIVE lineage(feature_version,package_digest,activation_generation) AS (
        SELECT r.feature_version,'',0
        FROM feature_runs r
        WHERE r.run_id=? AND r.feature_id=?
        UNION
        SELECT h.target_feature_version,h.target_package_digest,h.target_activation_generation
        FROM lineage l
        JOIN feature_operation_handoffs h
          ON h.feature_id=? AND h.source_feature_version=l.feature_version
        WHERE h.phase IN ('finalize_pending','finalized')
      )
      SELECT 1
      FROM lineage l
      WHERE (
        l.feature_version=?
        AND EXISTS (
          SELECT 1 FROM feature_activation_heads a
          WHERE a.feature_id=? AND a.feature_version=l.feature_version
            AND (l.package_digest='' OR (
              a.package_digest=l.package_digest
              AND a.activation_generation=l.activation_generation
            ))
        )
      ) OR EXISTS (
        SELECT 1
        FROM feature_operation_handoffs h
        JOIN feature_activation_heads a
          ON a.feature_id=h.feature_id
         AND a.feature_version=h.source_feature_version
         AND a.package_digest=h.source_package_digest
         AND a.activation_generation=h.source_activation_generation
        WHERE h.feature_id=?
          AND h.source_feature_version=l.feature_version
          AND h.target_feature_version=?
          AND h.phase IN ('staged','prepared','committed','finalize_pending')
      )
      LIMIT 1
    `).get(
      runId,
      context.featureId,
      context.featureId,
      context.featureVersion,
      context.featureId,
      context.featureId,
      context.featureVersion
    ));
  }

  private runLineageIncludesVersion(runId: string, featureId: string, featureVersion: string): boolean {
    return Boolean(this.core.prepare(`
      WITH RECURSIVE lineage(feature_version) AS (
        SELECT r.feature_version
        FROM feature_runs r
        WHERE r.run_id=? AND r.feature_id=?
        UNION
        SELECT h.target_feature_version
        FROM lineage l
        JOIN feature_operation_handoffs h
          ON h.feature_id=? AND h.source_feature_version=l.feature_version
        WHERE h.phase IN ('finalize_pending','finalized')
      )
      SELECT 1 FROM lineage WHERE feature_version=? LIMIT 1
    `).get(runId, featureId, featureId, featureVersion));
  }

  recoverWorkerInterruption(
    input: FeatureWorkerInterruption,
    context: FeatureWorkerPortContext
  ): FeatureWorkerInterruptionResult {
    if (input.schemaVersion !== 'omnia.feature-worker-interruption/v1' || input.effect !== 'omnia_mutation') {
      throw new Error('Feature worker interruption contract is invalid.');
    }
    const requestedRunId = String(input.runId || '');
    const candidates = requestedRunId
      ? this.core.prepare(`
          SELECT run_id,state,state_revision FROM feature_runs
          WHERE run_id=? AND feature_id=? AND feature_version=?
        `).all(requestedRunId, context.featureId, context.featureVersion) as Array<{ run_id: string; state: string; state_revision: number }>
      : this.core.prepare(`
          SELECT run_id,state,state_revision FROM feature_runs
          WHERE feature_id=? AND feature_version=?
            AND state IN ('waiting_confirmation','returning','verifying','uncertain','reconciling')
          ORDER BY updated_at DESC,created_at DESC,rowid DESC
        `).all(context.featureId, context.featureVersion) as Array<{ run_id: string; state: string; state_revision: number }>;
    if (candidates.length !== 1) {
      return {
        schemaVersion: 'omnia.feature-worker-interruption-result/v1',
        classification: 'unresolved', retryable: false, effectState: 'possibly_started',
        runId: requestedRunId, commandIds: input.commandId ? [String(input.commandId)] : []
      };
    }
    const run = candidates[0]!;
    const commands = this.core.prepare(`
      SELECT command_id,intent_id,state,submitted_at,commit_point_at
      FROM feature_commands WHERE run_id=? ORDER BY created_at,command_id
    `).all(run.run_id) as Array<{
      command_id: string; intent_id: string; state: string; submitted_at: string; commit_point_at: string;
    }>;
    const hazardous = commands.filter((command) =>
      ['submitted', 'committed', 'verifying', 'uncertain'].includes(command.state)
      || Boolean(command.submitted_at) || Boolean(command.commit_point_at)
    ).filter((command) => !['readback_verified', 'closed_not_applied'].includes(command.state));
    if (hazardous.length > 0) {
      const occurredAt = now();
      const fromState = run.state;
      this.core.exec('BEGIN IMMEDIATE;');
      try {
        for (const command of hazardous) {
          this.core.prepare(`
            UPDATE feature_commands
            SET state='uncertain',last_error=?
            WHERE command_id=? AND run_id=?
              AND state NOT IN ('readback_verified','closed_not_applied')
          `).run('Worker/sidecar interruption after mutation submission; verified read-back is absent and automatic replay is forbidden.', command.command_id, run.run_id);
          this.core.prepare(`
            UPDATE managed_content_intents SET state='uncertain',updated_at=?
            WHERE intent_id=? AND state<>'verified'
          `).run(occurredAt, command.intent_id);
        }
        const transition = this.core.prepare(`
          UPDATE feature_runs
          SET state='uncertain',state_revision=state_revision+1,last_error=?,updated_at=?
          WHERE run_id=? AND feature_id=? AND feature_version=? AND state<>'uncertain'
        `).run(
          'Mutation worker/sidecar interruption occurred after durable submission but before verified read-back; read-only reconcile is required.',
          occurredAt, run.run_id, context.featureId, context.featureVersion
        );
        if (transition.changes === 1) {
          this.core.prepare(`
            INSERT INTO feature_run_events(event_id,run_id,revision,from_state,to_state,event_type,details_json,occurred_at)
            SELECT ?,run_id,state_revision,?,'uncertain','return.worker_interruption_uncertain',?,?
            FROM feature_runs WHERE run_id=?
          `).run(
            randomUUID(), fromState,
            JSON.stringify({
              reason: input.reason,
              actionId: input.actionId,
              invocationId: input.invocationId,
              commandIds: hazardous.map((command) => command.command_id),
              retryable: false,
              effectState: 'possibly_started'
            }),
            occurredAt, run.run_id
          );
        }
        this.core.exec('COMMIT;');
      } catch (error) {
        this.core.exec('ROLLBACK;');
        throw error;
      }
      return {
        schemaVersion: 'omnia.feature-worker-interruption-result/v1',
        classification: 'uncertain', retryable: false, effectState: 'possibly_started',
        runId: run.run_id, commandIds: hazardous.map((command) => command.command_id)
      };
    }
    const allDurablyClosed = commands.length > 0
      && commands.every((command) => ['readback_verified', 'closed_not_applied'].includes(command.state));
    if (allDurablyClosed) {
      return {
        schemaVersion: 'omnia.feature-worker-interruption-result/v1',
        classification: 'completed', retryable: false, effectState: 'completed',
        runId: run.run_id, commandIds: commands.map((command) => command.command_id)
      };
    }
    const occurredAt = now();
    this.core.exec('BEGIN IMMEDIATE;');
    try {
      this.core.prepare(`
        UPDATE feature_runs SET state_revision=state_revision+1,last_error=?,updated_at=?
        WHERE run_id=? AND feature_id=? AND feature_version=?
      `).run(
        'Mutation worker/sidecar interruption was recovered before durable submission; automatic replay is forbidden and explicit continuation is required.',
        occurredAt, run.run_id, context.featureId, context.featureVersion
      );
      this.core.prepare(`
        INSERT INTO feature_run_events(event_id,run_id,revision,from_state,to_state,event_type,details_json,occurred_at)
        SELECT ?,run_id,state_revision,state,state,'return.worker_interruption_pre_submit',?,?
        FROM feature_runs WHERE run_id=?
      `).run(
        randomUUID(),
        JSON.stringify({
          reason: input.reason,
          actionId: input.actionId,
          invocationId: input.invocationId,
          commandIds: commands.map((command) => command.command_id),
          retryable: false,
          effectState: 'not_started'
        }),
        occurredAt, run.run_id
      );
      this.core.exec('COMMIT;');
    } catch (error) {
      this.core.exec('ROLLBACK;');
      throw error;
    }
    return {
      schemaVersion: 'omnia.feature-worker-interruption-result/v1',
      classification: 'not_started', retryable: false, effectState: 'not_started',
      runId: run.run_id, commandIds: commands.map((command) => command.command_id)
    };
  }

  private open(featureId: string): DatabaseSync {
    const database = new DatabaseSync(path.join(this.paths.data, 'features', featureId, 'store.sqlite'));
    database.exec(`
      PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS "__runtime_plans" (
        plan_id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS "__runtime_evidence" (
        evidence_id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        checkpoint TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
    `);
    return database;
  }

  private runtimePlanTables(store: DatabaseSync): string[] {
    const tables = store.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type='table' AND name NOT LIKE 'sqlite_%'
      ORDER BY CASE WHEN name='__runtime_plans' THEN 0 ELSE 1 END, name
    `).all() as Array<{ name: string }>;
    return tables.map((row) => row.name).filter((table) => {
      const quoted = `"${table.replaceAll('"', '""')}"`;
      const columns = store.prepare(`PRAGMA table_info(${quoted})`).all() as Array<{ name: string }>;
      const names = new Set(columns.map((column) => column.name));
      return columns.length === 3
        && names.has('plan_id') && names.has('payload_json') && names.has('updated_at');
    });
  }

  private findRuntimePlan(store: DatabaseSync, planId: string): { table: string; payload_json: string; updated_at: string } | undefined {
    return this.runtimePlanTables(store).flatMap((table) => {
      const quoted = `"${table.replaceAll('"', '""')}"`;
      const row = store.prepare(`SELECT payload_json,updated_at FROM ${quoted} WHERE plan_id=?`).get(planId) as {
        payload_json: string;
        updated_at: string;
      } | undefined;
      return row ? [{ table, ...row }] : [];
    }).sort((left, right) => right.updated_at.localeCompare(left.updated_at))[0];
  }

  private assertPortPolicy(method: string, input: unknown, context: FeatureWorkerPortContext): void {
    const policy = FEATURE_RUNTIME_STORE_PORT_POLICIES[method];
    if (!policy) {
      throw new AppError('FEATURE.STORE_PORT_UNKNOWN', `Feature Store method is not a Core capability: ${method}`);
    }
    if (policy.permission === 'omnia_mutation' && !context.allowMutation) {
      throw new AppError('FEATURE.STORE_MUTATION_AUTHORITY_REQUIRED', `${method} requires an authorized Omnia mutation action.`);
    }
    if (policy.owner === 'feature_context' || policy.owner === 'feature_private_store') return;
    const request = input && typeof input === 'object' && !Array.isArray(input)
      ? input as Record<string, unknown>
      : {};
    if (policy.owner === 'same_feature_artifact') {
      const artifactId = String(request.artifactId || '');
      if (!artifactId || !this.core.prepare(`SELECT 1 FROM feature_artifacts WHERE artifact_id=? AND feature_id=?`)
        .get(artifactId, context.featureId)) {
        throw new AppError('FEATURE.STORE_OWNER_MISMATCH', 'Feature Artifact is not owned by the active Feature.');
      }
      return;
    }
    const runId = String(request[policy.identityField || 'runId'] || '');
    if ((policy.owner === 'optional_current_run' || policy.owner === 'optional_same_feature_run') && !runId) return;
    if (!runId) throw new AppError('FEATURE.STORE_OWNER_MISMATCH', `${method} requires an owned Run identity.`);
    if (policy.owner === 'current_run' || policy.owner === 'current_run_optional_command' || policy.owner === 'optional_current_run') {
      if (!this.currentActivationOwnsRun(runId, context)) {
        throw new AppError('FEATURE.STORE_OWNER_MISMATCH', 'Feature Run is not owned by the active Feature version.');
      }
      if (policy.owner !== 'current_run_optional_command') return;
    }
    if (policy.owner === 'same_feature_run' || policy.owner === 'optional_same_feature_run') {
      if (!this.core.prepare(`SELECT 1 FROM feature_runs WHERE run_id=? AND feature_id=?`)
        .get(runId, context.featureId)) {
        throw new AppError('FEATURE.STORE_OWNER_MISMATCH', 'Feature Run is not owned by the active Feature.');
      }
      return;
    }
    const commandId = String(request.commandId || '');
    if (policy.owner === 'current_run_optional_command' && !commandId) return;
    if (!commandId) throw new AppError('FEATURE.STORE_OWNER_MISMATCH', `${method} requires an owned command identity.`);
    const exactVersion = policy.owner === 'current_command' || policy.owner === 'current_run_optional_command';
    if (!this.core.prepare(`
      SELECT 1 FROM feature_commands c
      JOIN feature_runs r ON r.run_id=c.run_id
      WHERE c.command_id=? AND c.run_id=? AND r.feature_id=?
    `).get(commandId, runId, context.featureId)
      || (exactVersion && !this.currentActivationOwnsRun(runId, context))) {
      throw new AppError('FEATURE.STORE_OWNER_MISMATCH', 'Feature command is not owned by the authorized Feature context.');
    }
  }

  call(method: string, input: unknown, context: FeatureWorkerPortContext): unknown {
    this.assertPortPolicy(method, input, context);
    if (method === 'upsertManagedContent') return this.upsertManagedContent(input, context);
    if (method === 'readArtifactBytes') return this.readArtifactBytes(input, context);
    if (method === 'readManagedAssetBytes') return this.readManagedAssetBytes(input, context);
    if (method === 'createProcessingRun') return this.createProcessingRun(input, context);
    if (method === 'createSuccessorProcessingRun') return this.createSuccessorProcessingRun(input, context);
    if (method === 'loadProcessingRun') return this.loadProcessingRun(input, context);
    if (method === 'finishProcessingRun') return this.finishProcessingRun(input, context);
    if (method === 'failProcessingRun') return this.failProcessingRun(input, context);
    if (method === 'beginPythonInputTransfer') return this.beginPythonInputTransfer(input, context);
    if (method === 'appendPythonInputTransferChunk') return this.appendPythonInputTransferChunk(input, context);
    if (method === 'commitPythonInputTransfer') return this.commitPythonInputTransfer(input, context);
    if (method === 'abortPythonInputTransfer') return this.abortPythonInputTransfer(input, context);
    if (method === 'openPythonArtifactHandle') return this.openPythonArtifactHandle(input, context);
    if (method === 'createPythonJsonInputHandle') return this.createPythonJsonInputHandle(input, context);
    if (method === 'createPythonOutputHandle') return this.createPythonOutputHandle(input, context);
    if (method === 'readPythonJsonHandle') return this.readPythonJsonHandle(input, context);
    if (method === 'commitPythonOutputHandle') return this.commitPythonOutputHandle(input, context);
    if (method === 'releasePythonArtifactHandles') return this.releasePythonArtifactHandles(input, context);
    if (method === 'commitArtifact') return this.commitArtifact(input, context);
    if (method === 'inspectLegacyReturnRecovery') return this.inspectLegacyReturnRecovery(input, context);
    if (method === 'authorizeLegacyReturnRecovery') return this.authorizeLegacyReturnRecovery(input, context);
    if (method === 'recordLegacyReturnRecoveryOutcome') return this.recordLegacyReturnRecoveryOutcome(input, context);
    if (method === 'closeLegacyPartialReturn') return this.closeLegacyPartialReturn(input, context);
    if (method === 'closeLegacyFrozenInputRecovery') return this.closeLegacyFrozenInputRecovery(input, context);
    if (method === 'proveOwnedCreatedObject') return this.proveOwnedCreatedObject(input, context);
    if (method === 'beginStandaloneArtifactTransfer') return this.beginStandaloneArtifactTransfer(input, context);
    if (method === 'appendStandaloneArtifactTransferChunk') return this.appendStandaloneArtifactTransferChunk(input, context);
    if (method === 'commitStandaloneArtifactTransfer') return this.commitStandaloneArtifactTransfer(input, context);
    if (method === 'abortStandaloneArtifactTransfer') return this.abortStandaloneArtifactTransfer(input, context);
    if (method === 'commitStandaloneArtifact') return this.commitStandaloneArtifact(input, context);
    if (method === 'recordTemplateMetadata') return this.recordTemplateMetadata(input, context);
    if (method === 'loadLatestRun') return this.loadLatestRun(context);
    if (method === 'loadOpenRun') return this.loadOpenRun(context);
    if (method === 'createMutationRun') return this.createMutationRun(input, context);
    if (method === 'transitionRun') return this.transitionRun(input, context);
    if (method === 'recordFieldRevisions') return this.recordFieldRevisions(input, context);
    if (method === 'recordIssues') return this.recordIssues(input, context);
    if (method === 'loadRunReview') return this.loadRunReview(input, context);
    if (method === 'applyIssueRevisions') return this.applyIssueRevisions(input, context);
    if (method === 'commitReviewValidation') return this.commitReviewValidation(input, context);
    if (method === 'returnRunToReview') return this.returnRunToReview(input, context);
    if (method === 'restartRun') return this.restartRun(input, context);
    if (method === 'prepareReturnIntent') return this.prepareReturnIntent(input, context);
    if (method === 'approveReturnIntent') return this.approveReturnIntent(input, context);
    if (method === 'prepareReturnCommand') return this.prepareReturnCommand(input, context);
    if (method === 'bindMutationReservationEvidence') return this.bindMutationReservationEvidence(input, context);
    if (method === 'prepareDeletionCommand') return this.prepareDeletionCommand(input, context);
    if (method === 'freezeReturnEvidenceSpec') return this.freezeReturnEvidenceSpec(input, context);
    if (method === 'recordReturnEvidence') return this.recordReturnEvidence(input, context);
    if (method === 'projectVerifiedReturn') return this.projectVerifiedReturn(input, context);
    if (method === 'projectVerifiedDeletion') return this.projectVerifiedDeletion(input, context);
    if (method === 'projectVerifiedDeletionCascade') return this.projectVerifiedDeletionCascade(input, context);
    if (method === 'finishReturn') return this.finishReturn(input, context);
    if (method === 'recordBootstrapCapabilityEvidence') return this.recordBootstrapCapabilityEvidence(input, context);
    if (method === 'getCapabilityEvidenceState') {
      const request=object(input,'Capability evidence lookup'); const binding=returnAuthorityBinding(request.connectorBinding,'Capability evidence binding');
      const workspaceIds=Array.isArray(request.workspaceIds)?[...new Set(request.workspaceIds.map(String))]:[];
      if(!binding.authorityInstanceId||!binding.packId||!binding.engagementId||workspaceIds.length<1)return{verified:false};
      const count=this.core.prepare(`SELECT COUNT(DISTINCT workspace_id) AS count FROM feature_capability_evidence WHERE feature_id=? AND feature_version=? AND scenario_id=? AND capability_id=? AND authority_instance_id=? AND tenant_or_org_id=? AND pack_contract_id=? AND engagement_id=? AND workspace_id IN (${workspaceIds.map(()=>'?').join(',')}) AND automated_status='passed' AND portable_status='passed' AND canary_status='passed' AND readback_status='passed' AND verified=1 AND revoked_at='' AND expires_at>?`).get(context.featureId,context.featureVersion,String(request.scenarioId||''),String(request.capabilityId||''),String(binding.authorityInstanceId),String(binding.tenantOrOrgId),String(binding.packId),String(binding.engagementId),...workspaceIds,now()) as {count:number};
      return{verified:count.count===workspaceIds.length};
    }
    if (method === 'validateReturnAuthority') return this.validateReturnAuthority(input, context);
    if (method === 'loadReturnProgress') {
      const request=object(input,'Return progress'); const runId=String(request.runId||'');
      if(!this.currentActivationOwnsRun(runId,context)) throw new Error('Return progress Run is not owned by this Feature.');
      return this.core.prepare(`
        SELECT i.target_key,i.target_kind,i.state,
          json_extract(i.intended_revision_json,'$.objectType') AS object_type,
          COALESCE((
            SELECT c.command_id FROM feature_commands c
            WHERE c.intent_id=i.intent_id AND c.run_id=i.run_id
            ORDER BY c.created_at DESC,c.command_id DESC LIMIT 1
          ),'') AS command_id,
          COALESCE((
            SELECT c.state FROM feature_commands c
            WHERE c.intent_id=i.intent_id AND c.run_id=i.run_id
            ORDER BY c.created_at DESC,c.command_id DESC LIMIT 1
          ),'pending') AS command_state,
          COALESCE((
            SELECT COUNT(*) FROM managed_relation_revisions r
            WHERE r.run_id=i.run_id AND r.command_id=(
              SELECT c.command_id FROM feature_commands c
              WHERE c.intent_id=i.intent_id AND c.run_id=i.run_id
              ORDER BY c.created_at DESC,c.command_id DESC LIMIT 1
            )
          ),0) AS relation_projection_count,
          COALESCE((
            SELECT json_extract(s.spec_json,'$.mutationPayload.riskId')
            FROM feature_command_specs s WHERE s.command_id=(
              SELECT c.command_id FROM feature_commands c
              WHERE c.intent_id=i.intent_id AND c.run_id=i.run_id
              ORDER BY c.created_at DESC,c.command_id DESC LIMIT 1
            ) AND s.run_id=i.run_id LIMIT 1
          ),'') AS projection_source_object_id,
          COALESCE((
            SELECT json_extract(s.spec_json,'$.mutationPayload.controlRiskScopes[0].controlId')
            FROM feature_command_specs s WHERE s.command_id=(
              SELECT c.command_id FROM feature_commands c
              WHERE c.intent_id=i.intent_id AND c.run_id=i.run_id
              ORDER BY c.created_at DESC,c.command_id DESC LIMIT 1
            ) AND s.run_id=i.run_id LIMIT 1
          ),'') AS projection_target_object_id
        FROM managed_content_intents i
        WHERE i.run_id=? ORDER BY i.created_at,i.intent_id
      `).all(runId);
    }
    if (method === 'saveReturnReconcileSpec') {
      // This freezes the exact future read-back contract before submission; it
      // does not authorize or perform a remote mutation.  Read-only reconcile
      // actions must be able to use the same immutable specification.
      const request=object(input,'Return reconcile specification'); const commandId=String(request.commandId||''); const runId=String(request.runId||'');
      if(!this.currentActivationOwnsRun(runId,context)) throw new Error('Reconcile specification Run is not owned by the active Feature lineage.');
      const command=this.core.prepare(`
        SELECT c.state,r.feature_version FROM feature_commands c
        JOIN feature_runs r ON r.run_id=c.run_id
        WHERE c.command_id=? AND c.run_id=? AND r.feature_id=?
      `).get(commandId,runId,context.featureId) as {state:string;feature_version:string}|undefined;
      if(!command||!['prepared','submitted'].includes(command.state)) throw new Error('Reconcile specification must precede or accompany mutation submission.');
      const spec=object(request.spec,'Serializable reconcile specification');
      if(String(spec.commandId||'')!==commandId) {
        throw new AppError('FEATURE.RECONCILE_SPEC_OWNER_MISMATCH','Reconcile specification command identity differs from its owned command.');
      }
      const encoded=JSON.stringify(spec);
      if(Buffer.byteLength(encoded,'utf8')>256_000) throw new Error('Reconcile specification exceeds the bounded Store contract.');
      const inserted=this.core.prepare(`
        INSERT INTO feature_command_specs(command_id,run_id,feature_id,feature_version,spec_json,created_at)
        VALUES(?,?,?,?,?,?) ON CONFLICT(command_id) DO NOTHING
      `).run(commandId,runId,context.featureId,command.feature_version,encoded,now());
      if(inserted.changes!==1){
        const existing=this.core.prepare(`
          SELECT spec_json FROM feature_command_specs
          WHERE command_id=? AND run_id=? AND feature_id=? AND feature_version=?
        `).get(commandId,runId,context.featureId,command.feature_version) as {spec_json:string}|undefined;
        if(!existing||canonical(JSON.parse(existing.spec_json))!==canonical(spec)) {
          throw new AppError('FEATURE.RECONCILE_SPEC_IMMUTABLE','A command reconcile specification cannot be replaced or reassigned.');
        }
      }
      return true;
    }
    if (method === 'loadReturnReconcileSpec') {
      const request=object(input,'Return reconcile lookup'); const runId=String(request.runId||'');
      const commandId=String(request.commandId||'');
      if(!this.currentActivationOwnsRun(runId,context)) throw new Error('Historical reconcile Run is not owned by the active Feature lineage.');
      const rows=this.core.prepare(`
        SELECT s.command_id,s.spec_json FROM feature_command_specs s
        JOIN feature_commands c ON c.command_id=s.command_id AND c.run_id=s.run_id
        JOIN feature_runs r ON r.run_id=c.run_id AND r.feature_id=s.feature_id AND r.feature_version=s.feature_version
        WHERE s.run_id=? AND s.feature_id=? AND c.state='uncertain'
          AND json_valid(s.spec_json) AND json_extract(s.spec_json,'$.commandId')=s.command_id
          AND (?='' OR s.command_id=?)
        ORDER BY s.created_at DESC,s.command_id DESC LIMIT 1
      `).all(runId,context.featureId,commandId,commandId) as Array<{command_id:string;spec_json:string}>;
      return rows[0]?JSON.parse(rows[0].spec_json):null;
    }
    const store = this.open(context.featureId);
    try {
      if (method === 'savePlan') {
        const plan = object(input, 'Feature plan');
        const planId = String(plan.planId || '');
        if (!planId) throw new Error('Feature plan identity is missing.');
        if (Object.prototype.hasOwnProperty.call(plan, 'storeRevision')) {
          throw new AppError('FEATURE.PLAN_CAS_REQUIRED', 'Plans with storeRevision must use compareAndSwapPlan.');
        }
        store.exec('BEGIN IMMEDIATE;');
        try {
          const existing = this.findRuntimePlan(store, planId);
          if (existing) {
            const current = object(JSON.parse(existing.payload_json), 'Stored Feature plan');
            if (Object.prototype.hasOwnProperty.call(current, 'storeRevision')) {
              throw new AppError('FEATURE.PLAN_CAS_REQUIRED', 'This Feature plan is CAS-managed and cannot be overwritten by savePlan.');
            }
          }
          const table = existing?.table || '__runtime_plans';
          const quoted = `"${table.replaceAll('"', '""')}"`;
          store.prepare(`
            INSERT INTO ${quoted}(plan_id, payload_json, updated_at) VALUES(?, ?, ?)
            ON CONFLICT(plan_id) DO UPDATE SET payload_json=excluded.payload_json, updated_at=excluded.updated_at
          `).run(planId, JSON.stringify(plan), now());
          store.exec('COMMIT;');
          return true;
        } catch (error) {
          store.exec('ROLLBACK;');
          throw error;
        }
      }
      if (method === 'compareAndSwapPlan') {
        const request = object(input, 'Feature plan CAS request');
        exactRecordKeys(request, ['schemaVersion', 'planId', 'expectedStoreRevision', 'plan'], 'Feature plan CAS request');
        if (request.schemaVersion !== 'omnia.feature-runtime-plan-cas/v1') {
          throw new AppError('FEATURE.PLAN_CAS_INVALID', 'Feature plan CAS schema is invalid.');
        }
        const planId = typeof request.planId === 'string' ? request.planId : '';
        if (!planId || planId.length > 200 || /[\u0000-\u001f\u007f]/u.test(planId)) {
          throw new AppError('FEATURE.PLAN_CAS_INVALID', 'Feature plan CAS identity is invalid.');
        }
        const expectedStoreRevision = request.expectedStoreRevision;
        if (!Number.isSafeInteger(expectedStoreRevision) || Number(expectedStoreRevision) < 0
          || Number(expectedStoreRevision) >= Number.MAX_SAFE_INTEGER) {
          throw new AppError('FEATURE.PLAN_CAS_INVALID', 'Feature plan CAS expectedStoreRevision is invalid.');
        }
        const plan = object(request.plan, 'Feature plan CAS payload');
        const nextStoreRevision = Number(expectedStoreRevision) + 1;
        if (plan.planId !== planId || plan.storeRevision !== nextStoreRevision) {
          throw new AppError(
            'FEATURE.PLAN_CAS_INVALID',
            'Feature plan CAS payload must preserve planId and advance storeRevision by exactly one.'
          );
        }
        const encoded = serializeRuntimePlan(plan);
        store.exec('BEGIN IMMEDIATE;');
        try {
          const existing = this.findRuntimePlan(store, planId);
          let actualStoreRevision = 0;
          if (existing) {
            let current: Record<string, unknown>;
            try {
              current = object(JSON.parse(existing.payload_json), 'Stored Feature plan');
            } catch {
              throw new AppError('FEATURE.PLAN_STORE_CORRUPT', 'Stored Feature plan is not a valid JSON object.');
            }
            if (String(current.planId || '') !== planId) {
              throw new AppError('FEATURE.PLAN_STORE_CORRUPT', 'Stored Feature plan identity differs from its row identity.');
            }
            actualStoreRevision = runtimePlanRevision(current);
          }
          if (actualStoreRevision !== expectedStoreRevision) {
            throw new AppError(
              'FEATURE.PLAN_CAS_MISMATCH',
              `Feature plan storeRevision changed from ${expectedStoreRevision} to ${actualStoreRevision}; reload before retrying.`,
              true
            );
          }
          const updatedAt = now();
          if (existing) {
            const quoted = `"${existing.table.replaceAll('"', '""')}"`;
            const result = store.prepare(`UPDATE ${quoted} SET payload_json=?,updated_at=? WHERE plan_id=?`)
              .run(encoded, updatedAt, planId);
            if (result.changes !== 1) {
              throw new AppError('FEATURE.PLAN_CAS_MISMATCH', 'Feature plan changed before the CAS update completed.', true);
            }
          } else {
            store.prepare(`INSERT INTO "__runtime_plans"(plan_id,payload_json,updated_at) VALUES(?,?,?)`)
              .run(planId, encoded, updatedAt);
          }
          store.exec('COMMIT;');
          return {
            schemaVersion: 'omnia.feature-runtime-plan-cas-result/v1',
            planId,
            storeRevision: nextStoreRevision,
            updatedAt
          };
        } catch (error) {
          store.exec('ROLLBACK;');
          throw error;
        }
      }
      if (method === 'loadPlan') {
        const row = this.findRuntimePlan(store, String(input || ''));
        return row ? JSON.parse(row.payload_json) : null;
      }
      if (method === 'appendEvidence') {
        const evidence = object(input, 'Feature evidence');
        store.prepare(`
          INSERT INTO "__runtime_evidence"(evidence_id, plan_id, checkpoint, payload_json, occurred_at)
          VALUES(?, ?, ?, ?, ?)
        `).run(
          randomUUID(), String(evidence.planId || ''), String(evidence.checkpoint || ''),
          JSON.stringify(evidence), String(evidence.occurredAt || now())
        );
        const revision = store.prepare(`SELECT COUNT(*) AS count FROM "__runtime_evidence"`).get() as { count: number };
        return { revision: Math.max(1, revision.count) };
      }
      throw new Error(`Feature store method is not allowlisted: ${method}`);
    } finally {
      store.close();
    }
  }

  private assertLegacyVerifiedLedger(runId: string, run: Record<string, any>, confirmation: Record<string, any>): { verified: number; workspaceIds: string[] } {
    const commands=this.core.prepare(`
      SELECT c.command_id,c.plan_digest,c.evidence_operation_ids_json,c.evidence_target_identity_key,c.evidence_request_digest,
        i.target_key,
        e.receipt_id,o.feature_id,o.feature_version,o.operation_package_digest,o.operation_id,o.authority_digest,
        o.connector_id,o.session_generation,o.engagement_id,o.authority_instance_id,o.tenant_or_org_id,o.pack_id,
        o.frozen_target_key,o.target_identity_key,o.workspace_ids_json,o.plan_digest AS receipt_plan_digest,o.request_digest,o.response_digest,o.response_json
      FROM feature_commands c
      JOIN managed_content_intents i ON i.intent_id=c.intent_id AND i.run_id=c.run_id AND i.plan_digest=c.plan_digest
      JOIN feature_command_evidence e ON e.command_id=c.command_id AND e.run_id=c.run_id
        AND e.evidence_type IN ('readback','reconcile') AND e.verified=1 AND e.receipt_id<>''
      JOIN feature_operation_receipts o ON o.receipt_id=e.receipt_id AND o.command_id=c.command_id AND o.run_id=c.run_id
      WHERE c.run_id=? AND c.state='readback_verified'
      ORDER BY c.command_id,e.occurred_at
    `).all(runId) as Array<Record<string,any>>;
    const expected=(this.core.prepare(`SELECT COUNT(*) AS count FROM feature_commands WHERE run_id=? AND state='readback_verified'`).get(runId) as {count:number}).count;
    const grouped=new Map<string,Array<Record<string,any>>>();
    for(const row of commands)grouped.set(String(row.command_id),[...(grouped.get(String(row.command_id))||[]),row]);
    if(grouped.size!==expected||[...grouped.values()].some((rows)=>rows.length!==1))throw new Error('Legacy verified commands do not each own exactly one authoritative read-back receipt.');
    let frozenWorkspaceIds:string[]|null=null;
    for(const row of commands){
      const allowed=JSON.parse(String(row.evidence_operation_ids_json||'[]')) as string[];
      const receiptWorkspaceIds=JSON.parse(String(row.workspace_ids_json||'[]')) as string[];
      if(!Array.isArray(receiptWorkspaceIds)||receiptWorkspaceIds.length<1||receiptWorkspaceIds.some((value)=>typeof value!=='string'||!value)) {
        throw new Error('Legacy verified receipt has no valid frozen workspace scope.');
      }
      if(frozenWorkspaceIds===null)frozenWorkspaceIds=receiptWorkspaceIds;
      else if(canonical(receiptWorkspaceIds)!==canonical(frozenWorkspaceIds))throw new Error('Legacy verified receipts disagree on their frozen workspace scope.');
      let response:unknown;
      try{response=JSON.parse(String(row.response_json));}catch{throw new Error('Legacy verified receipt response is not valid JSON.');}
      const projections=(this.core.prepare(`SELECT
        (SELECT COUNT(*) FROM managed_object_revisions WHERE run_id=? AND command_id=?) AS objects,
        (SELECT COUNT(*) FROM managed_relation_revisions WHERE run_id=? AND command_id=?) AS relations
      `).get(runId,row.command_id,runId,row.command_id) as {objects:number;relations:number});
      if(String(row.plan_digest)!==String(run.plan_digest)||String(row.receipt_plan_digest)!==String(run.plan_digest)
        ||String(row.feature_id)!==String(run.feature_id)||String(row.feature_version)!==String(run.feature_version)
        ||!/^sha256:[0-9a-f]{64}$/u.test(String(row.operation_package_digest))||!allowed.includes(String(row.operation_id))
        ||String(row.frozen_target_key)!==String(row.target_key)||String(row.target_identity_key)!==String(row.evidence_target_identity_key)
        ||String(row.request_digest)!==String(row.evidence_request_digest)||String(row.authority_digest)!==String(confirmation.credential_digest)
        ||String(row.connector_id)!==String(confirmation.connector_id)||Number(row.session_generation)!==Number(confirmation.session_generation)
        ||String(row.engagement_id)!==String(confirmation.engagement_id)||String(row.authority_instance_id)!==String(confirmation.authority_instance_id)
        ||String(row.tenant_or_org_id)!==String(confirmation.tenant_or_org_id)||String(row.pack_id)!==String(confirmation.pack_id)
        ||canonicalDigest(response)!==String(row.response_digest)||projections.objects+projections.relations!==1) {
        throw new Error(`Legacy verified command receipt or projection drifted: ${String(row.command_id)}.`);
      }
    }
    if(expected<1||frozenWorkspaceIds===null)throw new Error('Legacy recovery requires at least one verified receipt to establish the frozen workspace scope.');
    return{verified:expected,workspaceIds:frozenWorkspaceIds};
  }

  private inspectLegacyReturnRecovery(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    const request=object(input,'Legacy Return recovery inspection');
    if(request.schemaVersion!=='omnia.feature-return-recovery-inspection/v1')throw new Error('Legacy Return recovery inspection schema is invalid.');
    const requestedRunId=String(request.runId||'');const requestedVersion=String(request.sourceFeatureVersion||'');
    const where=[`feature_id=?`,`feature_version<>?`,`state='returning'`];const params:string[]=[context.featureId,context.featureVersion];
    if(requestedRunId){where.push('run_id=?');params.push(requestedRunId);}
    if(requestedVersion){where.push('feature_version=?');params.push(requestedVersion);}
    const runs=this.core.prepare(`SELECT * FROM feature_runs WHERE ${where.join(' AND ')} ORDER BY updated_at DESC,rowid DESC`).all(...params) as Array<Record<string,any>>;
    if(runs.length!==1)throw new Error('Legacy Return recovery requires exactly one eligible source Run.');
    const run=runs[0]!;
    const confirmations=this.core.prepare(`SELECT * FROM feature_confirmations WHERE run_id=? AND plan_digest=? AND decision='approved' ORDER BY created_at`).all(run.run_id,run.plan_digest) as Array<Record<string,any>>;
    if(confirmations.length!==1)throw new Error('Legacy Return recovery requires one immutable approved confirmation.');
    const confirmation=confirmations[0]!;
    const safety=this.core.prepare(`SELECT * FROM workspace_safety WHERE singleton=1`).get() as Record<string,any>;
    const currentWorkspaceIds=JSON.parse(String(safety.workspace_ids_json||'[]')) as string[];
    if(Number(safety.enabled)!==1||Number(safety.global_enabled)!==0||!String(safety.connector_id)||Number(safety.session_generation)<1
      ||String(safety.connector_id)!==String(confirmation.connector_id)||Number(safety.session_generation)===Number(confirmation.session_generation)
      ||String(safety.authority_instance_id)!==String(confirmation.authority_instance_id)
      ||String(safety.tenant_or_org_id)!==String(confirmation.tenant_or_org_id)||String(safety.pack_id)!==String(confirmation.pack_id)
      ||String(safety.engagement_id)!==String(confirmation.engagement_id)||currentWorkspaceIds.length<1) {
      throw new Error('Current durable safety lock is not an exact new-generation continuation of the legacy confirmation scope.');
    }
    const inFlight=(this.core.prepare(`SELECT COUNT(*) AS count FROM feature_commands WHERE run_id=? AND state IN ('submitted','committed','verifying','uncertain')`).get(run.run_id) as {count:number}).count;
    const uncertain=(this.core.prepare(`SELECT COUNT(*) AS count FROM managed_content_intents WHERE run_id=? AND state='uncertain'`).get(run.run_id) as {count:number}).count;
    if(inFlight||uncertain)throw new Error('Legacy Return recovery is blocked by an in-flight or uncertain command.');
    const ledger=this.assertLegacyVerifiedLedger(String(run.run_id),run,confirmation);
    if(canonical(currentWorkspaceIds)!==canonical(ledger.workspaceIds))throw new Error('Current durable safety workspace scope differs from the legacy verified receipt scope.');
    const legacyIntents=this.core.prepare(`SELECT intended_revision_json FROM managed_content_intents WHERE run_id=?`).all(run.run_id) as Array<{intended_revision_json:string}>;
    const intentWorkspaces=[...new Set(legacyIntents.map((row)=>{
      const intended=JSON.parse(String(row.intended_revision_json||'{}')) as Record<string,unknown>;
      return String(intended.workspace||'');
    }))];
    if(intentWorkspaces.some((workspaceId)=>!workspaceId||!ledger.workspaceIds.includes(workspaceId))||canonical(intentWorkspaces)!==canonical(ledger.workspaceIds)) {
      throw new Error('Legacy intent workspace scope differs from the frozen verified receipt scope.');
    }
    const failed=this.core.prepare(`
      SELECT c.command_id,c.operation_id,c.submitted_at,c.commit_point_at,c.evidence_operation_ids_json,c.evidence_target_identity_key,
        i.target_kind,i.target_key,s.spec_json,
        (SELECT COUNT(*) FROM feature_operation_receipts o WHERE o.command_id=c.command_id) AS receipt_count,
        (SELECT COUNT(*) FROM feature_command_evidence e WHERE e.command_id=c.command_id AND e.evidence_type IN ('request','commit','readback','reconcile')) AS post_preflight_evidence
      FROM feature_commands c JOIN managed_content_intents i ON i.intent_id=c.intent_id AND i.run_id=c.run_id
      LEFT JOIN feature_command_specs s ON s.command_id=c.command_id AND s.run_id=c.run_id
        AND s.feature_id=? AND s.feature_version=?
      WHERE c.run_id=? AND c.state='failed' ORDER BY c.created_at,c.command_id
    `).all(run.feature_id,run.feature_version,run.run_id) as Array<Record<string,any>>;
    const preflightOnly=failed.filter((row)=>!String(row.submitted_at)&&!String(row.commit_point_at)&&Number(row.receipt_count)===0&&Number(row.post_preflight_evidence)===0);
    const hazardous=failed.filter((row)=>!preflightOnly.includes(row));
    if(hazardous.some((row)=>!String(row.spec_json)||Number(row.receipt_count)>0||String(row.commit_point_at))) {
      throw new Error('A legacy failed command lacks an unambiguous frozen read-only reconcile specification.');
    }
    const targets=hazardous.map((row)=>{
      const spec=JSON.parse(String(row.spec_json)) as Record<string,unknown>;
      const recoveryRequests=['preflightRequest','reconcileRequest','readRequest'].map((key)=>spec[key]).filter((value)=>value&&typeof value==='object'&&!Array.isArray(value)) as Array<Record<string,unknown>>;
      for(const recoveryRequest of recoveryRequests){
        const target=recoveryRequest.target as Record<string,unknown>|undefined;
        const workspaceId=String(target?.workspaceId||'');
        if(!workspaceId||!ledger.workspaceIds.includes(workspaceId))throw new Error(`Legacy recovery target workspace escaped the frozen receipt scope: ${String(row.command_id)}.`);
      }
      return{commandId:String(row.command_id),targetKind:String(row.target_kind),targetKey:String(row.target_key),operationId:String(row.operation_id),
        evidenceOperationIds:JSON.parse(String(row.evidence_operation_ids_json||'[]')),targetIdentityKey:String(row.evidence_target_identity_key),reconcileSpec:spec};
    });
    const source=this.core.prepare(`SELECT a.artifact_id,a.sha256,a.original_name,a.size_bytes FROM feature_artifacts a WHERE a.artifact_id=? AND a.run_id=? AND a.feature_id=? AND a.kind='source'`)
      .get(String(run.source_artifact_id),String(run.run_id),context.featureId) as Record<string,any>|undefined;
    if(!source)throw new Error('Legacy Return source Artifact is unavailable.');
    const counts=Object.fromEntries((this.core.prepare(`SELECT state,COUNT(*) AS count FROM managed_content_intents WHERE run_id=? GROUP BY state`).all(run.run_id) as Array<{state:string;count:number}>).map((row)=>[row.state,row.count]));
    return{schemaVersion:'omnia.feature-return-recovery-inspection-result/v1',eligible:true,runId:String(run.run_id),featureId:context.featureId,
      sourceFeatureVersion:String(run.feature_version),successorFeatureVersion:context.featureVersion,state:String(run.state),stateRevision:Number(run.state_revision),
      recoveryMode:'partial_close_no_reuse',planDigest:String(run.plan_digest),confirmationId:String(confirmation.confirmation_id),
      oldBinding:{connectorId:String(confirmation.connector_id),sessionGeneration:Number(confirmation.session_generation),engagementId:String(confirmation.engagement_id),authorityInstanceId:String(confirmation.authority_instance_id),tenantOrOrgId:String(confirmation.tenant_or_org_id),packId:String(confirmation.pack_id)},
      currentBinding:{connectorId:String(safety.connector_id),sessionGeneration:Number(safety.session_generation),engagementId:String(safety.engagement_id),authorityInstanceId:String(safety.authority_instance_id),tenantOrOrgId:String(safety.tenant_or_org_id),packId:String(safety.pack_id)},
      workspaceIds:ledger.workspaceIds,safetyRevision:Number(safety.state_version),counts:{verified:ledger.verified,failed:failed.length,frozen:Number(counts.frozen||0),uncertain,inFlight},
      reconcileRequired:targets,preflightOnlyFailedCommandIds:preflightOnly.map((row)=>String(row.command_id)),
      sourceArtifact:{artifactId:String(source.artifact_id),sha256:String(source.sha256),originalName:String(source.original_name),sizeBytes:Number(source.size_bytes)}};
  }

  private authorizeLegacyReturnRecovery(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    const request=object(input,'Legacy Return recovery authorization');
    if(request.schemaVersion!=='omnia.feature-return-recovery-authorization-request/v1')throw new Error('Legacy Return recovery authorization schema is invalid.');
    const inspection=this.inspectLegacyReturnRecovery({schemaVersion:'omnia.feature-return-recovery-inspection/v1',runId:String(request.runId||''),sourceFeatureVersion:String(request.sourceFeatureVersion||'')},context) as Record<string,any>;
    if(Number(request.expectedStateRevision)!==Number(inspection.stateRevision))throw new Error('Legacy Return recovery inspection changed before authorization.');
    const binding=returnAuthorityBinding(request.connectorBinding,'Legacy recovery current Connector binding');const safety=object(request.safetyLock,'Legacy recovery current safety lock');
    const current=inspection.currentBinding as Record<string,any>;const workspaceIds=(inspection.workspaceIds as string[]);
    if(binding.connectorId!==current.connectorId||Number(binding.sessionGeneration)!==Number(current.sessionGeneration)
      ||binding.engagementId!==current.engagementId||binding.authorityInstanceId!==current.authorityInstanceId
      ||binding.tenantOrOrgId!==current.tenantOrOrgId||binding.packId!==current.packId||safety.enabled!==true||safety.globalEnabled!==false
      ||String(safety.connectorId||'')!==String(current.connectorId)||Number(safety.sessionGeneration)!==Number(current.sessionGeneration)
      ||String(safety.authorityInstanceId||'')!==String(current.authorityInstanceId)||String(safety.tenantOrOrgId||'')!==String(current.tenantOrOrgId)
      ||String(safety.packId||'')!==String(current.packId)||String(safety.engagementId||'')!==String(current.engagementId)
      ||Number(safety.stateVersion)!==Number(inspection.safetyRevision)||canonical(Array.isArray(safety.workspaceIds)?safety.workspaceIds.map(String):[])!==canonical(workspaceIds))throw new Error('Legacy Return recovery authorization differs from current durable authority or safety scope.');
    const authorizationId=randomUUID(),createdAt=now(),expiresAt=new Date(Date.now()+15*60_000).toISOString();const source=inspection.sourceArtifact as Record<string,any>;
    this.core.exec('BEGIN IMMEDIATE;');
    try{
      if(this.core.prepare(`SELECT 1 FROM feature_return_partial_closures WHERE run_id=?`).get(inspection.runId))throw new Error('Legacy Return Run was already closed.');
      this.core.prepare(`INSERT INTO feature_return_recovery_authorizations(authorization_id,run_id,feature_id,source_feature_version,successor_feature_version,plan_digest,confirmation_id,connector_id,from_session_generation,to_session_generation,authority_instance_id,tenant_or_org_id,pack_id,engagement_id,workspace_ids_json,safety_revision,expected_run_revision,source_artifact_id,source_artifact_digest,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(authorizationId,inspection.runId,context.featureId,inspection.sourceFeatureVersion,context.featureVersion,inspection.planDigest,inspection.confirmationId,current.connectorId,inspection.oldBinding.sessionGeneration,current.sessionGeneration,current.authorityInstanceId,current.tenantOrOrgId,current.packId,current.engagementId,canonical(workspaceIds),Number(safety.stateVersion),inspection.stateRevision,source.artifactId,source.sha256,expiresAt,createdAt);
      for(const target of inspection.reconcileRequired as Array<Record<string,any>>){const specJson=canonical(target.reconcileSpec);this.core.prepare(`INSERT INTO feature_return_recovery_targets(authorization_id,run_id,command_id,target_kind,target_key,mutation_operation_id,evidence_operation_ids_json,target_identity_key,reconcile_spec_json,reconcile_spec_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(authorizationId,inspection.runId,target.commandId,target.targetKind,target.targetKey,target.operationId,canonical(target.evidenceOperationIds),target.targetIdentityKey,specJson,canonicalDigest(target.reconcileSpec),createdAt);}
      this.core.exec('COMMIT;');
    }catch(error){this.core.exec('ROLLBACK;');throw error;}
    return{schemaVersion:'omnia.feature-return-recovery-authorization/v1',authorizationId,runId:inspection.runId,sourceFeatureVersion:inspection.sourceFeatureVersion,successorFeatureVersion:context.featureVersion,expectedStateRevision:inspection.stateRevision,expiresAt,reconcileRequired:inspection.reconcileRequired};
  }

  private recordLegacyReturnRecoveryOutcome(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    const request=object(input,'Legacy Return recovery outcome');
    if(request.schemaVersion!=='omnia.feature-return-recovery-outcome/v1'||!['applied','not_applied'].includes(String(request.outcome)))throw new Error('Legacy Return recovery outcome schema is invalid.');
    const authorizationId=String(request.authorizationId||''),runId=String(request.runId||''),commandId=String(request.commandId||''),receiptId=String(request.recoveryReceiptId||'');
    const row=this.core.prepare(`SELECT a.*,t.command_id,t.target_identity_key,t.reconcile_spec_json,
      r.operation_id,r.operation_package_digest,r.workspace_id,r.target_identity_key AS receipt_target_identity_key,r.request_digest,r.response_digest,r.response_json,
      r.connector_request_id,r.connector_wire_result_digest,r.connector_execution_generation,
      c.connector_request_id AS source_connector_request_id,c.connector_execution_generation AS source_connector_execution_generation,
      c.connector_session_generation AS source_connector_session_generation,c.connector_id AS source_connector_id,
      c.connector_operation_package_digest AS source_operation_package_digest,c.operation_id AS source_operation_id
      FROM feature_return_recovery_authorizations a
      JOIN feature_return_recovery_targets t ON t.authorization_id=a.authorization_id AND t.run_id=a.run_id
      JOIN feature_return_recovery_receipts r ON r.authorization_id=t.authorization_id AND r.run_id=t.run_id AND r.command_id=t.command_id
      JOIN feature_commands c ON c.run_id=t.run_id AND c.command_id=t.command_id
      WHERE a.authorization_id=? AND a.run_id=? AND t.command_id=? AND r.receipt_id=?`).get(authorizationId,runId,commandId,receiptId) as Record<string,any>|undefined;
    const payload=request.payload??null;
    if(!row||String(row.successor_feature_version)!==context.featureVersion||String(row.expires_at)<=now()||canonicalDigest(payload)!==String(row.response_digest)||canonical(JSON.parse(String(row.response_json)))!==canonical(payload))throw new Error('Legacy Return recovery outcome lacks an exact trusted signed read-only receipt.');
    const response=payload as Record<string,any>;const spec=JSON.parse(String(row.reconcile_spec_json)) as Record<string,any>;
    const binding={connectorId:String(row.connector_id),sessionGeneration:Number(row.to_session_generation),engagementId:String(row.engagement_id),authorityInstanceId:String(row.authority_instance_id),tenantOrOrgId:String(row.tenant_or_org_id),packId:String(row.pack_id)};
    const preflight=spec.preflightRequest as Record<string,any>;const mutation=spec.mutationPayload as Record<string,any>;
    if(String(row.receipt_target_identity_key)!==String(row.target_identity_key)||String(row.workspace_id)!==String(preflight?.target?.workspaceId||''))throw new Error('Recovery outcome receipt target differs from the frozen command specification.');
    if(String(request.outcome)==='not_applied'){
      const expectedRequest={...preflight,connectorBinding:binding};
      if(String(row.operation_id)!==String(spec.preflightOperation)||String(row.request_digest)!==canonicalDigest(expectedRequest)
        ||canonical(response)!==canonical({found:false,item:null,evidence:{directoryMatches:0}}))throw new Error('not_applied requires the exact frozen GRA preflight receipt proving no matching assessment exists.');
    }else{
      if(String(row.operation_id)!==String(spec.readOperation))throw new Error('applied requires the exact frozen read-back Operation receipt, not a preflight observation.');
      const prior=this.core.prepare(`SELECT response_json FROM feature_return_recovery_receipts WHERE authorization_id=? AND run_id=? AND command_id=? AND operation_id=? ORDER BY created_at,receipt_id`)
        .all(authorizationId,runId,commandId,String(spec.preflightOperation||'')) as Array<{response_json:string}>;
      const found=prior.map((item)=>JSON.parse(item.response_json) as Record<string,any>).filter((item)=>item.found===true&&item.item&&typeof item.item==='object'&&!Array.isArray(item.item)&&Number(item.evidence?.directoryMatches)===1);
      const ids=[...new Set(found.map((item)=>String(item.item.id||item.item.riskAssessmentId||item.evidence?.assessmentId||'').toLowerCase()).filter(Boolean))];
      if(found.length<1||ids.length!==1||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(ids[0]!))throw new Error('applied recovery has no unique exact preflight assessment identity.');
      const expectedRequest={target:preflight.target,riskAssessmentId:ids[0],query:{entityId:preflight.query?.entityId,name:preflight.query?.name,itElementType:preflight.query?.itElementType,inkContentId:mutation?.inkContentId,typeId:mutation?.typeId},connectorBinding:binding};
      const exactValues=(values:unknown[])=>[...new Set(values.map((value)=>String(value||'')).filter(Boolean))];
      const responseIds=exactValues([response.id,response.riskAssessmentId]);
      const responseEntities=exactValues([response.entityId,response.itElementId,response.applicationId]);
      const responseWorkspaces=exactValues([response.workspaceId,response.facetId]);
      const responseTypes=exactValues([response.type,response.itElementType,response.entityType]);
      const responseContents=exactValues([response.inkContentId,response.contentId]);
      if(String(row.request_digest)!==canonicalDigest(expectedRequest)||responseIds.length!==1||responseIds[0]!==ids[0]
        ||responseEntities.length!==1||responseEntities[0]!==String(preflight.query?.entityId||'')
        ||responseWorkspaces.length!==1||responseWorkspaces[0]!==String(preflight.target?.workspaceId||'')
        ||String(response.name||response.graName||'')!==String(preflight.query?.name||'')
        ||responseTypes.length!==1||responseTypes[0]!==String(preflight.query?.itElementType||'')
        ||responseContents.length!==1||responseContents[0]!==String(mutation?.inkContentId||''))throw new Error('applied recovery read-back does not prove one exact frozen GRA identity, content, type, name, and workspace.');
    }
    const outcomeId=randomUUID(),recordedAt=now();
    if(!/^[0-9a-f-]{36}$/iu.test(String(row.connector_request_id||''))
      ||!/^[a-f0-9]{48}$/u.test(String(row.connector_execution_generation||'')))throw new Error('Legacy recovery outcome lacks the current exact Connector delivery identity.');
    const sourceRequestId=String(row.source_connector_request_id||'');
    const legacySourceAbsent=!sourceRequestId&&!String(row.source_connector_execution_generation||'')
      &&!String(row.source_connector_id||'')&&!String(row.source_operation_package_digest||'')
      &&Number(row.source_connector_session_generation||0)===0;
    if(!legacySourceAbsent&&(!/^[0-9a-f-]{36}$/iu.test(sourceRequestId)
      ||!/^[a-f0-9]{48}$/u.test(String(row.source_connector_execution_generation||''))
      ||!String(row.source_connector_id||'')||!/^sha256:[0-9a-f]{64}$/u.test(String(row.source_operation_package_digest||''))
      ||!Number.isSafeInteger(Number(row.source_connector_session_generation))||Number(row.source_connector_session_generation)<1)){
      throw new Error('Legacy recovery source Connector identity is partially populated and cannot be trusted.');
    }
    const ackId=legacySourceAbsent?'':randomUUID();const ack=legacySourceAbsent?null:{schemaVersion:'omnia.connector-delivery-ack/v1',ackId,deliveredRequestId:String(row.connector_request_id),
      resultDigest:String(row.connector_wire_result_digest),connectorId:String(row.connector_id),sessionGeneration:Number(row.to_session_generation),
      executionGeneration:String(row.connector_execution_generation),featureId:String(row.feature_id),featureVersion:context.featureVersion,
      operationId:String(row.operation_id),operationPackageDigest:String(row.operation_package_digest),runId,commandId,receiptId,
      receiptResponseDigest:String(row.response_digest),resolution:String(request.outcome)==='applied'?'readback_verified':'closed_not_applied',
      effectOutcome:(String(request.outcome)==='applied'?'applied':'not_applied'),reconciles:{requestId:sourceRequestId,featureId:String(row.feature_id),
        featureVersion:String(row.source_feature_version),operationId:String(row.source_operation_id),operationPackageDigest:String(row.source_operation_package_digest),
        connectorId:String(row.source_connector_id),sessionGeneration:Number(row.source_connector_session_generation),executionGeneration:String(row.source_connector_execution_generation)}} satisfies import('../../shared/connector-delivery.js').ConnectorDeliveryAck;
    this.core.exec('BEGIN IMMEDIATE;');try{
    this.core.prepare(`INSERT INTO feature_return_recovery_outcomes(outcome_id,authorization_id,run_id,command_id,outcome,receipt_id,payload_digest,payload_json,recorded_at) VALUES(?,?,?,?,?,?,?,?,?)`).run(outcomeId,authorizationId,runId,commandId,String(request.outcome),receiptId,canonicalDigest(payload),canonical(payload),recordedAt);
    if(ack){
      this.core.prepare(`INSERT INTO connector_delivery_ack_outbox(ack_id,request_id,transaction_kind,payload_json,state,attempts,last_error,created_at,updated_at,delivered_at) VALUES(?,?,'effect_resolved',?,'pending',0,'',?,?,'')`)
        .run(ackId,String(row.connector_request_id),canonical(ack),recordedAt,recordedAt);
      this.core.prepare(`UPDATE connector_delivery_requests SET state='effect_resolved',updated_at=? WHERE request_id=? AND state='receipt_committed'`).run(recordedAt,String(row.connector_request_id));
    }
    this.core.exec('COMMIT;');}catch(error){this.core.exec('ROLLBACK;');throw error;}
    return{schemaVersion:'omnia.feature-return-recovery-outcome-result/v1',outcomeId,outcome:String(request.outcome),recordedAt};
  }

  private closeLegacyPartialReturn(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    const request=object(input,'Legacy partial Return close');
    if(request.schemaVersion!=='omnia.feature-return-partial-close/v1')throw new Error('Legacy partial Return close schema is invalid.');
    const authorizationId=String(request.authorizationId||''),runId=String(request.runId||''),sourceVersion=String(request.sourceFeatureVersion||'');
    const auth=this.core.prepare(`SELECT * FROM feature_return_recovery_authorizations WHERE authorization_id=? AND run_id=?`).get(authorizationId,runId) as Record<string,any>|undefined;
    if(!auth||String(auth.feature_id)!==context.featureId||String(auth.source_feature_version)!==sourceVersion||String(auth.successor_feature_version)!==context.featureVersion
      ||Number(request.expectedStateRevision)!==Number(auth.expected_run_revision)||String(auth.expires_at)<=now())throw new Error('Legacy partial Return close authorization is stale or invalid.');
    const inspection=this.inspectLegacyReturnRecovery({schemaVersion:'omnia.feature-return-recovery-inspection/v1',runId,sourceFeatureVersion:sourceVersion},context) as Record<string,any>;
    const current=inspection.currentBinding as Record<string,any>;
    if(Number(inspection.stateRevision)!==Number(request.expectedStateRevision)||Number(inspection.safetyRevision)!==Number(auth.safety_revision)
      ||String(current.connectorId)!==String(auth.connector_id)||Number(current.sessionGeneration)!==Number(auth.to_session_generation)
      ||String(current.authorityInstanceId)!==String(auth.authority_instance_id)||String(current.tenantOrOrgId)!==String(auth.tenant_or_org_id)
      ||String(current.packId)!==String(auth.pack_id)||String(current.engagementId)!==String(auth.engagement_id)
      ||canonical(inspection.workspaceIds)!==canonical(JSON.parse(String(auth.workspace_ids_json))))throw new Error('Legacy partial Return changed after recovery authorization.');
    const required=(this.core.prepare(`SELECT COUNT(*) AS count FROM feature_return_recovery_targets WHERE authorization_id=?`).get(authorizationId) as {count:number}).count;
    const outcomes=(this.core.prepare(`SELECT COUNT(*) AS count FROM feature_return_recovery_outcomes WHERE authorization_id=?`).get(authorizationId) as {count:number}).count;
    if(required!==outcomes)throw new Error('Every possibly submitted legacy command requires one conclusive signed read-only recovery outcome.');
    const unresolvedActiveReservations=(this.core.prepare(`
      SELECT COUNT(*) AS count
      FROM feature_mutation_reservations reservation
      LEFT JOIN feature_return_recovery_outcomes outcome
        ON outcome.authorization_id=? AND outcome.run_id=? AND outcome.command_id=reservation.owner_command_id
      WHERE reservation.owner_run_id=? AND reservation.lifecycle='active' AND outcome.outcome_id IS NULL
    `).get(authorizationId,runId,runId) as {count:number}).count;
    if(unresolvedActiveReservations)throw new Error('Legacy partial Return still owns an active mutation reservation without a conclusive recovery outcome.');
    const closedAt=now(),nextRevision=Number(request.expectedStateRevision)+1,closureId=randomUUID();
    this.core.exec('BEGIN IMMEDIATE;');
    try{
      const resolvedReservations=this.core.prepare(`
        UPDATE feature_mutation_reservations AS reservation
        SET lifecycle=(
          SELECT CASE outcome.outcome WHEN 'applied' THEN 'completed' ELSE 'released' END
          FROM feature_return_recovery_outcomes outcome
          WHERE outcome.authorization_id=? AND outcome.run_id=? AND outcome.command_id=reservation.owner_command_id
        ),updated_at=?
        WHERE reservation.owner_run_id=? AND reservation.lifecycle='active'
          AND EXISTS(
            SELECT 1 FROM feature_return_recovery_outcomes outcome
            WHERE outcome.authorization_id=? AND outcome.run_id=? AND outcome.command_id=reservation.owner_command_id
          )
      `).run(authorizationId,runId,closedAt,runId,authorizationId,runId);
      const remainingActive=(this.core.prepare(`SELECT COUNT(*) AS count FROM feature_mutation_reservations WHERE owner_run_id=? AND lifecycle='active'`).get(runId) as {count:number}).count;
      if(remainingActive)throw new Error('Legacy partial Return reservation release did not close every conclusively recovered active reservation.');
      const cancelled=this.core.prepare(`UPDATE managed_content_intents SET state='cancelled',updated_at=? WHERE run_id=? AND state='frozen'`).run(closedAt,runId);
      const updated=this.core.prepare(`UPDATE feature_runs SET state='failed',state_revision=?,last_error='Partial Return closed after managed Connector generation recovery; verified effects and audit evidence are preserved.',updated_at=? WHERE run_id=? AND feature_id=? AND feature_version=? AND state='returning' AND state_revision=?`).run(nextRevision,closedAt,runId,context.featureId,sourceVersion,Number(request.expectedStateRevision));
      if(updated.changes!==1)throw new Error('Legacy partial Return changed before close CAS completed.');
      const verified=Number((inspection.counts as Record<string,unknown>).verified||0),preflightOnly=(inspection.preflightOnlyFailedCommandIds as string[]).length;
      this.core.prepare(`INSERT INTO feature_return_partial_closures(closure_id,authorization_id,run_id,source_feature_version,successor_feature_version,from_run_revision,to_run_revision,verified_command_count,preflight_only_failure_count,reconciled_failure_count,cancelled_frozen_intent_count,closed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(closureId,authorizationId,runId,sourceVersion,context.featureVersion,Number(request.expectedStateRevision),nextRevision,verified,preflightOnly,outcomes,cancelled.changes,closedAt);
      this.core.prepare(`INSERT INTO feature_run_events(event_id,run_id,revision,from_state,to_state,event_type,details_json,occurred_at) VALUES(?,?,?,'returning','failed','return.partial_closed_for_reimport',?,?)`).run(randomUUID(),runId,nextRevision,JSON.stringify({authorizationId,closureId,recoveryMode:'partial_close_no_reuse',verifiedCommands:verified,preflightOnlyFailures:preflightOnly,reconciledFailures:outcomes,resolvedActiveReservations:resolvedReservations.changes,cancelledFrozenIntents:cancelled.changes,successorFeatureVersion:context.featureVersion}),closedAt);
      this.core.exec('COMMIT;');
      return{schemaVersion:'omnia.feature-return-partial-close-result/v1',runId,state:'failed',stateRevision:nextRevision,cancelledFrozenIntents:cancelled.changes,preservedVerifiedCommands:verified,recoveryAuthorizationId:authorizationId,recoveryMode:'partial_close_no_reuse'};
    }catch(error){this.core.exec('ROLLBACK;');throw error;}
  }

  private closeLegacyFrozenInputRecovery(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    const request = object(input, 'Legacy frozen-input recovery close');
    if (request.schemaVersion !== 'omnia.processing-run-frozen-input-recovery-close/v1') {
      throw new Error('Legacy frozen-input recovery close schema is invalid.');
    }
    const runId = String(request.runId || '');
    const sourceFeatureVersion = String(request.sourceFeatureVersion || '');
    const expectedStateRevision = Number(request.expectedStateRevision);
    const externalId = String(request.externalId || '').toLowerCase();
    if (!/^\d+\.\d+\.\d+$/u.test(sourceFeatureVersion) || sourceFeatureVersion === context.featureVersion) {
      throw new Error('Legacy frozen-input recovery close is not authorized for this Feature generation.');
    }
    const run = this.core.prepare(`
      SELECT r.state,r.state_revision,e.details_json
      FROM feature_runs r
      JOIN feature_run_events e ON e.run_id=r.run_id AND e.event_type='run.processing_started'
      WHERE r.run_id=? AND r.feature_id=? AND r.feature_version=?
      ORDER BY e.occurred_at,e.rowid LIMIT 1
    `).get(runId, context.featureId, sourceFeatureVersion) as {state:string;state_revision:number;details_json:string}|undefined;
    if (!run || run.state !== 'processing' || run.state_revision !== expectedStateRevision) {
      throw new Error('Legacy frozen-input Run is absent or changed.');
    }
    const details = JSON.parse(run.details_json || '{}') as Record<string, unknown>;
    if (String(details.externalId || '').toLowerCase() !== externalId) {
      throw new Error('Legacy frozen-input recording identity changed.');
    }
    const inFlight = (this.core.prepare(`SELECT COUNT(*) AS count FROM feature_commands WHERE run_id=? AND state IN ('submitted','committed','verifying','uncertain')`).get(runId) as {count:number}).count;
    const intents = (this.core.prepare(`SELECT COUNT(*) AS count FROM managed_content_intents WHERE run_id=?`).get(runId) as {count:number}).count;
    if (inFlight || intents) throw new Error('Legacy frozen-input Run owns mutation state and cannot be closed as a recording failure.');
    const closedAt = now();
    const nextRevision = expectedStateRevision + 1;
    const error = 'Frozen recording finalization could not be resumed across Feature generations; Connector input remains non-authoritative and no Omnia mutation occurred.';
    this.core.exec('BEGIN IMMEDIATE;');
    try {
      const updated = this.core.prepare(`
        UPDATE feature_runs SET state='failed',state_revision=?,last_error=?,updated_at=?
        WHERE run_id=? AND feature_id=? AND feature_version=? AND state='processing' AND state_revision=?
      `).run(nextRevision,error,closedAt,runId,context.featureId,sourceFeatureVersion,expectedStateRevision);
      if (updated.changes !== 1) throw new Error('Legacy frozen-input Run changed before close CAS completed.');
      this.core.prepare(`
        INSERT INTO feature_run_events(event_id,run_id,revision,from_state,to_state,event_type,details_json,occurred_at)
        VALUES(?,?,?,'processing','failed','recording.frozen_input_recovery_failed',?,?)
      `).run(randomUUID(),runId,nextRevision,JSON.stringify({externalId,sourceFeatureVersion,successorFeatureVersion:context.featureVersion,noOmniaMutation:true}),closedAt);
      this.core.exec('COMMIT;');
    } catch (errorValue) { this.core.exec('ROLLBACK;'); throw errorValue; }
    return {schemaVersion:'omnia.processing-run-frozen-input-recovery-close-result/v1',runId,state:'failed',stateRevision:nextRevision,externalId,noOmniaMutation:true};
  }

  private proveOwnedCreatedObject(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    const request=object(input,'Owned created object proof'); const objectId=String(request.objectId||'').toLowerCase();
    const workspaceId=String(request.workspaceId||'').toLowerCase(); const externalId=String(request.externalId||'').normalize('NFKC').replace(/\s+/gu,' ').trim();
    const externalIdentity=normalizedExternalIdentity(externalId);
    const expectedObjectType=String(request.expectedObjectType||'');
    const binding=returnAuthorityBinding(request.connectorBinding,'Owned created object current binding');
    if(!/^[A-Za-z][A-Za-z0-9._ -]{1,127}$/u.test(expectedObjectType))throw new Error('Owned created object proof requires one exact object type.');
    if(!objectId||!workspaceId||!externalIdentity||!binding.connectorId||Number(binding.sessionGeneration)<1||!binding.engagementId||!binding.authorityInstanceId||!binding.packId)throw new Error('Owned created object proof request is incomplete.');
    const safety=this.core.prepare(`SELECT enabled,engagement_id,workspace_ids_json FROM workspace_safety WHERE singleton=1`).get() as {enabled:number;engagement_id:string;workspace_ids_json:string}|undefined;
    const allowed=safety?JSON.parse(safety.workspace_ids_json) as string[]:[];
    if(!safety||safety.enabled!==1||safety.engagement_id!==binding.engagementId||!allowed.includes(workspaceId))throw new Error('Owned created object proof is outside the current exact safety scope.');
    const rows=this.core.prepare(`
      SELECT r.run_id,r.engagement_id,i.intended_revision_json,c.command_id,c.operation_id,c.commit_point_at,e.payload_json,
        f.connector_id,f.session_generation,f.authority_instance_id,f.tenant_or_org_id,f.pack_id,
        f.engagement_id AS confirmation_engagement_id
      FROM feature_runs r
      JOIN managed_content_intents i ON i.run_id=r.run_id AND i.target_kind='object'
      JOIN feature_commands c ON c.run_id=i.run_id AND c.intent_id=i.intent_id AND c.commit_point_at<>''
      JOIN feature_command_evidence e ON e.run_id=c.run_id AND e.command_id=c.command_id AND e.evidence_type='commit' AND e.verified=1
      JOIN feature_confirmations f ON f.run_id=c.run_id AND f.plan_digest=c.plan_digest AND f.decision='approved'
      WHERE r.feature_id=? AND r.engagement_id=?
      ORDER BY e.occurred_at,c.command_id
    `).all(context.featureId,binding.engagementId) as Array<Record<string,unknown>>;
    const matches=rows.filter((row)=>{
      const sourceSessionGeneration=Number(row.session_generation);
      // Connector session generations rotate after a signed online update. The
      // stable Connector id plus the exact authority/Pack/engagement scope is
      // the ownership boundary; requiring the old transient generation to equal
      // the current one would reject objects this Agent already created.
      if(String(row.connector_id)!==String(binding.connectorId)
        ||!Number.isSafeInteger(sourceSessionGeneration)||sourceSessionGeneration<1
        ||String(row.authority_instance_id)!==String(binding.authorityInstanceId)||String(row.tenant_or_org_id)!==String(binding.tenantOrOrgId)
        ||String(row.pack_id)!==String(binding.packId)||String(row.confirmation_engagement_id)!==String(binding.engagementId))return false;
      const intended=JSON.parse(String(row.intended_revision_json||'{}')) as Record<string,unknown>;
      if(intended.kind!=='object'||intended.objectType!==expectedObjectType||intended.disposition!=='create'
        ||String(intended.workspace||'').toLowerCase()!==workspaceId||normalizedExternalIdentity(intended.externalId)!==externalIdentity
        ||!String(intended.mutationOperationId||'')||String(intended.mutationOperationId)!==String(row.operation_id))return false;
      const payload=JSON.parse(String(row.payload_json||'{}')) as Record<string,unknown>;
      const committedId=String(payload.id||payload.itElementId||payload.applicationId||'').toLowerCase();
      return String(payload.engagementId||'')===String(binding.engagementId)&&committedId===objectId
        &&normalizedExternalIdentity(payload.number||payload.referenceNumber||payload.name)===externalIdentity;
    });
    if(matches.length===1){
      const match=matches[0]!;
      return{proven:true,runId:String(match.run_id),commandId:String(match.command_id),objectId,workspaceId,externalId,objectType:expectedObjectType,
        sourceSessionGeneration:Number(match.session_generation),currentSessionGeneration:Number(binding.sessionGeneration)};
    }
    return{proven:false};
  }

  private createMutationRun(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    const request = object(input, 'Mutation Run request');
    const engagementId = String(request.engagementId || '');
    if (!engagementId || engagementId.length > 200) throw new Error('Mutation Run Engagement identity is invalid.');
    const runId = randomUUID();
    const traceId = randomUUID();
    const createdAt = now();
    this.core.exec('BEGIN IMMEDIATE;');
    try {
      this.core.prepare(`
        INSERT INTO feature_runs(
          run_id,trace_id,feature_id,feature_version,engagement_id,state,state_revision,
          source_artifact_id,template_version_id,output_artifact_id,plan_digest,last_error,created_at,updated_at
        ) VALUES(?,?,?,?,?,'ready_for_review',1,'','','','','',?,?)
      `).run(runId, traceId, context.featureId, context.featureVersion, engagementId, createdAt, createdAt);
      this.core.prepare(`
        INSERT INTO feature_run_events(event_id,run_id,revision,from_state,to_state,event_type,details_json,occurred_at)
        VALUES(?,?,1,'','ready_for_review','mutation.plan_prepared','{}',?)
      `).run(randomUUID(), runId, createdAt);
      this.core.exec('COMMIT;');
    } catch (error) { this.core.exec('ROLLBACK;'); throw error; }
    return { runId, traceId, state: 'ready_for_review', stateRevision: 1 };
  }

  private loadLatestRun(context: FeatureWorkerPortContext): Record<string, unknown> | null {
    let run = this.core.prepare(`
      SELECT * FROM feature_runs WHERE feature_id=? AND feature_version=? ORDER BY updated_at DESC, created_at DESC, rowid DESC LIMIT 1
    `).get(context.featureId, context.featureVersion) as Record<string, unknown> | undefined;
    if (!run) run = this.core.prepare(`
      WITH RECURSIVE lineage(run_id,feature_version,package_digest,activation_generation) AS (
        SELECT r.run_id,r.feature_version,'',0
        FROM feature_runs r
        WHERE r.feature_id=?
        UNION
        SELECT l.run_id,h.target_feature_version,h.target_package_digest,h.target_activation_generation
        FROM lineage l
        JOIN feature_operation_handoffs h
          ON h.feature_id=? AND h.source_feature_version=l.feature_version
        WHERE h.phase IN ('staged','prepared','committed','finalize_pending','finalized')
      )
      SELECT r.*
      FROM lineage l
      JOIN feature_runs r ON r.run_id=l.run_id
      WHERE l.feature_version=? AND l.package_digest<>''
        AND (
          EXISTS (
            SELECT 1 FROM feature_activation_heads a
            WHERE a.feature_id=?
              AND a.feature_version=l.feature_version
              AND a.activation_generation=l.activation_generation
              AND a.package_digest=l.package_digest
              AND a.runtime_enabled=1
          ) OR EXISTS (
            SELECT 1
            FROM feature_operation_handoffs h
            JOIN feature_activation_heads a
              ON a.feature_id=h.feature_id
             AND a.feature_version=h.source_feature_version
             AND a.package_digest=h.source_package_digest
             AND a.activation_generation=h.source_activation_generation
            WHERE h.feature_id=?
              AND h.target_feature_version=l.feature_version
              AND h.target_package_digest=l.package_digest
              AND h.target_activation_generation=l.activation_generation
              AND h.phase IN ('staged','prepared','committed','finalize_pending')
          )
        )
        AND r.state IN (
          'acquiring','processing','converting','validating_output','needs_input','ready_for_review',
          'waiting_confirmation','returning','verifying','uncertain','reconciling','succeeded','failed'
      )
      ORDER BY r.updated_at DESC,r.created_at DESC,r.rowid DESC LIMIT 1
    `).get(
      context.featureId,
      context.featureId,
      context.featureVersion,
      context.featureId,
      context.featureId
    ) as Record<string, unknown> | undefined;
    if (!run) return null;
    if (run.state === 'failed'
      && run.last_error === 'Bootstrap evidence requires durable intents, commands, and authoritative read-back evidence for the completed Return batch.') {
      const runId = String(run.run_id);
      const uncertain = this.core.prepare(`SELECT COUNT(*) AS count FROM feature_commands c JOIN managed_content_intents i ON i.intent_id=c.intent_id AND i.run_id=c.run_id WHERE c.run_id=? AND c.state='uncertain' AND i.state='uncertain'`).get(runId) as {count:number};
      const inFlight = this.core.prepare(`SELECT COUNT(*) AS count FROM feature_commands WHERE run_id=? AND state IN ('submitted','committed','verifying')`).get(runId) as {count:number};
      const terminalEvent = this.core.prepare(`SELECT event_type,to_state FROM feature_run_events WHERE run_id=? ORDER BY occurred_at DESC,rowid DESC LIMIT 1`).get(runId) as {event_type:string;to_state:string}|undefined;
      if (uncertain.count > 0 && inFlight.count === 0 && terminalEvent?.event_type === 'return.failed' && terminalEvent.to_state === 'failed') {
        const recoveredAt = now();
        this.core.exec('BEGIN IMMEDIATE;');
        try {
          const updated = this.core.prepare(`UPDATE feature_runs SET state='uncertain',state_revision=state_revision+1,last_error='Recovered unresolved Return commands; only signed read-only reconcile is permitted.',updated_at=? WHERE run_id=? AND state='failed' AND last_error='Bootstrap evidence requires durable intents, commands, and authoritative read-back evidence for the completed Return batch.'`).run(recoveredAt,runId);
          if (updated.changes === 1) this.core.prepare(`INSERT INTO feature_run_events(event_id,run_id,revision,from_state,to_state,event_type,details_json,occurred_at) SELECT ?,run_id,state_revision,'failed','uncertain','return.failed_uncertain_recovered',?,? FROM feature_runs WHERE run_id=?`).run(randomUUID(),JSON.stringify({uncertainCommands:uncertain.count}),recoveredAt,runId);
          this.core.exec('COMMIT;');
        } catch (error) { this.core.exec('ROLLBACK;'); throw error; }
        run = this.core.prepare(`SELECT * FROM feature_runs WHERE run_id=?`).get(runId) as Record<string,unknown>;
      }
    }
    if (run.state === 'failed') {
      const runId = String(run.run_id);
      const terminalEvent = this.core.prepare(`SELECT event_type,to_state FROM feature_run_events WHERE run_id=? ORDER BY occurred_at DESC,rowid DESC LIMIT 1`)
        .get(runId) as {event_type:string;to_state:string}|undefined;
      if (run.last_error === 'Bootstrap evidence requires the current verified Return batch before terminal completion.'
        && terminalEvent?.event_type === 'return.failed' && terminalEvent.to_state === 'failed') {
        const incomplete = (this.core.prepare(`SELECT COUNT(*) AS count FROM managed_content_intents WHERE run_id=? AND state<>'verified'`).get(runId) as {count:number}).count;
        const openCommands = (this.core.prepare(`SELECT COUNT(*) AS count FROM feature_commands WHERE run_id=? AND state NOT IN ('readback_verified','closed_not_applied')`).get(runId) as {count:number}).count;
        const missingProjection = (this.core.prepare(`SELECT COUNT(*) AS count FROM managed_content_intents i WHERE i.run_id=? AND i.state='verified' AND NOT EXISTS (SELECT 1 FROM feature_commands c WHERE c.intent_id=i.intent_id AND (c.state='closed_not_applied' OR (c.state='readback_verified' AND (EXISTS(SELECT 1 FROM managed_object_revisions o WHERE o.command_id=c.command_id AND o.run_id=c.run_id) OR EXISTS(SELECT 1 FROM managed_relation_revisions r WHERE r.command_id=c.command_id AND r.run_id=c.run_id)))))`).get(runId) as {count:number}).count;
        if (incomplete === 0 && openCommands === 0 && missingProjection === 0) {
          const recoveredAt = now();
          this.core.exec('BEGIN IMMEDIATE;');
          try {
            const updated = this.core.prepare(`UPDATE feature_runs SET state='returning',state_revision=state_revision+1,last_error='Recovered the fully verified Return batch for bootstrap evidence finalization.',updated_at=? WHERE run_id=? AND state='failed' AND last_error='Bootstrap evidence requires the current verified Return batch before terminal completion.'`).run(recoveredAt,runId);
            if (updated.changes === 1) this.core.prepare(`INSERT INTO feature_run_events(event_id,run_id,revision,from_state,to_state,event_type,details_json,occurred_at) SELECT ?,run_id,state_revision,'failed','returning','return.bootstrap_evidence_recovered','{}',? FROM feature_runs WHERE run_id=?`).run(randomUUID(),recoveredAt,runId);
            this.core.exec('COMMIT;');
          } catch (error) { this.core.exec('ROLLBACK;'); throw error; }
          run = this.core.prepare(`SELECT * FROM feature_runs WHERE run_id=?`).get(runId) as Record<string,unknown>;
        }
      }
    }
    if (run.state === 'failed') {
      const runId = String(run.run_id);
      const terminalEvent = this.core.prepare(`SELECT event_type,to_state FROM feature_run_events WHERE run_id=? ORDER BY occurred_at DESC,rowid DESC LIMIT 1`)
        .get(runId) as {event_type:string;to_state:string}|undefined;
      // Older installed Workers mapped an authoritative "not applied" result
      // to failed.  That result closes exactly one command and is resumable;
      // repair only this exact terminal event, without replaying any mutation.
      if (terminalEvent?.event_type === 'return.reconcile_not_applied' && terminalEvent.to_state === 'failed') {
        const uncertain = (this.core.prepare(`SELECT COUNT(*) AS count FROM managed_content_intents WHERE run_id=? AND state='uncertain'`).get(runId) as {count:number}).count;
        const recoveredState = uncertain > 0 ? 'uncertain' : 'returning';
        const recoveredAt = now();
        this.core.exec('BEGIN IMMEDIATE;');
        try {
          const updated = this.core.prepare(`UPDATE feature_runs SET state=?,state_revision=state_revision+1,last_error=?,updated_at=? WHERE run_id=? AND state='failed'`)
            .run(recoveredState, uncertain > 0 ? 'Continue signed read-only reconciliation for the remaining uncertain command.' : 'Authoritative reconcile proved the command was not applied; explicit Return continuation is available.', recoveredAt, runId);
          if (updated.changes === 1) this.core.prepare(`INSERT INTO feature_run_events(event_id,run_id,revision,from_state,to_state,event_type,details_json,occurred_at) SELECT ?,run_id,state_revision,'failed',?,'return.reconcile_not_applied_recovered',?,? FROM feature_runs WHERE run_id=?`)
            .run(randomUUID(), recoveredState, JSON.stringify({remainingUncertain:uncertain}), recoveredAt, runId);
          this.core.exec('COMMIT;');
        } catch (error) { this.core.exec('ROLLBACK;'); throw error; }
        run = this.core.prepare(`SELECT * FROM feature_runs WHERE run_id=?`).get(runId) as Record<string,unknown>;
      }
    }
    if(run.state==='reconciling'){
      const recoveredAt=now();
      this.core.exec('BEGIN IMMEDIATE;');
      try{
        const updated=this.core.prepare(`UPDATE feature_runs SET state='uncertain',state_revision=state_revision+1,last_error='Read-only reconcile was interrupted; no mutation was replayed.',updated_at=? WHERE run_id=? AND state='reconciling'`).run(recoveredAt,String(run.run_id));
        if(updated.changes===1)this.core.prepare(`INSERT INTO feature_run_events(event_id,run_id,revision,from_state,to_state,event_type,details_json,occurred_at) SELECT ?,run_id,state_revision,'reconciling','uncertain','return.reconcile_crash_recovered','{}',? FROM feature_runs WHERE run_id=?`).run(randomUUID(),recoveredAt,String(run.run_id));
        this.core.exec('COMMIT;');
      }catch(error){this.core.exec('ROLLBACK;');throw error;}
      run=this.core.prepare(`SELECT * FROM feature_runs WHERE run_id=?`).get(String(run.run_id)) as Record<string,unknown>;
    }
    if (run.state === 'returning') {
      const stranded = this.core.prepare(`SELECT command_id,intent_id FROM feature_commands WHERE run_id=? AND state IN ('submitted','committed') ORDER BY created_at LIMIT 1`)
        .get(String(run.run_id)) as {command_id:string;intent_id:string}|undefined;
      if (stranded) {
        const recoveredAt = now();
        this.core.exec('BEGIN IMMEDIATE;');
        try {
          this.core.prepare(`UPDATE feature_commands SET state='uncertain',last_error='Worker exited after mutation submission; read-only reconcile is required.' WHERE command_id=? AND state IN ('submitted','committed')`).run(stranded.command_id);
          this.core.prepare(`UPDATE managed_content_intents SET state='uncertain',updated_at=? WHERE intent_id=?`).run(recoveredAt,stranded.intent_id);
          this.core.prepare(`UPDATE feature_runs SET state='uncertain',state_revision=state_revision+1,last_error='Recovered an in-flight mutation without a verified response.',updated_at=? WHERE run_id=? AND state='returning'`).run(recoveredAt,String(run.run_id));
          this.core.prepare(`INSERT INTO feature_run_events(event_id,run_id,revision,from_state,to_state,event_type,details_json,occurred_at) SELECT ?,run_id,state_revision,'returning','uncertain','return.crash_recovered',?,? FROM feature_runs WHERE run_id=?`).run(randomUUID(),JSON.stringify({commandId:stranded.command_id}),recoveredAt,String(run.run_id));
          this.core.exec('COMMIT;');
        } catch (error) { this.core.exec('ROLLBACK;'); throw error; }
        run = this.core.prepare(`SELECT * FROM feature_runs WHERE run_id=?`).get(String(run.run_id)) as Record<string,unknown>;
      }else{
        const pending=this.core.prepare(`SELECT COUNT(*) AS count FROM feature_commands WHERE run_id=? AND state='prepared'`).get(String(run.run_id)) as {count:number};
        if((pending.count>0||this.core.prepare(`SELECT 1 FROM feature_confirmations WHERE run_id=? AND decision='approved'`).get(String(run.run_id)))&&String(run.last_error||'')!=='Recovered a confirmed Return before mutation submission; explicit continuation is required.'){
          const recoveredAt=now();
          this.core.prepare(`UPDATE feature_runs SET state_revision=state_revision+1,last_error='Recovered a confirmed Return before mutation submission; explicit continuation is required.',updated_at=? WHERE run_id=? AND state='returning'`).run(recoveredAt,String(run.run_id));
          this.core.prepare(`INSERT INTO feature_run_events(event_id,run_id,revision,from_state,to_state,event_type,details_json,occurred_at) SELECT ?,run_id,state_revision,'returning','returning','return.pre_submit_crash_recovered',?,? FROM feature_runs WHERE run_id=?`).run(randomUUID(),JSON.stringify({preparedCommands:pending.count}),recoveredAt,String(run.run_id));
          run=this.core.prepare(`SELECT * FROM feature_runs WHERE run_id=?`).get(String(run.run_id)) as Record<string,unknown>;
        }
      }
    }
    const issues = this.core.prepare(`
      SELECT issue_id, field_key, issue_type, state, message, resolution_revision_id
      FROM feature_issues WHERE run_id=? ORDER BY created_at, issue_id
    `).all(String(run.run_id));
    const artifacts = this.core.prepare(`
      SELECT artifact_id, kind, original_name, sha256, size_bytes
      FROM feature_artifacts WHERE run_id=? ORDER BY created_at, artifact_id
    `).all(String(run.run_id));
    const events=this.core.prepare(`SELECT event_id,revision,from_state,to_state,event_type,details_json,occurred_at FROM feature_run_events WHERE run_id=? ORDER BY revision,event_id`).all(String(run.run_id));
    const returnProgress=this.core.prepare(`
      SELECT i.target_key,i.target_kind,i.state,
        COALESCE((SELECT c.state FROM feature_commands c WHERE c.intent_id=i.intent_id ORDER BY c.created_at DESC LIMIT 1),'pending') AS command_state
      FROM managed_content_intents i WHERE i.run_id=? ORDER BY i.created_at,i.intent_id
    `).all(String(run.run_id));
    return { run, issues, artifacts, events, returnProgress };
  }

  private loadOpenRun(context: FeatureWorkerPortContext): Record<string, unknown> | null {
    const candidates = this.core.prepare(`
      SELECT *
      FROM feature_runs
      WHERE feature_id=?
        AND state NOT IN ('succeeded','failed','cancelled','not_evaluable')
      ORDER BY updated_at DESC,created_at DESC,rowid DESC
    `).all(context.featureId) as Array<Record<string, unknown>>;
    const owned = candidates.filter((run) => this.currentActivationOwnsRun(String(run.run_id || ''), context));
    if (owned.length > 1) {
      throw new AppError(
        'FEATURE.OPEN_RUN_AMBIGUOUS',
        'More than one nonterminal Run belongs to the active Feature lineage; recovery must remain fail-closed.'
      );
    }
    return owned[0] || null;
  }

  private readArtifactBytes(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    const artifactId = String(object(input, 'Artifact request').artifactId || '');
    const row = this.core.prepare(`
      SELECT a.artifact_id, a.run_id, r.trace_id, a.kind, a.original_name, a.media_type,
             a.managed_path, a.sha256, a.size_bytes, a.imported_at
      FROM feature_artifacts a
      JOIN feature_runs r ON r.run_id=a.run_id AND r.feature_id=a.feature_id
      WHERE a.artifact_id=? AND a.feature_id=?
    `).get(artifactId, context.featureId) as Record<string, unknown> | undefined;
    if (!row) throw new Error('Managed Feature artifact was not found.');
    const managedPath = path.resolve(this.paths.data, ...String(row.managed_path).split('/'));
    const root = path.resolve(this.paths.data, 'features', context.featureId, 'artifacts');
    if (!managedPath.startsWith(`${root}${path.sep}`) || !fs.statSync(managedPath).isFile()) {
      throw new Error('Managed Feature artifact path is invalid.');
    }
    const bytes = fs.readFileSync(managedPath);
    if (bytes.length > 64 * 1024 * 1024) throw new Error('Managed Feature artifact exceeds the worker transfer limit.');
    const actualDigest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (actualDigest !== row.sha256 || bytes.length !== Number(row.size_bytes)) {
      throw new Error('Managed Feature artifact bytes drifted from their durable digest or size.');
    }
    return {
      artifactId: String(row.artifact_id), runId: String(row.run_id), traceId: String(row.trace_id),
      kind: String(row.kind), originalName: String(row.original_name),
      mediaType: String(row.media_type), sha256: String(row.sha256), sizeBytes: Number(row.size_bytes),
      importedAt: String(row.imported_at), contentBase64: bytes.toString('base64')
    };
  }

  private readManagedAssetBytes(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    const request = object(input, 'Managed asset request');
    const memberPath = String(request.memberPath || '');
    if (!/^backend\/[A-Za-z0-9._/-]{1,240}$/u.test(memberPath) || memberPath.includes('..')) {
      throw new Error('Managed asset member path is invalid.');
    }
    const row = this.core.prepare(`
      SELECT package_digest, member_path, member_digest, asset_kind, managed_path, imported_at
      FROM feature_managed_assets
      WHERE feature_id=? AND feature_version=? AND member_path=?
    `).get(context.featureId, context.featureVersion, memberPath) as Record<string, unknown> | undefined;
    if (!row) throw new Error('Managed Feature asset was not found for the active Feature version.');
    const managedPath = path.resolve(this.paths.data, ...String(row.managed_path).split('/'));
    const installedRoot = path.resolve(this.paths.data, 'packages', 'installed', context.featureId, context.featureVersion);
    if (!managedPath.startsWith(`${installedRoot}${path.sep}`) || !fs.statSync(managedPath).isFile()) {
      throw new Error('Managed Feature asset path is invalid.');
    }
    const bytes = fs.readFileSync(managedPath);
    if (bytes.length < 1 || bytes.length > 64 * 1024 * 1024) throw new Error('Managed Feature asset size is invalid.');
    const actualDigest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (actualDigest !== row.member_digest) throw new Error('Managed Feature asset digest drifted from the signed package manifest.');
    return {
      packageDigest: String(row.package_digest), memberPath: String(row.member_path),
      memberDigest: String(row.member_digest), assetKind: String(row.asset_kind),
      importedAt: String(row.imported_at), sizeBytes: bytes.length, contentBase64: bytes.toString('base64')
    };
  }

  private createProcessingRun(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    const request = object(input, 'Processing Run request');
    const surfaceId = String(request.surfaceId || '');
    if (!/^[a-z0-9][a-z0-9._-]{2,127}$/u.test(surfaceId)) throw new Error('Processing Run Surface identity is invalid.');
    const engagementId = String(request.engagementId || '');
    if (engagementId.length > 200) throw new Error('Processing Run Engagement identity is invalid.');
    const externalId = String(request.externalId || randomUUID()).toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(externalId)) {
      throw new Error('Processing Run external identity is invalid.');
    }
    const sourceRef = String(request.sourceRef || '');
    if (!sourceRef || sourceRef.length > 500) throw new Error('Processing Run source reference is invalid.');
    const recovery = request.recovery === undefined ? null : object(request.recovery, 'Processing Run frozen-input recovery');
    let frozenInputRecovery: Record<string, unknown> | null = null;
    if (recovery) {
      exactRecordKeys(recovery, [
        'schemaVersion', 'sourceFeatureVersion', 'externalId', 'connectorState',
        'frozenSha256', 'frozenSizeBytes', 'frozenChunkCount'
      ], 'Processing Run frozen-input recovery');
      const frozenSizeBytes = Number(recovery.frozenSizeBytes);
      const frozenChunkCount = Number(recovery.frozenChunkCount);
      const sourceFeatureVersion = String(recovery.sourceFeatureVersion || '');
      if (
        recovery.schemaVersion !== 'omnia.processing-run-frozen-input-recovery/v1'
        || !/^\d+\.\d+\.\d+$/u.test(sourceFeatureVersion)
        || String(recovery.externalId || '').toLowerCase() !== externalId
        || recovery.connectorState !== 'stopped'
        || !/^[0-9a-f]{64}$/u.test(String(recovery.frozenSha256 || ''))
        || !Number.isSafeInteger(frozenSizeBytes) || frozenSizeBytes < 1 || frozenSizeBytes > 64 * 1024 * 1024
        || !Number.isSafeInteger(frozenChunkCount) || frozenChunkCount < 1 || frozenChunkCount > 256
      ) throw new Error('Processing Run recovery requires exact stopped frozen-input identity, digest, size, and chunk count.');
      frozenInputRecovery = {
        schemaVersion: 'omnia.processing-run-frozen-input-recovery/v1',
        sourceFeatureVersion, externalId, connectorState: 'stopped',
        frozenSha256: String(recovery.frozenSha256), frozenSizeBytes, frozenChunkCount
      };
    }
    const processingStartedDetails = {
      surfaceId, externalId, sourceRef,
      ...(frozenInputRecovery ? { frozenInputRecovery } : {})
    };
    const existing = this.core.prepare(`
      SELECT r.run_id,r.trace_id,r.state,r.state_revision,r.created_at,r.engagement_id,e.details_json
      FROM feature_runs r
      JOIN feature_run_events e ON e.run_id=r.run_id AND e.event_type='run.processing_started'
      WHERE r.feature_id=? AND r.feature_version=?
        AND json_extract(e.details_json,'$.surfaceId')=?
        AND json_extract(e.details_json,'$.externalId')=?
      ORDER BY e.occurred_at DESC,e.rowid DESC LIMIT 1
    `).get(context.featureId, context.featureVersion, surfaceId, externalId) as Record<string, unknown> | undefined;
    if (existing) {
      const existingDetails = JSON.parse(String(existing.details_json || '{}')) as Record<string, unknown>;
      if (
        String(existing.engagement_id || '') !== engagementId
        || canonical(existingDetails) !== canonical(processingStartedDetails)
      ) throw new Error('Existing Processing Run identity or frozen-input recovery evidence differs from this request.');
      return {
        schemaVersion: 'omnia.processing-run/v1', runId: String(existing.run_id), traceId: String(existing.trace_id),
        externalId, surfaceId, featureId: context.featureId, featureVersion: context.featureVersion,
        state: String(existing.state), stateRevision: Number(existing.state_revision), createdAt: String(existing.created_at), idempotent: true
      };
    }
    const runId = randomUUID();
    const traceId = randomUUID();
    const createdAt = now();
    const planDigest = canonicalDigest({
      featureId: context.featureId, featureVersion: context.featureVersion,
      surfaceId, engagementId, externalId, sourceRef, frozenInputRecovery
    });
    this.core.exec('BEGIN IMMEDIATE;');
    try {
      this.core.prepare(`
        INSERT INTO feature_runs(
          run_id,trace_id,feature_id,feature_version,engagement_id,state,state_revision,
          source_artifact_id,template_version_id,output_artifact_id,plan_digest,last_error,created_at,updated_at
        ) VALUES(?,?,?,?,?,'processing',1,'','','',?,'',?,?)
      `).run(runId, traceId, context.featureId, context.featureVersion, engagementId, planDigest, createdAt, createdAt);
      this.core.prepare(`
        INSERT INTO feature_run_events(event_id,run_id,revision,from_state,to_state,event_type,details_json,occurred_at)
        VALUES(?,?,1,'','processing','run.processing_started',?,?)
      `).run(randomUUID(), runId, JSON.stringify(processingStartedDetails), createdAt);
      this.core.exec('COMMIT;');
    } catch (error) { this.core.exec('ROLLBACK;'); throw error; }
    return {
      schemaVersion: 'omnia.processing-run/v1', runId, traceId, externalId, surfaceId,
      featureId: context.featureId, featureVersion: context.featureVersion,
      state: 'processing', stateRevision: 1, createdAt
    };
  }

  private createSuccessorProcessingRun(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    const request = object(input, 'Successor Processing Run request');
    exactRecordKeys(request, [
      'schemaVersion', 'predecessorRunId', 'surfaceId', 'engagementId', 'externalId', 'sourceRef', 'frozenInput'
    ], 'Successor Processing Run request');
    if (request.schemaVersion !== 'omnia.processing-run-successor-request/v1') {
      throw new Error('Successor Processing Run schema is invalid.');
    }
    const predecessorRunId = String(request.predecessorRunId || '').toLowerCase();
    const externalId = String(request.externalId || '').toLowerCase();
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
    if (!uuid.test(predecessorRunId) || !uuid.test(externalId)) {
      throw new Error('Successor Processing Run identity is invalid.');
    }
    const surfaceId = String(request.surfaceId || '');
    const engagementId = String(request.engagementId || '');
    const sourceRef = String(request.sourceRef || '');
    if (!/^[a-z0-9][a-z0-9._-]{2,127}$/u.test(surfaceId) || engagementId.length > 200
      || !sourceRef || sourceRef.length > 500) {
      throw new Error('Successor Processing Run source identity is invalid.');
    }
    const frozen = object(request.frozenInput, 'Successor Processing Run frozen input');
    exactRecordKeys(frozen, [
      'schemaVersion', 'observationId', 'streamId', 'stoppedAt', 'eventCount',
      'complete', 'omissionCount', 'streamSha256', 'streamSizeBytes', 'streamChunkCount'
    ], 'Successor Processing Run frozen input');
    const eventCount = Number(frozen.eventCount);
    const streamSizeBytes = Number(frozen.streamSizeBytes);
    const streamChunkCount = Number(frozen.streamChunkCount);
    const stoppedAt = String(frozen.stoppedAt || '');
    const frozenSchemaVersion = String(frozen.schemaVersion || '');
    if (!/^omnia\.[a-z0-9][a-z0-9._-]{2,100}-frozen-input\/v1$/u.test(frozenSchemaVersion)
      || !/^observation_[0-9a-f]{32}$/u.test(String(frozen.observationId || ''))
      || !/^stream_[0-9a-f]{32}$/u.test(String(frozen.streamId || ''))
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(stoppedAt)
      || !Number.isSafeInteger(eventCount) || eventCount < 1 || eventCount > 100_000
      || frozen.complete !== true || frozen.omissionCount !== 0
      || !/^[0-9a-f]{64}$/u.test(String(frozen.streamSha256 || ''))
      || !Number.isSafeInteger(streamSizeBytes) || streamSizeBytes < 1 || streamSizeBytes > 64 * 1024 * 1024
      || !Number.isSafeInteger(streamChunkCount) || streamChunkCount < 1 || streamChunkCount > 512) {
      throw new Error('Successor Processing Run requires complete bounded frozen-input evidence.');
    }
    const frozenInput = {
      schemaVersion: frozenSchemaVersion,
      observationId: String(frozen.observationId), streamId: String(frozen.streamId), stoppedAt, eventCount,
      complete: true, omissionCount: 0,
      streamSha256: String(frozen.streamSha256), streamSizeBytes, streamChunkCount
    };
    const createdAt = now();
    let result: Record<string, unknown> | null = null;
    this.core.exec('BEGIN IMMEDIATE;');
    try {
      const predecessor = this.core.prepare(`
        SELECT r.run_id,r.feature_version,r.engagement_id,r.state,r.state_revision,r.output_artifact_id,
               r.created_at,e.details_json,
               (SELECT COALESCE(MAX(revision),0) FROM feature_run_events WHERE run_id=r.run_id) AS event_revision,
               (SELECT event_type FROM feature_run_events WHERE run_id=r.run_id ORDER BY revision DESC LIMIT 1) AS last_event_type,
               (SELECT details_json FROM feature_run_events WHERE run_id=r.run_id ORDER BY revision DESC LIMIT 1) AS last_event_details_json,
               (SELECT COUNT(*) FROM feature_artifacts WHERE run_id=r.run_id AND kind='result') AS output_count,
               (SELECT COUNT(*) FROM managed_content_intents WHERE run_id=r.run_id) AS intent_count,
               (SELECT COUNT(*) FROM feature_commands WHERE run_id=r.run_id) AS command_count
        FROM feature_runs r
        JOIN feature_run_events e ON e.run_id=r.run_id AND e.revision=1 AND e.event_type='run.processing_started'
        WHERE r.run_id=? AND r.feature_id=?
      `).get(predecessorRunId, context.featureId) as Record<string, unknown> | undefined;
      if (!predecessor) throw new Error('Failed predecessor Processing Run is unavailable for successor recovery.');
      const predecessorDetails = JSON.parse(String(predecessor.details_json || '{}')) as Record<string, unknown>;
      const lastEventDetails = JSON.parse(String(predecessor.last_event_details_json || '{}')) as Record<string, unknown>;
      if (String(predecessor.feature_version) === context.featureVersion
        || predecessor.state !== 'failed'
        || Number(predecessor.state_revision) !== Number(predecessor.event_revision)
        || predecessor.last_event_type !== 'recording.terminal_projection_reconciled'
        || lastEventDetails.privateState !== 'finalization_failed'
        || lastEventDetails.evidenceRetained !== true
        || lastEventDetails.mutationReplayed !== false
        || String(predecessor.output_artifact_id || '') !== ''
        || Number(predecessor.output_count) !== 0
        || Number(predecessor.intent_count) !== 0
        || Number(predecessor.command_count) !== 0
        || String(predecessor.engagement_id || '') !== engagementId
        || String(predecessorDetails.surfaceId || '') !== surfaceId
        || String(predecessorDetails.externalId || '').toLowerCase() !== externalId
        || String(predecessorDetails.sourceRef || '') !== sourceRef) {
        throw new Error('Failed predecessor Run is not eligible for side-effect-free successor recovery.');
      }
      const recoveryLineage = {
        schemaVersion: 'omnia.processing-run-recovery-lineage/v1',
        recoveryKind: 'frozen_input_finalize', predecessorRunId,
        predecessorFeatureVersion: String(predecessor.feature_version),
        predecessorStateRevision: Number(predecessor.state_revision),
        predecessorCreatedAt: String(predecessor.created_at), externalId, frozenInput
      };
      const processingStartedDetails = { surfaceId, externalId, sourceRef, recoveryLineage };
      const existingRows = this.core.prepare(`
        SELECT r.run_id,r.trace_id,r.feature_version,r.state,r.state_revision,r.created_at,e.details_json
        FROM feature_runs r
        JOIN feature_run_events e ON e.run_id=r.run_id AND e.revision=1 AND e.event_type='run.processing_started'
        WHERE r.feature_id=?
          AND json_extract(e.details_json,'$.recoveryLineage.predecessorRunId')=?
        ORDER BY r.created_at,r.run_id
      `).all(context.featureId, predecessorRunId) as Array<Record<string, unknown>>;
      if (existingRows.length > 1) {
        throw new AppError('FEATURE.PROCESSING_RUN_SUCCESSOR_CONFLICT', 'More than one successor Run exists for the same predecessor.');
      }
      if (existingRows.length === 1) {
        const existing = existingRows[0]!;
        if (String(existing.feature_version || '') !== context.featureVersion) {
          throw new AppError('FEATURE.PROCESSING_RUN_SUCCESSOR_CONFLICT', 'A different Feature generation already owns the predecessor successor lineage.');
        }
        if (canonical(JSON.parse(String(existing.details_json || '{}'))) !== canonical(processingStartedDetails)) {
          throw new AppError('FEATURE.PROCESSING_RUN_SUCCESSOR_CONFLICT', 'Existing successor Run recovery evidence differs from this request.');
        }
        result = {
          schemaVersion: 'omnia.processing-run/v1', runId: String(existing.run_id), traceId: String(existing.trace_id),
          externalId, surfaceId, featureId: context.featureId, featureVersion: context.featureVersion,
          state: String(existing.state), stateRevision: Number(existing.state_revision), createdAt: String(existing.created_at),
          predecessorRunId, recoveryLineage, idempotent: true
        };
      } else {
        const runId = randomUUID();
        const traceId = randomUUID();
        const planDigest = canonicalDigest({
          featureId: context.featureId, featureVersion: context.featureVersion,
          surfaceId, engagementId, externalId, sourceRef, recoveryLineage
        });
        this.core.prepare(`
          INSERT INTO feature_runs(
            run_id,trace_id,feature_id,feature_version,engagement_id,state,state_revision,
            source_artifact_id,template_version_id,output_artifact_id,plan_digest,last_error,created_at,updated_at
          ) VALUES(?,?,?,?,?,'processing',1,'','','',?,'',?,?)
        `).run(runId, traceId, context.featureId, context.featureVersion, engagementId, planDigest, createdAt, createdAt);
        this.core.prepare(`
          INSERT INTO feature_run_events(event_id,run_id,revision,from_state,to_state,event_type,details_json,occurred_at)
          VALUES(?,?,1,'','processing','run.processing_started',?,?)
        `).run(randomUUID(), runId, JSON.stringify(processingStartedDetails), createdAt);
        result = {
          schemaVersion: 'omnia.processing-run/v1', runId, traceId, externalId, surfaceId,
          featureId: context.featureId, featureVersion: context.featureVersion,
          state: 'processing', stateRevision: 1, createdAt, predecessorRunId, recoveryLineage
        };
      }
      this.core.exec('COMMIT;');
    } catch (error) {
      this.core.exec('ROLLBACK;');
      throw error;
    }
    return result!;
  }

  private loadProcessingRun(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> | null {
    const request = object(input, 'Processing Run lookup');
    const runId = String(request.runId || '');
    const externalId = String(request.externalId || '').toLowerCase();
    if (Boolean(runId) === Boolean(externalId)) throw new Error('Processing Run lookup requires exactly one Run or external identity.');
    if (externalId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(externalId)) {
      throw new Error('Processing Run lookup external identity is invalid.');
    }
    const ownerPredicate = runId
      ? 'r.run_id=?'
      : "r.feature_version=? AND json_extract(e.details_json,'$.externalId')=?";
    const ownerParameters = runId
      ? [context.featureId, runId]
      : [context.featureId, context.featureVersion, externalId];
    const row = this.core.prepare(`
      SELECT r.*,e.details_json,
        a.artifact_id,a.kind,a.media_type,a.original_name,a.sha256,a.size_bytes,a.imported_at
      FROM feature_runs r
      JOIN feature_run_events e ON e.run_id=r.run_id AND e.event_type='run.processing_started'
      LEFT JOIN feature_artifacts a ON a.artifact_id=r.output_artifact_id AND a.run_id=r.run_id
      WHERE r.feature_id=? AND ${ownerPredicate}
      ORDER BY e.occurred_at DESC,e.rowid DESC LIMIT 1
    `).get(...ownerParameters) as Record<string, unknown> | undefined;
    if (!row) return null;
    const details = JSON.parse(String(row.details_json || '{}')) as Record<string, unknown>;
    const artifact = row.artifact_id ? {
      artifactId: String(row.artifact_id), kind: String(row.kind), originalName: String(row.original_name),
      mediaType: String(row.media_type), sha256: String(row.sha256), sizeBytes: Number(row.size_bytes),
      importedAt: String(row.imported_at)
    } : null;
    return {
      schemaVersion: 'omnia.processing-run/v1', runId: String(row.run_id), traceId: String(row.trace_id),
      externalId: String(details.externalId || ''), surfaceId: String(details.surfaceId || ''),
      sourceRef: String(details.sourceRef || ''), state: String(row.state), stateRevision: Number(row.state_revision),
      lastError: String(row.last_error || ''), createdAt: String(row.created_at), updatedAt: String(row.updated_at), artifact,
      ...(details.recoveryLineage ? {
        predecessorRunId: String((details.recoveryLineage as Record<string, unknown>).predecessorRunId || ''),
        recoveryLineage: details.recoveryLineage
      } : {})
    };
  }

  private finishProcessingRun(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    const request = object(input, 'Processing Run completion');
    const runId = String(request.runId || '');
    const artifactId = String(request.artifactId || '');
    const completedAt = now();
    let stateRevision = 0;
    let idempotent = false;
    this.core.exec('BEGIN IMMEDIATE;');
    try {
      const run = this.core.prepare(`
        SELECT state,state_revision,output_artifact_id FROM feature_runs
        WHERE run_id=? AND feature_id=? AND feature_version=?
      `).get(runId, context.featureId, context.featureVersion) as { state: string; state_revision: number; output_artifact_id: string } | undefined;
      if (!run) throw new Error('Processing Run is unavailable for this Feature version.');
      stateRevision = run.state_revision;
      if (run.state === 'succeeded' && run.output_artifact_id === artifactId) {
        idempotent = true;
      } else {
        if (run.state !== 'processing') throw new Error('Processing Run is not in a completable state.');
        if (!this.core.prepare(`SELECT 1 FROM feature_artifacts WHERE artifact_id=? AND run_id=? AND feature_id=?`).get(
          artifactId, runId, context.featureId
        )) throw new Error('Processing Run output Artifact is not owned by this Run.');
        const eventRevision = Number((this.core.prepare(`
          SELECT COALESCE(MAX(revision),0) AS revision FROM feature_run_events WHERE run_id=?
        `).get(runId) as { revision: number }).revision);
        if (eventRevision !== run.state_revision) {
          throw new Error('Processing Run event revision invariant is broken; completion was not written.');
        }
        stateRevision = run.state_revision + 1;
      const updated = this.core.prepare(`
        UPDATE feature_runs SET state='succeeded',state_revision=?,output_artifact_id=?,last_error='',updated_at=?
        WHERE run_id=? AND feature_id=? AND feature_version=? AND state='processing' AND state_revision=?
      `).run(stateRevision, artifactId, completedAt, runId, context.featureId, context.featureVersion, run.state_revision);
      if (updated.changes !== 1) throw new Error('Processing Run changed before completion.');
      this.core.prepare(`
        INSERT INTO feature_run_events(event_id,run_id,revision,from_state,to_state,event_type,details_json,occurred_at)
        VALUES(?,?,?,'processing','succeeded','run.processing_succeeded',?,?)
      `).run(randomUUID(), runId, stateRevision, JSON.stringify({ artifactId }), completedAt);
      }
      this.core.exec('COMMIT;');
    } catch (error) { this.core.exec('ROLLBACK;'); throw error; }
    const artifact = this.core.prepare(`
      SELECT artifact_id,kind,media_type,original_name,sha256,size_bytes,imported_at
      FROM feature_artifacts WHERE artifact_id=? AND run_id=? AND feature_id=?
    `).get(artifactId, runId, context.featureId) as Record<string, unknown>;
    return {
      schemaVersion: 'omnia.processing-run-result/v1', runId, artifactId, state: 'succeeded', stateRevision,
      ...(idempotent ? { idempotent: true } : { completedAt }),
      artifact: {
        artifactId: String(artifact.artifact_id), kind: String(artifact.kind), originalName: String(artifact.original_name),
        mediaType: String(artifact.media_type), sha256: String(artifact.sha256), sizeBytes: Number(artifact.size_bytes),
        importedAt: String(artifact.imported_at)
      }
    };
  }

  private failProcessingRun(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    const request = object(input, 'Processing Run failure');
    const runId = String(request.runId || '');
    const message = String(request.error || 'Processing failed.').slice(0, 2_000);
    const terminalState = String(request.state || 'failed');
    if (!['failed', 'uncertain'].includes(terminalState)) throw new Error('Processing Run failure state is invalid.');
    const failedAt = now();
    let stateRevision = 0;
    let idempotent = false;
    this.core.exec('BEGIN IMMEDIATE;');
    try {
      const run = this.core.prepare(`
        SELECT state,state_revision,feature_version FROM feature_runs WHERE run_id=? AND feature_id=?
      `).get(runId, context.featureId) as { state: string; state_revision: number; feature_version: string } | undefined;
      if (!run) throw new Error('Processing Run is unavailable for this Feature.');
      stateRevision = run.state_revision;
      if (run.state === terminalState) {
        idempotent = true;
      } else {
        if (run.state !== 'processing') throw new Error('Processing Run is not in a failable state.');
        const eventRevision = Number((this.core.prepare(`
          SELECT COALESCE(MAX(revision),0) AS revision FROM feature_run_events WHERE run_id=?
        `).get(runId) as { revision: number }).revision);
        if (eventRevision !== run.state_revision) {
          throw new Error('Processing Run event revision invariant is broken; failure was not written.');
        }
        stateRevision = run.state_revision + 1;
      const updated = this.core.prepare(`
        UPDATE feature_runs SET state=?,state_revision=?,last_error=?,updated_at=?
        WHERE run_id=? AND feature_id=? AND feature_version=? AND state='processing' AND state_revision=?
      `).run(terminalState, stateRevision, message, failedAt, runId, context.featureId, run.feature_version, run.state_revision);
      if (updated.changes !== 1) throw new Error('Processing Run changed before failure was recorded.');
      this.core.prepare(`
        INSERT INTO feature_run_events(event_id,run_id,revision,from_state,to_state,event_type,details_json,occurred_at)
        VALUES(?,?,?,'processing',?,?,?,?)
      `).run(randomUUID(), runId, stateRevision, terminalState,
        terminalState === 'uncertain' ? 'run.processing_uncertain' : 'run.processing_failed',
        JSON.stringify({ error: message }), failedAt);
      }
      this.core.exec('COMMIT;');
    } catch (error) { this.core.exec('ROLLBACK;'); throw error; }
    return {
      schemaVersion: 'omnia.processing-run-result/v1', runId, state: terminalState, stateRevision,
      ...(idempotent ? { idempotent: true } : { failedAt })
    };
  }

  private beginPythonInputTransfer(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    const request = object(input, 'Python input transfer');
    const runId = String(request.runId || '');
    const originalName = path.basename(String(request.originalName || ''));
    if (!originalName || originalName !== String(request.originalName) || originalName.length > 255) throw new Error('Python input transfer name is invalid.');
    const extension = path.extname(originalName).toLowerCase();
    if (!/^\.[a-z0-9]{1,12}$/u.test(extension)) throw new Error('Python input transfer extension is invalid.');
    const expectedSizeBytes = Number(request.expectedSizeBytes);
    const chunkCount = Number(request.chunkCount);
    const expectedSha256 = String(request.expectedSha256 || '');
    if (!Number.isSafeInteger(expectedSizeBytes) || expectedSizeBytes < 1 || expectedSizeBytes > 64 * 1024 * 1024) {
      throw new Error('Python input transfer size is invalid.');
    }
    if (!Number.isSafeInteger(chunkCount) || chunkCount < 1 || chunkCount > 256) throw new Error('Python input transfer chunk count is invalid.');
    if (!/^[0-9a-f]{64}$/u.test(expectedSha256)) throw new Error('Python input transfer digest is invalid.');
    const run = this.core.prepare(`
      SELECT r.state,r.state_revision,e.details_json
      FROM feature_runs r
      JOIN feature_run_events e ON e.run_id=r.run_id AND e.event_type='run.processing_started'
      WHERE r.run_id=? AND r.feature_id=? AND r.feature_version=?
      ORDER BY e.occurred_at DESC,e.rowid DESC LIMIT 1
    `).get(runId, context.featureId, context.featureVersion) as { state: string; state_revision: number; details_json: string } | undefined;
    if (!run || !['processing', 'uncertain'].includes(run.state)) {
      throw new Error('Python input transfer Run is unavailable or not recoverable.');
    }
    const started = JSON.parse(run.details_json || '{}') as Record<string, unknown>;
    const recovery = request.recovery && typeof request.recovery === 'object'
      ? request.recovery as Record<string, unknown> : null;
    let bindingEvidence: Record<string, unknown> | null = null;
    if (recovery) {
    const externalId = String(started.externalId || '');
    exactRecordKeys(recovery, [
      'schemaVersion', 'externalId', 'connectorState',
      'frozenSha256', 'frozenSizeBytes', 'frozenChunkCount'
    ], 'Python input frozen recovery');
    bindingEvidence = {
      schemaVersion: 'omnia.processing-run-frozen-input-recovery/v1',
      externalId, connectorState: 'stopped', frozenSha256: expectedSha256,
      frozenSizeBytes: expectedSizeBytes, frozenChunkCount: chunkCount
    };
    const startedRecovery = started.frozenInputRecovery && typeof started.frozenInputRecovery === 'object'
      ? started.frozenInputRecovery as Record<string, unknown> : null;
    if (
      recovery.schemaVersion !== bindingEvidence.schemaVersion
      || String(recovery.externalId || '') !== externalId
      || recovery.connectorState !== 'stopped'
      || String(recovery.frozenSha256 || '') !== expectedSha256
      || Number(recovery.frozenSizeBytes) !== expectedSizeBytes
      || Number(recovery.frozenChunkCount) !== chunkCount
      || (startedRecovery && (
        String(startedRecovery.externalId || '') !== externalId
        || startedRecovery.connectorState !== 'stopped'
        || String(startedRecovery.frozenSha256 || '') !== expectedSha256
        || Number(startedRecovery.frozenSizeBytes) !== expectedSizeBytes
        || Number(startedRecovery.frozenChunkCount) !== chunkCount
      ))
    ) throw new Error('Processing Run requires exact stopped Connector frozen-input identity, digest, size, and chunk count.');
    } else if (run.state === 'uncertain') {
      throw new Error('An uncertain Processing Run requires exact Connector frozen-input evidence.');
    }
    const transferId = randomUUID();
    const transferRoot = this.pythonHandleRoot(context, runId, transferId);
    fs.mkdirSync(path.dirname(transferRoot), { recursive: true });
    fs.mkdirSync(transferRoot, { recursive: false });
    const filename = path.join(transferRoot, `input${extension}`);
    try { fs.writeFileSync(filename, Buffer.alloc(0), { flag: 'wx' }); }
    catch (error) { fs.rmSync(transferRoot, { recursive: true, force: true }); throw error; }
    try {
      if (bindingEvidence) {
        const transitionAt = now();
        this.core.exec('BEGIN IMMEDIATE;');
        try {
          const current = this.core.prepare(`
            SELECT state,state_revision FROM feature_runs
            WHERE run_id=? AND feature_id=? AND feature_version=?
          `).get(runId, context.featureId, context.featureVersion) as { state: string; state_revision: number } | undefined;
          if (!current || !['processing', 'uncertain'].includes(current.state)) {
            throw new Error('Python input transfer Run changed before frozen-input binding.');
          }
          const duplicate = this.core.prepare(`
            SELECT details_json FROM feature_run_events WHERE run_id=? AND event_type='run.processing_frozen_input_bound'
            ORDER BY occurred_at,rowid LIMIT 1
          `).get(runId) as { details_json: string } | undefined;
          if (duplicate) {
            if (canonical(JSON.parse(duplicate.details_json || '{}')) !== canonical(bindingEvidence)) {
              throw new Error('Processing Run frozen-input evidence changed during binding.');
            }
          }
          const eventRevision = Number((this.core.prepare(`
            SELECT COALESCE(MAX(revision),0) AS revision FROM feature_run_events WHERE run_id=?
          `).get(runId) as { revision: number }).revision);
          if (eventRevision !== current.state_revision) {
            throw new Error('Processing Run event revision invariant is broken; frozen input was not bound.');
          }
          const bindingRevision = duplicate ? current.state_revision : current.state_revision + 1;
          const recoveryRevision = current.state === 'uncertain' ? bindingRevision + 1 : bindingRevision;
          if (!duplicate || current.state === 'uncertain') {
            const updated = this.core.prepare(`
              UPDATE feature_runs SET state='processing',state_revision=?,last_error='',updated_at=?
              WHERE run_id=? AND feature_id=? AND feature_version=? AND state=? AND state_revision=?
            `).run(
              recoveryRevision, transitionAt, runId, context.featureId, context.featureVersion,
              current.state, current.state_revision
            );
            if (updated.changes !== 1) throw new Error('Processing Run changed before frozen-input binding.');
          }
          if (!duplicate) {
            this.core.prepare(`
              INSERT INTO feature_run_events(event_id,run_id,revision,from_state,to_state,event_type,details_json,occurred_at)
              VALUES(?,?,?,?,?,'run.processing_frozen_input_bound',?,?)
            `).run(
              randomUUID(), runId, bindingRevision, current.state, current.state,
              JSON.stringify(bindingEvidence), transitionAt
            );
          }
          if (current.state === 'uncertain') {
            this.core.prepare(`
              INSERT INTO feature_run_events(event_id,run_id,revision,from_state,to_state,event_type,details_json,occurred_at)
              VALUES(?,?,?,'uncertain','processing','run.processing_recovered_from_frozen_input',?,?)
            `).run(randomUUID(), runId, recoveryRevision, JSON.stringify({
              externalId: String(recovery?.externalId || ''), connectorState: 'stopped',
              frozenSha256: expectedSha256, frozenSizeBytes: expectedSizeBytes, frozenChunkCount: chunkCount
            }), transitionAt);
          }
          this.core.exec('COMMIT;');
        } catch (error) { this.core.exec('ROLLBACK;'); throw error; }
      }
      this.pythonInputTransfers.set(transferId, {
        featureId: context.featureId, featureVersion: context.featureVersion, runId, originalName,
        mediaType: String(request.mediaType || 'application/octet-stream'), expectedSizeBytes, expectedSha256,
        chunkCount, nextChunkIndex: 0, receivedBytes: 0, filename, digest: crypto.createHash('sha256')
      });
    } catch (error) {
      fs.rmSync(transferRoot, { recursive: true, force: true });
      throw error;
    }
    return {
      schemaVersion: 'omnia.python-input-transfer/v1', transferId, runId,
      expectedSizeBytes, expectedSha256, chunkCount, nextChunkIndex: 0, receivedBytes: 0
    };
  }

  private appendPythonInputTransferChunk(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    const request = object(input, 'Python input transfer chunk');
    const transferId = String(request.transferId || '');
    const transfer = this.pythonInputTransfers.get(transferId);
    if (!transfer || transfer.featureId !== context.featureId || transfer.featureVersion !== context.featureVersion) {
      throw new Error('Python input transfer is unavailable or not owned by this Feature version.');
    }
    const chunkIndex = Number(request.chunkIndex);
    if (!Number.isSafeInteger(chunkIndex) || chunkIndex !== transfer.nextChunkIndex || chunkIndex >= transfer.chunkCount) {
      throw new Error('Python input transfer chunk is out of order.');
    }
    if (typeof request.contentBase64 !== 'string') throw new Error('Python input transfer chunk requires strict base64 bytes.');
    const bytes = Buffer.from(request.contentBase64, 'base64');
    if (bytes.length < 1 || bytes.length > 1024 * 1024 || bytes.toString('base64') !== request.contentBase64) {
      throw new Error('Python input transfer chunk bytes are invalid.');
    }
    if (request.offsetBytes !== undefined && Number(request.offsetBytes) !== transfer.receivedBytes) throw new Error('Python input transfer chunk offset drifted.');
    const chunkSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (request.sha256 !== undefined && String(request.sha256) !== chunkSha256) throw new Error('Python input transfer chunk digest mismatch.');
    if (transfer.receivedBytes + bytes.length > transfer.expectedSizeBytes) throw new Error('Python input transfer exceeded its frozen size.');
    fs.appendFileSync(transfer.filename, bytes);
    transfer.digest.update(bytes);
    transfer.receivedBytes += bytes.length;
    transfer.nextChunkIndex += 1;
    return {
      schemaVersion: 'omnia.python-input-transfer-progress/v1', transferId,
      acceptedChunkIndex: chunkIndex, nextChunkIndex: transfer.nextChunkIndex,
      receivedBytes: transfer.receivedBytes, chunkSha256
    };
  }

  private commitPythonInputTransfer(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    const request = object(input, 'Python input transfer commit');
    const transferId = String(request.transferId || '');
    const transfer = this.pythonInputTransfers.get(transferId);
    if (!transfer || transfer.featureId !== context.featureId || transfer.featureVersion !== context.featureVersion) {
      throw new Error('Python input transfer is unavailable or not owned by this Feature version.');
    }
    if (transfer.nextChunkIndex !== transfer.chunkCount || transfer.receivedBytes !== transfer.expectedSizeBytes) throw new Error('Python input transfer is incomplete.');
    const stat = fs.statSync(transfer.filename);
    if (!stat.isFile() || stat.size !== transfer.expectedSizeBytes) throw new Error('Python input transfer file size drifted.');
    const sha256 = transfer.digest.digest('hex');
    if (sha256 !== transfer.expectedSha256) throw new Error('Python input transfer digest mismatch.');
    this.pythonInputTransfers.delete(transferId);
    this.pythonArtifactHandles.set(transferId, {
      featureId: transfer.featureId, featureVersion: transfer.featureVersion, runId: transfer.runId,
      filename: transfer.filename, access: 'read', kind: 'transient_input', mediaType: transfer.mediaType,
      originalName: transfer.originalName, maxBytes: transfer.expectedSizeBytes
    });
    return {
      schemaVersion: 'omnia.python-artifact-handle/v1', handleId: transferId, runId: transfer.runId,
      path: transfer.filename, access: 'read', mediaType: transfer.mediaType,
      originalName: transfer.originalName, sizeBytes: transfer.expectedSizeBytes, sha256
    };
  }

  private abortPythonInputTransfer(input: unknown, context: FeatureWorkerPortContext): true {
    const request = object(input, 'Python input transfer abort');
    const transferId = String(request.transferId || '');
    const transfer = this.pythonInputTransfers.get(transferId);
    if (!transfer) return true;
    if (transfer.featureId !== context.featureId || transfer.featureVersion !== context.featureVersion) {
      throw new Error('Python input transfer is owned by another Feature version.');
    }
    this.pythonInputTransfers.delete(transferId);
    fs.rmSync(this.pythonHandleRoot(context, transfer.runId, transferId), { recursive: true, force: true });
    return true;
  }

  private pythonHandleRoot(context: FeatureWorkerPortContext, runId: string, handleId: string): string {
    if (!/^[0-9a-f-]{36}$/u.test(runId) || !/^[0-9a-f-]{36}$/u.test(handleId)) {
      throw new Error('Python Artifact handle Run or handle identity is invalid.');
    }
    const featureRoot = path.resolve(this.paths.temp, 'features', context.featureId);
    const handleRoot = path.resolve(featureRoot, runId, handleId);
    if (!handleRoot.startsWith(`${featureRoot}${path.sep}`)) throw new Error('Python Artifact handle escaped its Feature/Run temp root.');
    return handleRoot;
  }

  private openPythonArtifactHandle(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    const request = object(input, 'Python input Artifact handle');
    const runId = String(request.runId || '');
    if (!this.core.prepare(`SELECT 1 FROM feature_runs WHERE run_id=? AND feature_id=? AND feature_version=?`).get(
      runId, context.featureId, context.featureVersion
    )) throw new Error('Python input Artifact handle Run is not owned by the active Feature version.');
    const artifactId = String(request.artifactId || '');
    const memberPath = String(request.memberPath || '');
    if (Boolean(artifactId) === Boolean(memberPath)) throw new Error('Python input handle requires exactly one Artifact or managed asset identity.');
    let source: string;
    let sha256: string;
    let sizeBytes: number;
    let originalName: string;
    let mediaType: string;
    let managedMetadata: Record<string, unknown> | undefined;
    if (artifactId) {
      const row = this.core.prepare(`
        SELECT a.managed_path,a.sha256,a.size_bytes,a.original_name,a.media_type
        FROM feature_artifacts a
        WHERE a.artifact_id=? AND a.run_id=? AND a.feature_id=?
      `).get(artifactId, runId, context.featureId) as Record<string, unknown> | undefined;
      if (!row) throw new Error('Python input Artifact is not owned by the Feature Run.');
      source = path.resolve(this.paths.data, ...String(row.managed_path).split('/'));
      const artifactRoot = path.resolve(this.paths.data, 'features', context.featureId, 'artifacts');
      if (!source.startsWith(`${artifactRoot}${path.sep}`)) throw new Error('Python input Artifact path escaped its managed Feature root.');
      sha256 = String(row.sha256); sizeBytes = Number(row.size_bytes);
      originalName = path.basename(String(row.original_name)); mediaType = String(row.media_type);
    } else {
      if (!/^backend\/[A-Za-z0-9._/-]{1,240}$/u.test(memberPath) || memberPath.includes('..')) throw new Error('Python managed asset member path is invalid.');
      const row = this.core.prepare(`
        SELECT package_digest,member_path,member_digest,asset_kind,managed_path FROM feature_managed_assets
        WHERE feature_id=? AND feature_version=? AND member_path=?
      `).get(context.featureId, context.featureVersion, memberPath) as Record<string, unknown> | undefined;
      if (!row) throw new Error('Python managed asset is unavailable for the active Feature version.');
      managedMetadata = row;
      source = path.resolve(this.paths.data, ...String(row.managed_path).split('/'));
      const installedRoot = path.resolve(this.paths.data, 'packages', 'installed', context.featureId, context.featureVersion);
      if (!source.startsWith(`${installedRoot}${path.sep}`)) throw new Error('Python managed asset path escaped the immutable package root.');
      sha256 = String(row.member_digest); sizeBytes = fs.statSync(source).size;
      originalName = path.basename(memberPath); mediaType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    }
    const sourceStat = fs.statSync(source);
    if (!sourceStat.isFile() || sourceStat.size !== sizeBytes || sizeBytes < 1 || sizeBytes > 64 * 1024 * 1024) {
      throw new Error('Python input Artifact size is invalid.');
    }
    const actualDigest = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
    if (actualDigest !== sha256) throw new Error('Python input Artifact digest drifted before handle creation.');
    const handleId = randomUUID();
    const handleRoot = this.pythonHandleRoot(context, runId, handleId);
    const extension = path.extname(originalName).toLowerCase();
    const filename = path.join(handleRoot, `input${/^\.[a-z0-9]{1,12}$/u.test(extension) ? extension : '.bin'}`);
    fs.mkdirSync(path.dirname(handleRoot), { recursive: true });
    fs.mkdirSync(handleRoot, { recursive: false });
    try { fs.copyFileSync(source, filename, fs.constants.COPYFILE_EXCL); }
    catch (error) { fs.rmSync(handleRoot, { recursive: true, force: true }); throw error; }
    this.pythonArtifactHandles.set(handleId, {
      featureId: context.featureId, featureVersion: context.featureVersion, runId, filename,
      access: 'read', kind: 'input', mediaType, originalName, maxBytes: sizeBytes
    });
    return {
      schemaVersion: 'omnia.python-artifact-handle/v1', handleId, runId, path: filename,
      access: 'read', mediaType, originalName, sizeBytes, sha256,
      ...(managedMetadata ? {
        packageDigest: String(managedMetadata.package_digest),
        memberPath: String(managedMetadata.member_path), memberDigest: sha256,
        assetKind: String(managedMetadata.asset_kind)
      } : {})
    };
  }

  private createPythonOutputHandle(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    const request = object(input, 'Python output Artifact handle');
    const runId = String(request.runId || '');
    if (!this.core.prepare(`SELECT 1 FROM feature_runs WHERE run_id=? AND feature_id=? AND feature_version=?`).get(
      runId, context.featureId, context.featureVersion
    )) throw new Error('Python output Artifact handle Run is not owned by the active Feature version.');
    const kind = String(request.kind || '');
    if (!['template_candidate', 'template_instance', 'result', 'evidence', 'transient_json'].includes(kind)) throw new Error('Python output Artifact kind is not allowlisted.');
    const originalName = path.basename(String(request.originalName || ''));
    if (!originalName || originalName !== String(request.originalName) || originalName.length > 255) throw new Error('Python output Artifact name is invalid.');
    const extension = path.extname(originalName).toLowerCase();
    if (!/^\.[a-z0-9]{1,12}$/u.test(extension)) throw new Error('Python output Artifact extension is invalid.');
    const maxBytes = Number(request.maxBytes || 0);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024) throw new Error('Python output Artifact size budget is invalid.');
    const handleId = randomUUID();
    const handleRoot = this.pythonHandleRoot(context, runId, handleId);
    const filename = path.join(handleRoot, `output${extension}`);
    fs.mkdirSync(path.dirname(handleRoot), { recursive: true });
    fs.mkdirSync(handleRoot, { recursive: false });
    fs.writeFileSync(filename, Buffer.alloc(0), { flag: 'wx' });
    const mediaType = String(request.mediaType || 'application/octet-stream');
    this.pythonArtifactHandles.set(handleId, {
      featureId: context.featureId, featureVersion: context.featureVersion, runId, filename,
      access: 'write', kind, mediaType, originalName, maxBytes
    });
    return {
      schemaVersion: 'omnia.python-artifact-handle/v1', handleId, runId, path: filename,
      access: 'write', mediaType, originalName, sizeBytes: 0, sha256: ''
    };
  }

  private createPythonJsonInputHandle(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    const request = object(input, 'Python JSON input Artifact handle');
    const runId = String(request.runId || '');
    if (!this.core.prepare(`SELECT 1 FROM feature_runs WHERE run_id=? AND feature_id=? AND feature_version=?`).get(
      runId, context.featureId, context.featureVersion
    )) throw new Error('Python JSON input Artifact handle Run is not owned by the active Feature version.');
    const maxBytes = Number(request.maxBytes || 0);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 2 || maxBytes > 64 * 1024 * 1024) {
      throw new Error('Python JSON input Artifact size budget is invalid.');
    }
    let bytes: Buffer;
    try { bytes = Buffer.from(JSON.stringify(request.value), 'utf8'); }
    catch { throw new Error('Python JSON input Artifact value is not serializable.'); }
    if (bytes.length < 2 || bytes.length > maxBytes) throw new Error('Python JSON input Artifact exceeds its declared size budget.');
    const handleId = randomUUID();
    const handleRoot = this.pythonHandleRoot(context, runId, handleId);
    fs.mkdirSync(path.dirname(handleRoot), { recursive: true });
    fs.mkdirSync(handleRoot, { recursive: false });
    const filename = path.join(handleRoot, 'input.json');
    fs.writeFileSync(filename, bytes, { flag: 'wx' });
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    this.pythonArtifactHandles.set(handleId, {
      featureId: context.featureId, featureVersion: context.featureVersion, runId, filename,
      access: 'read', kind: 'transient_json', mediaType: 'application/json', originalName: 'input.json', maxBytes
    });
    return {
      schemaVersion: 'omnia.python-artifact-handle/v1', handleId, runId, path: filename,
      access: 'read', mediaType: 'application/json', originalName: 'input.json', sizeBytes: bytes.length, sha256
    };
  }

  private readPythonJsonHandle(input: unknown, context: FeatureWorkerPortContext): unknown {
    const request = object(input, 'Python JSON Artifact handle read');
    const descriptor = object(request.handle, 'Python JSON Artifact handle descriptor');
    const handleId = String(descriptor.handleId || '');
    const handle = this.pythonArtifactHandles.get(handleId);
    if (!handle || handle.access !== 'write' || handle.kind !== 'transient_json'
      || handle.featureId !== context.featureId || handle.featureVersion !== context.featureVersion
      || descriptor.schemaVersion !== 'omnia.python-artifact-handle/v1'
      || String(descriptor.runId || '') !== handle.runId
      || path.resolve(String(descriptor.path || '')) !== handle.filename) {
      throw new Error('Python JSON Artifact handle is unavailable or not owned by this Feature Run.');
    }
    const stat = fs.statSync(handle.filename);
    const sizeBytes = Number(descriptor.sizeBytes || 0);
    if (!stat.isFile() || stat.size < 2 || stat.size !== sizeBytes || stat.size > handle.maxBytes) {
      throw new Error('Python JSON Artifact handle size is invalid.');
    }
    const bytes = fs.readFileSync(handle.filename);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (!/^[0-9a-f]{64}$/u.test(String(descriptor.sha256 || '')) || descriptor.sha256 !== sha256) {
      throw new Error('Python JSON Artifact handle digest mismatch.');
    }
    let value: unknown;
    try { value = JSON.parse(bytes.toString('utf8')); }
    catch { throw new Error('Python JSON Artifact handle does not contain valid UTF-8 JSON.'); }
    this.releasePythonHandle(handleId, context);
    return value;
  }

  private commitPythonOutputHandle(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    const request = object(input, 'Python output Artifact commit');
    const handleId = String(request.handleId || '');
    const handle = this.pythonArtifactHandles.get(handleId);
    if (!handle || handle.access !== 'write' || handle.kind === 'transient_json'
      || handle.featureId !== context.featureId || handle.featureVersion !== context.featureVersion) {
      throw new Error('Python output Artifact handle is unavailable or not owned by this Feature.');
    }
    const handleRoot = this.pythonHandleRoot(context, handle.runId, handleId);
    if (!handle.filename.startsWith(`${handleRoot}${path.sep}`)) throw new Error('Python output Artifact handle path drifted.');
    const stat = fs.statSync(handle.filename);
    if (!stat.isFile() || stat.size < 1 || stat.size > handle.maxBytes) throw new Error('Python output Artifact exceeded its declared size budget.');
    const sha256 = sha256FileSync(handle.filename);
    if (request.sha256 && String(request.sha256) !== sha256) throw new Error('Python output Artifact digest mismatch.');
    const artifactId = randomUUID();
    const extension = path.extname(handle.originalName).toLowerCase();
    const relative = path.posix.join('features', context.featureId, 'artifacts', artifactId, `artifact${extension}`);
    const destination = path.resolve(this.paths.data, ...relative.split('/'));
    const artifactRoot = path.resolve(this.paths.data, 'features', context.featureId, 'artifacts');
    if (!destination.startsWith(`${artifactRoot}${path.sep}`)) throw new Error('Python output Artifact destination escaped its Feature root.');
    const createdAt = now();
    let committedArtifactId: string = artifactId;
    let committedAt = createdAt;
    let copied = false;
    let idempotent = false;
    this.core.exec('BEGIN IMMEDIATE;');
    try {
      const run = this.core.prepare(`
        SELECT state,source_artifact_id FROM feature_runs
        WHERE run_id=? AND feature_id=? AND feature_version=?
      `).get(handle.runId, context.featureId, context.featureVersion) as { state: string; source_artifact_id: string } | undefined;
      if (!run || !['processing', 'converting', 'needs_input', 'ready_for_review', 'succeeded'].includes(run.state)) {
        throw new Error('Python output Artifact Run is unavailable or not committable.');
      }
      const existing = this.core.prepare(`
        SELECT artifact_id,managed_path,imported_at FROM feature_artifacts
        WHERE run_id=? AND feature_id=? AND source_version=? AND source_kind='worker_output'
          AND kind=? AND media_type=? AND original_name=? AND sha256=? AND size_bytes=?
        ORDER BY created_at,artifact_id LIMIT 1
      `).get(
        handle.runId, context.featureId, context.featureVersion, handle.kind, handle.mediaType,
        handle.originalName, sha256, stat.size
      ) as { artifact_id: string; managed_path: string; imported_at: string } | undefined;
      if (existing) {
        const existingPath = path.resolve(this.paths.data, ...existing.managed_path.split('/'));
        if (!existingPath.startsWith(`${artifactRoot}${path.sep}`)) {
          throw new Error('Existing Python output Artifact escaped its managed Feature root.');
        }
        const existingStat = fs.statSync(existingPath);
        if (!existingStat.isFile() || existingStat.size !== stat.size || sha256FileSync(existingPath) !== sha256) {
          throw new Error('Existing Python output Artifact differs from its immutable Core record.');
        }
        committedArtifactId = existing.artifact_id;
        committedAt = existing.imported_at;
        idempotent = true;
      } else {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(handle.filename, destination, fs.constants.COPYFILE_EXCL);
        copied = true;
        const committedStat = fs.statSync(destination);
        if (!committedStat.isFile() || committedStat.size !== stat.size || sha256FileSync(destination) !== sha256) {
          throw new Error('Python output Artifact drifted while entering managed storage.');
        }
        this.core.prepare(`
          INSERT INTO feature_artifacts(
            artifact_id,run_id,feature_id,kind,media_type,original_name,source_kind,source_ref,
            managed_path,sha256,size_bytes,source_version,imported_at,created_at
          ) VALUES(?,?,?,?,?,?,'worker_output',?,?,?,?,?,?,?)
        `).run(
          artifactId, handle.runId, context.featureId, handle.kind, handle.mediaType, handle.originalName,
          run.source_artifact_id, relative, sha256, stat.size, context.featureVersion, createdAt, createdAt
        );
      }
      this.core.exec('COMMIT;');
    } catch (error) {
      this.core.exec('ROLLBACK;');
      if (copied) fs.rmSync(destination, { force: true });
      throw error;
    }
    this.releasePythonHandle(handleId, context);
    return {
      artifactId: committedArtifactId, sha256, sizeBytes: stat.size, createdAt: committedAt,
      ...(idempotent ? { idempotent: true } : {})
    };
  }

  private releasePythonArtifactHandles(input: unknown, context: FeatureWorkerPortContext): true {
    const request = object(input, 'Python Artifact handle release');
    if (!Array.isArray(request.handleIds) || request.handleIds.length > 128) throw new Error('Python Artifact handle release list is invalid.');
    for (const handleId of [...new Set(request.handleIds.map(String))]) this.releasePythonHandle(handleId, context);
    return true;
  }

  private releasePythonHandle(handleId: string, context: FeatureWorkerPortContext): void {
    const handle = this.pythonArtifactHandles.get(handleId);
    if (!handle) return;
    if (handle.featureId !== context.featureId || handle.featureVersion !== context.featureVersion) {
      throw new Error('Python Artifact handle is owned by another Feature version.');
    }
    const handleRoot = this.pythonHandleRoot(context, handle.runId, handleId);
    this.pythonArtifactHandles.delete(handleId);
    fs.rmSync(handleRoot, { recursive: true, force: true });
  }

  private commitArtifact(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    const request = object(input, 'Artifact commit');
    if (!['template_candidate', 'template_instance', 'result', 'evidence'].includes(String(request.kind || ''))) {
      throw new Error('Artifact commit kind is not allowlisted.');
    }
    if (typeof request.contentBase64 !== 'string' || typeof request.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(request.sha256)) {
      throw new Error('Artifact commit requires strict base64 bytes and a lowercase SHA-256 digest.');
    }
    const bytes = Buffer.from(request.contentBase64, 'base64');
    if (bytes.toString('base64') !== request.contentBase64) throw new Error('Artifact commit base64 is not canonical.');
    if (bytes.length < 1 || bytes.length > 64 * 1024 * 1024) throw new Error('Artifact commit payload size is invalid.');
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (request.sha256 && String(request.sha256).toLowerCase() !== sha256) throw new Error('Artifact commit digest mismatch.');
    const artifactId = randomUUID();
    const runId = String(request.runId || '');
    const sourceArtifactId = String(request.sourceArtifactId || '');
    const run = this.core.prepare(`
      SELECT source_artifact_id FROM feature_runs WHERE run_id=? AND feature_id=? AND feature_version=?
    `).get(runId, context.featureId, context.featureVersion) as { source_artifact_id: string } | undefined;
    if (!run) throw new Error('Artifact commit Run is unavailable for the active Feature version.');
    if (!sourceArtifactId || sourceArtifactId !== run.source_artifact_id) {
      throw new Error('Artifact commit source artifact is not owned by the Run.');
    }
    const extension = String(request.extension || '');
    if (!/^\.[a-z0-9]{1,12}$/u.test(extension)) throw new Error('Artifact extension is invalid.');
    const relative = path.posix.join('features', context.featureId, 'artifacts', artifactId, `artifact${extension}`);
    const destination = path.resolve(this.paths.data, ...relative.split('/'));
    const root = path.resolve(this.paths.data, 'features', context.featureId, 'artifacts');
    if (!destination.startsWith(`${root}${path.sep}`)) throw new Error('Artifact commit path escaped its Feature root.');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes, { flag: 'wx' });
    const createdAt = now();
    try {
      this.core.prepare(`
        INSERT INTO feature_artifacts(
        artifact_id, run_id, feature_id, kind, media_type, original_name, source_kind, source_ref,
        managed_path, sha256, size_bytes, source_version, imported_at, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, 'worker_output', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        artifactId, runId, context.featureId, String(request.kind),
        String(request.mediaType || 'application/octet-stream'), path.basename(String(request.originalName || `artifact${extension}`)),
        sourceArtifactId, relative, sha256, bytes.length, context.featureVersion, createdAt, createdAt
      );
    } catch (error) {
      fs.rmSync(destination, { force: true });
      throw error;
    }
    return { artifactId, sha256, sizeBytes: bytes.length, createdAt };
  }

  private standaloneArtifactTransferRoot(context: FeatureWorkerPortContext, transferId: string): string {
    if (!/^[0-9a-f-]{36}$/u.test(transferId)) throw new Error('Standalone Artifact transfer identity is invalid.');
    const featureRoot = path.resolve(this.paths.temp, 'features', context.featureId, 'standalone-artifact-transfers');
    const transferRoot = path.resolve(featureRoot, transferId);
    if (!transferRoot.startsWith(`${featureRoot}${path.sep}`)) throw new Error('Standalone Artifact transfer escaped its Feature temp root.');
    return transferRoot;
  }

  private beginStandaloneArtifactTransfer(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    const request = object(input, 'Standalone Artifact transfer');
    const kind = String(request.kind || '');
    if (!['result', 'evidence'].includes(kind)) throw new Error('Standalone Artifact transfer kind is not allowlisted.');
    const originalName = path.basename(String(request.originalName || ''));
    if (!originalName || originalName !== String(request.originalName) || originalName.length > 255) {
      throw new Error('Standalone Artifact transfer name is invalid.');
    }
    if (!/^\.[a-z0-9]{1,12}$/u.test(path.extname(originalName).toLowerCase())) {
      throw new Error('Standalone Artifact transfer extension is invalid.');
    }
    const surfaceId = String(request.surfaceId || '');
    if (!/^[a-z0-9][a-z0-9._-]{2,127}$/u.test(surfaceId)) throw new Error('Standalone Artifact transfer Surface identity is invalid.');
    const engagementId = String(request.engagementId || '');
    if (engagementId.length > 200) throw new Error('Standalone Artifact transfer Engagement identity is invalid.');
    const expectedSizeBytes = Number(request.expectedSizeBytes);
    const chunkCount = Number(request.chunkCount);
    const expectedSha256 = String(request.expectedSha256 || '');
    if (!Number.isSafeInteger(expectedSizeBytes) || expectedSizeBytes < 1 || expectedSizeBytes > 64 * 1024 * 1024) {
      throw new Error('Standalone Artifact transfer size is invalid.');
    }
    if (!Number.isSafeInteger(chunkCount) || chunkCount < 1 || chunkCount > 256) {
      throw new Error('Standalone Artifact transfer chunk count is invalid.');
    }
    if (!/^[0-9a-f]{64}$/u.test(expectedSha256)) throw new Error('Standalone Artifact transfer digest is invalid.');
    const transferId = randomUUID();
    const transferRoot = this.standaloneArtifactTransferRoot(context, transferId);
    fs.mkdirSync(path.dirname(transferRoot), { recursive: true });
    fs.mkdirSync(transferRoot, { recursive: false });
    const filename = path.join(transferRoot, 'payload.partial');
    try { fs.writeFileSync(filename, Buffer.alloc(0), { flag: 'wx' }); }
    catch (error) { fs.rmSync(transferRoot, { recursive: true, force: true }); throw error; }
    this.standaloneArtifactTransfers.set(transferId, {
      featureId: context.featureId,
      featureVersion: context.featureVersion,
      kind: kind as 'result' | 'evidence',
      surfaceId,
      engagementId,
      originalName,
      mediaType: String(request.mediaType || 'application/octet-stream'),
      sourceRef: String(request.sourceRef || ''),
      expectedSizeBytes,
      expectedSha256,
      chunkCount,
      nextChunkIndex: 0,
      receivedBytes: 0,
      filename,
      digest: crypto.createHash('sha256')
    });
    return {
      schemaVersion: 'omnia.standalone-artifact-transfer/v1',
      transferId,
      expectedSizeBytes,
      expectedSha256,
      chunkCount,
      nextChunkIndex: 0,
      receivedBytes: 0
    };
  }

  private appendStandaloneArtifactTransferChunk(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    const request = object(input, 'Standalone Artifact transfer chunk');
    const transferId = String(request.transferId || '');
    const transfer = this.standaloneArtifactTransfers.get(transferId);
    if (!transfer || transfer.featureId !== context.featureId || transfer.featureVersion !== context.featureVersion) {
      throw new Error('Standalone Artifact transfer is unavailable or not owned by this Feature version.');
    }
    const chunkIndex = Number(request.chunkIndex);
    if (!Number.isSafeInteger(chunkIndex) || chunkIndex !== transfer.nextChunkIndex || chunkIndex >= transfer.chunkCount) {
      throw new Error('Standalone Artifact transfer chunk is out of order.');
    }
    if (typeof request.contentBase64 !== 'string') throw new Error('Standalone Artifact transfer chunk requires strict base64 bytes.');
    const bytes = Buffer.from(request.contentBase64, 'base64');
    if (bytes.length < 1 || bytes.length > 1024 * 1024 || bytes.toString('base64') !== request.contentBase64) {
      throw new Error('Standalone Artifact transfer chunk bytes are invalid.');
    }
    if (request.offsetBytes !== undefined && Number(request.offsetBytes) !== transfer.receivedBytes) {
      throw new Error('Standalone Artifact transfer chunk offset drifted.');
    }
    const chunkSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (request.sha256 !== undefined && String(request.sha256) !== chunkSha256) {
      throw new Error('Standalone Artifact transfer chunk digest mismatch.');
    }
    if (transfer.receivedBytes + bytes.length > transfer.expectedSizeBytes) {
      throw new Error('Standalone Artifact transfer exceeded its frozen size.');
    }
    fs.appendFileSync(transfer.filename, bytes);
    transfer.digest.update(bytes);
    transfer.receivedBytes += bytes.length;
    transfer.nextChunkIndex += 1;
    return {
      schemaVersion: 'omnia.standalone-artifact-transfer-progress/v1',
      transferId,
      acceptedChunkIndex: chunkIndex,
      nextChunkIndex: transfer.nextChunkIndex,
      receivedBytes: transfer.receivedBytes,
      chunkSha256
    };
  }

  private commitStandaloneArtifactTransfer(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    const request = object(input, 'Standalone Artifact transfer commit');
    const transferId = String(request.transferId || '');
    const transfer = this.standaloneArtifactTransfers.get(transferId);
    if (!transfer || transfer.featureId !== context.featureId || transfer.featureVersion !== context.featureVersion) {
      throw new Error('Standalone Artifact transfer is unavailable or not owned by this Feature version.');
    }
    if (transfer.nextChunkIndex !== transfer.chunkCount || transfer.receivedBytes !== transfer.expectedSizeBytes) {
      throw new Error('Standalone Artifact transfer is incomplete.');
    }
    const stat = fs.statSync(transfer.filename);
    if (!stat.isFile() || stat.size !== transfer.expectedSizeBytes) throw new Error('Standalone Artifact transfer file size drifted.');
    const sha256 = transfer.digest.digest('hex');
    if (sha256 !== transfer.expectedSha256) throw new Error('Standalone Artifact transfer digest mismatch.');
    const artifactId = randomUUID();
    const runId = randomUUID();
    const traceId = randomUUID();
    const createdAt = now();
    const extension = path.extname(transfer.originalName).toLowerCase();
    const relative = path.posix.join('features', context.featureId, 'artifacts', artifactId, `artifact${extension}`);
    const destination = path.resolve(this.paths.data, ...relative.split('/'));
    const root = path.resolve(this.paths.data, 'features', context.featureId, 'artifacts');
    if (!destination.startsWith(`${root}${path.sep}`)) throw new Error('Standalone Artifact transfer destination escaped its Feature root.');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(transfer.filename, destination);
    try {
      this.core.exec('BEGIN IMMEDIATE;');
      this.core.prepare(`
        INSERT INTO feature_runs(
          run_id,trace_id,feature_id,feature_version,engagement_id,state,state_revision,
          source_artifact_id,template_version_id,output_artifact_id,plan_digest,last_error,created_at,updated_at
        ) VALUES(?,?,?,?,?,'succeeded',1,'','',?,'','',?,?)
      `).run(runId, traceId, context.featureId, context.featureVersion, transfer.engagementId, artifactId, createdAt, createdAt);
      this.core.prepare(`
        INSERT INTO feature_artifacts(
          artifact_id,run_id,feature_id,kind,media_type,original_name,source_kind,source_ref,
          managed_path,sha256,size_bytes,source_version,imported_at,created_at
        ) VALUES(?,?,?,?,?,?,'connector_evidence',?,?,?,?,?,?,?)
      `).run(
        artifactId, runId, context.featureId, transfer.kind, transfer.mediaType, transfer.originalName,
        transfer.sourceRef, relative, sha256, transfer.expectedSizeBytes, context.featureVersion, createdAt, createdAt
      );
      this.core.prepare(`
        INSERT INTO feature_run_events(event_id,run_id,revision,from_state,to_state,event_type,details_json,occurred_at)
        VALUES(?,?,1,'','succeeded','artifact.connector_evidence_committed',?,?)
      `).run(randomUUID(), runId, JSON.stringify({ artifactId, sizeBytes: transfer.expectedSizeBytes, sourceRef: transfer.sourceRef }), createdAt);
      this.core.exec('COMMIT;');
    } catch (error) {
      this.core.exec('ROLLBACK;');
      fs.rmSync(destination, { force: true });
      throw error;
    } finally {
      this.standaloneArtifactTransfers.delete(transferId);
      fs.rmSync(this.standaloneArtifactTransferRoot(context, transferId), { recursive: true, force: true });
    }
    return {
      schemaVersion: 'omnia.feature-artifact/v1', artifactId, runId, traceId,
      featureId: context.featureId, featureVersion: context.featureVersion, surfaceId: transfer.surfaceId,
      kind: transfer.kind, originalName: transfer.originalName, mediaType: transfer.mediaType,
      sizeBytes: transfer.expectedSizeBytes, sha256, importedAt: createdAt
    };
  }

  private abortStandaloneArtifactTransfer(input: unknown, context: FeatureWorkerPortContext): true {
    const request = object(input, 'Standalone Artifact transfer abort');
    const transferId = String(request.transferId || '');
    const transfer = this.standaloneArtifactTransfers.get(transferId);
    if (!transfer) return true;
    if (transfer.featureId !== context.featureId || transfer.featureVersion !== context.featureVersion) {
      throw new Error('Standalone Artifact transfer is owned by another Feature version.');
    }
    this.standaloneArtifactTransfers.delete(transferId);
    fs.rmSync(this.standaloneArtifactTransferRoot(context, transferId), { recursive: true, force: true });
    return true;
  }

  private commitStandaloneArtifact(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    const request = object(input, 'Standalone Artifact commit');
    const kind = String(request.kind || '');
    if (!['result', 'evidence'].includes(kind)) throw new Error('Standalone Artifact kind is not allowlisted.');
    if (typeof request.contentBase64 !== 'string') throw new Error('Standalone Artifact requires strict base64 bytes.');
    const bytes = Buffer.from(request.contentBase64, 'base64');
    if (bytes.toString('base64') !== request.contentBase64) throw new Error('Standalone Artifact base64 is not canonical.');
    if (bytes.length < 1 || bytes.length > 64 * 1024 * 1024) throw new Error('Standalone Artifact payload size is invalid.');
    const originalName = path.basename(String(request.originalName || ''));
    if (!originalName || originalName !== String(request.originalName) || originalName.length > 255) throw new Error('Standalone Artifact name is invalid.');
    const extension = path.extname(originalName).toLowerCase();
    if (!/^\.[a-z0-9]{1,12}$/u.test(extension)) throw new Error('Standalone Artifact extension is invalid.');
    const engagementId = String(request.engagementId || '');
    if (engagementId.length > 200) throw new Error('Standalone Artifact Engagement identity is invalid.');
    const surfaceId = String(request.surfaceId || '');
    if (!/^[a-z0-9][a-z0-9._-]{2,127}$/u.test(surfaceId)) throw new Error('Standalone Artifact Surface identity is invalid.');
    const artifactId = randomUUID();
    const runId = randomUUID();
    const traceId = randomUUID();
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const createdAt = now();
    const relative = path.posix.join('features', context.featureId, 'artifacts', artifactId, `artifact${extension}`);
    const destination = path.resolve(this.paths.data, ...relative.split('/'));
    const root = path.resolve(this.paths.data, 'features', context.featureId, 'artifacts');
    if (!destination.startsWith(`${root}${path.sep}`)) throw new Error('Standalone Artifact path escaped its Feature root.');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes, { flag: 'wx' });
    try {
      this.core.exec('BEGIN IMMEDIATE;');
      this.core.prepare(`
        INSERT INTO feature_runs(
          run_id,trace_id,feature_id,feature_version,engagement_id,state,state_revision,
          source_artifact_id,template_version_id,output_artifact_id,plan_digest,last_error,created_at,updated_at
        ) VALUES(?,?,?,?,?,'succeeded',1,'','',?,'','',?,?)
      `).run(runId, traceId, context.featureId, context.featureVersion, engagementId, artifactId, createdAt, createdAt);
      this.core.prepare(`
        INSERT INTO feature_artifacts(
          artifact_id,run_id,feature_id,kind,media_type,original_name,source_kind,source_ref,
          managed_path,sha256,size_bytes,source_version,imported_at,created_at
        ) VALUES(?,?,?,?,?,?,'connector_evidence',?,?,?,?,?,?,?)
      `).run(
        artifactId, runId, context.featureId, kind, String(request.mediaType || 'application/octet-stream'), originalName,
        String(request.sourceRef || ''), relative, sha256, bytes.length, context.featureVersion, createdAt, createdAt
      );
      this.core.prepare(`
        INSERT INTO feature_run_events(event_id,run_id,revision,from_state,to_state,event_type,details_json,occurred_at)
        VALUES(?,?,1,'','succeeded','artifact.connector_evidence_committed',?,?)
      `).run(randomUUID(), runId, JSON.stringify({ artifactId, sizeBytes: bytes.length, sourceRef: String(request.sourceRef || '') }), createdAt);
      this.core.exec('COMMIT;');
    } catch (error) {
      this.core.exec('ROLLBACK;');
      fs.rmSync(destination, { force: true });
      throw error;
    }
    return {
      schemaVersion: 'omnia.feature-artifact/v1', artifactId, runId, traceId,
      featureId: context.featureId, featureVersion: context.featureVersion, surfaceId,
      kind, originalName, mediaType: String(request.mediaType || 'application/octet-stream'),
      sizeBytes: bytes.length, sha256, importedAt: createdAt
    };
  }

  private transitionRun(input: unknown, context: FeatureWorkerPortContext): number {
    const change = object(input, 'Run transition');
    const runId = String(change.runId || '');
    const expectedRevision = Number(change.expectedRevision);
    const row = this.core.prepare(`SELECT state, state_revision FROM feature_runs WHERE run_id=? AND feature_id=?`)
      .get(runId, context.featureId) as { state: string; state_revision: number } | undefined;
    if (!row || row.state_revision !== expectedRevision) throw new Error('Run state revision changed; reload before continuing.');
    const transitions: Record<string, string[]> = {
      draft: ['acquiring', 'cancelled'], acquiring: ['processing', 'failed', 'cancelled'],
      processing: ['needs_input', 'converting', 'failed', 'cancelled'],
      needs_input: ['processing', 'converting', 'cancelled'], converting: ['validating_output', 'failed'],
      validating_output: ['ready_for_review', 'needs_input', 'failed'],
      ready_for_review: ['waiting_confirmation', 'cancelled'], waiting_confirmation: ['returning', 'cancelled'],
      returning: ['verifying', 'failed', 'uncertain'], verifying: ['succeeded', 'failed', 'uncertain'],
      uncertain: ['reconciling'], reconciling: ['returning', 'succeeded', 'failed', 'uncertain'],
      succeeded: [], failed: [], cancelled: [], not_evaluable: []
    };
    const requestedState = String(change.toState || '');
    const requestedEventType = String(change.eventType || 'run.transition');
    const forceClose = requestedEventType === 'return.force_cancelled' || requestedEventType === 'run.fresh_start_force_closed';
    const completedReconcile = row.state === 'reconciling'
      && ['return.reconcile_resolved','return.reconcile_not_applied'].includes(requestedEventType);
    const remainingUncertain = completedReconcile
      ? (this.core.prepare(`SELECT COUNT(*) AS count FROM managed_content_intents WHERE run_id=? AND state='uncertain'`).get(runId) as {count:number}).count
      : 0;
    // A signed reconcile that proves "applied" or "not applied" resolves one
    // command; it never fails the whole Run.  Continue reconciling the next
    // uncertain command, or resume the still-frozen Return ledger.
    const toState = completedReconcile
      ? (remainingUncertain > 0 ? 'uncertain' : 'returning')
      : requestedState;
    if (!transitions[row.state]?.includes(toState)) throw new Error(`Illegal run transition: ${row.state} -> ${toState}.`);
    const nextRevision = expectedRevision + 1;
    const occurredAt = now();
    this.core.exec('BEGIN IMMEDIATE;');
    try {
      let releasedReservations=0;
      if(forceClose){
        const unsafe=(this.core.prepare(`
          SELECT COUNT(*) AS count FROM feature_commands c
          WHERE c.run_id=? AND (
            c.state='uncertain'
            OR (c.state IN ('submitted','committed','verifying') AND c.completed_at='')
            OR EXISTS(SELECT 1 FROM connector_delivery_requests delivery
              WHERE delivery.command_id=c.command_id AND delivery.purpose='mutation'
                AND delivery.state NOT IN ('effect_resolved') AND delivery.abandoned_at='')
          )
        `).get(runId) as {count:number}).count;
        if(unsafe) throw new Error('Run force-close requires every dispatched mutation to have a conclusive read-only outcome.');
        releasedReservations=Number(this.core.prepare(`
          UPDATE feature_mutation_reservations SET lifecycle='released',updated_at=?
          WHERE owner_run_id=? AND lifecycle='active'
            AND EXISTS(SELECT 1 FROM feature_commands c WHERE c.command_id=owner_command_id
              AND c.run_id=? AND c.state IN ('prepared','failed','closed_not_applied')
              AND c.submitted_at='' AND c.commit_point_at='' AND c.connector_request_id=''
              AND NOT EXISTS(SELECT 1 FROM connector_delivery_requests delivery
                WHERE delivery.command_id=c.command_id AND delivery.purpose='mutation'))
        `).run(occurredAt,runId,runId).changes);
      }
      const updated = this.core.prepare(`
        UPDATE feature_runs SET state=?, state_revision=?, last_error=?, updated_at=?
        WHERE run_id=? AND feature_id=? AND state_revision=?
      `).run(toState, nextRevision, String(change.error || ''), occurredAt,
        runId, context.featureId, expectedRevision);
      if (updated.changes !== 1) throw new Error('Run state revision changed; reload before continuing.');
      this.core.prepare(`
        INSERT INTO feature_run_events(event_id, run_id, revision, from_state, to_state, event_type, details_json, occurred_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), runId, nextRevision, row.state, toState,
        completedReconcile && remainingUncertain > 0 ? 'return.reconcile_partial' : requestedEventType,
        JSON.stringify({...(remainingUncertain > 0 ? {...object(change.details || {},'Run transition details'),remainingUncertain} : object(change.details || {},'Run transition details')),...(forceClose?{releasedCreateReservations:releasedReservations}:{})}), occurredAt);
      this.core.exec('COMMIT;');
      return nextRevision;
    } catch (error) {
      this.core.exec('ROLLBACK;');
      throw error;
    }
  }

  private returnRunToReview(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    const request = object(input, 'Return-to-review request');
    const runId = String(request.runId || ''); const expectedRevision = Number(request.expectedRevision);
    const run = this.core.prepare(`SELECT state,state_revision,plan_digest FROM feature_runs WHERE run_id=? AND feature_id=?`)
      .get(runId, context.featureId) as {state:string;state_revision:number;plan_digest:string}|undefined;
    if (!run || !this.currentActivationOwnsRun(runId, context) || run.state !== 'waiting_confirmation' || run.state_revision !== expectedRevision || !run.plan_digest) {
      throw new Error('Only the current unconsumed waiting confirmation can return to Review.');
    }
    const commandCount = (this.core.prepare(`SELECT COUNT(*) AS count FROM feature_commands WHERE run_id=?`).get(runId) as {count:number}).count;
    const receiptCount = (this.core.prepare(`SELECT COUNT(*) AS count FROM feature_operation_receipts WHERE run_id=?`).get(runId) as {count:number}).count;
    const invalidIntent = this.core.prepare(`SELECT 1 FROM managed_content_intents WHERE run_id=? AND plan_digest=? AND state<>'frozen' LIMIT 1`).get(runId, run.plan_digest);
    if (commandCount || receiptCount || invalidIntent) throw new Error('Return confirmation already has command, receipt, or non-frozen intent state and cannot return to Review.');
    const occurredAt = now(); const nextRevision = expectedRevision + 1;
    this.core.exec('BEGIN IMMEDIATE;');
    try {
      const confirmations = this.core.prepare(`UPDATE feature_confirmations SET decision='invalidated',actor_id='feature.navigation',decision_at=? WHERE run_id=? AND plan_digest=? AND decision='pending'`)
        .run(occurredAt, runId, run.plan_digest);
      if (confirmations.changes !== 1) throw new Error('Pending Return confirmation is absent or ambiguous.');
      const intents = this.core.prepare(`UPDATE managed_content_intents SET state='cancelled',updated_at=? WHERE run_id=? AND plan_digest=? AND state='frozen'`)
        .run(occurredAt, runId, run.plan_digest);
      if (intents.changes < 1) throw new Error('Frozen Return intents are unavailable.');
      const updated = this.core.prepare(`UPDATE feature_runs SET state='ready_for_review',state_revision=?,plan_digest='',last_error='',updated_at=? WHERE run_id=? AND feature_id=? AND state='waiting_confirmation' AND state_revision=?`)
        .run(nextRevision, occurredAt, runId, context.featureId, expectedRevision);
      if (updated.changes !== 1) throw new Error('Run changed before Return confirmation invalidation completed.');
      this.core.prepare(`INSERT INTO feature_run_events(event_id,run_id,revision,from_state,to_state,event_type,details_json,occurred_at) VALUES(?,?,?,?,?,?,?,?)`)
        .run(randomUUID(),runId,nextRevision,'waiting_confirmation','ready_for_review','return.confirmation_invalidated',JSON.stringify({invalidatedConfirmations:confirmations.changes,cancelledIntents:intents.changes,preservedArtifacts:true,preservedRevisions:true}),occurredAt);
      this.core.exec('COMMIT;');
      return {state:'ready_for_review',stateRevision:nextRevision,invalidatedConfirmations:confirmations.changes,cancelledIntents:intents.changes};
    } catch (error) { this.core.exec('ROLLBACK;'); throw error; }
  }

  private restartRun(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    const request = object(input, 'Restart Run request');
    const runId = String(request.runId || ''); const expectedRevision = Number(request.expectedRevision);
    const run = this.core.prepare(`SELECT state,state_revision,plan_digest FROM feature_runs WHERE run_id=? AND feature_id=?`)
      .get(runId, context.featureId) as {state:string;state_revision:number;plan_digest:string}|undefined;
    const stablePreWrite = new Set(['acquiring','needs_input','ready_for_review','waiting_confirmation']);
    const stableTerminal = new Set(['succeeded','failed','cancelled','not_evaluable']);
    if (!run || !this.currentActivationOwnsRun(runId, context) || run.state_revision !== expectedRevision || (!stablePreWrite.has(run.state) && !stableTerminal.has(run.state))) {
      throw new Error('Run restart is forbidden while validation or Return mutation/reconciliation can still be active.');
    }
    const commandCount = (this.core.prepare(`SELECT COUNT(*) AS count FROM feature_commands WHERE run_id=?`).get(runId) as {count:number}).count;
    const receiptCount = (this.core.prepare(`SELECT COUNT(*) AS count FROM feature_operation_receipts WHERE run_id=?`).get(runId) as {count:number}).count;
    if (stablePreWrite.has(run.state) && (commandCount || receiptCount)) {
      throw new Error('A pre-write Run unexpectedly owns command or receipt evidence and cannot be cancelled.');
    }
    const alreadyRestarted = this.core.prepare(`SELECT 1 FROM feature_run_events WHERE run_id=? AND revision=? AND event_type='run.restart_requested' LIMIT 1`)
      .get(runId, expectedRevision);
    if (alreadyRestarted) throw new Error('This Run revision has already been restarted.');
    const occurredAt = now(); const nextRevision = expectedRevision + 1;
    const nextState = stablePreWrite.has(run.state) ? 'cancelled' : run.state;
    this.core.exec('BEGIN IMMEDIATE;');
    try {
      const confirmations = stablePreWrite.has(run.state)
        ? this.core.prepare(`UPDATE feature_confirmations SET decision='invalidated',actor_id='feature.navigation',decision_at=? WHERE run_id=? AND decision='pending'`).run(occurredAt, runId)
        : { changes: 0 };
      const intents = stablePreWrite.has(run.state)
        ? this.core.prepare(`UPDATE managed_content_intents SET state='cancelled',updated_at=? WHERE run_id=? AND state='frozen'`).run(occurredAt, runId)
        : { changes: 0 };
      const updated = this.core.prepare(`UPDATE feature_runs SET state=?,state_revision=?,last_error=CASE WHEN ?='cancelled' THEN '' ELSE last_error END,updated_at=? WHERE run_id=? AND feature_id=? AND state=? AND state_revision=?`)
        .run(nextState,nextRevision,nextState,occurredAt,runId,context.featureId,run.state,expectedRevision);
      if (updated.changes !== 1) throw new Error('Run changed before restart audit was committed.');
      this.core.prepare(`INSERT INTO feature_run_events(event_id,run_id,revision,from_state,to_state,event_type,details_json,occurred_at) VALUES(?,?,?,?,?,?,?,?)`)
        .run(randomUUID(),runId,nextRevision,run.state,nextState,'run.restart_requested',JSON.stringify({terminalAuditPreserved:stableTerminal.has(run.state),commandCount,receiptCount,invalidatedConfirmations:confirmations.changes,cancelledIntents:intents.changes,preserveArtifacts:true,preserveRevisions:true,nextUploadCreatesNewRun:true}),occurredAt);
      this.core.exec('COMMIT;');
      return {state:nextState,stateRevision:nextRevision,terminalAuditPreserved:stableTerminal.has(run.state),commandCount,receiptCount};
    } catch (error) { this.core.exec('ROLLBACK;'); throw error; }
  }

  private recordFieldRevisions(input: unknown, context: FeatureWorkerPortContext): number {
    const request = object(input, 'Field revision batch');
    const fields = request.fields;
    if (!Array.isArray(fields) || fields.length < 1 || fields.length > 2_000) throw new Error('Field revision batch is invalid.');
    const run = this.core.prepare(`SELECT run_id, source_artifact_id FROM feature_runs WHERE run_id=? AND feature_id=?`)
      .get(String(request.runId || ''), context.featureId) as { run_id: string; source_artifact_id: string } | undefined;
    if (!run) throw new Error('Field revision run is unavailable.');
    this.core.exec('BEGIN IMMEDIATE;');
    try {
      for (const candidate of fields) {
        const field = object(candidate, 'Field revision');
        const provenance = object(field.provenance, 'Field provenance');
        for (const required of ['sourceArtifactId', 'sourceSheet', 'sourceRow', 'rowKey', 'fieldKey', 'sourceTraceId']) {
          if (provenance[required] === undefined || provenance[required] === '') throw new Error(`Field provenance is missing ${required}.`);
        }
        if (String(field.fieldKey || '') !== String(provenance.fieldKey || '')) throw new Error('Field revision key differs from provenance field key.');
        const valueKind = String(field.valueKind || '');
        if (!['source', 'derived', 'inherited', 'rule_default', 'user_revision'].includes(valueKind)) {
          throw new Error('Field revision value kind is invalid.');
        }
        if (valueKind === 'source' && String(provenance.sourceArtifactId) !== run.source_artifact_id) {
          throw new Error('Source field provenance artifact is not the Run source artifact.');
        }
        if (['derived', 'rule_default'].includes(valueKind)) {
          const memberPath = String(provenance.sourceArtifactId).replace(/^ofp-member:/u, '').replace(/:sha256:[0-9a-f]{64}$/u, '');
          const managed = this.core.prepare(`
            SELECT managed_path,member_digest FROM feature_managed_assets WHERE feature_id=? AND feature_version=? AND member_path=? AND asset_kind='governance'
          `).get(context.featureId, context.featureVersion, memberPath) as {managed_path:string;member_digest:string}|undefined;
          if (!managed) throw new Error('Derived/default field provenance is not a signed managed governance asset.');
          const claimedDigest=String(provenance.sourceArtifactId).match(/:sha256:([0-9a-f]{64})$/u)?.[1]||'';
          if(claimedDigest!==managed.member_digest) throw new Error('Derived/default field provenance does not freeze the exact signed governance member digest.');
          const rulesAsset=this.core.prepare(`SELECT managed_path FROM feature_managed_assets WHERE feature_id=? AND feature_version=? AND member_path='backend/governance.json' AND asset_kind='governance'`).get(context.featureId,context.featureVersion) as {managed_path:string}|undefined;
          if(!rulesAsset) throw new Error('Signed governance rule IR is unavailable.');
          const governance=JSON.parse(fs.readFileSync(path.resolve(this.paths.data,...rulesAsset.managed_path.split('/')),'utf8')) as {
            fields?:Array<Record<string,unknown>>; derivationRules?:Array<Record<string,unknown>>;
          };
          if(valueKind==='rule_default'){
            const declaration=governance.fields?.find((item)=>String(item.fieldId||'')===String(field.canonicalFieldId||''));
            const rule=governance.derivationRules?.find((item)=>String(item.ruleId||'')===String(provenance.derivationRule||'')
              &&String(item.targetFieldId||'')===String(field.canonicalFieldId||''));
            const declaredDefault=declaration?.defaultValue;
            const expectedAlgorithm=typeof declaredDefault==='boolean'?`constant_boolean_${String(declaredDefault)}`:'';
            if(!declaration||!String(declaration.defaultRuleId||'')||!Object.hasOwn(declaration,'defaultValue')
              ||String(declaration.defaultRuleId)!==String(provenance.derivationRule||'')
              ||canonical(declaration.defaultValue)!==canonical(field.value)
              ||!expectedAlgorithm||!rule||String(rule.algorithm||'')!==expectedAlgorithm
              ||canonical(rule.constantValue)!==canonical(declaredDefault)
              ||String(rule.sourceTraceId||'')!==String(provenance.sourceTraceId||'')) throw new Error('Rule default is not an exact formally declared signed governance default.');
          } else {
            const rule=governance.derivationRules?.find((item)=>String(item.ruleId||'')===String(provenance.derivationRule||'')
              &&String(item.targetFieldId||'')===String(field.canonicalFieldId||''));
            if(!rule||!['canonical_element_id','prefix_literal'].includes(String(rule.algorithm||''))
              ||String(rule.sourceTraceId||'')!==String(provenance.sourceTraceId||'')) throw new Error('Derived field is not bound to an exact formally declared signed governance rule.');
            const dependencyFieldKey=String(provenance.dependencyFieldKey||'');
            const dependency=this.core.prepare(`
              SELECT r.value_json,p.row_key FROM feature_field_revisions r
              JOIN feature_field_provenance p ON p.field_revision_id=r.field_revision_id
              WHERE r.run_id=? AND p.row_key=? AND (${dependencyFieldKey?'r.field_key=?':'r.canonical_field_id=?'}) AND r.status IN ('accepted','needs_input')
              ORDER BY r.revision DESC LIMIT 1
            `).get(String(request.runId),String(provenance.rowKey),dependencyFieldKey||String(rule.dependencyFieldId)) as {value_json:string;row_key:string}|undefined;
            const dependencyValue=dependency?String(JSON.parse(dependency.value_json)??''):'';
            const expectedValue=String(rule.algorithm)==='prefix_literal'?`${String(rule.prefix||'')}${dependencyValue}`:dependencyValue;
            if(!dependency||!dependencyFieldKey&&String(rule.dependencyFieldId||'')!=='P1.APP.IT.ELEMENT_ID'||canonical(expectedValue)!==canonical(field.value)) throw new Error('Derived field value differs from its signed dependency algorithm result.');
          }
        }
        if (valueKind === 'inherited') {
          const evidence = this.core.prepare(`
            SELECT 1 FROM feature_artifacts WHERE artifact_id=? AND run_id=? AND feature_id=? AND kind='evidence'
          `).get(String(provenance.sourceArtifactId), String(request.runId), context.featureId);
          const plannedSourceEdge=String(provenance.sourceArtifactId)===run.source_artifact_id
            &&String(provenance.derivationRule||'').includes('remote_verification_required_before_return');
          if (!evidence&&!plannedSourceEdge) throw new Error('Inherited field provenance is neither verified Run evidence nor an explicitly unverified source edge gated before Return.');
        }
        if (valueKind === 'user_revision') {
          throw new Error('Initial field batches cannot claim user_revision; use the issue revision CAS contract.');
        }
        const latest = this.core.prepare(`
          SELECT revision FROM feature_field_revisions WHERE run_id=? AND field_key=? ORDER BY revision DESC LIMIT 1
        `).get(String(request.runId), String(field.fieldKey || '')) as { revision: number } | undefined;
        const requestedRevision = Number(field.revision || 1);
        if (requestedRevision !== (latest?.revision || 0) + 1) throw new Error('Field revision is not monotonic.');
        const revisionId = randomUUID();
        this.core.prepare(`
          INSERT INTO feature_field_revisions(
            field_revision_id, run_id, template_instance_id, field_key, raw_field_key, canonical_field_id, revision, value_kind,
            value_json, status, created_at
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(revisionId, String(request.runId), String(request.templateInstanceId || ''), String(field.fieldKey || ''),
          String(field.rawFieldKey || ''), String(field.canonicalFieldId || ''), requestedRevision,
          valueKind, JSON.stringify(field.value ?? null),
          String(field.status || 'accepted'), now());
        this.core.prepare(`
          INSERT INTO feature_field_provenance(
            provenance_id, field_revision_id, source_artifact_id, source_sheet, source_row,
            row_key, field_key, source_trace_id, derivation_rule, created_at
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(randomUUID(), revisionId, String(provenance.sourceArtifactId), String(provenance.sourceSheet),
          Number(provenance.sourceRow), String(provenance.rowKey), String(provenance.fieldKey),
          String(provenance.sourceTraceId), String(provenance.derivationRule || ''), now());
        this.core.prepare(`INSERT INTO template_instance_field_revisions(template_instance_id,field_revision_id,field_key,revision,bound_at) VALUES(?,?,?,?,?) ON CONFLICT(template_instance_id,field_key) DO UPDATE SET field_revision_id=excluded.field_revision_id,revision=excluded.revision,bound_at=excluded.bound_at WHERE excluded.revision>template_instance_field_revisions.revision`).run(String(request.templateInstanceId||''),revisionId,String(field.fieldKey||''),requestedRevision,now());
        if (latest) {
          this.core.prepare(`
            UPDATE feature_field_revisions SET status='superseded'
            WHERE run_id=? AND field_key=? AND revision=? AND status IN ('accepted','needs_input','blocked')
          `).run(String(request.runId), String(field.fieldKey), latest.revision);
        }
      }
      this.core.exec('COMMIT;');
      return fields.length;
    } catch (error) {
      this.core.exec('ROLLBACK;');
      throw error;
    }
  }

  private recordIssues(input: unknown, context: FeatureWorkerPortContext): number {
    const request = object(input, 'Issue batch');
    const issues = request.issues;
    if (!Array.isArray(issues) || issues.length > 2_000) throw new Error('Issue batch is invalid.');
    if (!this.core.prepare(`SELECT 1 FROM feature_runs WHERE run_id=? AND feature_id=?`).get(String(request.runId || ''), context.featureId)) {
      throw new Error('Issue run is unavailable.');
    }
    for (const value of issues) {
      const issue = object(value, 'Feature issue');
      const { issueType, state } = featureIssueIdentity(issue);
      const issueId=String(issue.issueId || randomUUID());const owner=this.core.prepare(`SELECT run_id FROM feature_issues WHERE issue_id=?`).get(issueId) as {run_id:string}|undefined;if(owner&&owner.run_id!==String(request.runId))throw new Error('Feature issue identity belongs to another Run.');
      this.core.prepare(`
        INSERT INTO feature_issues(
          issue_id, run_id, field_key, issue_type, state, message, resolution_revision_id, created_at, resolved_at
        ) VALUES(?, ?, ?, ?, ?, ?, '', ?, '')
        ON CONFLICT(issue_id) DO UPDATE SET field_key=excluded.field_key,issue_type=excluded.issue_type,state=excluded.state,message=excluded.message,resolution_revision_id='',created_at=excluded.created_at,resolved_at=''
      `).run(issueId, String(request.runId), String(issue.fieldKey || ''),
        issueType, state, String(issue.message || ''), now());
    }
    return issues.length;
  }

  private loadRunReview(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    const runId = String(object(input, 'Run review request').runId || '');
    if (!this.core.prepare(`SELECT 1 FROM feature_runs WHERE run_id=? AND feature_id=?`).get(runId, context.featureId)) {
      throw new Error('Run review is unavailable.');
    }
    const unresolved = this.core.prepare(`
      SELECT i.issue_id, i.field_key, i.issue_type, i.message,
             r.revision, r.value_json, r.raw_field_key, r.canonical_field_id
      FROM feature_issues i
      LEFT JOIN feature_field_revisions r ON r.field_revision_id=(
        SELECT r2.field_revision_id FROM feature_field_revisions r2
        WHERE r2.run_id=i.run_id AND r2.field_key=i.field_key
        ORDER BY r2.revision DESC LIMIT 1
      )
      WHERE i.run_id=? AND i.state IN ('needs_input','blocking')
      ORDER BY i.created_at, i.issue_id
    `).all(runId) as Array<Record<string, unknown>>;
    return {
      unresolvedCount: unresolved.length,
      editors: unresolved.filter((row) => Number(row.revision) >= 1).map((row) => ({
        issueId: String(row.issue_id), fieldKey: String(row.field_key), expectedRevision: Number(row.revision),
        inputKind: 'text', label: String(row.message), currentValue: String(JSON.parse(String(row.value_json || '""')) ?? ''),
        allowedValues: [], required: true, maxLength: 2_000
      }))
    };
  }

  private applyIssueRevisions(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    const request = object(input, 'Issue revision request');
    const runId = String(request.runId || '');
    const revisions = request.revisions;
    if (!Array.isArray(revisions) || revisions.length < 1 || revisions.length > 500) throw new Error('Issue revision batch is invalid.');
    const run = this.core.prepare(`
      SELECT r.state, r.source_artifact_id,
             (SELECT template_instance_id FROM template_instances WHERE run_id=r.run_id ORDER BY created_at DESC, rowid DESC LIMIT 1) AS template_instance_id
      FROM feature_runs r WHERE r.run_id=? AND r.feature_id=?
    `).get(runId, context.featureId) as { state: string; source_artifact_id: string; template_instance_id: string } | undefined;
    if (!run || run.state !== 'needs_input' || !run.template_instance_id) throw new Error('Issue revisions require a needs_input Run with a TemplateInstance.');
    this.core.exec('BEGIN IMMEDIATE;');
    try {
      for (const raw of revisions) {
        const change = object(raw, 'Issue revision');
        const issueId = String(change.issueId || '');
        const fieldKey = String(change.fieldKey || '');
        const expectedRevision = Number(change.expectedRevision);
        const value = String(change.value ?? '').normalize('NFC').trim();
        if (!value || value.length > 2_000) throw new Error('Issue revision value is invalid.');
        const row = this.core.prepare(`
          SELECT i.field_key, i.state, r.field_revision_id, r.revision, r.raw_field_key, r.canonical_field_id,
                 r.value_kind, p.source_artifact_id, p.source_sheet, p.source_row, p.row_key, p.source_trace_id
          FROM feature_issues i
          JOIN feature_field_revisions r ON r.field_revision_id=(
            SELECT r2.field_revision_id FROM feature_field_revisions r2 WHERE r2.run_id=i.run_id AND r2.field_key=i.field_key
            ORDER BY r2.revision DESC LIMIT 1
          )
          JOIN feature_field_provenance p ON p.field_revision_id=r.field_revision_id
          WHERE i.issue_id=? AND i.run_id=?
        `).get(issueId, runId) as Record<string, unknown> | undefined;
        if (!row || row.state !== 'needs_input' || row.field_key !== fieldKey || Number(row.revision) !== expectedRevision) {
          throw new Error('Issue or field revision changed; reload before saving.');
        }
        const revisionId = randomUUID();
        const createdAt = now();
        this.core.prepare(`
          INSERT INTO feature_field_revisions(
            field_revision_id, run_id, template_instance_id, field_key, raw_field_key, canonical_field_id,
            revision, value_kind, value_json, status, created_at
          ) VALUES(?, ?, ?, ?, ?, ?, ?, 'user_revision', ?, 'accepted', ?)
        `).run(revisionId, runId, '', fieldKey, String(row.raw_field_key || ''),
          String(row.canonical_field_id || ''), expectedRevision + 1, JSON.stringify(value), createdAt);
        this.core.prepare(`
          INSERT INTO feature_field_provenance(
            provenance_id, field_revision_id, source_artifact_id, source_sheet, source_row,
            row_key, field_key, source_trace_id, derivation_rule, created_at
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'explicit_user_revision_with_cas', ?)
        `).run(randomUUID(), revisionId, String(row.source_artifact_id), String(row.source_sheet), Number(row.source_row),
          String(row.row_key), fieldKey, `${String(row.source_trace_id)}:revision:${expectedRevision + 1}`, createdAt);
        this.core.prepare(`UPDATE feature_field_revisions SET status='superseded' WHERE field_revision_id=?`).run(String(row.field_revision_id));
        this.core.prepare(`UPDATE feature_issues SET state='resolved', resolution_revision_id=?, resolved_at=? WHERE issue_id=? AND state='needs_input'`)
          .run(revisionId, createdAt, issueId);
      }
      this.core.exec('COMMIT;');
    } catch (error) {
      this.core.exec('ROLLBACK;');
      throw error;
    }
    return this.loadRunReview({ runId }, context);
  }

  private commitReviewValidation(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    const request=object(input,'Review validation commit') as FeatureReviewValidationCommit&Record<string,any>;const runId=String(request.runId||'');const expectedRunRevision=Number(request.expectedRunRevision);
    const revisions=Array.isArray(request.revisions)?request.revisions:[];const derivedRevisions=Array.isArray(request.derivedRevisions)?request.derivedRevisions:[];const issues=Array.isArray(request.issues)?request.issues:[];
    if(revisions.length>500||derivedRevisions.length>1000||issues.length>2000)throw new Error('Review validation batch exceeds limits.');
    const run=this.core.prepare(`SELECT state,state_revision,(SELECT template_instance_id FROM template_instances WHERE run_id=feature_runs.run_id ORDER BY created_at DESC,rowid DESC LIMIT 1) AS template_instance_id FROM feature_runs WHERE run_id=? AND feature_id=? AND feature_version=?`).get(runId,context.featureId,context.featureVersion) as {state:string;state_revision:number;template_instance_id:string}|undefined;
    if(!run||!['needs_input','ready_for_review'].includes(run.state)||run.state_revision!==expectedRunRevision)throw new Error('Review Run revision changed; reload before saving.');
    if(!request.templateInstanceId||String(request.templateInstanceId)!==String(run.template_instance_id||''))throw new Error('Review commit must bind the latest compiled TemplateInstance.');
    const nextState=String(request.nextState||'');if(!['needs_input','ready_for_review'].includes(nextState))throw new Error('Review validation next state is invalid.');
    const occurredAt=now();this.core.exec('BEGIN IMMEDIATE;');
    try{const revisedDependencies=new Map<string,{canonicalFieldId:string;rowKey:string;nextRevision:number}>();
      for(const raw of revisions){const change=object(raw,'Review field change');const fieldKey=String(change.fieldKey||'');const expectedRevision=Number(change.expectedRevision);const value=String(change.value??'').normalize('NFC').trim();
        if(value.length>8000)throw new Error('Review value exceeds the maximum supported field limit.');const row=this.core.prepare(`SELECT r.field_revision_id,r.revision,r.raw_field_key,r.canonical_field_id,r.value_kind,p.source_artifact_id,p.source_sheet,p.source_row,p.row_key,p.source_trace_id FROM feature_field_revisions r JOIN feature_field_provenance p ON p.field_revision_id=r.field_revision_id WHERE r.run_id=? AND r.field_key=? ORDER BY r.revision DESC LIMIT 1`).get(runId,fieldKey) as Record<string,unknown>|undefined;
        if(!row||Number(row.revision)!==expectedRevision||['derived','rule_default','inherited'].includes(String(row.value_kind)))throw new Error('Review field revision changed or is not editable.');
        const revisionId=randomUUID(),nextRevision=expectedRevision+1;this.core.prepare(`INSERT INTO feature_field_revisions(field_revision_id,run_id,template_instance_id,field_key,raw_field_key,canonical_field_id,revision,value_kind,value_json,status,created_at) VALUES(?,?,?,?,?,?,?,'user_revision',?,'accepted',?)`).run(revisionId,runId,String(request.templateInstanceId||''),fieldKey,String(row.raw_field_key||''),String(row.canonical_field_id||''),nextRevision,JSON.stringify(value),occurredAt);
        this.core.prepare(`INSERT INTO feature_field_provenance(provenance_id,field_revision_id,source_artifact_id,source_sheet,source_row,row_key,field_key,source_trace_id,derivation_rule,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(),revisionId,String(row.source_artifact_id),String(row.source_sheet),Number(row.source_row),String(row.row_key),fieldKey,`${String(row.source_trace_id)}:revision:${nextRevision}`,'explicit_user_revision_with_cas',occurredAt);
        this.core.prepare(`INSERT INTO template_instance_field_revisions(template_instance_id,field_revision_id,field_key,revision,bound_at) VALUES(?,?,?,?,?) ON CONFLICT(template_instance_id,field_key) DO UPDATE SET field_revision_id=excluded.field_revision_id,revision=excluded.revision,bound_at=excluded.bound_at WHERE excluded.revision>template_instance_field_revisions.revision`).run(String(request.templateInstanceId||''),revisionId,fieldKey,nextRevision,occurredAt);
        this.core.prepare(`UPDATE feature_field_revisions SET status='superseded' WHERE field_revision_id=?`).run(String(row.field_revision_id));
        revisedDependencies.set(fieldKey,{canonicalFieldId:String(row.canonical_field_id||''),rowKey:String(row.row_key||''),nextRevision});
      }
      const derivedByDependency=new Map<string,Set<string>>();
      for(const raw of derivedRevisions){const change=object(raw,'Derived review revision');const fieldKey=String(change.fieldKey||''),dependencyFieldKey=String(change.dependencyFieldKey||'');const expectedRevision=Number(change.expectedRevision),dependencyRevision=Number(change.dependencyRevision);const value=String(change.value??'').normalize('NFC').trim();
        const dependency=revisedDependencies.get(dependencyFieldKey);if(!dependency||dependency.nextRevision!==dependencyRevision)throw new Error('Derived review revision is not bound to a dependency changed in the same atomic commit.');
        const row=this.core.prepare(`SELECT r.field_revision_id,r.revision,r.raw_field_key,r.canonical_field_id,r.value_kind,p.source_artifact_id,p.source_sheet,p.source_row,p.row_key,p.source_trace_id,p.derivation_rule FROM feature_field_revisions r JOIN feature_field_provenance p ON p.field_revision_id=r.field_revision_id WHERE r.run_id=? AND r.field_key=? ORDER BY r.revision DESC LIMIT 1`).get(runId,fieldKey) as Record<string,unknown>|undefined;
        if(!row||String(row.value_kind)!=='derived'||Number(row.revision)!==expectedRevision||String(row.row_key)!==dependency.rowKey)throw new Error('Derived review field revision changed or has invalid lineage.');
        const dependencyRow=this.core.prepare(`SELECT value_json,revision FROM feature_field_revisions WHERE run_id=? AND field_key=? ORDER BY revision DESC LIMIT 1`).get(runId,dependencyFieldKey) as {value_json:string;revision:number}|undefined;if(!dependencyRow||dependencyRow.revision!==dependencyRevision)throw new Error('Derived review dependency revision changed.');
        const rulesAsset=this.core.prepare(`SELECT managed_path FROM feature_managed_assets WHERE feature_id=? AND feature_version=? AND member_path='backend/governance.json' AND asset_kind='governance'`).get(context.featureId,context.featureVersion) as {managed_path:string}|undefined;if(!rulesAsset)throw new Error('Signed governance rule IR is unavailable.');
        const governance=JSON.parse(fs.readFileSync(path.resolve(this.paths.data,...rulesAsset.managed_path.split('/')),'utf8')) as {derivationRules?:Array<Record<string,unknown>>};const rule=governance.derivationRules?.find((candidate)=>String(candidate.ruleId||'')===String(row.derivation_rule||'')&&String(candidate.targetFieldId||'')===String(row.canonical_field_id||''));
        if(!rule||!['canonical_element_id','prefix_literal'].includes(String(rule.algorithm||''))||String(rule.sourceTraceId||'')!==String(row.source_trace_id||''))throw new Error('Derived review field is not backed by its signed rule.');const dependencyValue=String(JSON.parse(dependencyRow.value_json)??'');const expectedValue=String(rule.algorithm)==='prefix_literal'?`${String(rule.prefix||'')}${dependencyValue}`:dependencyValue;if(value!==expectedValue)throw new Error('Derived review value differs from its signed dependency rule.');
        const revisionId=randomUUID(),nextRevision=expectedRevision+1;this.core.prepare(`INSERT INTO feature_field_revisions(field_revision_id,run_id,template_instance_id,field_key,raw_field_key,canonical_field_id,revision,value_kind,value_json,status,created_at) VALUES(?,?,?,?,?,?,?,'derived',?,'accepted',?)`).run(revisionId,runId,String(request.templateInstanceId),fieldKey,String(row.raw_field_key||''),String(row.canonical_field_id||''),nextRevision,JSON.stringify(value),occurredAt);
        this.core.prepare(`INSERT INTO feature_field_provenance(provenance_id,field_revision_id,source_artifact_id,source_sheet,source_row,row_key,field_key,source_trace_id,derivation_rule,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(),revisionId,String(row.source_artifact_id||''),String(row.source_sheet||''),Number(row.source_row),String(row.row_key||''),fieldKey,String(row.source_trace_id||''),String(row.derivation_rule||''),occurredAt);
        this.core.prepare(`INSERT INTO template_instance_field_revisions(template_instance_id,field_revision_id,field_key,revision,bound_at) VALUES(?,?,?,?,?) ON CONFLICT(template_instance_id,field_key) DO UPDATE SET field_revision_id=excluded.field_revision_id,revision=excluded.revision,bound_at=excluded.bound_at WHERE excluded.revision>template_instance_field_revisions.revision`).run(String(request.templateInstanceId),revisionId,fieldKey,nextRevision,occurredAt);this.core.prepare(`UPDATE feature_field_revisions SET status='superseded' WHERE field_revision_id=?`).run(String(row.field_revision_id));
        const targets=derivedByDependency.get(dependencyFieldKey)||new Set<string>();targets.add(String(row.canonical_field_id||''));derivedByDependency.set(dependencyFieldKey,targets);
      }
      for(const [fieldKey,dependency] of revisedDependencies){if(!/P1\.(?:APP|DB|OS|TOOL)\.IT\.ELEMENT_ID/u.test(dependency.canonicalFieldId))continue;const actual=derivedByDependency.get(fieldKey)||new Set<string>();if(!actual.has('P1.RUNTIME.GRA.NAME')||(dependency.canonicalFieldId==='P1.APP.IT.ELEMENT_ID'&&!actual.has('P1.APP.IT.DESCRIPTION')))throw new Error('Element ID revision must atomically include every signed derived field revision.');}
      this.core.prepare(`UPDATE feature_issues SET state='resolved',resolved_at=? WHERE run_id=? AND state IN ('needs_input','blocking','waived')`).run(occurredAt,runId);
      for(const raw of issues){const issue=object(raw,'Revalidated issue');const {issueType,state}=featureIssueIdentity(issue);const issueId=String(issue.issueId||randomUUID());const owner=this.core.prepare(`SELECT run_id FROM feature_issues WHERE issue_id=?`).get(issueId) as {run_id:string}|undefined;if(owner&&owner.run_id!==runId)throw new Error('Revalidated issue identity belongs to another Run.');this.core.prepare(`INSERT INTO feature_issues(issue_id,run_id,field_key,issue_type,state,message,resolution_revision_id,created_at,resolved_at) VALUES(?,?,?,?,?,?,'',?,'') ON CONFLICT(issue_id) DO UPDATE SET field_key=excluded.field_key,issue_type=excluded.issue_type,state=excluded.state,message=excluded.message,resolution_revision_id='',created_at=excluded.created_at,resolved_at=''`).run(issueId,runId,String(issue.fieldKey||''),issueType,state,String(issue.message||''),occurredAt);}
      const nextRevision=expectedRunRevision+1;const changed=this.core.prepare(`UPDATE feature_runs SET state=?,state_revision=?,last_error='',updated_at=? WHERE run_id=? AND feature_id=? AND state_revision=?`).run(nextState,nextRevision,occurredAt,runId,context.featureId,expectedRunRevision);if(changed.changes!==1)throw new Error('Review Run revision changed; reload before saving.');
      this.core.prepare(`INSERT INTO feature_run_events(event_id,run_id,revision,from_state,to_state,event_type,details_json,occurred_at) VALUES(?,?,?,?,?,?,?,?)`).run(randomUUID(),runId,nextRevision,run.state,nextState,String(request.eventType||'review.revalidated'),JSON.stringify({revisionCount:revisions.length,derivedRevisionCount:derivedRevisions.length,issueCount:issues.length,excludedRowKey:String(request.excludedRowKey||'')}),occurredAt);
      this.core.exec('COMMIT;');return{state:nextState,stateRevision:nextRevision};
    }catch(error){this.core.exec('ROLLBACK;');throw error;}
  }

  private prepareReturnIntent(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    const request = object(input, 'Return intent request');
    const runId = String(request.runId || '');
    let plan = object(request.plan, 'Return plan');
    const targets = plan.targets;
    if (!Array.isArray(targets) || targets.length < 1 || targets.length > 2_000) throw new Error('Return plan target inventory is invalid.');
    const run = this.core.prepare(`SELECT state, state_revision, engagement_id FROM feature_runs WHERE run_id=? AND feature_id=? AND feature_version=?`)
      .get(runId, context.featureId, context.featureVersion) as { state: string; state_revision: number; engagement_id: string } | undefined;
    if (!run || run.state !== 'ready_for_review') throw new Error('Return intent requires a ready_for_review Run.');
    const binding = returnAuthorityBinding(request.connectorBinding, 'Return Connector binding');
    const safety = object(request.safetyLock, 'Return safety lock');
    const workspaceIds = Array.isArray(safety.workspaceIds) ? safety.workspaceIds.map(String) : [];
    const globalWorkspaceIds = safety.globalEnabled === true && Array.isArray(safety.globalWorkspaceIds)
      ? safety.globalWorkspaceIds.map(String) : [];
    const allowedWorkspaceIds = [...new Set([...workspaceIds, ...globalWorkspaceIds])];
    if (!binding.connectorId || Number(binding.sessionGeneration) < 1 || !binding.engagementId
      || !binding.authorityInstanceId || !binding.packId
      || safety.enabled !== true || safety.engagementId !== binding.engagementId || workspaceIds.length < 1) {
      throw new Error('Return intent binding or safety lock is invalid.');
    }
    if (run.engagement_id && run.engagement_id !== String(binding.engagementId)) {
      throw new Error('Return intent engagement differs from the engagement already frozen on this Run.');
    }
    const planAuthority = returnAuthorityBinding(plan.authority, 'Return plan authority snapshot');
    plan = { ...plan, authority: planAuthority };
    if (String(planAuthority.authorityInstanceId || '') !== String(binding.authorityInstanceId)
      || String(planAuthority.tenantOrOrgId || '') !== String(binding.tenantOrOrgId)
      || String(planAuthority.packId || '') !== String(binding.packId)
      || String(planAuthority.engagementId || '') !== String(binding.engagementId)) {
      throw new Error('Return plan authority snapshot differs from the exact current Connector authority.');
    }
    const durableSafety = this.core.prepare(`SELECT enabled, engagement_id, workspace_ids_json, global_enabled, global_section_ids_json, global_workspace_ids_json, state_version FROM workspace_safety WHERE singleton=1`)
      .get() as { enabled: number; engagement_id: string; workspace_ids_json: string; global_enabled:number; global_section_ids_json:string; global_workspace_ids_json:string; state_version: number };
    if (durableSafety.enabled !== 1 || durableSafety.engagement_id !== binding.engagementId
      || canonical(JSON.parse(durableSafety.workspace_ids_json)) !== canonical(workspaceIds)
      || durableSafety.global_enabled !== (safety.globalEnabled === true ? 1 : 0)
      || canonical(JSON.parse(durableSafety.global_section_ids_json)) !== canonical(Array.isArray(safety.globalSectionIds) ? safety.globalSectionIds.map(String) : [])
      || canonical(JSON.parse(durableSafety.global_workspace_ids_json)) !== canonical(globalWorkspaceIds)
      || durableSafety.state_version !== Number(safety.stateVersion)) throw new Error('Return intent safety lock differs from durable Core state.');
    const authorityDigest = crypto.createHash('sha256').update(canonical({
      connectorId: binding.connectorId, sessionGeneration: Number(binding.sessionGeneration), engagementId: binding.engagementId,
      authorityInstanceId: binding.authorityInstanceId, tenantOrOrgId: binding.tenantOrOrgId, packId: binding.packId,
      workspaceIds
    })).digest('hex');
    if (String(request.credentialDigest || '') !== authorityDigest) throw new Error('Return authority credential digest is absent or does not match the exact frozen authority scope.');
    if (!/^[0-9a-f]{64}$/u.test(String(request.preflightDigest || ''))) throw new Error('Return intent requires a real preflight digest.');
    const planDigest = crypto.createHash('sha256').update(canonical(plan)).digest('hex');
    const confirmationId = randomUUID(); const messageId = `feature-return:${context.featureId}:${runId}`;
    const confirmationToken = randomUUID(); const tokenDigest = crypto.createHash('sha256').update(confirmationToken).digest('hex');
    const createdAt = now(); const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    this.core.exec('BEGIN IMMEDIATE;');
    try {
      for (const raw of targets) {
        const target = object(raw, 'Return intent target');
        if (!['object', 'relation', 'field', 'risk_control', 'documentation', 'evaluation'].includes(String(target.kind))
          || !String(target.key || '')) throw new Error('Return intent target identity is invalid.');
        if (String(target.kind) === 'object' && String(target.objectType) === 'GRA'
          && target.disposition !== undefined
          && !['create', 'reuse'].includes(String(target.disposition || ''))) {
          throw new Error('GRA Return intent disposition must be exactly create or reuse.');
        }
        if (target.workspace !== undefined && !allowedWorkspaceIds.includes(String(target.workspace))) {
          throw new Error('Return intent target Workspace is outside the exact durable safety scope.');
        }
        const frozenIntent = this.core.prepare(`
          INSERT INTO managed_content_intents(intent_id, run_id, plan_digest, target_kind, target_key, intended_revision_json, state, created_at, updated_at)
          VALUES(?, ?, ?, ?, ?, ?, 'frozen', ?, ?)
          ON CONFLICT(run_id,target_kind,target_key) DO UPDATE SET
            plan_digest=excluded.plan_digest,
            intended_revision_json=excluded.intended_revision_json,
            state='frozen',
            updated_at=excluded.updated_at
          WHERE managed_content_intents.state='cancelled'
            AND NOT EXISTS(SELECT 1 FROM feature_commands c WHERE c.intent_id=managed_content_intents.intent_id)
        `).run(randomUUID(), runId, planDigest, String(target.kind), String(target.key), JSON.stringify(target), createdAt, createdAt);
        if (frozenIntent.changes !== 1) throw new Error('Return intent target conflicts with a non-cancelled or commanded prior freeze.');
      }
      this.core.prepare(`
        INSERT INTO feature_confirmations(
          confirmation_id, run_id, message_id, plan_digest, connector_id, session_generation, engagement_id,
          authority_instance_id, tenant_or_org_id, pack_id,
          safety_revision, credential_digest, preflight_digest, confirmation_token_digest, decision, actor_id,
          decision_at, consumed_command_id, expires_at, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '', '', '', ?, ?)
      `).run(confirmationId, runId, messageId, planDigest, String(binding.connectorId), Number(binding.sessionGeneration),
        String(binding.engagementId), String(binding.authorityInstanceId), String(binding.tenantOrOrgId), String(binding.packId),
        Number(safety.stateVersion), authorityDigest,
        String(request.preflightDigest || ''), tokenDigest, expiresAt, createdAt);
      const updated = this.core.prepare(`UPDATE feature_runs SET state='waiting_confirmation', state_revision=state_revision+1, engagement_id=?, plan_digest=?, updated_at=? WHERE run_id=? AND state_revision=? AND (engagement_id='' OR engagement_id=?)`)
        .run(String(binding.engagementId), planDigest, createdAt, runId, run.state_revision, String(binding.engagementId));
      if (updated.changes !== 1) throw new Error('Run changed while freezing the return intent.');
      this.core.prepare(`INSERT INTO feature_run_events(event_id, run_id, revision, from_state, to_state, event_type, details_json, occurred_at) VALUES(?, ?, ?, 'ready_for_review', 'waiting_confirmation', 'return.intent_frozen', ?, ?)`)
        .run(randomUUID(), runId, run.state_revision + 1, JSON.stringify({ confirmationId, messageId, planDigest }), createdAt);
      this.core.exec('COMMIT;');
    } catch (error) { this.core.exec('ROLLBACK;'); throw error; }
    return { confirmationId, confirmationToken, messageId, planDigest, stateVersion: 1, expiresAt,
      authoritySnapshot: { authorityInstanceId: String(binding.authorityInstanceId), tenantOrOrgId: String(binding.tenantOrOrgId),
        packId: String(binding.packId), engagementId: String(binding.engagementId) } };
  }

  private approveReturnIntent(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    if (!context.allowMutation) throw new Error('Return confirmation is only available from an authorized mutation action.');
    const request = object(input, 'Return approval request');
    const confirmationId = String(request.confirmationId || '');
    const tokenDigest = crypto.createHash('sha256').update(String(request.confirmationToken || '')).digest('hex');
    const row = this.core.prepare(`
      SELECT c.*, r.state, r.state_revision, r.engagement_id AS run_engagement_id FROM feature_confirmations c JOIN feature_runs r ON r.run_id=c.run_id
      WHERE c.confirmation_id=? AND r.feature_id=? AND r.feature_version=?
    `).get(confirmationId, context.featureId, context.featureVersion) as Record<string, any> | undefined;
    const binding = returnAuthorityBinding(request.connectorBinding, 'Current Return Connector binding');
    const safety = object(request.safetyLock, 'Current Return safety lock');
    const durableSafety = this.core.prepare(`SELECT enabled, engagement_id, workspace_ids_json, global_enabled, global_section_ids_json, global_workspace_ids_json, state_version FROM workspace_safety WHERE singleton=1`)
      .get() as { enabled: number; engagement_id: string; workspace_ids_json: string; global_enabled:number; global_section_ids_json:string; global_workspace_ids_json:string; state_version: number };
    if (!row || row.decision !== 'pending' || row.state !== 'waiting_confirmation' || row.confirmation_token_digest !== tokenDigest
      || row.expires_at <= now() || Number(request.expectedStateVersion) !== 1
      || String(binding.connectorId) !== String(row.connector_id) || Number(binding.sessionGeneration) !== Number(row.session_generation)
      || String(binding.engagementId) !== String(row.engagement_id) || String(row.run_engagement_id) !== String(row.engagement_id)
      || safety.enabled !== true
      || String(binding.authorityInstanceId || '') !== String(row.authority_instance_id)
      || String(binding.tenantOrOrgId || '') !== String(row.tenant_or_org_id)
      || String(binding.packId || '') !== String(row.pack_id)
      || crypto.createHash('sha256').update(canonical({
        connectorId: binding.connectorId, sessionGeneration: Number(binding.sessionGeneration), engagementId: binding.engagementId,
        authorityInstanceId: binding.authorityInstanceId, tenantOrOrgId: binding.tenantOrOrgId, packId: binding.packId,
        workspaceIds: safety.workspaceIds
      })).digest('hex') !== String(row.credential_digest)
      || String(safety.engagementId) !== String(row.engagement_id) || Number(safety.stateVersion) !== Number(row.safety_revision)
      || durableSafety.enabled !== 1 || durableSafety.engagement_id !== String(row.engagement_id)
      || durableSafety.state_version !== Number(row.safety_revision)
      || canonical(JSON.parse(durableSafety.workspace_ids_json)) !== canonical(safety.workspaceIds)
      || durableSafety.global_enabled !== (safety.globalEnabled === true ? 1 : 0)
      || canonical(JSON.parse(durableSafety.global_section_ids_json)) !== canonical(Array.isArray(safety.globalSectionIds) ? safety.globalSectionIds.map(String) : [])
      || canonical(JSON.parse(durableSafety.global_workspace_ids_json)) !== canonical(safety.globalEnabled === true && Array.isArray(safety.globalWorkspaceIds) ? safety.globalWorkspaceIds.map(String) : [])) {
      throw new Error('Return confirmation is stale, invalid, expired, or no longer bound to the durable safety scope.');
    }
    const approvedAt = now();
    this.core.exec('BEGIN IMMEDIATE;');
    try {
      const confirmationUpdate=this.core.prepare(`UPDATE feature_confirmations SET decision='approved', actor_id='local-user', decision_at=? WHERE confirmation_id=? AND decision='pending'`)
        .run(approvedAt, confirmationId);
      if(confirmationUpdate.changes!==1) throw new Error('Return confirmation changed before approval CAS completed.');
      const runUpdate=this.core.prepare(`UPDATE feature_runs SET state='returning', state_revision=state_revision+1, updated_at=? WHERE run_id=? AND state='waiting_confirmation' AND state_revision=? AND engagement_id=?`)
        .run(approvedAt, String(row.run_id),Number(row.state_revision),String(row.engagement_id));
      if(runUpdate.changes!==1) throw new Error('Return Run changed before approval CAS completed.');
      this.core.prepare(`INSERT INTO feature_run_events(event_id, run_id, revision, from_state, to_state, event_type, details_json, occurred_at) VALUES(?, ?, ?, 'waiting_confirmation', 'returning', 'return.confirmed_in_comments', ?, ?)`)
        .run(randomUUID(), String(row.run_id), Number(row.state_revision) + 1, JSON.stringify({ confirmationId }), approvedAt);
      this.core.exec('COMMIT;');
    } catch (error) { this.core.exec('ROLLBACK;'); throw error; }
    return { runId: String(row.run_id), planDigest: String(row.plan_digest), stateRevision: Number(row.state_revision) + 1 };
  }

  private validateReturnAuthority(input: unknown, context: FeatureWorkerPortContext): true {
    const request=object(input,'Return authority validation'); const runId=String(request.runId||'');
    const binding=returnAuthorityBinding(request.connectorBinding,'Current Return Connector binding'); const safety=object(request.safetyLock,'Current Return safety lock');
    if(!this.currentActivationOwnsRun(runId,context)) throw new Error('Current Return authority differs from the approved exact scope.');
    const confirmation=this.core.prepare(`SELECT c.confirmation_id,c.credential_digest,c.connector_id,c.session_generation,c.engagement_id,c.authority_instance_id,c.tenant_or_org_id,c.pack_id,c.safety_revision,r.engagement_id AS run_engagement_id,r.state AS run_state FROM feature_confirmations c JOIN feature_runs r ON r.run_id=c.run_id WHERE c.run_id=? AND c.decision='approved' AND r.feature_id=? ORDER BY c.created_at DESC LIMIT 1`).get(runId,context.featureId) as Record<string,any>|undefined;
    const durable=this.core.prepare(`SELECT enabled,engagement_id,workspace_ids_json,global_enabled,global_section_ids_json,global_workspace_ids_json,state_version FROM workspace_safety WHERE singleton=1`).get() as {enabled:number;engagement_id:string;workspace_ids_json:string;global_enabled:number;global_section_ids_json:string;global_workspace_ids_json:string;state_version:number};
    const workspaceIds=Array.isArray(safety.workspaceIds)?safety.workspaceIds.map(String):[];
    const authorityDigest=crypto.createHash('sha256').update(canonical({connectorId:binding.connectorId,sessionGeneration:Number(binding.sessionGeneration),engagementId:binding.engagementId,authorityInstanceId:binding.authorityInstanceId,tenantOrOrgId:binding.tenantOrOrgId,packId:binding.packId,workspaceIds})).digest('hex');
    if(!confirmation||confirmation.engagement_id!==binding.engagementId
      ||confirmation.run_engagement_id!==binding.engagementId||confirmation.authority_instance_id!==binding.authorityInstanceId
      ||confirmation.tenant_or_org_id!==binding.tenantOrOrgId||confirmation.pack_id!==binding.packId
      ||durable.enabled!==1||durable.engagement_id!==binding.engagementId
      ||durable.state_version!==Number(safety.stateVersion)||canonical(JSON.parse(durable.workspace_ids_json))!==canonical(workspaceIds)
      ||durable.global_enabled!==(safety.globalEnabled===true?1:0)
      ||canonical(JSON.parse(durable.global_section_ids_json))!==canonical(Array.isArray(safety.globalSectionIds)?safety.globalSectionIds.map(String):[])
      ||canonical(JSON.parse(durable.global_workspace_ids_json))!==canonical(safety.globalEnabled===true&&Array.isArray(safety.globalWorkspaceIds)?safety.globalWorkspaceIds.map(String):[])) throw new Error('Current Return authority differs from the approved exact scope.');
    if(confirmation.credential_digest===authorityDigest&&confirmation.safety_revision===Number(safety.stateVersion)
      &&confirmation.connector_id===binding.connectorId&&Number(confirmation.session_generation)===Number(binding.sessionGeneration)) return true;
    const intendedRows=this.core.prepare(`SELECT intended_revision_json FROM managed_content_intents WHERE run_id=? AND state<>'cancelled'`).all(runId) as Array<{intended_revision_json:string}>;
    const intendedWorkspaceIds=[...new Set(intendedRows.map((row)=>String((JSON.parse(row.intended_revision_json) as Record<string,unknown>).workspace||'')).filter(Boolean))].sort();
    const currentWorkspaceIds=[...new Set(workspaceIds)].sort();
    if(confirmation.connector_id!==binding.connectorId
      ||!['uncertain','reconciling','returning','verifying'].includes(String(confirmation.run_state||''))
      ||intendedWorkspaceIds.length===0||canonical(intendedWorkspaceIds)!==canonical(currentWorkspaceIds)) {
      throw new Error('Current Return authority differs from the approved exact scope.');
    }
    this.core.exec('BEGIN IMMEDIATE;');
    try {
      const rebound=this.core.prepare(`UPDATE feature_confirmations SET session_generation=?,safety_revision=?,credential_digest=? WHERE confirmation_id=? AND decision='approved' AND connector_id=? AND session_generation=? AND safety_revision=? AND credential_digest=?`)
        .run(Number(binding.sessionGeneration),Number(safety.stateVersion),authorityDigest,String(confirmation.confirmation_id),String(confirmation.connector_id),Number(confirmation.session_generation),Number(confirmation.safety_revision),String(confirmation.credential_digest));
      if(rebound.changes!==1) throw new Error('Return authority changed before generation reauthorization completed.');
      this.core.exec('COMMIT;');
    } catch(error) { this.core.exec('ROLLBACK;'); throw error; }
    return true;
  }

  private prepareReturnCommand(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    if (!context.allowMutation) throw new Error('Return commands require an authorized mutation action.');
    const request = object(input, 'Return command');
    const runId = String(request.runId || ''); const planDigest = String(request.planDigest || '');
    if (!this.currentActivationOwnsRun(runId, context)
      || !this.core.prepare(`SELECT 1 FROM feature_runs WHERE run_id=? AND state='returning'`).get(runId)) {
      throw new Error('Return command Run is not owned by the active returning Feature version.');
    }
    const targetKind = String(request.targetKind || ''); const targetKey = String(request.targetKey || '');
    const intent = this.core.prepare(`SELECT intent_id, state, intended_revision_json FROM managed_content_intents WHERE run_id=? AND plan_digest=? AND target_kind=? AND target_key=?`)
      .get(runId, planDigest, targetKind, targetKey) as { intent_id: string; state: string; intended_revision_json: string } | undefined;
    const confirmation = this.core.prepare(`SELECT decision, credential_digest, authority_instance_id, tenant_or_org_id, pack_id, engagement_id FROM feature_confirmations WHERE run_id=? AND plan_digest=? ORDER BY created_at DESC LIMIT 1`)
      .get(runId, planDigest) as Record<string, any> | undefined;
    const binding = returnAuthorityBinding(request.binding, 'Return command authority binding');
    const workspaceIds = Array.isArray(request.workspaceIds) ? request.workspaceIds.map(String) : [];
    const authorityDigest = crypto.createHash('sha256').update(canonical({
      connectorId: binding.connectorId, sessionGeneration: Number(binding.sessionGeneration), engagementId: binding.engagementId,
      authorityInstanceId: binding.authorityInstanceId, tenantOrOrgId: binding.tenantOrOrgId, packId: binding.packId, workspaceIds
    })).digest('hex');
    const intended = intent ? JSON.parse(intent.intended_revision_json) as Record<string, unknown> : {};
    const evidenceOperationIds = Array.isArray(request.evidenceOperationIds) ? request.evidenceOperationIds.map(String) : [];
    const evidenceTargetIdentityKey = String(request.evidenceTargetIdentityKey || '');
    const commandRequest = object(request.request, 'Exact Return command request');
    const projectedObjectId = (targetKeyToResolve: unknown): string => {
      const projected = this.core.prepare(`SELECT o.object_id FROM managed_content_intents i JOIN feature_commands c ON c.intent_id=i.intent_id AND c.run_id=i.run_id AND c.state='readback_verified' JOIN managed_object_revisions o ON o.command_id=c.command_id AND o.run_id=c.run_id WHERE i.run_id=? AND i.target_kind='object' AND i.target_key=? AND i.state='verified' ORDER BY o.verified_at DESC LIMIT 1`).get(runId,String(targetKeyToResolve||'')) as {object_id:string}|undefined;
      return String(projected?.object_id || '');
    };
    let intendedTargetIdentityKey = String(intended.operationTargetIdentityKey || '');
    if (intended.operationTargetIdentityMode === 'resolved_relation') {
      const relationQuery = commandRequest.query && typeof commandRequest.query === 'object' ? commandRequest.query as Record<string, unknown> : commandRequest;
      const sourceObjectId = String(relationQuery.itElementId || relationQuery.ItElementId || '');
      const targetIds = Array.isArray(relationQuery.AssociatingEntityIds) ? relationQuery.AssociatingEntityIds.map(String) : [String(relationQuery.associatingEntityId || '')];
      const sourceWorkspace = String(relationQuery.sourceWorkspaceId || relationQuery.workspaceId || intended.workspace || '');
      const targetWorkspace = String(relationQuery.targetWorkspaceId || intended.targetWorkspace || '');
      const relationType = String(relationQuery.associationType || intended.relationType || '');
      const expectedSource = projectedObjectId(intended.sourceObjectTargetKey);
      const targetSourceType = String(intended.targetSourceType || '');
      const expectedTarget = targetSourceType === 'in_batch'
        ? projectedObjectId(intended.targetObjectTargetKey)
        : targetSourceType === 'external'
          ? String(intended.resolvedTargetObjectId || '')
          : '';
      if (!expectedSource || !expectedTarget || sourceObjectId !== expectedSource || targetIds.length !== 1 || targetIds[0] !== expectedTarget
        || !targetWorkspace || sourceWorkspace !== String(intended.workspace || '')
        || targetWorkspace !== String(intended.targetWorkspace || '') || relationType !== String(intended.relationType || '')) {
        throw new Error('Return relation command IDs differ from the receipt-backed frozen source and target object intents.');
      }
      intendedTargetIdentityKey = `relation|${sourceWorkspace}|${targetWorkspace}|${expectedSource}|${expectedTarget}|${relationType}`;
    }
    const desired = commandRequest.query && typeof commandRequest.query === 'object'
      ? commandRequest.query as Record<string, any> : commandRequest;
    let commandIntentValid = true;
    if (String(intended.kind) === 'object' && String(intended.objectType) !== 'GRA') {
      if (['reuse','resume'].includes(String(intended.disposition))) commandIntentValid = String(commandRequest.objectId || '') === String(intended.resolvedObjectId || '')
        && String(desired.externalId || '') === String(intended.externalId || '') && String(desired.objectType || '') === String(intended.objectType || '')
        && (String(intended.objectType)!=='Application'||String(desired.description||'')===JSON.stringify({editorData:`<p>${String(intended.description||'').replace(/[&<>"]/gu,(char)=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[char] || char))}</p>`,suggestionsData:[],trackChangesEnableFlagInEditor:false,plainText:String(intended.description||'')}));
      else commandIntentValid = String(commandRequest.number || '') === String(intended.externalId || '')
        && String(commandRequest.name || '') === String(intended.externalId || '')
        && String(commandRequest.workspaceId || '') === String(intended.workspace || '')
        && String(commandRequest.itElementType || '') === String(intended.objectType || '')
        && (String(intended.objectType)!=='Application'||String(commandRequest.description||'')===JSON.stringify({editorData:`<p>${String(intended.description||'').replace(/[&<>"]/gu,(char)=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[char] || char))}</p>`,suggestionsData:[],trackChangesEnableFlagInEditor:false,plainText:String(intended.description||'')}));
    } else if (String(intended.kind) === 'object' && String(intended.objectType) === 'GRA') {
      const contentIdentity = intended.contentIdentity as Record<string, unknown> | undefined;
      const contentName = String(intended.contentName || '').normalize('NFKC').trim();
      const disposition = String(intended.disposition || '');
      if (!['create', 'reuse'].includes(disposition)
        || !contentName || !String(contentIdentity?.inkContentId || '') || !String(contentIdentity?.typeId || '')) commandIntentValid = false;
      else if (disposition === 'reuse') commandIntentValid = String(commandRequest.riskAssessmentId || '') === String(intended.resolvedObjectId || '')
        && String(desired.entityId || '') === projectedObjectId(intended.entityObjectTargetKey)
        && String(desired.name || '') === String(intended.externalId || '')
        && String(desired.inkContentId || '') === String(contentIdentity!.inkContentId || '')
        && String(desired.typeId || '') === String(contentIdentity!.typeId || '');
      else {
        commandIntentValid = String(commandRequest.entityId || '') === projectedObjectId(intended.entityObjectTargetKey)
          && String(commandRequest.name || '') === String(intended.externalId || '')
          && String(commandRequest.facetId || '') === String(intended.workspace || '')
          && String(commandRequest.inkContentId || '') === String(contentIdentity?.inkContentId || '')
          && String(commandRequest.typeId || '') === String(contentIdentity?.typeId || '');
      }
    } else if (String(intended.key || '').startsWith('object-settings|')) {
      const parentId = projectedObjectId(intended.objectTargetKey);
      const ownedProof=intended.ownedCreateProof as Record<string,unknown>|undefined;
      const currentOwnedProof=String(intended.mode||'')==='recover_owned_create_bootstrap'
        ?this.proveOwnedCreatedObject({objectId:parentId,workspaceId:intended.workspace,externalId:intended.externalId,expectedObjectType:'Application',connectorBinding:binding},context)
        :{proven:true};
      commandIntentValid = String(desired.objectId || '') === parentId
        && String(desired.typeId || '') === String(intended.typeId || '')
        && desired.isRelevant === intended.isRelevant && desired.isDataAvailable === intended.isDataAvailable
        && ['create_bootstrap','existing_with_token','recover_owned_create_bootstrap'].includes(String(intended.mode||''))
        && String(desired.mode||'')===String(intended.mode||'')
        && (String(intended.mode||'')!=='recover_owned_create_bootstrap'||currentOwnedProof.proven===true
          &&String(currentOwnedProof.runId||'')===String(ownedProof?.runId||'')&&String(currentOwnedProof.commandId||'')===String(ownedProof?.commandId||'')
          &&String(currentOwnedProof.objectId||'')===parentId);
    } else if (String(intended.key || '').startsWith('gra-status|') || String(intended.key || '').startsWith('gra-rait|') || String(intended.key || '').startsWith('inheritance-source|')) {
      const expectedPatchKind = String(intended.fieldId) === 'status' ? 'status' : 'rait';
      commandIntentValid = String(desired.riskAssessmentId || '') === projectedObjectId(intended.graTargetKey)
        && String(desired.patchKind || '') === expectedPatchKind && String(desired.value || '') === String(intended.value || '');
    } else if (String(intended.key || '').startsWith('risk-classification|')) {
      const resolvedRisk = intended.resolvedRisk as Record<string, unknown> | undefined;
      const target = commandRequest.target && typeof commandRequest.target === 'object' && !Array.isArray(commandRequest.target)
        ? commandRequest.target as Record<string, unknown>
        : undefined;
      const queryMode = commandRequest.query && typeof commandRequest.query === 'object' && !Array.isArray(commandRequest.query);
      const exactKeys = (value: Record<string, unknown>, expected: string[]): boolean => {
        const actual = Object.keys(value).sort(); const required = [...expected].sort();
        return actual.length === required.length && actual.every((key, index) => key === required[index]);
      };
      const immutableShape = String(intended.kind || '') === 'field'
        && String(intended.objectType || '') === 'GRA'
        && String(intended.fieldId || '') === 'classificationType'
        && Boolean(String(intended.rowKey || '')) && Boolean(String(intended.riskNumber || ''))
        && String(intended.key || '') === `risk-classification|${String(intended.rowKey)}|${String(intended.riskNumber)}`
        && ['Higher','Lower','ClassificationNA'].includes(String(intended.value || ''))
        && Boolean(String(intended.riskName || ''));
      const commonPayload = immutableShape
        && Boolean(projectedObjectId(intended.graTargetKey))
        && String(desired.riskAssessmentId || '') === projectedObjectId(intended.graTargetKey)
        && String(desired.riskName || '') === String(intended.riskName || '')
        && String(desired.classification || '') === String(intended.value || '')
        && Boolean(String(desired.riskId || ''))
        && (!resolvedRisk || String(desired.riskId || '') === String(resolvedRisk.riskId || ''));
      commandIntentValid = queryMode
        ? Boolean(target)
          && exactKeys(commandRequest, ['target','query'])
          && exactKeys(desired, ['riskAssessmentId','riskName','riskId','classification'])
          && exactKeys(target!, ['targetIdentityKey','workspaceId'])
          && String(target!.targetIdentityKey || '') === intendedTargetIdentityKey
          && String(target!.workspaceId || '') === String(intended.workspace || '')
          && commonPayload
        : exactKeys(commandRequest, ['engagementId','workspaceId','riskAssessmentId','riskName','riskId','classification'])
          && String(commandRequest.engagementId || '') === String(binding.engagementId || '')
          && String(commandRequest.workspaceId || '') === String(intended.workspace || '')
          && commonPayload;
    } else if (String(intended.key || '').startsWith('risk-factor|')) {
      const factor=intended.resolvedFactor as Record<string,unknown>|undefined;
      commandIntentValid = String(desired.riskAssessmentId || '') === projectedObjectId(intended.graTargetKey)
        && String(desired.itemId || '') === String(intended.fieldId || '') && String(desired.selectionMode || '') === String(intended.value || '')
        &&(!factor||(!!commandRequest.query||(String(desired.factorId||'')===String(factor.factorId||'')&&Number(desired.selectedValue)===Number(factor.selectedValue)
        &&String(desired.spectrumDigest||'')===String(factor.spectrumDigest||''))));
    } else if (String(intended.kind) === 'documentation') {
      commandIntentValid = String(desired.riskAssessmentId || '') === projectedObjectId(intended.graTargetKey)
        && String(desired.plainText || commandRequest.plainText || '') === String(intended.plainText || '');
    } else if (String(intended.kind) === 'evaluation') {
      commandIntentValid = String(desired.riskAssessmentId || '') === projectedObjectId(intended.graTargetKey);
    } else if (String(intended.kind) === 'risk_control') {
      const catalog=intended.resolvedCatalog as Record<string,unknown>|undefined;
      const scope=Array.isArray(commandRequest.controlRiskScopes)?commandRequest.controlRiskScopes[0] as Record<string,any>:undefined;
      commandIntentValid=!catalog
        ?(!commandRequest.query&&String(commandRequest.riskAssessmentId||'')===projectedObjectId(intended.graTargetKey)
          &&String(commandRequest.riskName||'')===String(intended.riskName||'')&&String(commandRequest.controlName||'')===String(intended.controlName||'')
          &&String(commandRequest.riskClassification||'')===String(intended.classification||''))
        :(commandRequest.query
        ?String(desired.riskId||'')===String(catalog.riskId||'')&&String(desired.riskRiskScopeId||'')===String(catalog.riskRiskScopeId||'')
          &&String(desired.controlId||'')===String(catalog.controlId||'')&&String(desired.assertion||'')===String(catalog.assertion||'')
        :String(commandRequest.riskAssessmentId||'')===projectedObjectId(intended.graTargetKey)
          &&String(commandRequest.riskRiskScopeId||'')===String(catalog.riskRiskScopeId||'')
          &&String(commandRequest.riskName||'')===String(intended.riskName||'')&&String(commandRequest.controlName||'')===String(intended.controlName||'')
          &&String(commandRequest.riskClassification||'')===String(intended.classification||'')&&String(commandRequest.riskId||'')===String(catalog.riskId||'')
          &&String(commandRequest.updatedOn||'')===String(catalog.updatedOn||'')&&String(scope?.riskScopeId||'')===String(catalog.riskScopeId||'')
          &&String(scope?.controlId||'')===String(catalog.controlId||'')&&String(scope?.assertionType||'')===String(catalog.assertionType||'')
          &&String(scope?.assertions?.[0]?.assertion||'')===String(catalog.assertion||''));
    }
    const priorCommandCount = intent ? Number((this.core.prepare(`SELECT COUNT(*) AS count FROM feature_commands WHERE intent_id=? AND run_id=?`)
      .get(intent.intent_id, runId) as { count: number }).count) : 0;
    const priorClosed = intent ? this.core.prepare(`
      SELECT command_id,state,submitted_at,connector_request_id
      FROM feature_commands WHERE intent_id=? AND run_id=?
      ORDER BY created_at DESC,command_id DESC LIMIT 1
    `).get(intent.intent_id, runId) as { command_id:string; state:string; submitted_at:string; connector_request_id:string }|undefined : undefined;
    const priorEffectResolutionDelivered = Boolean(priorClosed && (
      (!priorClosed.submitted_at && !priorClosed.connector_request_id)
      || this.core.prepare(`
        SELECT 1 FROM connector_delivery_ack_outbox
        WHERE transaction_kind='effect_resolved' AND state='delivered'
          AND json_extract(payload_json,'$.resolution')='closed_not_applied'
          AND json_extract(payload_json,'$.reconciles.requestId')=?
        LIMIT 1
      `).get(priorClosed.connector_request_id)
    ));
    const retryClosedNotApplied = intent?.state === 'verified'
      && priorClosed?.state === 'closed_not_applied' && priorEffectResolutionDelivered;
    const idempotencyIdentity: Record<string,unknown> = { runId, planDigest, targetKind, targetKey, operationId: request.operationId };
    if (retryClosedNotApplied) idempotencyIdentity.retryAttempt = priorCommandCount + 1;
    const idempotencyKey = crypto.createHash('sha256').update(canonical(idempotencyIdentity)).digest('hex');
    const requestDigest = crypto.createHash('sha256').update(canonical(request.request || {})).digest('hex');
    if (!intent || (!['frozen','commanded'].includes(intent.state) && !retryClosedNotApplied) || confirmation?.decision !== 'approved' || confirmation.credential_digest !== authorityDigest
      || confirmation.authority_instance_id !== binding.authorityInstanceId || confirmation.tenant_or_org_id !== binding.tenantOrOrgId
      || confirmation.pack_id !== binding.packId || confirmation.engagement_id !== binding.engagementId
      || String(request.operationId || '') !== String(intended.mutationOperationId || '')
      || !commandIntentValid
      || canonical(evidenceOperationIds) !== canonical(intended.evidenceOperationIds || [])
      || evidenceTargetIdentityKey !== intendedTargetIdentityKey
      || evidenceOperationIds.length < 1 || evidenceOperationIds.some((value)=>!value) || !evidenceTargetIdentityKey) {
      throw new Error(`Return command is not bound to the approved immutable intent: target=${targetKey}, operation=${String(request.operationId||'')}, expectedOperation=${String(intended.mutationOperationId||'')}, commandIntentValid=${commandIntentValid}.`);
    }
    if (intent.state === 'commanded') {
      const prepared = this.core.prepare(`
        SELECT command_id,idempotency_key,request_digest FROM feature_commands
        WHERE run_id=? AND intent_id=? AND operation_id=? AND plan_digest=? AND request_digest=?
          AND evidence_operation_ids_json=? AND evidence_target_identity_key=?
          AND state='prepared' AND submitted_at='' AND commit_point_at='' AND completed_at='' AND last_error=''
          AND connector_request_id=''
          AND NOT EXISTS(SELECT 1 FROM connector_delivery_requests delivery WHERE delivery.command_id=feature_commands.command_id AND delivery.purpose='mutation')
        ORDER BY created_at DESC,command_id DESC LIMIT 1
      `).get(runId,intent.intent_id,String(request.operationId||''),planDigest,requestDigest,
        canonical(evidenceOperationIds),evidenceTargetIdentityKey) as {command_id:string;idempotency_key:string;request_digest:string}|undefined;
      if (prepared) {
        if (String(intended.kind)==='object' && String(intended.disposition)==='create'
          && !this.core.prepare(`SELECT 1 FROM feature_mutation_reservations WHERE owner_run_id=? AND owner_intent_id=? AND owner_command_id=? AND lifecycle='active'`).get(runId,intent.intent_id,prepared.command_id)) {
          throw new Error('The prepared create command no longer owns its exact active mutation reservation.');
        }
        return { commandId: prepared.command_id, intentId: intent.intent_id, idempotencyKey: prepared.idempotency_key, requestDigest: prepared.request_digest };
      }

      // A preflight/readback may legitimately refresh dynamic mutation fields after the
      // command row was prepared.  If no mutation request was ever dispatched, retain
      // the old command as a closed audit record and atomically replace it with a command
      // bound to the current readback.  Never take this path once a mutation delivery
      // request, submission marker, or commit point exists.
      const preEffectPrepared = this.core.prepare(`
        SELECT command_id FROM feature_commands
        WHERE run_id=? AND intent_id=? AND operation_id=? AND plan_digest=?
          AND evidence_operation_ids_json=? AND evidence_target_identity_key=?
          AND state='prepared' AND submitted_at='' AND commit_point_at='' AND completed_at=''
          AND connector_request_id=''
          AND NOT EXISTS(SELECT 1 FROM connector_delivery_requests delivery WHERE delivery.command_id=feature_commands.command_id AND delivery.purpose='mutation')
        ORDER BY created_at DESC,command_id DESC LIMIT 1
      `).get(runId,intent.intent_id,String(request.operationId||''),planDigest,
        canonical(evidenceOperationIds),evidenceTargetIdentityKey) as {command_id:string}|undefined;
      if (!preEffectPrepared) throw new Error('The commanded Return intent has no exact unsubmitted prepared command to resume safely.');

      const replacementCommandId = randomUUID();
      const replacementCreatedAt = now();
      const replacementIdempotencyKey = crypto.createHash('sha256').update(canonical({
        ...idempotencyIdentity,
        retryAttempt: priorCommandCount + 1
      })).digest('hex');
      this.core.exec('BEGIN IMMEDIATE;');
      try {
        const closed = this.core.prepare(`
          UPDATE feature_commands
          SET state='closed_not_applied', completed_at=?, last_error=?
          WHERE command_id=? AND run_id=? AND intent_id=? AND state='prepared'
            AND submitted_at='' AND commit_point_at='' AND completed_at='' AND connector_request_id=''
            AND NOT EXISTS(SELECT 1 FROM connector_delivery_requests delivery WHERE delivery.command_id=feature_commands.command_id AND delivery.purpose='mutation')
        `).run(replacementCreatedAt,
          'Superseded before mutation submission by a fresh readback-bound command.',
          preEffectPrepared.command_id,runId,intent.intent_id);
        if (closed.changes !== 1) throw new Error('The pre-effect prepared command changed before it could be safely superseded.');
        if (String(intended.kind)==='object' && String(intended.disposition)==='create') {
          const reservation=this.core.prepare(`
          UPDATE feature_mutation_reservations SET owner_command_id=?,absence_receipt_id='',updated_at=?
          WHERE owner_run_id=? AND owner_intent_id=? AND owner_command_id=? AND lifecycle='active'
          `).run(replacementCommandId,replacementCreatedAt,runId,intent.intent_id,preEffectPrepared.command_id);
          if(reservation.changes!==1)throw new Error('The prepared create command no longer owns its exact active mutation reservation.');
        }
        this.core.prepare(`INSERT INTO feature_commands(command_id, run_id, intent_id, operation_id, idempotency_key, plan_digest, request_digest, evidence_operation_ids_json, evidence_target_identity_key, evidence_request_digest, state, commit_point_at, submitted_at, completed_at, last_error, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, '', 'prepared', '', '', '', '', ?)`)
          .run(replacementCommandId,runId,intent.intent_id,String(request.operationId||''),replacementIdempotencyKey,
            planDigest,requestDigest,canonical(evidenceOperationIds),evidenceTargetIdentityKey,replacementCreatedAt);
        this.core.exec('COMMIT;');
      } catch (error) { this.core.exec('ROLLBACK;'); throw error; }
      return { commandId: replacementCommandId, intentId: intent.intent_id, idempotencyKey: replacementIdempotencyKey, requestDigest };
    }
    const commandId = randomUUID();
    const createdAt = now();
    this.core.exec('BEGIN IMMEDIATE;');
    try {
      const expectedIntentState = retryClosedNotApplied ? 'verified' : 'frozen';
      const claimedIntent=this.core.prepare(`UPDATE managed_content_intents SET state='commanded', updated_at=? WHERE intent_id=? AND state=?`).run(createdAt,intent.intent_id,expectedIntentState);
      if(claimedIntent.changes!==1) throw new Error('Return intent was already claimed by another command.');
      if(String(intended.kind)==='object'&&String(intended.disposition)==='create'){
        const leaseExpiresAt=new Date(Date.parse(createdAt)+15*60_000).toISOString();
        const reservation=this.core.prepare(`INSERT INTO feature_mutation_reservations(authority_instance_id,tenant_or_org_id,pack_id,engagement_id,workspace_id,logical_identity_key,owner_run_id,owner_intent_id,owner_command_id,lifecycle,acquired_at,lease_expires_at,updated_at,absence_receipt_id) VALUES(?,?,?,?,?,?,?,?,?,'active',?,?,?,'') ON CONFLICT(authority_instance_id,tenant_or_org_id,pack_id,engagement_id,workspace_id,logical_identity_key) DO UPDATE SET owner_run_id=excluded.owner_run_id,owner_intent_id=excluded.owner_intent_id,owner_command_id=excluded.owner_command_id,lifecycle='active',acquired_at=excluded.acquired_at,lease_expires_at=excluded.lease_expires_at,updated_at=excluded.updated_at,absence_receipt_id='' WHERE feature_mutation_reservations.lifecycle IN ('completed','released') OR (feature_mutation_reservations.lifecycle='active' AND feature_mutation_reservations.lease_expires_at<excluded.acquired_at AND EXISTS(SELECT 1 FROM feature_commands prior WHERE prior.command_id=feature_mutation_reservations.owner_command_id AND prior.state='prepared' AND prior.submitted_at='' AND prior.commit_point_at='' AND prior.connector_request_id='' AND NOT EXISTS(SELECT 1 FROM connector_delivery_requests delivery WHERE delivery.command_id=prior.command_id AND delivery.purpose='mutation')))`).run(
          String(binding.authorityInstanceId||''),String(binding.tenantOrOrgId||''),String(binding.packId||''),String(binding.engagementId||''),String(intended.workspace||''),intendedTargetIdentityKey,runId,intent.intent_id,commandId,createdAt,leaseExpiresAt,createdAt);
        if(reservation.changes!==1) throw new Error('Another Run owns an active create mutation for this exact authority and logical identity.');
      }
      this.core.prepare(`INSERT INTO feature_commands(command_id, run_id, intent_id, operation_id, idempotency_key, plan_digest, request_digest, evidence_operation_ids_json, evidence_target_identity_key, evidence_request_digest, state, commit_point_at, submitted_at, completed_at, last_error, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, '', 'prepared', '', '', '', '', ?)`)
        .run(commandId, runId, intent.intent_id, String(request.operationId || ''), idempotencyKey, planDigest, requestDigest, canonical(evidenceOperationIds), evidenceTargetIdentityKey, createdAt);
      this.core.exec('COMMIT;');
    } catch (error) { this.core.exec('ROLLBACK;'); throw error; }
    return { commandId, intentId: intent.intent_id, idempotencyKey, requestDigest };
  }

  private bindMutationReservationEvidence(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    if (!context.allowMutation) throw new Error('Mutation reservation evidence requires an authorized mutation action.');
    const request=object(input,'Mutation reservation evidence binding');
    const runId=String(request.runId||''),commandId=String(request.commandId||''),operationId=String(request.operationId||'');
    const receiptId=String(request.receiptId||'');
    const row=this.core.prepare(`
      SELECT c.state,c.intent_id,c.operation_id,c.evidence_operation_ids_json,c.evidence_target_identity_key,
        c.submitted_at,c.commit_point_at,c.connector_request_id,i.intended_revision_json,e.payload_json,e.receipt_id,
        receipt.operation_id AS receipt_operation_id,receipt.target_identity_key AS receipt_target_identity_key,
        receipt.response_json AS receipt_response_json,receipt.request_digest AS receipt_request_digest,
        receipt.authority_instance_id AS receipt_authority_instance_id,
        receipt.tenant_or_org_id AS receipt_tenant_or_org_id,receipt.pack_id AS receipt_pack_id,
        receipt.engagement_id AS receipt_engagement_id,
        f.authority_instance_id,f.tenant_or_org_id,f.pack_id,f.engagement_id
      FROM feature_commands c
      JOIN managed_content_intents i ON i.intent_id=c.intent_id AND i.run_id=c.run_id AND i.plan_digest=c.plan_digest
      JOIN feature_runs r ON r.run_id=c.run_id
      JOIN feature_confirmations f ON f.run_id=c.run_id AND f.plan_digest=c.plan_digest AND f.decision='approved'
      JOIN feature_command_evidence e ON e.command_id=c.command_id AND e.run_id=c.run_id
        AND e.evidence_type='preflight' AND e.verified=1
      JOIN feature_operation_receipts receipt ON receipt.receipt_id=e.receipt_id
        AND receipt.command_id=c.command_id AND receipt.run_id=c.run_id
      WHERE c.command_id=? AND c.run_id=? AND r.feature_id=? AND r.feature_version=? AND r.state='returning'
        AND e.receipt_id=?
      ORDER BY f.created_at DESC LIMIT 1
    `).get(commandId,runId,context.featureId,context.featureVersion,receiptId) as Record<string,any>|undefined;
    const intended=row?JSON.parse(String(row.intended_revision_json)) as Record<string,unknown>:{};
    const observed=row?JSON.parse(String(row.payload_json)) as Record<string,unknown>:{};
    const receiptObserved=row?JSON.parse(String(row.receipt_response_json)) as Record<string,unknown>:{};
    const evidenceRequest=object(request.evidenceRequest,'Create absence evidence request');
    const binding=returnAuthorityBinding(evidenceRequest.connectorBinding,'Create absence evidence authority');
    const target=object(evidenceRequest.target,'Create absence preflight target');
    const query=object(evidenceRequest.query,'Create absence preflight query');
    if(!row||row.state!=='prepared'||row.submitted_at||row.commit_point_at||row.connector_request_id
      ||String(intended.kind||'')!=='object'||String(intended.disposition||'')!=='create'
      ||!(JSON.parse(String(row.evidence_operation_ids_json)) as string[]).includes(operationId)
      ||!receiptId||String(row.receipt_id||'')!==receiptId||receiptId!==String(observed.__operationReceiptId||'')
      ||String(row.receipt_operation_id||'')!==operationId
      ||String(row.receipt_target_identity_key||'')!==String(row.evidence_target_identity_key)
      ||canonical(receiptObserved)!==canonical(Object.fromEntries(Object.entries(observed).filter(([key])=>key!=='__operationReceiptId')))
      ||canonicalDigest(evidenceRequest)!==String(row.receipt_request_digest||'')
      ||String(row.receipt_authority_instance_id||'')!==String(row.authority_instance_id||'')
      ||String(row.receipt_tenant_or_org_id||'')!==String(row.tenant_or_org_id||'')
      ||String(row.receipt_pack_id||'')!==String(row.pack_id||'')||String(row.receipt_engagement_id||'')!==String(row.engagement_id||'')
      ||String(target.targetIdentityKey||'')!==String(row.evidence_target_identity_key)
      ||String(target.targetIdentityKey||'')!==String(intended.operationTargetIdentityKey||'')
      ||String(target.workspaceId||'')!==String(intended.workspace||'')||String(query.workspaceId||'')!==String(intended.workspace||'')
      ||String(binding.authorityInstanceId||'')!==String(row.authority_instance_id||'')
      ||String(binding.tenantOrOrgId||'')!==String(row.tenant_or_org_id||'')||String(binding.packId||'')!==String(row.pack_id||'')
      ||String(binding.engagementId||'')!==String(row.engagement_id||'')
      ||(String(intended.objectType||'')==='GRA'?String(query.name||'')!==String(intended.externalId||''):
        String(query.externalId||'')!==String(intended.externalId||'')||String(query.objectType||'')!==String(intended.objectType||''))){
      throw new Error('Mutation reservation evidence requires an exact trusted preflight receipt bound to the frozen command, target, authority, and request.');
    }
    const claimedAt=now();
    this.core.exec('BEGIN IMMEDIATE;');
    try{
      // A resumed pre-effect command may perform a newer authoritative absence
      // read. Rebinding the same owned, still-prepared reservation to that newer
      // receipt is safe; no mutation request or delivery exists yet.
      const reservation=this.core.prepare(`UPDATE feature_mutation_reservations SET absence_receipt_id=?,updated_at=? WHERE authority_instance_id=? AND tenant_or_org_id=? AND pack_id=? AND engagement_id=? AND workspace_id=? AND logical_identity_key=? AND owner_run_id=? AND owner_intent_id=? AND owner_command_id=? AND lifecycle='active' AND EXISTS(SELECT 1 FROM feature_commands c WHERE c.command_id=? AND c.run_id=? AND c.state='prepared' AND c.submitted_at='' AND c.commit_point_at='' AND c.connector_request_id='' AND NOT EXISTS(SELECT 1 FROM connector_delivery_requests delivery WHERE delivery.command_id=c.command_id AND delivery.purpose='mutation'))`).run(
        String(row.receipt_id),claimedAt,String(row.authority_instance_id),String(row.tenant_or_org_id),String(row.pack_id),String(row.engagement_id),String(intended.workspace||''),String(row.evidence_target_identity_key),runId,String(row.intent_id),commandId,commandId,runId);
      if(reservation.changes!==1)throw new Error('Create mutation reservation changed before its authoritative absence receipt could be bound.');
      // The command's evidence_request_digest is a one-at-a-time admission
      // slot. The preflight receipt is now durably owned by the reservation,
      // so release the slot for the later post-effect read-back/reconcile.
      const releasedEvidenceSlot=this.core.prepare(`UPDATE feature_commands SET evidence_request_digest='' WHERE command_id=? AND run_id=? AND state='prepared' AND evidence_request_digest=? AND submitted_at='' AND commit_point_at='' AND connector_request_id=''`).run(
        commandId,runId,String(row.receipt_request_digest));
      if(releasedEvidenceSlot.changes!==1)throw new Error('Create absence evidence slot changed before the reservation could be finalized.');
      this.core.exec('COMMIT;');
      return{claimed:true,logicalIdentityKey:String(row.evidence_target_identity_key),absenceReceiptId:String(row.receipt_id)};
    }catch(error){this.core.exec('ROLLBACK;');throw error;}
  }

  private prepareDeletionCommand(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    if (!context.allowMutation) throw new Error('Deletion commands require an authorized mutation action.');
    const request = object(input, 'Deletion command');
    const runId = String(request.runId || '');
    const planDigest = String(request.planDigest || '');
    if (!this.core.prepare(`SELECT 1 FROM feature_runs WHERE run_id=? AND feature_id=? AND state='returning'`)
      .get(runId, context.featureId) || !this.currentActivationOwnsRun(runId, context)) {
      throw new Error('Mutation command Run is not active or is outside the finalized Feature handoff lineage.');
    }
    const targetKind = String(request.targetKind || '');
    const targetKey = String(request.targetKey || '');
    const intent = this.core.prepare(`SELECT intent_id,state,intended_revision_json FROM managed_content_intents WHERE run_id=? AND plan_digest=? AND target_kind=? AND target_key=?`)
      .get(runId, planDigest, targetKind, targetKey) as { intent_id:string; state:string; intended_revision_json:string }|undefined;
    const confirmation = this.core.prepare(`SELECT decision,credential_digest,authority_instance_id,tenant_or_org_id,pack_id,engagement_id FROM feature_confirmations WHERE run_id=? AND plan_digest=? ORDER BY created_at DESC LIMIT 1`)
      .get(runId, planDigest) as Record<string,any>|undefined;
    const binding = returnAuthorityBinding(request.binding, 'Deletion command authority binding');
    const workspaceIds = Array.isArray(request.workspaceIds) ? request.workspaceIds.map(String) : [];
    const intended = intent ? JSON.parse(intent.intended_revision_json) as Record<string,unknown> : {};
    const mutationPayload = object(request.request, 'Exact deletion mutation payload');
    const evidenceOperationIds = Array.isArray(request.evidenceOperationIds) ? request.evidenceOperationIds.map(String) : [];
    const targetIdentityKey = String(request.evidenceTargetIdentityKey || '');
    const authorityDigest = crypto.createHash('sha256').update(canonical({
      connectorId: binding.connectorId, sessionGeneration: Number(binding.sessionGeneration), engagementId: binding.engagementId,
      authorityInstanceId: binding.authorityInstanceId, tenantOrOrgId: binding.tenantOrOrgId, packId: binding.packId, workspaceIds
    })).digest('hex');
    if (!intent || !['frozen', 'commanded'].includes(intent.state) || confirmation?.decision !== 'approved'
      || confirmation.credential_digest !== authorityDigest
      || confirmation.authority_instance_id !== binding.authorityInstanceId
      || confirmation.tenant_or_org_id !== binding.tenantOrOrgId
      || confirmation.pack_id !== binding.packId || confirmation.engagement_id !== binding.engagementId
      || String(intended.workspace || '') !== String(request.workspaceId || '')
      || String(intended.mutationOperationId || '') !== String(request.operationId || '')
      || String(intended.operationTargetIdentityKey || '') !== targetIdentityKey
      || canonical(intended.mutationPayload) !== canonical(mutationPayload)
      || canonical(intended.evidenceOperationIds || []) !== canonical(evidenceOperationIds)
      || evidenceOperationIds.length < 1 || evidenceOperationIds.some((value) => !value) || !targetIdentityKey) {
      throw new Error('Deletion command differs from the approved immutable intent.');
    }
    const durable = this.core.prepare(`SELECT enabled,engagement_id,workspace_ids_json,global_enabled,global_workspace_ids_json FROM workspace_safety WHERE singleton=1`)
      .get() as {enabled:number;engagement_id:string;workspace_ids_json:string;global_enabled:number;global_workspace_ids_json:string};
    const allowedWorkspaceIds = [...new Set([
      ...(JSON.parse(durable.workspace_ids_json) as string[]),
      ...(durable.global_enabled === 1 ? JSON.parse(durable.global_workspace_ids_json) as string[] : [])
    ])];
    if (durable.enabled !== 1 || durable.engagement_id !== binding.engagementId
      || !allowedWorkspaceIds.includes(String(request.workspaceId || ''))) throw new Error('Deletion target is outside the current durable safety lock.');
    const priorPartialCommands = Number((this.core.prepare(`
      SELECT COUNT(*) AS count FROM feature_commands prior
      WHERE prior.intent_id=? AND prior.state='readback_verified'
        AND EXISTS(
          SELECT 1 FROM feature_command_evidence evidence
          WHERE evidence.command_id=prior.command_id AND evidence.run_id=prior.run_id
            AND evidence.evidence_type='reconcile' AND evidence.verified=1
            AND json_extract(evidence.payload_json,'$.outcome')='partial_applied'
        )
    `).get(intent.intent_id) as {count:number}).count || 0);
    const continuationIndex = priorPartialCommands + 1;
    const commandId = randomUUID();
    const idempotencyKey = crypto.createHash('sha256').update(canonical({
      runId,planDigest,targetKind,targetKey,operationId:request.operationId,continuationIndex
    })).digest('hex');
    const requestDigest = crypto.createHash('sha256').update(canonical(mutationPayload)).digest('hex');
    const exactPreparedCommand = (): {command_id:string;idempotency_key:string;request_digest:string}|undefined => this.core.prepare(`
      SELECT command_id,idempotency_key,request_digest FROM feature_commands
      WHERE run_id=? AND intent_id=? AND operation_id=? AND idempotency_key=? AND plan_digest=? AND request_digest=?
        AND evidence_operation_ids_json=? AND evidence_target_identity_key=? AND evidence_request_digest=''
        AND state='prepared' AND submitted_at='' AND commit_point_at='' AND completed_at='' AND last_error=''
        AND NOT EXISTS(
          SELECT 1 FROM feature_commands sibling
          WHERE sibling.intent_id=feature_commands.intent_id AND sibling.command_id<>feature_commands.command_id
            AND NOT (
              sibling.state='readback_verified'
              AND EXISTS(
                SELECT 1 FROM feature_command_evidence evidence
                WHERE evidence.command_id=sibling.command_id AND evidence.run_id=sibling.run_id
                  AND evidence.evidence_type='reconcile' AND evidence.verified=1
                  AND json_extract(evidence.payload_json,'$.outcome')='partial_applied'
              )
            )
        )
        AND NOT EXISTS(SELECT 1 FROM feature_operation_receipts receipt WHERE receipt.command_id=feature_commands.command_id)
        AND NOT EXISTS(SELECT 1 FROM feature_command_evidence prior WHERE prior.command_id=feature_commands.command_id AND (prior.evidence_type<>'preflight' OR prior.receipt_id<>''))
    `).get(
      runId,intent.intent_id,String(request.operationId||''),idempotencyKey,planDigest,requestDigest,
      canonical(evidenceOperationIds),targetIdentityKey
    ) as {command_id:string;idempotency_key:string;request_digest:string}|undefined;
    const recoveredResult = (prepared: {command_id:string;idempotency_key:string;request_digest:string}): Record<string,unknown> => ({
      commandId:prepared.command_id,intentId:intent.intent_id,
      idempotencyKey:prepared.idempotency_key,requestDigest:prepared.request_digest
    });
    if (intent.state === 'commanded') {
      const prepared = exactPreparedCommand();
      if (!prepared) throw new Error('The commanded deletion intent has no exact unsubmitted prepared command to resume safely.');
      return recoveredResult(prepared);
    }
    const createdAt = now();
    this.core.exec('BEGIN IMMEDIATE;');
    try {
      const claimed = this.core.prepare(`UPDATE managed_content_intents SET state='commanded',updated_at=? WHERE intent_id=? AND state='frozen'`).run(createdAt,intent.intent_id);
      if (claimed.changes !== 1) {
        const prepared = exactPreparedCommand();
        if (!prepared) throw new Error('Deletion intent was already claimed without one exact resumable command.');
        this.core.exec('COMMIT;');
        return recoveredResult(prepared);
      }
      this.core.prepare(`INSERT INTO feature_commands(command_id,run_id,intent_id,operation_id,idempotency_key,plan_digest,request_digest,evidence_operation_ids_json,evidence_target_identity_key,evidence_request_digest,state,commit_point_at,submitted_at,completed_at,last_error,created_at) VALUES(?,?,?,?,?,?,?,?,?,'','prepared','','','','',?)`)
        .run(commandId,runId,intent.intent_id,String(request.operationId||''),idempotencyKey,planDigest,requestDigest,canonical(evidenceOperationIds),targetIdentityKey,createdAt);
      this.core.exec('COMMIT;');
    } catch (error) { this.core.exec('ROLLBACK;'); throw error; }
    return {commandId,intentId:intent.intent_id,idempotencyKey,requestDigest};
  }

  private freezeReturnEvidenceSpec(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    // Local evidence-ledger persistence is valid for both an authorized Return
    // mutation and a signed read-only reconcile.  Remote mutation authority is
    // enforced separately by the Operation effect and Connector binding.
    const request = object(input, 'Return evidence specification');
    const commandId = String(request.commandId || ''); const runId = String(request.runId || '');
    const operationId = String(request.operationId || '');
    const evidenceRequest = object(request.request, 'Exact evidence read request');
    if (!this.currentActivationOwnsRun(runId, context)) {
      throw new Error('Evidence specification Run is not owned by the active Feature lineage.');
    }
    const row = this.core.prepare(`
      SELECT c.evidence_operation_ids_json,c.evidence_target_identity_key,c.evidence_request_digest,c.state,
        EXISTS(
          SELECT 1 FROM feature_command_evidence partial
          WHERE partial.command_id=c.command_id AND partial.run_id=c.run_id
            AND partial.evidence_type='reconcile' AND partial.verified=1
            AND json_extract(partial.payload_json,'$.outcome')='partial_applied'
        ) AS has_partial_evidence,
        i.intended_revision_json,f.credential_digest,f.connector_id,f.session_generation,f.safety_revision,
        f.authority_instance_id,f.tenant_or_org_id,f.pack_id,f.engagement_id,
        EXISTS(
          SELECT 1 FROM feature_command_evidence verified
          WHERE verified.command_id=c.command_id AND verified.run_id=c.run_id
            AND verified.verified=1 AND verified.evidence_type IN ('readback','reconcile')
        ) AS has_verified_evidence
      FROM feature_commands c
      JOIN feature_runs r ON r.run_id=c.run_id
      JOIN managed_content_intents i ON i.intent_id=c.intent_id AND i.run_id=c.run_id AND i.plan_digest=c.plan_digest
      JOIN feature_confirmations f ON f.run_id=c.run_id AND f.plan_digest=c.plan_digest AND f.decision='approved'
      WHERE c.command_id=? AND c.run_id=? AND r.feature_id=?
      ORDER BY f.created_at DESC LIMIT 1
    `).get(commandId, runId, context.featureId) as Record<string, any> | undefined;
    const binding = returnAuthorityBinding(evidenceRequest.connectorBinding, 'Evidence authority binding');
    const target = object(evidenceRequest.target, 'Evidence target identity');
    const safety = this.core.prepare(`SELECT workspace_ids_json FROM workspace_safety WHERE singleton=1`).get() as {workspace_ids_json:string};
    const workspaceIds = JSON.parse(safety.workspace_ids_json) as string[];
    const authorityDigest = crypto.createHash('sha256').update(canonical({
      connectorId:binding.connectorId,sessionGeneration:Number(binding.sessionGeneration),engagementId:binding.engagementId,
      authorityInstanceId:binding.authorityInstanceId,tenantOrOrgId:binding.tenantOrOrgId,packId:binding.packId,workspaceIds
    })).digest('hex');
    const intended = row ? JSON.parse(String(row.intended_revision_json)) as Record<string, unknown> : {};
    const digest = crypto.createHash('sha256').update(canonical(evidenceRequest)).digest('hex');
    const exactFrozenAuthority = row !== undefined && authorityDigest === String(row.credential_digest);
    const safeReadOnlySessionRebind = row !== undefined
      && String(row.state) === 'uncertain'
      && Number(row.has_verified_evidence) === 0
      && String(binding.connectorId) === String(row.connector_id)
      && String(binding.engagementId) === String(row.engagement_id)
      && String(binding.authorityInstanceId) === String(row.authority_instance_id)
      && String(binding.tenantOrOrgId) === String(row.tenant_or_org_id)
      && String(binding.packId) === String(row.pack_id)
      && workspaceIds.includes(String(target.workspaceId || ''));
    if (!row || (!['prepared','committed','uncertain'].includes(String(row.state))
        && !(String(row.state)==='readback_verified' && Number(row.has_partial_evidence)===1))
      || !(JSON.parse(String(row.evidence_operation_ids_json)) as string[]).includes(operationId)
      || String(target.targetIdentityKey || '') !== String(row.evidence_target_identity_key)
      || (intended.operationTargetIdentityMode !== 'resolved_relation' && String(target.targetIdentityKey || '') !== String(intended.operationTargetIdentityKey || ''))
      || String(target.workspaceId || '') !== String(intended.workspace || '')
      || !workspaceIds.includes(String(target.workspaceId || ''))
      || (!exactFrozenAuthority && !safeReadOnlySessionRebind)
      || String(binding.authorityInstanceId || '') !== String(row.authority_instance_id)
      || String(binding.tenantOrOrgId || '') !== String(row.tenant_or_org_id)
      || String(binding.packId || '') !== String(row.pack_id)
      || String(binding.engagementId || '') !== String(row.engagement_id)) {
      throw new Error('Exact evidence specification differs from the frozen target, authority, read Operation, or prior request digest.');
    }
    const priorDigest=String(row.evidence_request_digest||'');
    if(priorDigest&&priorDigest!==digest){
      const rebound=this.core.prepare(`UPDATE feature_commands SET evidence_request_digest=? WHERE command_id=? AND state='uncertain' AND evidence_request_digest=? AND NOT EXISTS(SELECT 1 FROM feature_command_evidence WHERE command_id=? AND verified=1 AND evidence_type IN ('readback','reconcile'))`)
        .run(digest,commandId,priorDigest,commandId);
      if(rebound.changes!==1) throw new Error('Exact evidence specification differs from the frozen target, authority, read Operation, or prior request digest.');
    }else this.core.prepare(`UPDATE feature_commands SET evidence_request_digest=? WHERE command_id=? AND evidence_request_digest=''`).run(digest, commandId);
    return { requestDigest: digest };
  }

  private recordReturnEvidence(input: unknown, context: FeatureWorkerPortContext): Record<string, unknown> {
    const request = object(input, 'Return command evidence');
    const commandId = String(request.commandId || ''); const runId = String(request.runId || '');
    if (!this.currentActivationOwnsRun(runId, context)
      || !this.core.prepare(`SELECT 1 FROM feature_runs WHERE run_id=? AND state IN ('returning','verifying','uncertain','reconciling')`).get(runId)) {
      throw new Error('Return evidence Run is not owned by an active Return state.');
    }
    const row = this.core.prepare(`SELECT c.state,c.intent_id,i.intended_revision_json FROM feature_commands c JOIN managed_content_intents i ON i.intent_id=c.intent_id AND i.run_id=c.run_id WHERE c.command_id=? AND c.run_id=?`).get(commandId, runId) as { state: string; intent_id: string; intended_revision_json:string } | undefined;
    if (!row) throw new Error('Return command evidence has no owned command.');
    const evidenceType = String(request.evidenceType || '');
    if (!['preflight', 'request', 'commit', 'readback', 'reconcile', 'projection'].includes(evidenceType)) throw new Error('Return evidence type is invalid.');
    const payload = request.payload ?? null; const evidenceId = randomUUID(); const occurredAt = now();
    const receiptId = String(request.receiptId || '');
    const receiptPayload = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? Object.fromEntries(Object.entries(payload as Record<string, unknown>).filter(([key]) => key !== '__operationReceiptId'))
      : payload;
    const evidenceDigest = crypto.createHash('sha256').update(canonical(receiptPayload)).digest('hex');
    const nextState = String(request.commandState || row.state);
    const intentResolution = String(request.intentResolution || 'complete');
    if (!['complete','partial_effect'].includes(intentResolution)) throw new Error('Return intent resolution is invalid.');
    const repeatedPartialResolution = row.state === 'readback_verified' && intentResolution === 'partial_effect';
    if (!['prepared','submitted','committed','verifying','readback_verified','closed_not_applied','failed','uncertain'].includes(nextState)) throw new Error('Return command state is invalid.');
    const transitions: Record<string, string[]> = {
      prepared: ['prepared','submitted','readback_verified','closed_not_applied','failed'],
      submitted: ['committed','uncertain','failed'], committed: ['verifying','readback_verified','failed','uncertain'],
      verifying: ['readback_verified','failed','uncertain'], uncertain: ['readback_verified','closed_not_applied','failed','uncertain'],
      readback_verified: [], closed_not_applied: [], failed: []
    };
    if (!repeatedPartialResolution && !transitions[row.state]?.includes(nextState)) {
      throw new Error(`Illegal Return command transition: ${row.state} -> ${nextState}.`);
    }
    if (nextState === 'submitted' && evidenceType !== 'request') throw new Error('Submitted state requires request evidence.');
    if(nextState==='submitted'){
      const intended=JSON.parse(row.intended_revision_json) as Record<string,unknown>;
      if(String(intended.kind)==='object'&&String(intended.disposition)==='create'){
        const owned=this.core.prepare(`SELECT 1 FROM feature_mutation_reservations WHERE owner_command_id=? AND lifecycle='active' AND absence_receipt_id<>''`).get(commandId);
        if(!owned) throw new Error('Create mutation reservation was superseded or released before submission.');
      }
    }
    if (nextState === 'committed' && evidenceType !== 'commit') throw new Error('Committed state requires commit evidence.');
    const conclusiveReceiptRequired = nextState === 'readback_verified' || nextState === 'closed_not_applied';
    // Create preflight is the authority that unlocks a reclaimed logical
    // identity. Preserve and validate its receipt exactly like a final
    // read-back, but do not treat it as an effect-resolution receipt.
    const absenceReceiptRequired = evidenceType === 'preflight' && nextState === 'prepared' && receiptId !== '';
    const trustedReceiptRequired = conclusiveReceiptRequired || absenceReceiptRequired;
    let verifiedReceipt: Record<string, any> | null = null;
    if (nextState === 'readback_verified' && !['readback','reconcile'].includes(evidenceType)) {
      throw new Error('Read-back verified state requires authoritative readback/reconcile evidence.');
    }
    if (nextState === 'closed_not_applied' && evidenceType !== 'reconcile') {
      throw new Error('Closed-not-applied state requires authoritative reconcile evidence.');
    }
    if (intentResolution === 'partial_effect'
      && (nextState !== 'readback_verified' || evidenceType !== 'reconcile'
        || !payload || typeof payload !== 'object' || Array.isArray(payload)
        || String((payload as Record<string,unknown>).outcome || '') !== 'partial_applied')) {
      throw new Error('Partial-effect resolution requires an exact authoritative partial-applied reconcile receipt.');
    }
    if (trustedReceiptRequired) {
      const receipt = this.core.prepare(`
        SELECT o.*,c.plan_digest AS command_plan_digest,c.evidence_operation_ids_json,c.evidence_target_identity_key,
          c.evidence_request_digest,i.target_key,i.intended_revision_json,c.state AS command_state,
          c.connector_request_id AS source_connector_request_id,
          c.connector_execution_generation AS source_connector_execution_generation,
          c.connector_session_generation AS source_connector_session_generation,
          c.connector_id AS source_connector_id,c.connector_operation_package_digest AS source_operation_package_digest,
          c.connector_feature_version AS source_feature_version,c.operation_id AS source_operation_id,
          EXISTS(
            SELECT 1 FROM feature_command_evidence verified
            WHERE verified.command_id=c.command_id AND verified.run_id=c.run_id
              AND verified.verified=1 AND verified.evidence_type IN ('readback','reconcile')
          ) AS has_verified_evidence,
          EXISTS(
            SELECT 1 FROM connector_delivery_requests source_delivery
            WHERE source_delivery.request_id=c.connector_request_id
              AND source_delivery.purpose='mutation' AND source_delivery.state='prepared'
              AND source_delivery.execution_generation='' AND source_delivery.wire_result_digest=''
          ) AS source_mutation_without_execution,
          f.credential_digest,f.connector_id AS confirmation_connector_id,
          f.session_generation AS confirmation_session_generation,f.engagement_id AS confirmation_engagement_id,
          f.authority_instance_id AS confirmation_authority_instance_id,
          f.tenant_or_org_id AS confirmation_tenant_or_org_id,f.pack_id AS confirmation_pack_id
        FROM feature_operation_receipts o
        JOIN feature_commands c ON c.command_id=o.command_id AND c.run_id=o.run_id
        JOIN managed_content_intents i ON i.intent_id=c.intent_id AND i.run_id=c.run_id AND i.plan_digest=c.plan_digest
        JOIN feature_confirmations f ON f.run_id=c.run_id AND f.plan_digest=c.plan_digest AND f.decision='approved'
        WHERE o.receipt_id=? AND o.command_id=? AND o.run_id=? AND o.feature_id=? AND o.feature_version=?
        ORDER BY f.created_at DESC LIMIT 1
      `).get(receiptId, commandId, runId, context.featureId, context.featureVersion) as Record<string, any> | undefined;
      const payloadReceiptId = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? String((payload as Record<string, unknown>).__operationReceiptId || '') : '';
      const receiptWorkspaceIds = receipt ? JSON.parse(String(receipt.workspace_ids_json)) as string[] : [];
      const receiptAuthorityDigest = receipt ? crypto.createHash('sha256').update(canonical({
        connectorId: receipt.connector_id,
        sessionGeneration: Number(receipt.session_generation),
        engagementId: receipt.engagement_id,
        authorityInstanceId: receipt.authority_instance_id,
        tenantOrOrgId: receipt.tenant_or_org_id,
        packId: receipt.pack_id,
        workspaceIds: receiptWorkspaceIds
      })).digest('hex') : '';
      const exactFrozenReceiptAuthority = receipt !== undefined
        && String(receipt.authority_digest) === String(receipt.credential_digest)
        && String(receipt.connector_id) === String(receipt.confirmation_connector_id)
        && Number(receipt.session_generation) === Number(receipt.confirmation_session_generation)
        && String(receipt.engagement_id) === String(receipt.confirmation_engagement_id)
        && String(receipt.authority_instance_id) === String(receipt.confirmation_authority_instance_id)
        && String(receipt.tenant_or_org_id) === String(receipt.confirmation_tenant_or_org_id)
        && String(receipt.pack_id) === String(receipt.confirmation_pack_id);
      const safeReadOnlySessionRebind = receipt !== undefined
        && String(receipt.command_state) === 'uncertain'
        && Number(receipt.has_verified_evidence) === 0
        && String(receipt.authority_digest) === receiptAuthorityDigest
        && String(receipt.connector_id) === String(receipt.confirmation_connector_id)
        && String(receipt.engagement_id) === String(receipt.confirmation_engagement_id)
        && String(receipt.authority_instance_id) === String(receipt.confirmation_authority_instance_id)
        && String(receipt.tenant_or_org_id) === String(receipt.confirmation_tenant_or_org_id)
        && String(receipt.pack_id) === String(receipt.confirmation_pack_id)
        && receiptWorkspaceIds.includes(String(JSON.parse(String(receipt.intended_revision_json || '{}')).workspace || ''));
      if (
        !receipt || payloadReceiptId !== receiptId
        || String(receipt.plan_digest) !== String(receipt.command_plan_digest)
        || String(receipt.frozen_target_key) !== String(receipt.target_key)
        || !(JSON.parse(String(receipt.evidence_operation_ids_json)) as string[]).includes(String(receipt.operation_id))
        || String(receipt.target_identity_key) !== String(receipt.evidence_target_identity_key)
        || String(receipt.request_digest) !== String(receipt.evidence_request_digest)
        || (!exactFrozenReceiptAuthority && !safeReadOnlySessionRebind)
        || !/^sha256:[0-9a-f]{64}$/u.test(String(receipt.operation_package_digest))
        || crypto.createHash('sha256').update(canonical(receiptPayload)).digest('hex') !== String(receipt.response_digest)
        || canonical(JSON.parse(String(receipt.response_json))) !== canonical(receiptPayload)
      ) throw new Error('Verified Return state requires an exact trusted Operation receipt bound to the frozen authority, plan, command, target, and response.');
      verifiedReceipt = receipt;
    }
    this.core.exec('BEGIN IMMEDIATE;');
    try {
      if(nextState==='submitted'){
        // Linearize submission against force-close. If force-close wins the
        // SQLite writer lock, the Run/reservation is already closed and this
        // transition cannot manufacture a submitted command afterwards. If
        // submission wins, force-close observes it and must refuse.
        const intended=JSON.parse(row.intended_revision_json) as Record<string,unknown>;
        const createReservationSql=String(intended.kind)==='object'&&String(intended.disposition)==='create'
          ?`AND EXISTS(SELECT 1 FROM feature_mutation_reservations mr WHERE mr.owner_command_id=c.command_id AND mr.lifecycle='active' AND mr.absence_receipt_id<>'')`:'';
        const admitted=this.core.prepare(`SELECT 1 FROM feature_commands c JOIN feature_runs r ON r.run_id=c.run_id WHERE c.command_id=? AND c.run_id=? AND c.state=? AND r.state='returning' ${createReservationSql}`).get(commandId,runId,row.state);
        if(!admitted)throw new Error('Return mutation submission lost authority to a concurrent force-close or reservation transition.');
      }
      this.core.prepare(`INSERT INTO feature_command_evidence(evidence_id, command_id, run_id, evidence_type, evidence_digest, receipt_id, verified, payload_json, occurred_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(evidenceId, commandId, runId, evidenceType, evidenceDigest, trustedReceiptRequired ? receiptId : '', trustedReceiptRequired ? 1 : (request.verified === true ? 1 : 0), JSON.stringify(payload), occurredAt);
      this.core.prepare(`UPDATE feature_commands SET state=?, commit_point_at=CASE WHEN ?='commit' THEN ? ELSE commit_point_at END, submitted_at=CASE WHEN ?='request' THEN ? ELSE submitted_at END, completed_at=CASE WHEN ? IN ('readback_verified','closed_not_applied','failed') THEN ? ELSE completed_at END, last_error=? WHERE command_id=?`)
        .run(nextState, evidenceType, occurredAt, evidenceType, occurredAt, nextState, occurredAt, String(request.error || ''), commandId);
      if (['readback_verified','closed_not_applied'].includes(nextState)) {
        this.core.prepare(`UPDATE managed_content_intents SET state=?, updated_at=? WHERE intent_id=?`).run(
          intentResolution === 'partial_effect' ? 'frozen' : 'verified', occurredAt, row.intent_id
        );
      }
      if (nextState==='readback_verified') this.core.prepare(`UPDATE feature_mutation_reservations SET lifecycle='completed',updated_at=? WHERE owner_command_id=? AND lifecycle='active'`).run(occurredAt,commandId);
      if (nextState==='closed_not_applied') this.core.prepare(`UPDATE feature_mutation_reservations SET lifecycle='released',absence_receipt_id='',updated_at=? WHERE owner_command_id=? AND lifecycle='active'`).run(occurredAt,commandId);
      if (nextState==='failed'&&row.state==='prepared') {
        // A pre-effect failure may release only the exact command's reservation
        // when no mutation request or delivery ever existed. This keeps a
        // failed read/check from blocking a later Run without weakening the
        // uncertain-mutation fence.
        this.core.prepare(`
          UPDATE feature_mutation_reservations SET lifecycle='released',absence_receipt_id='',updated_at=?
          WHERE owner_run_id=? AND owner_intent_id=? AND owner_command_id=? AND lifecycle='active'
            AND EXISTS(
              SELECT 1 FROM feature_commands c
              WHERE c.command_id=? AND c.run_id=? AND c.state='failed'
                AND c.submitted_at='' AND c.commit_point_at='' AND c.connector_request_id=''
                AND NOT EXISTS(
                  SELECT 1 FROM connector_delivery_requests delivery
                  WHERE delivery.command_id=c.command_id AND delivery.purpose='mutation'
                )
            )
        `).run(occurredAt,runId,row.intent_id,commandId,commandId,runId);
      }
      if (nextState === 'uncertain') this.core.prepare(`UPDATE managed_content_intents SET state='uncertain', updated_at=? WHERE intent_id=?`).run(occurredAt, row.intent_id);
      if (nextState === 'failed') this.core.prepare(`UPDATE managed_content_intents SET state='failed', updated_at=? WHERE intent_id=?`).run(occurredAt, row.intent_id);
      if (conclusiveReceiptRequired && verifiedReceipt && !repeatedPartialResolution) {
        const receipt = verifiedReceipt;
        const sourceRequestId = String(receipt.source_connector_request_id || '');
        // A prepared command may be closed as not-applied before any mutation was
        // submitted.  Its read-back receipt is terminal and there is no source
        // mutation ledger entry to resolve.  Only commands carrying a durable
        // source delivery identity are allowed to mint the second-phase ack.
        if (sourceRequestId && Number(receipt.source_mutation_without_execution) !== 1) {
          if (!/^[0-9a-f-]{36}$/iu.test(sourceRequestId)
            || !/^[a-f0-9]{48}$/u.test(String(receipt.source_connector_execution_generation || ''))
            || !/^[0-9a-f-]{36}$/iu.test(String(receipt.connector_request_id || ''))
            || !/^[a-f0-9]{64}$/u.test(String(receipt.connector_wire_result_digest || ''))
            || !/^[a-f0-9]{48}$/u.test(String(receipt.connector_execution_generation || ''))) {
            throw new Error('Conclusive Return evidence lacks exact source and readback Connector delivery identities.');
          }
          const ackId = randomUUID();
          const ack = {
            schemaVersion: 'omnia.connector-delivery-ack/v1', ackId,
            deliveredRequestId: String(receipt.connector_request_id),
            resultDigest: String(receipt.connector_wire_result_digest),
            connectorId: String(receipt.connector_id), sessionGeneration: Number(receipt.session_generation),
            executionGeneration: String(receipt.connector_execution_generation),
            featureId: context.featureId, featureVersion: context.featureVersion,
            operationId: String(receipt.operation_id), operationPackageDigest: String(receipt.operation_package_digest),
            runId, commandId, receiptId, receiptResponseDigest: String(receipt.response_digest),
            resolution: nextState, effectOutcome: nextState === 'readback_verified' ? 'applied' : 'not_applied',
            reconciles: {
              requestId: sourceRequestId, featureId: context.featureId,
              featureVersion: String(receipt.source_feature_version), operationId: String(receipt.source_operation_id),
              operationPackageDigest: String(receipt.source_operation_package_digest),
              connectorId: String(receipt.source_connector_id),
              sessionGeneration: Number(receipt.source_connector_session_generation),
              executionGeneration: String(receipt.source_connector_execution_generation)
            }
          } satisfies import('../../shared/connector-delivery.js').ConnectorDeliveryAck;
          this.core.prepare(`
            INSERT INTO connector_delivery_ack_outbox(
              ack_id,request_id,transaction_kind,payload_json,state,attempts,last_error,created_at,updated_at,delivered_at
            ) VALUES(?,?,'effect_resolved',?,'pending',0,'',?,?,'')
          `).run(ackId, String(receipt.connector_request_id), canonical(ack), occurredAt, occurredAt);
          this.core.prepare(`UPDATE connector_delivery_requests SET state='effect_resolved',updated_at=? WHERE request_id=? AND state='receipt_committed'`)
            .run(occurredAt, String(receipt.connector_request_id));
        } else if (sourceRequestId && Number(receipt.source_mutation_without_execution) === 1) {
          // The source mutation has no execution generation, so a second-phase
          // ack would be fabricated. The exact authoritative read-back still
          // closes Core's uncertainty while the source audit identity remains.
          this.core.prepare(`UPDATE connector_delivery_requests SET state='effect_resolved',updated_at=? WHERE request_id=? AND state='prepared' AND execution_generation='' AND wire_result_digest=''`)
            .run(occurredAt, sourceRequestId);
        }
      }
      this.core.exec('COMMIT;');
    } catch (error) { this.core.exec('ROLLBACK;'); throw error; }
    return { evidenceId, evidenceDigest, intentResolution };
  }

  private projectVerifiedReturn(input: unknown, context: FeatureWorkerPortContext): true {
    const request = object(input, 'Verified Return projection');
    const commandId = String(request.commandId || ''); const runId = String(request.runId || '');
    if (!this.currentActivationOwnsRun(runId, context)
      || !this.core.prepare(`SELECT 1 FROM feature_runs WHERE run_id=? AND state IN ('returning','verifying','reconciling')`).get(runId)) {
      throw new Error('Projection Run is not owned by the active Feature Return state.');
    }
    const command = this.core.prepare(`SELECT c.intent_id,c.state,c.plan_digest,c.evidence_operation_ids_json,c.evidence_target_identity_key,c.evidence_request_digest,i.target_kind,i.target_key,i.intended_revision_json,i.state AS intent_state FROM feature_commands c JOIN managed_content_intents i ON i.intent_id=c.intent_id AND i.run_id=c.run_id AND i.plan_digest=c.plan_digest WHERE c.command_id=? AND c.run_id=?`).get(commandId, runId) as { intent_id: string; state: string; plan_digest:string; evidence_operation_ids_json:string; evidence_target_identity_key:string; evidence_request_digest:string; target_kind:string; target_key:string; intended_revision_json:string; intent_state:string } | undefined;
    const evidence = this.core.prepare(`
      SELECT e.evidence_id,e.evidence_digest,e.receipt_id,e.payload_json,
        o.run_id,o.command_id,o.feature_id,o.feature_version,r.feature_version AS run_feature_version,o.operation_package_digest,o.operation_id,
        o.authority_digest,o.connector_id,o.session_generation,o.engagement_id,o.authority_instance_id,o.tenant_or_org_id,o.pack_id,
        o.frozen_target_key,o.target_identity_key,o.workspace_ids_json,o.plan_digest,o.request_digest,o.response_digest,o.response_json
      FROM feature_command_evidence e
      JOIN feature_operation_receipts o ON o.receipt_id=e.receipt_id AND o.command_id=e.command_id AND o.run_id=e.run_id
      JOIN feature_runs r ON r.run_id=o.run_id AND r.feature_id=o.feature_id
      WHERE e.command_id=? AND e.run_id=? AND e.evidence_type IN ('readback','reconcile') AND e.receipt_id<>'' AND e.verified=1
      ORDER BY e.occurred_at DESC LIMIT 1
    `).get(commandId, runId) as Record<string, any> | undefined;
    if (!command || command.state !== 'readback_verified' || command.intent_state !== 'verified' || !evidence) throw new Error('Managed projection requires verified current read-back evidence.');
    const binding = returnAuthorityBinding(request.binding, 'Projection authority binding');
    for (const field of ['authorityInstanceId', 'packId', 'engagementId']) if (!String(binding[field] || '')) throw new Error(`Projection authority is missing ${field}.`);
    const safety = this.core.prepare(`SELECT workspace_ids_json FROM workspace_safety WHERE singleton=1`).get() as {workspace_ids_json:string};
    const workspaceIds = JSON.parse(safety.workspace_ids_json) as string[];
    const authorityDigest = crypto.createHash('sha256').update(canonical({ connectorId:binding.connectorId,sessionGeneration:Number(binding.sessionGeneration),engagementId:binding.engagementId,authorityInstanceId:binding.authorityInstanceId,tenantOrOrgId:binding.tenantOrOrgId,packId:binding.packId,workspaceIds })).digest('hex');
    const currentConfirmation = this.core.prepare(`SELECT credential_digest,connector_id,session_generation,authority_instance_id,tenant_or_org_id,pack_id,engagement_id FROM feature_confirmations WHERE run_id=? AND plan_digest=? AND decision='approved' ORDER BY created_at DESC LIMIT 1`).get(runId, command.plan_digest) as Record<string,any>|undefined;
    const workspaceId = String(request.workspaceId || ''); const projectionKind = String(request.projectionKind || ''); const occurredAt = now();
    const intended = JSON.parse(command.intended_revision_json) as Record<string, any>;
    const projectionReceiptWorkspaceIds = JSON.parse(String(evidence.workspace_ids_json)) as string[];
    const exactFrozenProjectionAuthority = Boolean(currentConfirmation)
      && currentConfirmation!.credential_digest === authorityDigest
      && currentConfirmation!.connector_id === binding.connectorId
      && Number(currentConfirmation!.session_generation) === Number(binding.sessionGeneration)
      && currentConfirmation!.authority_instance_id === binding.authorityInstanceId
      && currentConfirmation!.tenant_or_org_id === binding.tenantOrOrgId
      && currentConfirmation!.pack_id === binding.packId
      && currentConfirmation!.engagement_id === binding.engagementId;
    const safeReadOnlyProjectionRebind = Boolean(currentConfirmation)
      && String(evidence.authority_digest) === authorityDigest
      && String(evidence.connector_id) === String(binding.connectorId)
      && Number(evidence.session_generation) === Number(binding.sessionGeneration)
      && String(evidence.authority_instance_id) === String(binding.authorityInstanceId)
      && String(evidence.tenant_or_org_id) === String(binding.tenantOrOrgId)
      && String(evidence.pack_id) === String(binding.packId)
      && String(evidence.engagement_id) === String(binding.engagementId)
      && currentConfirmation!.connector_id === binding.connectorId
      && currentConfirmation!.authority_instance_id === binding.authorityInstanceId
      && currentConfirmation!.tenant_or_org_id === binding.tenantOrOrgId
      && currentConfirmation!.pack_id === binding.packId
      && currentConfirmation!.engagement_id === binding.engagementId
      && projectionReceiptWorkspaceIds.includes(workspaceId);
    if ((!exactFrozenProjectionAuthority && !safeReadOnlyProjectionRebind) || !workspaceIds.includes(workspaceId)
      || intended.workspace !== workspaceId || intended.key !== command.target_key || intended.kind !== command.target_kind
      || projectionKind !== (['relation','risk_control'].includes(command.target_kind) ? 'relation' : 'object')) {
      throw new Error('Projection differs from the frozen authority scope or intended target.');
    }
    const recordedEvidence = JSON.parse(String(evidence.payload_json));
    const recordedReceiptId = recordedEvidence && typeof recordedEvidence === 'object' && !Array.isArray(recordedEvidence)
      ? String(recordedEvidence.__operationReceiptId || '') : '';
    const receiptPayload = recordedEvidence && typeof recordedEvidence === 'object' && !Array.isArray(recordedEvidence)
      ? Object.fromEntries(Object.entries(recordedEvidence as Record<string, unknown>).filter(([key]) => key !== '__operationReceiptId'))
      : recordedEvidence;
    // A successor Feature may repair a verified-but-unprojected command after
    // an interrupted Return.  When the signed Worker omits payload, Core uses
    // the exact trusted receipt payload itself; callers can never substitute
    // or enrich the durable evidence.
    const requestedPayload = request.payload === undefined
      ? receiptPayload
      : request.payload && typeof request.payload === 'object' && !Array.isArray(request.payload)
        ? Object.fromEntries(Object.entries(request.payload as Record<string, unknown>).filter(([key]) => key !== '__operationReceiptId'))
        : request.payload;
    const evidenceOperationIds = JSON.parse(String(command.evidence_operation_ids_json)) as string[];
    const receiptWorkspaceIds = projectionReceiptWorkspaceIds;
    const sourceAuthorityDigest = crypto.createHash('sha256').update(canonical({
      connectorId:String(evidence.connector_id),sessionGeneration:Number(evidence.session_generation),engagementId:String(evidence.engagement_id),
      authorityInstanceId:String(evidence.authority_instance_id),tenantOrOrgId:String(evidence.tenant_or_org_id),packId:String(evidence.pack_id),workspaceIds:receiptWorkspaceIds
    })).digest('hex');
    if (recordedReceiptId !== String(evidence.receipt_id)
      || canonical(receiptPayload) !== canonical(requestedPayload ?? {})
      || crypto.createHash('sha256').update(canonical(receiptPayload)).digest('hex') !== String(evidence.evidence_digest)
      || String(evidence.evidence_digest) !== String(evidence.response_digest)
      || canonical(JSON.parse(String(evidence.response_json))) !== canonical(receiptPayload)
      || String(evidence.run_id) !== runId || String(evidence.command_id) !== commandId
      || String(evidence.feature_id) !== context.featureId
      || !this.runLineageIncludesVersion(runId, context.featureId, String(evidence.feature_version))
      || !/^sha256:[0-9a-f]{64}$/u.test(String(evidence.operation_package_digest || ''))
      || !Array.isArray(evidenceOperationIds) || !evidenceOperationIds.includes(String(evidence.operation_id || ''))
      || String(evidence.plan_digest) !== command.plan_digest
      || String(evidence.frozen_target_key) !== command.target_key
      || String(evidence.target_identity_key) !== command.evidence_target_identity_key
      || String(evidence.request_digest) !== command.evidence_request_digest
      || !Array.isArray(receiptWorkspaceIds) || !receiptWorkspaceIds.includes(workspaceId)
      || String(evidence.authority_digest) !== sourceAuthorityDigest
      || String(evidence.connector_id) !== String(binding.connectorId)
      || !Number.isSafeInteger(Number(evidence.session_generation)) || Number(evidence.session_generation) < 1
      || String(evidence.engagement_id) !== String(binding.engagementId)
      || String(evidence.authority_instance_id) !== String(binding.authorityInstanceId)
      || String(evidence.tenant_or_org_id) !== String(binding.tenantOrOrgId)
      || String(evidence.pack_id) !== String(binding.packId)
      ) {
      throw new Error('Managed projection payload is not exactly bound to its trusted Operation receipt and frozen command identity.');
    }
    if (String(intended.kind || '') === 'object'
      && projectionKind === 'object' && String(intended.objectType || '') === 'GRA') {
      const contentIdentity = intended.contentIdentity as Record<string, unknown> | undefined;
      const contentName = String(intended.contentName || '').normalize('NFKC').trim();
      const payload = object(requestedPayload, 'Verified GRA projection payload');
      const observedContentId = String(payload.inkContentId || payload.contentId || '');
      if (!contentName || !String(contentIdentity?.inkContentId || '') || !String(contentIdentity?.typeId || '')
        || observedContentId !== String(contentIdentity!.inkContentId)) {
        throw new Error('GRA projection differs from its frozen semantic content name or exact authority content identity.');
      }
    }
    const existingObjects = this.core.prepare(`SELECT authority_instance_id,tenant_or_org_id,pack_id,engagement_id,workspace_id,object_type,object_id,evidence_id,payload_json FROM managed_object_revisions WHERE run_id=? AND command_id=?`).all(runId,commandId) as Array<Record<string,unknown>>;
    const existingRelations = this.core.prepare(`SELECT authority_instance_id,tenant_or_org_id,pack_id,engagement_id,workspace_id,relation_type,relation_key,source_object_id,target_object_id,evidence_id,payload_json FROM managed_relation_revisions WHERE run_id=? AND command_id=?`).all(runId,commandId) as Array<Record<string,unknown>>;
    if (existingObjects.length + existingRelations.length > 0) {
      const expectedPayload = canonical(requestedPayload ?? {});
      const exactObject = projectionKind === 'object' && existingObjects.length === 1 && existingRelations.length === 0
        && String(existingObjects[0]!.authority_instance_id) === binding.authorityInstanceId
        && String(existingObjects[0]!.tenant_or_org_id) === binding.tenantOrOrgId
        && String(existingObjects[0]!.pack_id) === binding.packId
        && String(existingObjects[0]!.engagement_id) === binding.engagementId
        && String(existingObjects[0]!.workspace_id) === workspaceId
        && String(existingObjects[0]!.object_type) === String(request.objectType || '')
        && String(existingObjects[0]!.object_id) === String(request.objectId || '')
        && String(existingObjects[0]!.evidence_id) === evidence.evidence_id
        && canonical(JSON.parse(String(existingObjects[0]!.payload_json))) === expectedPayload;
      const exactRelation = projectionKind === 'relation' && existingRelations.length === 1 && existingObjects.length === 0
        && String(existingRelations[0]!.authority_instance_id) === binding.authorityInstanceId
        && String(existingRelations[0]!.tenant_or_org_id) === binding.tenantOrOrgId
        && String(existingRelations[0]!.pack_id) === binding.packId
        && String(existingRelations[0]!.engagement_id) === binding.engagementId
        && String(existingRelations[0]!.workspace_id) === workspaceId
        && String(existingRelations[0]!.relation_type) === String(request.relationType || '')
        && String(existingRelations[0]!.relation_key) === String(request.relationKey || '')
        && String(existingRelations[0]!.source_object_id) === String(request.sourceObjectId || '')
        && String(existingRelations[0]!.target_object_id) === String(request.targetObjectId || '')
        && String(existingRelations[0]!.evidence_id) === evidence.evidence_id
        && canonical(JSON.parse(String(existingRelations[0]!.payload_json))) === expectedPayload;
      if (exactObject || exactRelation) return true;
      throw new Error('The verified command already owns a different Managed Content projection.');
    }
    this.core.exec('BEGIN IMMEDIATE;');
    try {
    if (projectionKind === 'object') {
      const objectType = String(request.objectType || ''); const objectId = String(request.objectId || '');
      if (objectType !== String(intended.objectType || '')) throw new Error('Object projection type differs from the frozen intent.');
      if (intended.graTargetKey) {
        const gra = this.core.prepare(`SELECT o.object_id FROM managed_content_intents i JOIN feature_commands c ON c.intent_id=i.intent_id AND c.state='readback_verified' JOIN managed_object_revisions o ON o.command_id=c.command_id AND o.run_id=c.run_id WHERE i.run_id=? AND i.target_kind='object' AND i.target_key=? AND i.state='verified' AND o.object_type='GRA' ORDER BY o.verified_at DESC LIMIT 1`).get(runId,String(intended.graTargetKey)) as {object_id:string}|undefined;
        if (!gra || gra.object_id !== objectId) throw new Error('GRA revision projection is not bound to the verified frozen GRA target.');
      }
      if (intended.objectTargetKey) {
        const parent=this.core.prepare(`SELECT o.object_id FROM managed_content_intents i JOIN feature_commands c ON c.intent_id=i.intent_id AND c.state='readback_verified' JOIN managed_object_revisions o ON o.command_id=c.command_id AND o.run_id=c.run_id WHERE i.run_id=? AND i.target_kind='object' AND i.target_key=? AND i.state='verified' ORDER BY o.verified_at DESC LIMIT 1`).get(runId,String(intended.objectTargetKey)) as {object_id:string}|undefined;
        if(!parent||parent.object_id!==objectId) throw new Error('IT Element settings projection is not bound to the verified frozen object target.');
      }
      const current = this.core.prepare(`SELECT current_revision FROM managed_objects WHERE authority_instance_id=? AND tenant_or_org_id=? AND pack_id=? AND engagement_id=? AND workspace_id=? AND object_type=? AND object_id=?`)
        .get(binding.authorityInstanceId, binding.tenantOrOrgId, binding.packId, binding.engagementId, workspaceId, objectType, objectId) as { current_revision: number } | undefined;
      const revision = Number(current?.current_revision || 0) + 1;
      this.core.prepare(`INSERT INTO managed_objects(authority_instance_id,tenant_or_org_id,pack_id,engagement_id,workspace_id,object_type,object_id,current_revision,lifecycle,freshness,updated_at) VALUES(?,?,?,?,?,?,?,?,'active','verified_current',?) ON CONFLICT(authority_instance_id,tenant_or_org_id,pack_id,engagement_id,workspace_id,object_type,object_id) DO UPDATE SET current_revision=excluded.current_revision,lifecycle='active',freshness='verified_current',updated_at=excluded.updated_at`)
        .run(binding.authorityInstanceId,binding.tenantOrOrgId,binding.packId,binding.engagementId,workspaceId,objectType,objectId,revision,occurredAt);
      this.core.prepare(`INSERT INTO managed_object_revisions(revision_id,authority_instance_id,tenant_or_org_id,pack_id,engagement_id,workspace_id,object_type,object_id,revision,run_id,intent_id,command_id,evidence_id,provenance_json,payload_json,verified_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(randomUUID(),binding.authorityInstanceId,binding.tenantOrOrgId,binding.packId,binding.engagementId,workspaceId,objectType,objectId,revision,runId,command.intent_id,commandId,evidence.evidence_id,JSON.stringify(request.provenance || {}),JSON.stringify(requestedPayload ?? {}),occurredAt);
    } else if (projectionKind === 'relation') {
      const relationType=String(request.relationType||''); const relationKey=String(request.relationKey||''); const source=String(request.sourceObjectId||''); const targetId=String(request.targetObjectId||'');
      const resolvedRelationObject=(targetKey:string)=>this.core.prepare(`SELECT o.object_id FROM managed_content_intents i JOIN feature_commands c ON c.intent_id=i.intent_id AND c.run_id=i.run_id AND c.state='readback_verified' JOIN managed_object_revisions o ON o.command_id=c.command_id AND o.run_id=c.run_id WHERE i.run_id=? AND i.target_kind='object' AND i.target_key=? AND i.state='verified' ORDER BY o.verified_at DESC LIMIT 1`).get(runId,targetKey) as {object_id:string}|undefined;
      if(command.target_kind==='risk_control'){
        const catalog=intended.resolvedCatalog as Record<string,unknown>|undefined;
        const storedSpec=this.core.prepare(`SELECT spec_json,feature_version FROM feature_command_specs WHERE command_id=? AND run_id=? AND feature_id=?`).get(commandId,runId,context.featureId) as {spec_json:string;feature_version:string}|undefined;
        if(storedSpec&&!this.runLineageIncludesVersion(runId,context.featureId,storedSpec.feature_version)) throw new Error('Risk-Control command specification is outside the active Feature handoff lineage.');
        const spec=storedSpec?JSON.parse(storedSpec.spec_json) as Record<string,any>:undefined;
        const payload=spec?.mutationPayload as Record<string,any>|undefined; const scope=Array.isArray(payload?.controlRiskScopes)?payload.controlRiskScopes[0]:undefined;
        const frozenRiskId=String(catalog?.riskId||payload?.riskId||''); const frozenControlId=String(catalog?.controlId||scope?.controlId||'');
        if(relationType!=='risk_control'||relationKey!==command.target_key||!catalog
          &&(!payload||String(payload.riskName||'')!==String(intended.riskName||'')||String(payload.controlName||'')!==String(intended.controlName||''))
          ||!frozenRiskId||!frozenControlId||source!==frozenRiskId||targetId!==frozenControlId) throw new Error('Risk-Control projection differs from the frozen/signed catalog identities.');
      }else{
        const expectedSource=resolvedRelationObject(String(intended.sourceObjectTargetKey||''));
        const targetSourceType=String(intended.targetSourceType||'');
        const expectedTargetId=targetSourceType==='in_batch'
          ?String(resolvedRelationObject(String(intended.targetObjectTargetKey||''))?.object_id||'')
          :targetSourceType==='external'
            ?String(intended.resolvedTargetObjectId||'')
            :'';
        if (relationType !== String(intended.relationType || '') || relationKey !== command.target_key
          ||!expectedSource||!expectedTargetId||source!==expectedSource.object_id||targetId!==expectedTargetId) throw new Error('Relation projection differs from the frozen intent or its receipt-backed source/target object IDs.');
      }
      const current=this.core.prepare(`SELECT current_revision,source_object_id,target_object_id FROM managed_relations WHERE authority_instance_id=? AND tenant_or_org_id=? AND pack_id=? AND engagement_id=? AND workspace_id=? AND relation_type=? AND relation_key=?`).get(binding.authorityInstanceId,binding.tenantOrOrgId,binding.packId,binding.engagementId,workspaceId,relationType,relationKey) as {current_revision:number;source_object_id:string;target_object_id:string}|undefined;
      const revision=Number(current?.current_revision||0)+1;
      this.core.prepare(`INSERT INTO managed_relations(authority_instance_id,tenant_or_org_id,pack_id,engagement_id,workspace_id,relation_type,relation_key,source_object_id,target_object_id,current_revision,lifecycle,freshness,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'active','verified_current',?) ON CONFLICT(authority_instance_id,tenant_or_org_id,pack_id,engagement_id,workspace_id,relation_type,relation_key) DO UPDATE SET source_object_id=excluded.source_object_id,target_object_id=excluded.target_object_id,current_revision=excluded.current_revision,lifecycle='active',freshness='verified_current',updated_at=excluded.updated_at`).run(binding.authorityInstanceId,binding.tenantOrOrgId,binding.packId,binding.engagementId,workspaceId,relationType,relationKey,source,targetId,revision,occurredAt);
      this.core.prepare(`INSERT INTO managed_relation_revisions(revision_id,authority_instance_id,tenant_or_org_id,pack_id,engagement_id,workspace_id,relation_type,relation_key,source_object_id,target_object_id,revision,run_id,intent_id,command_id,evidence_id,payload_json,verified_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(),binding.authorityInstanceId,binding.tenantOrOrgId,binding.packId,binding.engagementId,workspaceId,relationType,relationKey,source,targetId,revision,runId,command.intent_id,commandId,evidence.evidence_id,JSON.stringify(requestedPayload??{}),occurredAt);
    } else throw new Error('Unsupported verified projection kind.');
      this.core.exec('COMMIT;');
    } catch (error) { this.core.exec('ROLLBACK;'); throw error; }
    return true;
  }

  private resolveDeletionRelation(
    binding: Record<string, any>,
    workspaceId: string,
    relationType: string,
    canonicalRelationKey: string,
    sourceObjectId: string,
    targetObjectId: string,
    riskControlIdentity?: GraCascadeRiskControlIdentity & { graId: string }
  ): { relationKey: string; currentRevision: number } {
    const relationHeads = this.core.prepare(`
      SELECT r.relation_key,r.current_revision,v.payload_json,
        v.source_object_id AS revision_source_object_id,
        v.target_object_id AS revision_target_object_id,
        v.run_id AS revision_run_id,
        v.command_id AS revision_command_id
      FROM managed_relations r
      LEFT JOIN managed_relation_revisions v
        ON v.authority_instance_id=r.authority_instance_id
       AND v.tenant_or_org_id=r.tenant_or_org_id
       AND v.pack_id=r.pack_id
       AND v.engagement_id=r.engagement_id
       AND v.workspace_id=r.workspace_id
       AND v.relation_type=r.relation_type
       AND v.relation_key=r.relation_key
       AND v.revision=r.current_revision
      WHERE r.authority_instance_id=? AND r.tenant_or_org_id=? AND r.pack_id=? AND r.engagement_id=?
        AND r.workspace_id=? AND r.relation_type=? AND r.source_object_id=? AND r.target_object_id=?
        AND r.lifecycle='active'
      ORDER BY r.relation_key
    `).all(
      binding.authorityInstanceId, binding.tenantOrOrgId, binding.packId, binding.engagementId,
      workspaceId, relationType, sourceObjectId, targetObjectId
    ) as Array<{
      relation_key: string;
      current_revision: number;
      payload_json: string;
      revision_source_object_id: string;
      revision_target_object_id: string;
      revision_run_id: string;
      revision_command_id: string;
    }>;
    const candidates = relationHeads.filter((candidate) => {
      const revisionSource = String(candidate.revision_source_object_id || '');
      const revisionTarget = String(candidate.revision_target_object_id || '');
      if (revisionSource === sourceObjectId && revisionTarget === targetObjectId) return true;
      if (!revisionSource || !revisionTarget) {
        throw new Error('Active Managed Content relation has no exact current revision identity.');
      }
      const repaired = this.core.prepare(`
        UPDATE managed_relations SET source_object_id=?,target_object_id=?
        WHERE authority_instance_id=? AND tenant_or_org_id=? AND pack_id=? AND engagement_id=?
          AND workspace_id=? AND relation_type=? AND relation_key=? AND current_revision=?
          AND source_object_id=? AND target_object_id=? AND lifecycle='active'
      `).run(
        revisionSource, revisionTarget,
        binding.authorityInstanceId, binding.tenantOrOrgId, binding.packId, binding.engagementId,
        workspaceId, relationType, candidate.relation_key, candidate.current_revision,
        sourceObjectId, targetObjectId
      );
      if (Number(repaired.changes || 0) !== 1) {
        throw new Error('Managed Content relation head changed while repairing its current revision identity.');
      }
      return false;
    });
    let matches = candidates;
    if (relationType === 'risk_control') {
      if (!riskControlIdentity) throw new Error('Risk-Control deletion requires its full frozen/readback identity.');
      matches = candidates.filter((candidate) => {
        let payload: Record<string, unknown>;
        try { payload = object(JSON.parse(candidate.payload_json), 'Managed Risk-Control revision'); }
        catch { return false; }
        const modernIdentityMatches = String(payload.graId || '') === riskControlIdentity.graId
          && String(payload.riskRiskScopeId || '') === riskControlIdentity.riskRiskScopeId
          && String(payload.riskScopeId || '') === riskControlIdentity.riskScopeId;
        if (modernIdentityMatches) return true;

        // Older signed Create projections retained the same authority identity inside the
        // receipt-backed Pack response instead of duplicating it at the revision root.
        // Accept that representation only when the GRA, Risk scope, and Control endpoint
        // all independently match the frozen/readback cascade identity.
        const detail = payload.detail && typeof payload.detail === 'object' && !Array.isArray(payload.detail)
          ? payload.detail as Record<string, unknown> : undefined;
        if (!detail) return false;
        const riskCategories = Array.isArray(detail.plannedRiskFactorCategory)
          ? detail.plannedRiskFactorCategory as Array<Record<string, unknown>> : [];
        const risks = Array.isArray(detail.planResponseRisk)
          ? detail.planResponseRisk as Array<Record<string, unknown>> : [];
        const controls = Array.isArray(detail.planResponseSelectedControl)
          ? detail.planResponseSelectedControl as Array<Record<string, unknown>> : [];
        const payloadGraMatches = riskCategories.some((category) =>
          String(category?.riskAssessmentId || '') === riskControlIdentity.graId);
        let commandGraMatches = false;
        try {
          const storedSpec = this.core.prepare(`
            SELECT spec_json FROM feature_command_specs
            WHERE command_id=? AND run_id=?
          `).get(candidate.revision_command_id, candidate.revision_run_id) as { spec_json: string } | undefined;
          if (storedSpec) {
            const spec = object(JSON.parse(storedSpec.spec_json), 'Legacy Risk-Control command specification');
            const mutationPayload = object(spec.mutationPayload, 'Legacy Risk-Control mutation payload');
            const controlRiskScopes = Array.isArray(mutationPayload.controlRiskScopes)
              ? mutationPayload.controlRiskScopes as Array<Record<string, unknown>> : [];
            commandGraMatches = String(mutationPayload.riskAssessmentId || '') === riskControlIdentity.graId
              && String(mutationPayload.riskRiskScopeId || '') === riskControlIdentity.riskRiskScopeId
              && String(mutationPayload.riskId || '') === riskControlIdentity.riskId
              && controlRiskScopes.some((scope) =>
                String(scope?.controlId || '') === riskControlIdentity.controlId
                && String(scope?.riskId || '') === riskControlIdentity.riskId
                && String(scope?.riskScopeId || '') === riskControlIdentity.riskScopeId);
          }
        } catch {
          commandGraMatches = false;
        }
        const riskMatches = risks.some((risk) => {
          if (String(risk?.id || '') !== riskControlIdentity.riskId
            || String(risk?.riskScopeId || '') !== riskControlIdentity.riskScopeId) return false;
          const scopeIds = Array.isArray(risk?.riskRiskScopeIds)
            ? risk.riskRiskScopeIds.map((value) => String(value)) : [];
          const scopes = Array.isArray(risk?.riskRiskScopes)
            ? risk.riskRiskScopes as Array<Record<string, unknown>> : [];
          return scopeIds.includes(riskControlIdentity.riskRiskScopeId)
            || scopes.some((scope) => String(scope?.id || '') === riskControlIdentity.riskRiskScopeId
              && String(scope?.riskId || '') === riskControlIdentity.riskId
              && String(scope?.riskScopeId || '') === riskControlIdentity.riskScopeId);
        });
        const controlMatches = controls.some((control) =>
          String(control?.controlId || '') === riskControlIdentity.controlId
          && String(control?.riskId || '') === riskControlIdentity.riskId
          && String(control?.riskScopeId || '') === riskControlIdentity.riskScopeId);
        return (payloadGraMatches || commandGraMatches) && riskMatches && controlMatches;
      });
      if (candidates.length > 0 && matches.length === 0) {
        throw new Error('Active legacy Risk-Control relations exist for the endpoints, but none matches the frozen/readback GRA and exact risk scope identity.');
      }
    }
    if (matches.length > 1) throw new Error('Deletion relation identity is ambiguous across multiple active legacy Managed Content keys.');
    if (matches.length === 1) {
      return { relationKey: matches[0]!.relation_key, currentRevision: Number(matches[0]!.current_revision) };
    }
    const canonical = this.core.prepare(`
      SELECT current_revision,source_object_id,target_object_id FROM managed_relations
      WHERE authority_instance_id=? AND tenant_or_org_id=? AND pack_id=? AND engagement_id=?
        AND workspace_id=? AND relation_type=? AND relation_key=?
    `).get(
      binding.authorityInstanceId, binding.tenantOrOrgId, binding.packId, binding.engagementId,
      workspaceId, relationType, canonicalRelationKey
    ) as { current_revision: number; source_object_id: string; target_object_id: string } | undefined;
    if (canonical && (canonical.source_object_id !== sourceObjectId || canonical.target_object_id !== targetObjectId)) {
      throw new Error('Canonical deletion relation key is already owned by different endpoints.');
    }
    return { relationKey: canonicalRelationKey, currentRevision: Number(canonical?.current_revision || 0) };
  }

  private projectVerifiedDeletion(input: unknown, context: FeatureWorkerPortContext): true {
    const request = object(input, 'Verified deletion projection');
    const commandId = String(request.commandId || '');
    const runId = String(request.runId || '');
    const command = this.core.prepare(`SELECT c.intent_id,c.state,c.plan_digest,i.target_key,i.intended_revision_json,i.state AS intent_state FROM feature_commands c JOIN managed_content_intents i ON i.intent_id=c.intent_id AND i.run_id=c.run_id AND i.plan_digest=c.plan_digest JOIN feature_runs r ON r.run_id=c.run_id WHERE c.command_id=? AND c.run_id=? AND r.feature_id=? AND r.feature_version=? AND r.state IN ('returning','verifying','reconciling')`)
      .get(commandId,runId,context.featureId,context.featureVersion) as Record<string,any>|undefined;
    const evidence = this.core.prepare(`SELECT evidence_id,payload_json FROM feature_command_evidence WHERE command_id=? AND evidence_type IN ('readback','reconcile') AND receipt_id<>'' AND verified=1 ORDER BY occurred_at DESC LIMIT 1`)
      .get(commandId) as {evidence_id:string;payload_json:string}|undefined;
    if (!command || command.state !== 'readback_verified' || command.intent_state !== 'verified' || !evidence) {
      throw new Error('Deletion tombstone requires receipt-backed authoritative readback.');
    }
    const observed = JSON.parse(evidence.payload_json) as Record<string,unknown>;
    if (observed.deleted !== true) throw new Error('Deletion readback does not prove the target is deleted.');
    const intended = JSON.parse(String(command.intended_revision_json)) as Record<string,any>;
    const binding = returnAuthorityBinding(request.binding, 'Deletion projection authority binding');
    const workspaceId = String(request.workspaceId || '');
    if (!workspaceId || workspaceId !== String(intended.workspace || '')
      || String(command.target_key) !== String(intended.key || '')) throw new Error('Deletion projection differs from the frozen target.');
    const confirmation = this.core.prepare(`SELECT authority_instance_id,tenant_or_org_id,pack_id,engagement_id FROM feature_confirmations WHERE run_id=? AND plan_digest=? AND decision='approved' ORDER BY created_at DESC LIMIT 1`)
      .get(runId,String(command.plan_digest)) as Record<string,any>|undefined;
    if (!confirmation || confirmation.authority_instance_id !== binding.authorityInstanceId
      || confirmation.tenant_or_org_id !== binding.tenantOrOrgId || confirmation.pack_id !== binding.packId
      || confirmation.engagement_id !== binding.engagementId) throw new Error('Deletion projection authority drifted.');
    const occurredAt = now();
    const baseline = object(intended.baseline, 'Deletion adopted baseline');
    const relationDeletion = ['relation', 'risk_control'].includes(String(intended.kind || ''));
    this.core.exec('BEGIN IMMEDIATE;');
    try {
      if (relationDeletion) {
        const relationType = String(request.relationType || '');
        const canonicalRelationKey = String(request.relationKey || '');
        const sourceObjectId = String(request.sourceObjectId || '');
        const targetObjectId = String(request.targetObjectId || '');
        if (!relationType || relationType !== String(intended.relationType || '')
          || canonicalRelationKey !== String(intended.relationKey || intended.key || '')
          || sourceObjectId !== String(intended.sourceObjectId || '')
          || targetObjectId !== String(intended.targetObjectId || '')) {
          throw new Error('Relation deletion projection differs from the frozen relation identity.');
        }
        let riskControlIdentity: (GraCascadeRiskControlIdentity & { graId: string }) | undefined;
        if (relationType === 'risk_control') {
          const discriminator = {
            graId: String(observed.graId || ''),
            riskRiskScopeId: String(observed.riskRiskScopeId || ''),
            riskScopeId: String(observed.riskScopeId || ''),
            controlId: targetObjectId,
            riskId: sourceObjectId,
            assertionType: String(observed.assertionType || ''),
            assertion: String(observed.assertion || '')
          };
          if (!discriminator.graId || !discriminator.riskRiskScopeId || !discriminator.assertionType || !discriminator.assertion) {
            throw new Error('Risk-Control deletion readback lacks the GRA, RiskRiskScope, assertion type, or assertion discriminator.');
          }
          for (const source of [request, intended, intended.baseline, intended.resolvedCatalog]) {
            if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
            for (const field of ['graId', 'riskRiskScopeId', 'assertionType', 'assertion']) {
              if (source[field] !== undefined && String(source[field] || '') !== discriminator[field as keyof typeof discriminator]) {
                throw new Error(`Risk-Control deletion ${field} differs between the frozen identity and authoritative readback.`);
              }
            }
          }
          riskControlIdentity = discriminator;
        }
        const resolved = this.resolveDeletionRelation(
          binding, workspaceId, relationType, canonicalRelationKey, sourceObjectId, targetObjectId, riskControlIdentity
        );
        const relationKey = resolved.relationKey;
        let revision = resolved.currentRevision;
        if (revision === 0) {
          revision = 1;
          this.core.prepare(`INSERT INTO managed_relation_revisions(revision_id,authority_instance_id,tenant_or_org_id,pack_id,engagement_id,workspace_id,relation_type,relation_key,source_object_id,target_object_id,revision,run_id,intent_id,command_id,evidence_id,payload_json,verified_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(randomUUID(),binding.authorityInstanceId,binding.tenantOrOrgId,binding.packId,binding.engagementId,workspaceId,relationType,relationKey,sourceObjectId,targetObjectId,revision,runId,command.intent_id,commandId,evidence.evidence_id,JSON.stringify({source:'adopted_on_mutation',preflightDigest:String(intended.preflightDigest||''),baseline}),occurredAt);
        }
        revision += 1;
        this.core.prepare(`INSERT INTO managed_relations(authority_instance_id,tenant_or_org_id,pack_id,engagement_id,workspace_id,relation_type,relation_key,source_object_id,target_object_id,current_revision,lifecycle,freshness,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'deleted','verified_current',?) ON CONFLICT(authority_instance_id,tenant_or_org_id,pack_id,engagement_id,workspace_id,relation_type,relation_key) DO UPDATE SET source_object_id=excluded.source_object_id,target_object_id=excluded.target_object_id,current_revision=excluded.current_revision,lifecycle='deleted',freshness='verified_current',updated_at=excluded.updated_at`)
          .run(binding.authorityInstanceId,binding.tenantOrOrgId,binding.packId,binding.engagementId,workspaceId,relationType,relationKey,sourceObjectId,targetObjectId,revision,occurredAt);
        this.core.prepare(`INSERT INTO managed_relation_revisions(revision_id,authority_instance_id,tenant_or_org_id,pack_id,engagement_id,workspace_id,relation_type,relation_key,source_object_id,target_object_id,revision,run_id,intent_id,command_id,evidence_id,payload_json,verified_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(randomUUID(),binding.authorityInstanceId,binding.tenantOrOrgId,binding.packId,binding.engagementId,workspaceId,relationType,relationKey,sourceObjectId,targetObjectId,revision,runId,command.intent_id,commandId,evidence.evidence_id,JSON.stringify({deleted:true,tombstoneAt:occurredAt,baselineDigest:crypto.createHash('sha256').update(canonical(baseline)).digest('hex')}),occurredAt);
      } else {
        const objectType = String(request.objectType || '');
        const objectId = String(request.objectId || '');
        if (objectType !== String(intended.objectType || '') || objectId !== String(intended.objectId || '')) {
          throw new Error('Object deletion projection differs from the frozen object identity.');
        }
        const current = this.core.prepare(`SELECT current_revision FROM managed_objects WHERE authority_instance_id=? AND tenant_or_org_id=? AND pack_id=? AND engagement_id=? AND workspace_id=? AND object_type=? AND object_id=?`)
          .get(binding.authorityInstanceId,binding.tenantOrOrgId,binding.packId,binding.engagementId,workspaceId,objectType,objectId) as {current_revision:number}|undefined;
        let revision = Number(current?.current_revision || 0);
        if (!current) {
          revision = 1;
          this.core.prepare(`INSERT INTO managed_object_revisions(revision_id,authority_instance_id,tenant_or_org_id,pack_id,engagement_id,workspace_id,object_type,object_id,revision,run_id,intent_id,command_id,evidence_id,provenance_json,payload_json,verified_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(randomUUID(),binding.authorityInstanceId,binding.tenantOrOrgId,binding.packId,binding.engagementId,workspaceId,objectType,objectId,revision,runId,command.intent_id,commandId,evidence.evidence_id,JSON.stringify({source:'adopted_on_mutation',preflightDigest:String(intended.preflightDigest||'')}),JSON.stringify(baseline),occurredAt);
        }
        revision += 1;
        this.core.prepare(`INSERT INTO managed_objects(authority_instance_id,tenant_or_org_id,pack_id,engagement_id,workspace_id,object_type,object_id,current_revision,lifecycle,freshness,updated_at) VALUES(?,?,?,?,?,?,?,?,'deleted','verified_current',?) ON CONFLICT(authority_instance_id,tenant_or_org_id,pack_id,engagement_id,workspace_id,object_type,object_id) DO UPDATE SET current_revision=excluded.current_revision,lifecycle='deleted',freshness='verified_current',updated_at=excluded.updated_at`)
          .run(binding.authorityInstanceId,binding.tenantOrOrgId,binding.packId,binding.engagementId,workspaceId,objectType,objectId,revision,occurredAt);
        this.core.prepare(`INSERT INTO managed_object_revisions(revision_id,authority_instance_id,tenant_or_org_id,pack_id,engagement_id,workspace_id,object_type,object_id,revision,run_id,intent_id,command_id,evidence_id,provenance_json,payload_json,verified_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(randomUUID(),binding.authorityInstanceId,binding.tenantOrOrgId,binding.packId,binding.engagementId,workspaceId,objectType,objectId,revision,runId,command.intent_id,commandId,evidence.evidence_id,JSON.stringify({source:'agent_verified_delete'}),JSON.stringify({deleted:true,tombstoneAt:occurredAt,baselineDigest:crypto.createHash('sha256').update(canonical(baseline)).digest('hex')}),occurredAt);
      }
      this.core.exec('COMMIT;');
    } catch (error) { this.core.exec('ROLLBACK;'); throw error; }
    return true;
  }

  private projectVerifiedDeletionCascade(input: unknown, context: FeatureWorkerPortContext): true {
    const request = object(input, 'Verified deletion cascade projection');
    const runId = String(request.runId || '');
    const parentCommandId = String(request.parentCommandId || request.commandId || '');
    const command = this.core.prepare(`
      SELECT c.intent_id,c.state,c.plan_digest,c.operation_id,c.evidence_operation_ids_json,
        c.evidence_target_identity_key,c.evidence_request_digest,i.target_kind,i.target_key,
        i.intended_revision_json,i.state AS intent_state
      FROM feature_commands c
      JOIN managed_content_intents i
        ON i.intent_id=c.intent_id AND i.run_id=c.run_id AND i.plan_digest=c.plan_digest
      JOIN feature_runs r ON r.run_id=c.run_id
      WHERE c.command_id=? AND c.run_id=? AND r.feature_id=? AND r.feature_version=?
        AND r.state IN ('returning','verifying','reconciling')
    `).get(parentCommandId, runId, context.featureId, context.featureVersion) as Record<string, any> | undefined;
    if (!command || command.state !== 'readback_verified' || command.intent_state !== 'verified'
      || command.target_kind !== 'object') {
      throw new Error('Deletion cascade requires one receipt-verified parent object command.');
    }
    const intended = JSON.parse(String(command.intended_revision_json)) as Record<string, any>;
    const workspaceId = String(request.workspaceId || '');
    const objectType = String(request.objectType || '');
    const objectId = String(request.objectId || '');
    if (String(request.cascadeType || 'GRA') !== 'GRA' || objectType !== 'GRA'
      || String(intended.kind || '') !== 'object' || String(intended.objectType || '') !== 'GRA'
      || objectId !== String(intended.objectId || '') || workspaceId !== String(intended.workspace || '')
      || (request.targetKey !== undefined && String(request.targetKey || '') !== String(command.target_key || ''))
      || String(intended.key || '') !== String(command.target_key || '')) {
      throw new Error('Deletion cascade parent differs from the frozen GRA target.');
    }
    const baseline = object(intended.baseline, 'Deletion cascade frozen GRA baseline');
    const frozen = parseGraCascadeSnapshot(baseline.cascadeSnapshot, false);
    if (frozen.identity.assessment.riskAssessmentId !== objectId
      || frozen.identity.assessment.workspaceId !== workspaceId) {
      throw new Error('Deletion cascade frozen snapshot differs from the parent GRA or Workspace.');
    }
    const evidences = this.core.prepare(`
      SELECT e.evidence_id,e.evidence_digest,e.receipt_id,e.payload_json,
        o.response_digest,o.response_json,o.plan_digest,o.command_id,o.run_id,o.feature_id,o.feature_version,
        o.operation_package_digest,o.operation_id,o.authority_digest,o.frozen_target_key,
        o.target_identity_key,o.request_digest,o.authority_instance_id,o.tenant_or_org_id,o.pack_id,o.engagement_id
      FROM feature_command_evidence e
      JOIN feature_operation_receipts o
        ON o.receipt_id=e.receipt_id AND o.command_id=e.command_id AND o.run_id=e.run_id
      WHERE e.command_id=? AND e.run_id=? AND e.evidence_type IN ('readback','reconcile')
        AND e.receipt_id<>'' AND e.verified=1
      ORDER BY e.occurred_at
    `).all(parentCommandId, runId) as Array<Record<string, any>>;
    if (evidences.length !== 1) throw new Error('Deletion cascade requires one exact receipt-backed parent readback evidence record.');
    const evidence = evidences[0]!;
    const observed = object(JSON.parse(String(evidence.payload_json)), 'Deletion cascade authoritative readback');
    const receiptPayload = Object.fromEntries(Object.entries(observed).filter(([key]) => key !== '__operationReceiptId'));
    if (String(observed.__operationReceiptId || '') !== String(evidence.receipt_id)
      || canonicalDigest(receiptPayload) !== String(evidence.evidence_digest)
      || canonicalDigest(receiptPayload) !== String(evidence.response_digest)
      || canonical(JSON.parse(String(evidence.response_json))) !== canonical(receiptPayload)
      || String(evidence.plan_digest) !== String(command.plan_digest)
      || String(evidence.command_id) !== parentCommandId || String(evidence.run_id) !== runId
      || String(evidence.feature_id) !== context.featureId || String(evidence.feature_version) !== context.featureVersion
      || !/^sha256:[0-9a-f]{64}$/u.test(String(evidence.operation_package_digest || ''))
      || !(JSON.parse(String(command.evidence_operation_ids_json)) as string[]).includes(String(evidence.operation_id || ''))
      || String(evidence.frozen_target_key) !== String(command.target_key)
      || String(evidence.target_identity_key) !== String(command.evidence_target_identity_key)
      || String(evidence.request_digest) !== String(command.evidence_request_digest)) {
      throw new Error('Deletion cascade evidence is not exactly bound to its trusted Operation receipt.');
    }
    if (observed.deleted !== true || observed.verifiedCascade !== true
      || String(observed.objectId || observed.riskAssessmentId || '') !== objectId
      || String(observed.objectType || '') !== 'GRA') {
      throw new Error('Deletion cascade readback does not prove the parent GRA and its cascade are deleted.');
    }
    const observedWorkspaceIds = Array.isArray(observed.workspaceIds) ? observed.workspaceIds.map(String) : [];
    if (observedWorkspaceIds.length !== 1 || observedWorkspaceIds[0] !== workspaceId) {
      throw new Error('Deletion cascade readback Workspace differs from the frozen target.');
    }
    const readback = parseGraCascadeSnapshot(observed.cascadeSnapshot, true);
    if (readback.snapshotDigest !== frozen.snapshotDigest
      || canonical(readback.identity) !== canonical(frozen.identity)) {
      throw new Error('Deletion cascade readback child inventory is incomplete, additional, or differs from the frozen snapshot.');
    }
    const binding = returnAuthorityBinding(request.binding, 'Deletion cascade projection authority binding');
    const confirmation = this.core.prepare(`
      SELECT credential_digest,authority_instance_id,tenant_or_org_id,pack_id,engagement_id
      FROM feature_confirmations
      WHERE run_id=? AND plan_digest=? AND decision='approved'
      ORDER BY created_at DESC LIMIT 1
    `).get(runId, String(command.plan_digest)) as Record<string, any> | undefined;
    if (!confirmation || confirmation.authority_instance_id !== binding.authorityInstanceId
      || confirmation.tenant_or_org_id !== binding.tenantOrOrgId
      || confirmation.pack_id !== binding.packId || confirmation.engagement_id !== binding.engagementId
      || String(evidence.authority_instance_id) !== binding.authorityInstanceId
      || String(evidence.tenant_or_org_id) !== binding.tenantOrOrgId
      || String(evidence.pack_id) !== binding.packId || String(evidence.engagement_id) !== binding.engagementId
      || String(evidence.authority_digest) !== String(confirmation.credential_digest)) {
      throw new Error('Deletion cascade projection authority differs from the approved command or receipt.');
    }
    const metadata = {
      deleted: true,
      parentCommandId,
      evidenceId: String(evidence.evidence_id),
      snapshotDigest: frozen.snapshotDigest
    };
    const expectedObjectKeys = [
      `GRA\u0000${objectId}`,
      ...frozen.identity.risks.map((risk) => `Risk\u0000${risk.riskId}`),
      ...frozen.identity.controls.map((control) => `Control\u0000${control.controlId}`)
    ].sort();
    const expectedRelationKeys = frozen.identity.riskControls.map((relation) =>
      `${relation.riskId}\u0000${relation.controlId}\u0000${relation.riskRiskScopeId}\u0000${relation.riskScopeId}`
    ).sort();
    const priorObjects = this.core.prepare(`
      SELECT object_type,object_id,payload_json FROM managed_object_revisions
      WHERE run_id=? AND command_id=? AND evidence_id=? ORDER BY object_type,object_id,revision
    `).all(runId, parentCommandId, String(evidence.evidence_id)) as Array<Record<string, unknown>>;
    const priorRelations = this.core.prepare(`
      SELECT source_object_id,target_object_id,payload_json FROM managed_relation_revisions
      WHERE run_id=? AND command_id=? AND evidence_id=? AND relation_type='risk_control'
      ORDER BY source_object_id,target_object_id,revision
    `).all(runId, parentCommandId, String(evidence.evidence_id)) as Array<Record<string, unknown>>;
    const priorObjectTombstones = priorObjects.filter((row) => {
      try { return object(JSON.parse(String(row.payload_json)), 'Deletion cascade object projection').deleted === true; }
      catch { return false; }
    });
    const priorRelationTombstones = priorRelations.filter((row) => {
      try { return object(JSON.parse(String(row.payload_json)), 'Deletion cascade relation projection').deleted === true; }
      catch { return false; }
    });
    if (priorObjectTombstones.length || priorRelationTombstones.length) {
      const actualObjects = priorObjectTombstones.map((row) => `${String(row.object_type)}\u0000${String(row.object_id)}`).sort();
      const actualRelations = priorRelationTombstones.map((row) => {
        const payload = object(JSON.parse(String(row.payload_json)), 'Deletion cascade relation tombstone');
        if (payload.parentCommandId !== parentCommandId || payload.evidenceId !== metadata.evidenceId
          || payload.snapshotDigest !== metadata.snapshotDigest) return '';
        return `${String(row.source_object_id)}\u0000${String(row.target_object_id)}\u0000${String(payload.riskRiskScopeId || '')}\u0000${String(payload.riskScopeId || '')}`;
      }).sort();
      const objectMetadataValid = priorObjectTombstones.every((row) => {
        const payload = object(JSON.parse(String(row.payload_json)), 'Deletion cascade object tombstone');
        return payload.parentCommandId === parentCommandId && payload.evidenceId === metadata.evidenceId
          && payload.snapshotDigest === metadata.snapshotDigest;
      });
      if (objectMetadataValid && canonical(actualObjects) === canonical(expectedObjectKeys)
        && canonical(actualRelations) === canonical(expectedRelationKeys)) return true;
      throw new Error('Parent deletion command already owns a partial or different cascade projection.');
    }
    const occurredAt = now();
    this.core.exec('BEGIN IMMEDIATE;');
    try {
      const tombstoneObject = (targetType: string, targetId: string, frozenPayload: unknown): void => {
        const current = this.core.prepare(`
          SELECT current_revision FROM managed_objects
          WHERE authority_instance_id=? AND tenant_or_org_id=? AND pack_id=? AND engagement_id=?
            AND workspace_id=? AND object_type=? AND object_id=?
        `).get(
          binding.authorityInstanceId, binding.tenantOrOrgId, binding.packId, binding.engagementId,
          workspaceId, targetType, targetId
        ) as { current_revision: number } | undefined;
        let revision = Number(current?.current_revision || 0);
        if (!current) {
          revision = 1;
          this.core.prepare(`
            INSERT INTO managed_object_revisions(
              revision_id,authority_instance_id,tenant_or_org_id,pack_id,engagement_id,workspace_id,
              object_type,object_id,revision,run_id,intent_id,command_id,evidence_id,provenance_json,payload_json,verified_at
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          `).run(
            randomUUID(), binding.authorityInstanceId, binding.tenantOrOrgId, binding.packId, binding.engagementId,
            workspaceId, targetType, targetId, revision, runId, command.intent_id, parentCommandId,
            evidence.evidence_id, JSON.stringify({ source: 'adopted_on_verified_gra_cascade', ...metadata }),
            JSON.stringify(frozenPayload), occurredAt
          );
        }
        revision += 1;
        this.core.prepare(`
          INSERT INTO managed_objects(
            authority_instance_id,tenant_or_org_id,pack_id,engagement_id,workspace_id,
            object_type,object_id,current_revision,lifecycle,freshness,updated_at
          ) VALUES(?,?,?,?,?,?,?,?,'deleted','verified_current',?)
          ON CONFLICT(authority_instance_id,tenant_or_org_id,pack_id,engagement_id,workspace_id,object_type,object_id)
          DO UPDATE SET current_revision=excluded.current_revision,lifecycle='deleted',freshness='verified_current',updated_at=excluded.updated_at
        `).run(
          binding.authorityInstanceId, binding.tenantOrOrgId, binding.packId, binding.engagementId,
          workspaceId, targetType, targetId, revision, occurredAt
        );
        this.core.prepare(`
          INSERT INTO managed_object_revisions(
            revision_id,authority_instance_id,tenant_or_org_id,pack_id,engagement_id,workspace_id,
            object_type,object_id,revision,run_id,intent_id,command_id,evidence_id,provenance_json,payload_json,verified_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          randomUUID(), binding.authorityInstanceId, binding.tenantOrOrgId, binding.packId, binding.engagementId,
          workspaceId, targetType, targetId, revision, runId, command.intent_id, parentCommandId,
          evidence.evidence_id, JSON.stringify({ source: 'agent_verified_gra_cascade_delete', ...metadata }),
          JSON.stringify({ ...metadata, tombstoneAt: occurredAt }), occurredAt
        );
      };
      tombstoneObject('GRA', objectId, baseline);
      for (const risk of frozen.identity.risks) tombstoneObject('Risk', risk.riskId, risk);
      for (const control of frozen.identity.controls) tombstoneObject('Control', control.controlId, control);
      for (const relation of frozen.identity.riskControls) {
        const riskControlIdentity = { ...relation, graId: objectId };
        const canonicalRelationKey = `risk-control|${canonicalDigest(riskControlIdentity)}`;
        const resolved = this.resolveDeletionRelation(
          binding, workspaceId, 'risk_control', canonicalRelationKey,
          relation.riskId, relation.controlId, riskControlIdentity
        );
        let revision = resolved.currentRevision;
        if (revision === 0) {
          revision = 1;
          this.core.prepare(`
            INSERT INTO managed_relation_revisions(
              revision_id,authority_instance_id,tenant_or_org_id,pack_id,engagement_id,workspace_id,
              relation_type,relation_key,source_object_id,target_object_id,revision,run_id,intent_id,
              command_id,evidence_id,payload_json,verified_at
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          `).run(
            randomUUID(), binding.authorityInstanceId, binding.tenantOrOrgId, binding.packId, binding.engagementId,
            workspaceId, 'risk_control', resolved.relationKey, relation.riskId, relation.controlId, revision,
            runId, command.intent_id, parentCommandId, evidence.evidence_id,
            JSON.stringify({ source: 'adopted_on_verified_gra_cascade', ...riskControlIdentity, ...metadata }), occurredAt
          );
        }
        revision += 1;
        this.core.prepare(`
          INSERT INTO managed_relations(
            authority_instance_id,tenant_or_org_id,pack_id,engagement_id,workspace_id,relation_type,
            relation_key,source_object_id,target_object_id,current_revision,lifecycle,freshness,updated_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,'deleted','verified_current',?)
          ON CONFLICT(authority_instance_id,tenant_or_org_id,pack_id,engagement_id,workspace_id,relation_type,relation_key)
          DO UPDATE SET source_object_id=excluded.source_object_id,target_object_id=excluded.target_object_id,
            current_revision=excluded.current_revision,lifecycle='deleted',freshness='verified_current',updated_at=excluded.updated_at
        `).run(
          binding.authorityInstanceId, binding.tenantOrOrgId, binding.packId, binding.engagementId,
          workspaceId, 'risk_control', resolved.relationKey, relation.riskId, relation.controlId, revision, occurredAt
        );
        this.core.prepare(`
          INSERT INTO managed_relation_revisions(
            revision_id,authority_instance_id,tenant_or_org_id,pack_id,engagement_id,workspace_id,
            relation_type,relation_key,source_object_id,target_object_id,revision,run_id,intent_id,
            command_id,evidence_id,payload_json,verified_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          randomUUID(), binding.authorityInstanceId, binding.tenantOrOrgId, binding.packId, binding.engagementId,
          workspaceId, 'risk_control', resolved.relationKey, relation.riskId, relation.controlId, revision,
          runId, command.intent_id, parentCommandId, evidence.evidence_id,
          JSON.stringify({ ...metadata, ...riskControlIdentity, tombstoneAt: occurredAt }), occurredAt
        );
      }
      this.core.exec('COMMIT;');
    } catch (error) { this.core.exec('ROLLBACK;'); throw error; }
    return true;
  }

  private finishReturn(input: unknown, context: FeatureWorkerPortContext): true {
    const request = object(input, 'Return completion'); const runId = String(request.runId || '');
    const run = this.core.prepare(`SELECT state,state_revision FROM feature_runs WHERE run_id=? AND feature_id=?`).get(runId, context.featureId) as {state:string;state_revision:number}|undefined;
    if (!run || !['returning','verifying','uncertain','reconciling'].includes(run.state)) throw new Error('Return completion Run state is invalid.');
    const outcome=String(request.outcome||''); const toState=outcome==='succeeded'?'succeeded':outcome==='uncertain'?'uncertain':'failed';
    const transitions:Record<string,string[]>={returning:['verifying','failed','uncertain'],verifying:['succeeded','failed','uncertain'],uncertain:['reconciling'],reconciling:['succeeded','failed','uncertain']};
    let state=run.state; let revision=run.state_revision;
    if (toState === 'succeeded') {
      const incomplete = this.core.prepare(`SELECT COUNT(*) AS count FROM managed_content_intents WHERE run_id=? AND state<>'verified'`).get(runId) as {count:number};
      const openCommands = this.core.prepare(`SELECT COUNT(*) AS count FROM feature_commands WHERE run_id=? AND state NOT IN ('readback_verified','closed_not_applied')`).get(runId) as {count:number};
      const missingProjection = this.core.prepare(`SELECT COUNT(*) AS count FROM managed_content_intents i WHERE i.run_id=? AND i.state='verified' AND NOT EXISTS (SELECT 1 FROM feature_commands c WHERE c.intent_id=i.intent_id AND (c.state='closed_not_applied' OR (c.state='readback_verified' AND (EXISTS(SELECT 1 FROM managed_object_revisions o WHERE o.command_id=c.command_id AND o.run_id=c.run_id) OR EXISTS(SELECT 1 FROM managed_relation_revisions r WHERE r.command_id=c.command_id AND r.run_id=c.run_id)))))`).get(runId) as {count:number};
      if (incomplete.count || openCommands.count || missingProjection.count) throw new Error('Return cannot succeed while intents, commands, or required verified projections are incomplete.');
    }
    if (state==='returning' && toState==='succeeded') { revision=this.transitionRun({runId,expectedRevision:revision,toState:'verifying',eventType:'return.commit_batch_complete'},context); state='verifying'; }
    if (!transitions[state]?.includes(toState)) throw new Error(`Illegal return completion: ${state} -> ${toState}.`);
    this.transitionRun({runId,expectedRevision:revision,toState,eventType:`return.${toState}`,error:String(request.error||'')},context);
    return true;
  }

  private recordBootstrapCapabilityEvidence(input: unknown, context: FeatureWorkerPortContext): { recorded: boolean; expiresAt: string } {
    if (!context.allowMutation) throw new Error('Bootstrap capability evidence requires an authorized mutation invocation.');
    const request = object(input, 'Bootstrap capability evidence'); const runId = String(request.runId || '');
    const scenarioId = String(request.scenarioId || ''); const capabilityId = String(request.capabilityId || '');
    if (request.schemaVersion !== 'omnia.feature-capability-evidence-bootstrap/v1'
      || !/^[a-z0-9][a-z0-9._-]{2,127}$/u.test(scenarioId)
      || !/^[a-z0-9][a-z0-9._-]{2,127}$/u.test(capabilityId)) {
      throw new Error('Bootstrap capability evidence schema or capability declaration is invalid.');
    }
    const binding = returnAuthorityBinding(request.connectorBinding, 'Bootstrap Connector binding'); const safety = object(request.safetyLock, 'Bootstrap safety scope');
    const run = this.core.prepare(`SELECT state,feature_version FROM feature_runs WHERE run_id=? AND feature_id=?`)
      .get(runId, context.featureId) as { state: string; feature_version: string } | undefined;
    if (!run || !['returning','verifying'].includes(run.state) || !this.currentActivationOwnsRun(runId, context)) throw new Error('Bootstrap evidence requires the current verified Return batch before terminal completion.');
    const durableIntents = this.core.prepare(`SELECT COUNT(*) AS count FROM managed_content_intents WHERE run_id=?`).get(runId) as { count: number };
    const durableCommands = this.core.prepare(`SELECT COUNT(*) AS count FROM feature_commands WHERE run_id=?`).get(runId) as { count: number };
    const incomplete = this.core.prepare(`SELECT COUNT(*) AS count FROM managed_content_intents WHERE run_id=? AND state<>'verified'`).get(runId) as { count: number };
    const badCommands = this.core.prepare(`SELECT COUNT(*) AS count FROM feature_commands WHERE run_id=? AND state NOT IN ('readback_verified','closed_not_applied')`).get(runId) as { count: number };
    const badReadback = this.core.prepare(`
      WITH RECURSIVE lineage(feature_version) AS (
        SELECT feature_version FROM feature_runs WHERE run_id=? AND feature_id=?
        UNION
        SELECT h.target_feature_version FROM lineage l
        JOIN feature_operation_handoffs h ON h.feature_id=? AND h.source_feature_version=l.feature_version
        WHERE h.phase='finalized'
      )
      SELECT COUNT(*) AS count FROM feature_commands c
      WHERE c.run_id=? AND c.state='readback_verified' AND NOT EXISTS(
        SELECT 1 FROM feature_command_evidence e
        JOIN feature_operation_receipts r ON r.receipt_id=e.receipt_id
        WHERE e.command_id=c.command_id AND e.run_id=c.run_id
          AND e.evidence_type IN ('readback','reconcile') AND e.verified=1
          AND r.command_id=c.command_id AND r.run_id=c.run_id AND r.plan_digest=c.plan_digest
          AND r.feature_id=? AND r.feature_version IN (SELECT feature_version FROM lineage)
      )
    `).get(runId, context.featureId, context.featureId, runId, context.featureId) as { count: number };
    if (durableIntents.count < 1 || durableCommands.count < 1 || incomplete.count || badCommands.count || badReadback.count) {
      throw new Error('Bootstrap evidence requires durable intents, commands, and authoritative read-back evidence for the completed Return batch.');
    }
    const confirmation = this.core.prepare(`SELECT authority_instance_id,tenant_or_org_id,pack_id,engagement_id FROM feature_confirmations WHERE run_id=? AND decision='approved' ORDER BY created_at DESC LIMIT 1`).get(runId) as Record<string, unknown> | undefined;
    const workspaceIds = Array.isArray(safety.workspaceIds) ? [...new Set(safety.workspaceIds.map(String))].sort() : [];
    if (!confirmation || workspaceIds.length < 1 || safety.enabled !== true
      || String(binding.authorityInstanceId || '') !== String(confirmation.authority_instance_id)
      || String(binding.tenantOrOrgId || '') !== String(confirmation.tenant_or_org_id)
      || String(binding.packId || '') !== String(confirmation.pack_id)
      || String(binding.engagementId || '') !== String(confirmation.engagement_id)
      || String(safety.engagementId || '') !== String(binding.engagementId || '')) throw new Error('Bootstrap evidence scope differs from the approved authority and safety lock.');
    const missingBeforeRepair = this.core.prepare(`
      SELECT c.command_id,i.intended_revision_json,e.payload_json
      FROM managed_content_intents i
      JOIN feature_commands c ON c.intent_id=i.intent_id AND c.run_id=i.run_id
      JOIN feature_command_evidence e ON e.command_id=c.command_id AND e.run_id=c.run_id
        AND e.evidence_type IN ('readback','reconcile') AND e.verified=1 AND e.receipt_id<>''
      WHERE i.run_id=? AND i.state='verified' AND c.state='readback_verified'
        AND NOT EXISTS(SELECT 1 FROM managed_object_revisions o WHERE o.command_id=c.command_id AND o.run_id=c.run_id)
        AND NOT EXISTS(SELECT 1 FROM managed_relation_revisions r WHERE r.command_id=c.command_id AND r.run_id=c.run_id)
      GROUP BY c.command_id ORDER BY c.created_at
    `).all(runId) as Array<{command_id:string;intended_revision_json:string;payload_json:string}>;
    for (const missing of missingBeforeRepair) {
      const intended = JSON.parse(missing.intended_revision_json) as Record<string,unknown>;
      const parentTargetKey = String(intended.graTargetKey || intended.objectTargetKey || '');
      if (!parentTargetKey || ['relation','risk_control'].includes(String(intended.kind || ''))) continue;
      const parent = this.core.prepare(`
        SELECT o.object_id FROM managed_content_intents i
        JOIN feature_commands c ON c.intent_id=i.intent_id AND c.run_id=i.run_id AND c.state='readback_verified'
        JOIN managed_object_revisions o ON o.command_id=c.command_id AND o.run_id=c.run_id
        WHERE i.run_id=? AND i.target_kind='object' AND i.target_key=? AND i.state='verified'
        ORDER BY o.verified_at DESC LIMIT 1
      `).get(runId,parentTargetKey) as {object_id:string}|undefined;
      if (!parent) continue;
      this.projectVerifiedReturn({runId,commandId:missing.command_id,binding:request.connectorBinding,
        workspaceId:String(intended.workspace||''),projectionKind:'object',objectType:String(intended.objectType||''),objectId:parent.object_id,
        provenance:{rowKey:String(intended.rowKey||''),targetKey:String(intended.key||''),repair:'receipt_backed_projection'},
        payload:JSON.parse(missing.payload_json)},context);
    }
    const missingProjection = this.core.prepare(`SELECT COUNT(*) AS count FROM managed_content_intents i WHERE i.run_id=? AND i.state='verified' AND NOT EXISTS (SELECT 1 FROM feature_commands c WHERE c.intent_id=i.intent_id AND (c.state='closed_not_applied' OR (c.state='readback_verified' AND (EXISTS(SELECT 1 FROM managed_object_revisions o WHERE o.command_id=c.command_id AND o.run_id=c.run_id) OR EXISTS(SELECT 1 FROM managed_relation_revisions r WHERE r.command_id=c.command_id AND r.run_id=c.run_id)))))`).get(runId) as {count:number};
    if (missingProjection.count) throw new Error('Bootstrap evidence requires a receipt-backed Managed Content projection for every verified command.');
    const operationRows = this.core.prepare(`SELECT DISTINCT operation_package_digest FROM feature_operation_receipts WHERE run_id=? AND feature_id=? AND feature_version=?`).all(runId, context.featureId, context.featureVersion) as Array<{ operation_package_digest: string }>;
    if (operationRows.length !== 1 || !/^sha256:[0-9a-f]{64}$/u.test(operationRows[0]!.operation_package_digest)) throw new Error('Bootstrap evidence requires one exact verified Operation package digest.');
    const commandEvidence = this.core.prepare(`
      SELECT c.command_id,c.operation_id,c.plan_digest,i.target_key,c.state,e.evidence_type,e.evidence_digest,e.receipt_id,
        r.feature_version,r.operation_package_digest,r.target_identity_key,r.workspace_ids_json
      FROM feature_commands c
      JOIN managed_content_intents i ON i.intent_id=c.intent_id AND i.run_id=c.run_id AND i.plan_digest=c.plan_digest
      JOIN feature_command_evidence e ON e.command_id=c.command_id AND e.run_id=c.run_id AND e.verified=1
      JOIN feature_operation_receipts r ON r.receipt_id=e.receipt_id AND r.command_id=c.command_id AND r.run_id=c.run_id
        AND r.plan_digest=c.plan_digest AND r.feature_id=?
      WHERE c.run_id=? AND e.evidence_type IN ('readback','reconcile')
      ORDER BY c.command_id,e.occurred_at
    `).all(context.featureId, runId) as Array<Record<string,unknown>>;
    if (commandEvidence.length < 1 || commandEvidence.some((row) => !this.runLineageIncludesVersion(runId, context.featureId, String(row.feature_version || '')))) throw new Error('Bootstrap capability evidence requires authoritative read-back receipts inside the active Feature handoff lineage.');
    const evidenceDigest = crypto.createHash('sha256').update(canonical({ runId, scenarioId, capabilityId, commandEvidence })).digest('hex');
    const verifiedAt = now(); const expiresAt = new Date(Date.parse(verifiedAt) + 30 * 24 * 60 * 60_000).toISOString();
    this.core.exec('BEGIN IMMEDIATE;');
    try {
      for (const workspaceId of workspaceIds) this.core.prepare(`
        INSERT INTO feature_capability_evidence(capability_evidence_id,feature_id,feature_version,operation_package_digest,scenario_id,capability_id,authority_instance_id,tenant_or_org_id,pack_contract_id,engagement_id,workspace_id,automated_status,portable_status,canary_status,readback_status,evidence_digest,verified,verified_at,expires_at,revoked_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,'passed','passed','passed','passed',?,1,?,?,'')
        ON CONFLICT(feature_id,feature_version,operation_package_digest,scenario_id,capability_id,authority_instance_id,tenant_or_org_id,pack_contract_id,engagement_id,workspace_id)
        DO UPDATE SET automated_status='passed',portable_status='passed',canary_status='passed',readback_status='passed',evidence_digest=excluded.evidence_digest,verified=1,verified_at=excluded.verified_at,expires_at=excluded.expires_at,revoked_at=''
      `).run(randomUUID(),context.featureId,context.featureVersion,operationRows[0]!.operation_package_digest,scenarioId,capabilityId,String(binding.authorityInstanceId),String(binding.tenantOrOrgId),String(binding.packId),String(binding.engagementId),workspaceId,evidenceDigest,verifiedAt,expiresAt);
      this.core.exec('COMMIT;');
    } catch (error) { this.core.exec('ROLLBACK;'); throw error; }
    return { recorded: true, expiresAt };
  }

  private recordTemplateMetadata(input: unknown, context: FeatureWorkerPortContext): true {
    const request = object(input, 'Template metadata');
    if (request.status !== 'candidate') throw new Error('Worker-created TemplateVersion must remain candidate until separately authorized.');
    const output = this.core.prepare(`
      SELECT sha256 FROM feature_artifacts WHERE artifact_id=? AND feature_id=? AND run_id=? AND kind='template_instance'
    `).get(String(request.outputArtifactId || ''), context.featureId, String(request.runId || '')) as { sha256: string } | undefined;
    if (!output || output.sha256 !== request.outputFileDigest) throw new Error('TemplateInstance output artifact digest mismatch.');
    if (!/^[0-9a-f]{64}$/u.test(String(request.baseFileDigest || ''))) throw new Error('TemplateVersion base digest is invalid.');
    if (!/^sha256:[0-9a-f]{64}$/u.test(String(request.basePackageDigest || ''))) throw new Error('TemplateVersion package digest is invalid.');
    const base = this.core.prepare(`
      SELECT member_digest, package_digest, asset_kind
      FROM feature_managed_assets
      WHERE feature_id=? AND feature_version=? AND member_path=?
    `).get(context.featureId, context.featureVersion, String(request.baseAssetPath || '')) as {
      member_digest: string; package_digest: string; asset_kind: string;
    } | undefined;
    if (!base || base.asset_kind !== 'runtime_template_base'
      || base.member_digest !== request.baseFileDigest || base.package_digest !== request.basePackageDigest) {
      throw new Error('TemplateVersion base is not the signed managed runtime-template asset.');
    }
    const governancePath = String(request.governanceArtifactId || '').replace(/^ofp-member:/u, '');
    const governance = this.core.prepare(`
      SELECT member_digest, asset_kind FROM feature_managed_assets
      WHERE feature_id=? AND feature_version=? AND member_path=?
    `).get(context.featureId, context.featureVersion, governancePath) as { member_digest: string; asset_kind: string } | undefined;
    if (!governance || governance.asset_kind !== 'governance') {
      throw new Error('TemplateVersion governance source is not a signed managed governance asset.');
    }
    for (const field of ['semanticDigest', 'instanceSemanticDigest', 'patchDigest', 'outputFileDigest']) {
      if (!/^[0-9a-f]{64}$/u.test(String(request[field] || ''))) throw new Error(`Template metadata ${field} is invalid.`);
    }
    for (const field of ['templateVersionId', 'templateInstanceId', 'templateId', 'version', 'schemaVersion', 'owner', 'license']) {
      if (!String(request[field] || '').trim()) throw new Error(`Template metadata ${field} is required.`);
    }
    const createdAt = now();
    this.core.exec('BEGIN IMMEDIATE;');
    try {
      this.core.prepare(`
        INSERT OR IGNORE INTO template_versions(
          template_version_id, template_id, version, status, source_artifact_id, file_digest,
          semantic_digest, schema_version, owner, license, authorization_ref, requested_by,
          published_by, published_at, created_at
        ) VALUES(?, ?, ?, 'candidate', ?, ?, ?, ?, ?, ?, '', '', '', '', ?)
      `).run(
        String(request.templateVersionId || ''), String(request.templateId || ''), String(request.version || ''),
        `ofp-member:${governancePath}:sha256:${governance.member_digest}`, String(request.baseFileDigest || ''), String(request.semanticDigest || ''),
        String(request.schemaVersion || ''), String(request.owner || 'unassigned'), String(request.license || 'unconfirmed'), createdAt
      );
      const version = this.core.prepare(`
        SELECT file_digest, semantic_digest, status FROM template_versions WHERE template_version_id=?
      `).get(String(request.templateVersionId)) as { file_digest: string; semantic_digest: string; status: string } | undefined;
      if (!version || version.file_digest !== request.baseFileDigest || version.semantic_digest !== request.semanticDigest || version.status !== 'candidate') {
        throw new Error('TemplateVersion identity or immutable base digest drifted.');
      }
      this.core.prepare(`
        INSERT INTO template_instances(
          template_instance_id, run_id, template_version_id, source_artifact_id, output_artifact_id,
          patch_digest, semantic_digest, output_file_digest, governance_digest, state, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?)
      `).run(String(request.templateInstanceId || ''), String(request.runId), String(request.templateVersionId),
        String(request.sourceArtifactId), String(request.outputArtifactId), String(request.patchDigest || ''),
        String(request.instanceSemanticDigest || ''), String(request.outputFileDigest), governance.member_digest, createdAt, createdAt);
      this.core.prepare(`INSERT INTO template_instance_field_revisions(template_instance_id,field_revision_id,field_key,revision,bound_at) SELECT ?,r.field_revision_id,r.field_key,r.revision,? FROM feature_field_revisions r WHERE r.run_id=? AND r.revision=(SELECT MAX(r2.revision) FROM feature_field_revisions r2 WHERE r2.run_id=r.run_id AND r2.field_key=r.field_key)`).run(String(request.templateInstanceId||''),createdAt,String(request.runId));
      this.core.prepare(`UPDATE feature_field_revisions SET template_instance_id=? WHERE run_id=? AND template_instance_id='' AND field_revision_id IN (SELECT field_revision_id FROM template_instance_field_revisions WHERE template_instance_id=?)`).run(String(request.templateInstanceId||''),String(request.runId),String(request.templateInstanceId||''));
      this.core.prepare(`
        UPDATE feature_runs SET template_version_id=?, output_artifact_id=?, updated_at=?
        WHERE run_id=? AND feature_id=?
      `).run(String(request.templateVersionId), String(request.outputArtifactId), createdAt, String(request.runId), context.featureId);
      this.core.exec('COMMIT;');
    } catch (error) {
      this.core.exec('ROLLBACK;');
      throw error;
    }
    return true;
  }

  emit(input: unknown, context: FeatureWorkerPortContext): string {
    const event = object(input, 'Feature event');
    if (event.type !== 'workspace.authoritative_refresh_requested') {
      throw new Error('Feature event type is not allowlisted.');
    }
    const eventId = randomUUID();
    this.core.prepare(`
      INSERT INTO feature_runtime_events(
        event_id, feature_id, feature_version, event_type, payload_json, status, created_at, completed_at, error
      ) VALUES(?, ?, ?, ?, ?, 'pending', ?, '', '')
    `).run(eventId, context.featureId, context.featureVersion, event.type, JSON.stringify(event), now());
    return eventId;
  }

  private upsertManagedContent(input: unknown, context: FeatureWorkerPortContext): true {
    object(input, 'Managed content record');
    void context;
    throw new Error('Legacy Managed Content projection is disabled; only receipt-backed signed Operation projection may advance current state.');
  }
}
