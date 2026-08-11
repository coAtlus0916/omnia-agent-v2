#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const CREATE_FEATURE_ID = 'omnia.create-associate';
const DELETE_FEATURE_ID = 'omnia.delete-elements';
const VALIDATION_SUFFIX = '.xlsx.validation.json';
const BATCH_PATTERN = /^Phase1-TEST-supported-([HL])([1-4])-.+\.xlsx\.validation\.json$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
const PACKAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const EXPECTED_KIND_COUNTS = Object.freeze({ APP: 8, DB: 6, OS: 8, TOOL: 6, DCNO: 2 });
const OBJECT_TYPES = Object.freeze({ APP: 'Application', DB: 'Infrastructure', OS: 'Infrastructure', TOOL: 'ITTool', DCNO: 'Infrastructure' });
const DEPENDENCY_RELATION_TYPES = Object.freeze({ DB: 'InfrastructureApplication', OS: 'InfrastructureApplication', TOOL: 'ItToolApplication', DCNO: 'InfrastructureApplication' });

export class PendingAcceptanceError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'PendingAcceptanceError';
    this.details = details;
  }
}

function requiredText(value, label) {
  const result = String(value ?? '').trim();
  if (!result) throw new Error(`${label} is required.`);
  return result;
}

function exactVersion(value, label) {
  const result = requiredText(value, label);
  if (!/^\d+\.\d+\.\d+$/u.test(result)) throw new Error(`${label} must be an exact x.y.z Feature version.`);
  return result;
}

function parseJson(value, label) {
  try { return JSON.parse(String(value)); }
  catch (error) { throw new Error(`${label} is not valid JSON: ${error.message}`); }
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PendingAcceptanceError(`${label} is not a complete object.`);
  return value;
}

function exactKeys(value, keys, label) {
  const actual = Object.keys(record(value, label)).sort(); const expected = [...keys].sort();
  if (canonical(actual) !== canonical(expected)) throw new PendingAcceptanceError(`${label} has an unexpected or incomplete field set.`);
}

function evidenceText(value, label) {
  const result = String(value ?? '').trim();
  if (!result) throw new PendingAcceptanceError(`${label} is missing from live evidence.`);
  return result;
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function digest(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value)).digest('hex');
}

function fileDigest(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function tableNames(db) {
  return new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map((row) => String(row.name)));
}

function requireTables(db, names, label) {
  const available = tableNames(db);
  const missing = names.filter((name) => !available.has(name));
  if (missing.length) throw new Error(`${label} is missing required table(s): ${missing.join(', ')}.`);
}

function deepValues(value, key) {
  const found = [];
  const visit = (candidate) => {
    if (!candidate || typeof candidate !== 'object') return;
    if (Array.isArray(candidate)) { for (const item of candidate) visit(item); return; }
    for (const [name, item] of Object.entries(candidate)) {
      if (name === key) found.push(item);
      visit(item);
    }
  };
  visit(value);
  return found;
}

function containsExact(value, key, expected) {
  return deepValues(value, key).some((candidate) => String(candidate) === String(expected));
}

function containsLabel(value, keys, expected) {
  const normalized = String(expected).normalize('NFKC').toLocaleLowerCase('en-US');
  return keys.some((key) => deepValues(value, key).some((candidate) => String(candidate).normalize('NFKC').toLocaleLowerCase('en-US') === normalized));
}

function one(rows, label) {
  if (rows.length !== 1) throw new PendingAcceptanceError(`${label}: expected exactly one live proof, found ${rows.length}.`);
  return rows[0];
}

export function loadAcceptanceManifest(evidenceDirectory) {
  const root = path.resolve(evidenceDirectory);
  const validationNames = fs.readdirSync(root).filter((name) => BATCH_PATTERN.test(name)).sort();
  if (validationNames.length !== 8) throw new Error(`Acceptance input must contain exactly 8 supported batch validations; found ${validationNames.length}.`);
  const batches = validationNames.map((validationName) => {
    const match = BATCH_PATTERN.exec(validationName);
    const workbookName = validationName.slice(0, -'.validation.json'.length);
    const workbookPath = path.join(root, workbookName);
    const validationPath = path.join(root, validationName);
    if (!fs.existsSync(workbookPath)) throw new Error(`Frozen workbook is missing: ${workbookName}.`);
    const validation = parseJson(fs.readFileSync(validationPath, 'utf8'), validationName);
    if (validation.schemaVersion !== 'omnia.create-associate.acceptance-workbook-validation/v1'
      || validation.validationScope !== 'offline-installed-package-parser-validator-plan-only'
      || validation.liveOmniaCanary !== false) {
      throw new Error(`${validationName} is not an offline-only frozen acceptance validation.`);
    }
    if (!HEX64.test(String(validation.workbookSha256 || '')) || fileDigest(workbookPath) !== String(validation.workbookSha256)) {
      throw new Error(`${workbookName} differs from its frozen SHA256.`);
    }
    if (!Array.isArray(validation.rows) || !validation.rows.length) throw new Error(`${validationName} has no expected rows.`);
    const mode = match[1] === 'H' ? 'Higher' : 'Lower';
    if (validation.matrix?.mode !== mode) throw new Error(`${validationName} mode differs from its batch identity.`);
    const seen = new Set();
    const rows = validation.rows.map((row, index) => {
      const elementId = requiredText(row.elementId, `${validationName} rows[${index}].elementId`);
      const kind = requiredText(row.kind, `${elementId}.kind`);
      if (!Object.hasOwn(OBJECT_TYPES, kind) || row.rait !== mode || seen.has(elementId)) throw new Error(`${validationName} has a duplicate or invalid kind/RAIT row: ${elementId}.`);
      seen.add(elementId);
      const dependencies = Array.isArray(row.dependencies) ? row.dependencies.map(String) : [];
      const riskControlRequired = Number(row.riskControlRequired);
      if (!Number.isSafeInteger(riskControlRequired) || riskControlRequired < 0) throw new Error(`${elementId} has an invalid riskControlRequired count.`);
      return { elementId, kind, rait: mode, dependencies, riskControlRequired, subtype: validation.matrix?.[`${kind.toLocaleLowerCase('en-US')}Type`] ?? (kind === 'DCNO' ? '网络' : '') };
    });
    return { validationName, workbookName, workbookPath, workbookSha256: validation.workbookSha256, inputPackageVersion: String(validation.packageVersion || ''), mode, rows };
  });
  const rows = batches.flatMap((batch) => batch.rows.map((row) => ({ ...row, batch: batch.workbookName })));
  if (rows.length !== 30 || new Set(rows.map((row) => row.elementId)).size !== 30) throw new Error(`Frozen acceptance matrix must contain exactly 30 unique combinations; found ${rows.length}.`);
  const counts = Object.fromEntries(Object.keys(EXPECTED_KIND_COUNTS).map((kind) => [kind, rows.filter((row) => row.kind === kind).length]));
  if (canonical(counts) !== canonical(EXPECTED_KIND_COUNTS)) throw new Error(`Frozen acceptance kind coverage drifted: ${canonical(counts)}.`);
  for (const kind of Object.keys(EXPECTED_KIND_COUNTS)) {
    const modes = new Set(rows.filter((row) => row.kind === kind).map((row) => row.rait));
    if (modes.size !== 2 || !modes.has('Higher') || !modes.has('Lower')) throw new Error(`${kind} is not covered in both Higher and Lower modes.`);
  }
  return { schemaVersion: 'omnia.live-acceptance-input/v1', evidenceDirectory: root, batches, rows, counts };
}

const CORE_TABLES = [
  'feature_runs', 'feature_artifacts', 'managed_content_intents', 'feature_commands', 'feature_command_specs',
  'feature_confirmations', 'feature_operation_receipts', 'feature_command_evidence', 'managed_objects',
  'managed_object_revisions', 'managed_relations', 'managed_relation_revisions'
];

function trustedProjection(db, revision, featureId, featureVersion, allowedMutationPrefix) {
  const rows = db.prepare(`
    SELECT c.operation_id AS mutation_operation_id,c.state AS command_state,c.plan_digest AS command_plan_digest,
      c.request_digest AS command_request_digest,c.evidence_operation_ids_json,c.evidence_target_identity_key,
      c.evidence_request_digest,c.intent_id,i.target_key,i.state AS intent_state,i.intended_revision_json,s.spec_json,
      e.evidence_id,e.evidence_type,e.evidence_digest,e.receipt_id,e.verified,e.payload_json,
      o.feature_id,o.feature_version,o.operation_package_digest,o.operation_id AS evidence_operation_id,
      o.authority_digest,o.connector_id,o.session_generation,o.engagement_id,o.frozen_target_key,
      o.target_identity_key,o.workspace_ids_json,o.plan_digest AS receipt_plan_digest,o.request_digest AS receipt_request_digest,
      o.response_digest,o.response_json,o.authority_instance_id,o.tenant_or_org_id,o.pack_id,
      f.credential_digest,f.connector_id AS confirmation_connector_id,f.session_generation AS confirmation_session_generation,
      f.engagement_id AS confirmation_engagement_id,f.authority_instance_id AS confirmation_authority_instance_id,
      f.tenant_or_org_id AS confirmation_tenant_or_org_id,f.pack_id AS confirmation_pack_id,r.plan_digest AS run_plan_digest
    FROM feature_commands c
    JOIN feature_runs r ON r.run_id=c.run_id
    JOIN managed_content_intents i ON i.intent_id=c.intent_id AND i.run_id=c.run_id AND i.plan_digest=c.plan_digest
    LEFT JOIN feature_command_specs s ON s.command_id=c.command_id AND s.run_id=c.run_id
    JOIN feature_command_evidence e ON e.evidence_id=? AND e.command_id=c.command_id AND e.run_id=c.run_id
    JOIN feature_operation_receipts o ON o.receipt_id=e.receipt_id AND o.command_id=e.command_id AND o.run_id=e.run_id
    JOIN feature_confirmations f ON f.run_id=c.run_id AND f.plan_digest=c.plan_digest AND f.decision='approved'
    WHERE c.command_id=? AND c.run_id=? AND r.feature_id=? AND r.feature_version=?
    ORDER BY f.created_at DESC
  `).all(String(revision.evidence_id), String(revision.command_id), String(revision.run_id), featureId, featureVersion);
  const proof = one(rows, `Trusted projection ${revision.run_id}/${revision.command_id}/${revision.evidence_id}`);
  if (proof.command_state !== 'readback_verified' || proof.intent_state !== 'verified'
    || !String(proof.mutation_operation_id).startsWith(allowedMutationPrefix)
    || !['readback', 'reconcile'].includes(String(proof.evidence_type)) || Number(proof.verified) !== 1
    || !proof.receipt_id || proof.feature_id !== featureId || proof.feature_version !== featureVersion
    || !PACKAGE_DIGEST.test(String(proof.operation_package_digest || ''))
    || !HEX64.test(String(proof.command_request_digest || '')) || !HEX64.test(String(proof.command_plan_digest || ''))
    || proof.command_plan_digest !== proof.run_plan_digest || proof.receipt_plan_digest !== proof.command_plan_digest
    || proof.frozen_target_key !== proof.target_key || proof.target_identity_key !== proof.evidence_target_identity_key
    || proof.receipt_request_digest !== proof.evidence_request_digest
    || proof.authority_digest !== proof.credential_digest || proof.connector_id !== proof.confirmation_connector_id
    || Number(proof.session_generation) !== Number(proof.confirmation_session_generation)
    || proof.engagement_id !== proof.confirmation_engagement_id
    || proof.authority_instance_id !== proof.confirmation_authority_instance_id
    || proof.tenant_or_org_id !== proof.confirmation_tenant_or_org_id || proof.pack_id !== proof.confirmation_pack_id) {
    throw new PendingAcceptanceError(`Projection ${revision.command_id} is not bound to one trusted ${featureId}@${featureVersion} command/receipt/readback.`);
  }
  const receiptWorkspaceIds = parseJson(proof.workspace_ids_json, `Receipt ${proof.receipt_id} Workspace scope`);
  if (String(proof.authority_instance_id) !== String(revision.authority_instance_id)
    || String(proof.tenant_or_org_id) !== String(revision.tenant_or_org_id)
    || String(proof.pack_id) !== String(revision.pack_id)
    || String(proof.engagement_id) !== String(revision.engagement_id)
    || !Array.isArray(receiptWorkspaceIds) || !receiptWorkspaceIds.map(String).includes(String(revision.workspace_id))) {
    throw new PendingAcceptanceError(`Projection ${revision.command_id} authority or Workspace differs from its managed revision identity.`);
  }
  const evidenceOperations = parseJson(proof.evidence_operation_ids_json, `${proof.mutation_operation_id} evidence operations`);
  if (!Array.isArray(evidenceOperations) || !evidenceOperations.includes(proof.evidence_operation_id)) throw new PendingAcceptanceError(`Receipt ${proof.receipt_id} uses an operation outside the frozen evidence allowlist.`);
  const intended = parseJson(proof.intended_revision_json, `Intent ${proof.intent_id} immutable revision`);
  const spec = proof.spec_json ? parseJson(proof.spec_json, `Command ${revision.command_id} signed spec`) : null;
  const frozenCommandRequest = featureId === DELETE_FEATURE_ID
    ? intended?.mutationPayload
    : spec && typeof spec === 'object' && !Array.isArray(spec) && Object.hasOwn(spec, 'mutationPayload')
      ? spec.mutationPayload : spec?.request;
  if (frozenCommandRequest === undefined || digest(frozenCommandRequest) !== proof.command_request_digest) {
    throw new PendingAcceptanceError(`Command ${revision.command_id} spec does not reproduce its frozen mutation/read request digest.`);
  }
  const evidencePayload = parseJson(proof.payload_json, `Evidence ${proof.evidence_id}`);
  if (String(evidencePayload?.__operationReceiptId || '') !== String(proof.receipt_id)) throw new PendingAcceptanceError(`Evidence ${proof.evidence_id} does not name its Operation receipt.`);
  const receiptPayload = evidencePayload && typeof evidencePayload === 'object' && !Array.isArray(evidencePayload)
    ? Object.fromEntries(Object.entries(evidencePayload).filter(([key]) => key !== '__operationReceiptId')) : evidencePayload;
  if (digest(receiptPayload) !== proof.evidence_digest || digest(receiptPayload) !== proof.response_digest
    || canonical(parseJson(proof.response_json, `Receipt ${proof.receipt_id} response`)) !== canonical(receiptPayload)) {
    throw new PendingAcceptanceError(`Evidence ${proof.evidence_id} response digest is not exact.`);
  }
  const payload = parseJson(revision.payload_json, `Projection ${revision.revision_id || revision.relation_key}`);
  if (featureId === CREATE_FEATURE_ID && canonical(payload) !== canonical(receiptPayload)) {
    throw new PendingAcceptanceError(`Projection ${revision.command_id} payload is not the exact receipt-backed Create readback.`);
  }
  return { proof, payload, evidencePayload, receiptPayload, intended, spec };
}

function currentObject(db, revision) {
  return db.prepare(`SELECT lifecycle,freshness,current_revision FROM managed_objects WHERE authority_instance_id=? AND tenant_or_org_id=? AND pack_id=? AND engagement_id=? AND workspace_id=? AND object_type=? AND object_id=?`)
    .get(revision.authority_instance_id, revision.tenant_or_org_id, revision.pack_id, revision.engagement_id, revision.workspace_id, revision.object_type, revision.object_id);
}

function currentRelation(db, revision) {
  return db.prepare(`SELECT lifecycle,freshness,current_revision,source_object_id,target_object_id FROM managed_relations WHERE authority_instance_id=? AND tenant_or_org_id=? AND pack_id=? AND engagement_id=? AND workspace_id=? AND relation_type=? AND relation_key=?`)
    .get(revision.authority_instance_id, revision.tenant_or_org_id, revision.pack_id, revision.engagement_id, revision.workspace_id, revision.relation_type, revision.relation_key);
}

function activeCurrentObject(db, revision, label, allowDeleted = false) {
  const current = currentObject(db, revision);
  if (!current || (!allowDeleted && current.lifecycle !== 'active') || (allowDeleted && !['active', 'deleted'].includes(current.lifecycle))
    || current.freshness !== 'verified_current' || Number(current.current_revision) < Number(revision.revision)) {
    throw new PendingAcceptanceError(`${label} is not a ${allowDeleted ? 'live-or-later-deleted' : 'active'}, verified-current Core projection.`);
  }
}

function activeCurrentRelation(db, revision, label, allowDeleted = false) {
  const current = currentRelation(db, revision);
  if (!current || (!allowDeleted && current.lifecycle !== 'active') || (allowDeleted && !['active', 'deleted'].includes(current.lifecycle))
    || current.freshness !== 'verified_current' || Number(current.current_revision) < Number(revision.revision)) {
    throw new PendingAcceptanceError(`${label} is not a ${allowDeleted ? 'live-or-later-deleted' : 'active'}, verified-current Core relation projection.`);
  }
}

function provenance(revision) {
  return parseJson(revision.provenance_json, `Projection ${revision.revision_id} provenance`);
}

function parseGraCascadeSnapshot(value, requireDeleted, label) {
  const snapshot = record(value, label);
  exactKeys(snapshot, ['schemaVersion', 'assessment', 'risks', 'controls', 'riskControls', 'snapshotDigest'], label);
  if (snapshot.schemaVersion !== 'omnia.delete.gra-cascade-snapshot/v1') throw new PendingAcceptanceError(`${label} schema is invalid.`);
  const assessment = record(snapshot.assessment, `${label} assessment`);
  exactKeys(assessment, ['riskAssessmentId', 'workItemId', 'workspaceId', 'updatedOn'], `${label} assessment`);
  const assessmentIdentity = Object.fromEntries(Object.entries(assessment).map(([key, item]) => [key, evidenceText(item, `${label} assessment.${key}`)]));
  const parseRows = (raw, fields, rowLabel, key) => {
    if (!Array.isArray(raw) || raw.length > 2_000) throw new PendingAcceptanceError(`${label} ${rowLabel} inventory is invalid.`);
    const rows = raw.map((entry, index) => {
      const row = record(entry, `${label} ${rowLabel}[${index}]`);
      const statusFields = requireDeleted ? ['deleted', 'absent'].filter((field) => Object.hasOwn(row, field)) : [];
      exactKeys(row, [...fields, ...statusFields], `${label} ${rowLabel}[${index}]`);
      if (requireDeleted && (statusFields.length !== 1 || row[statusFields[0]] !== true)) {
        throw new PendingAcceptanceError(`${label} ${rowLabel}[${index}] is not authoritatively deleted or absent.`);
      }
      return Object.fromEntries(fields.map((field) => [field, evidenceText(row[field], `${label} ${rowLabel}[${index}].${field}`)]));
    });
    const sorted = [...rows].sort((left, right) => key(left).localeCompare(key(right)));
    const identities = sorted.map(key);
    if (new Set(identities).size !== identities.length) throw new PendingAcceptanceError(`${label} ${rowLabel} inventory contains a duplicate identity.`);
    if (canonical(rows) !== canonical(sorted)) throw new PendingAcceptanceError(`${label} ${rowLabel} inventory is not in canonical order.`);
    return rows;
  };
  const risks = parseRows(snapshot.risks, ['riskId', 'riskRiskScopeId', 'riskScopeId', 'updatedOn'], 'Risk',
    (row) => `${row.riskId}\0${row.riskRiskScopeId}`);
  const controls = parseRows(snapshot.controls, ['controlId', 'workItemId', 'updatedOn'], 'Control',
    (row) => `${row.controlId}\0${row.workItemId}`);
  const riskControls = parseRows(snapshot.riskControls,
    ['riskId', 'riskRiskScopeId', 'riskScopeId', 'controlId', 'assertionType', 'assertion'], 'Risk-Control',
    (row) => `${row.riskId}\0${row.riskRiskScopeId}\0${row.controlId}\0${row.assertionType}\0${row.assertion}`);
  const identity = { schemaVersion: snapshot.schemaVersion, assessment: assessmentIdentity, risks, controls, riskControls };
  if (!HEX64.test(String(snapshot.snapshotDigest || '')) || digest(identity) !== snapshot.snapshotDigest) {
    throw new PendingAcceptanceError(`${label} digest does not match its exact identity inventory.`);
  }
  return { identity, snapshotDigest: String(snapshot.snapshotDigest) };
}

function receiptConnectorBinding(proof) {
  return { connectorId: String(proof.connector_id), sessionGeneration: Number(proof.session_generation),
    engagementId: String(proof.engagement_id), authorityInstanceId: String(proof.authority_instance_id),
    tenantOrOrgId: String(proof.tenant_or_org_id), packId: String(proof.pack_id) };
}

function verifiedCreateRiskControlIdentity(relation, proof, rowKey, graId, workspaceId) {
  const intended = record(proof.intended, `${relation.relation_key} immutable Risk-Control intent`);
  const catalog = record(intended.resolvedCatalog, `${relation.relation_key} frozen catalog identity`);
  const identity = Object.fromEntries(['riskId', 'riskRiskScopeId', 'riskScopeId', 'controlId', 'assertionType', 'assertion']
    .map((field) => [field, evidenceText(catalog[field], `${relation.relation_key}.${field}`)]));
  if (intended.kind !== 'risk_control' || intended.key !== relation.relation_key || intended.rowKey !== rowKey
    || intended.graTargetKey !== `gra|${rowKey}` || intended.workspace !== workspaceId || intended.objectType !== 'GRA'
    || relation.source_object_id !== identity.riskId || relation.target_object_id !== identity.controlId) {
    throw new PendingAcceptanceError(`${relation.relation_key} is not exactly owned by its frozen Create GRA and catalog identities.`);
  }
  const spec = record(proof.spec, `${relation.relation_key} signed command spec`);
  const readRequest = record(spec.readRequest || spec.reconcileRequest, `${relation.relation_key} signed read request`);
  const target = record(readRequest.target, `${relation.relation_key} signed read target`);
  const query = record(readRequest.query, `${relation.relation_key} signed read query`);
  exactKeys(readRequest, ['target', 'query'], `${relation.relation_key} signed read request`);
  exactKeys(target, ['targetIdentityKey', 'workspaceId'], `${relation.relation_key} signed read target`);
  exactKeys(query, ['riskRiskScopeId', 'riskScopeId', 'riskId', 'controlId', 'assertionType', 'assertion'], `${relation.relation_key} signed read query`);
  if (String(spec.readOperation || spec.reconcileOperation || '') !== String(proof.proof.evidence_operation_id)
    || target.targetIdentityKey !== proof.proof.target_identity_key || target.workspaceId !== workspaceId
    || Object.entries(identity).some(([field, expected]) => String(query[field] || '') !== expected)
    || digest({ connectorBinding: receiptConnectorBinding(proof.proof), ...readRequest }) !== proof.proof.receipt_request_digest
    || proof.receiptPayload?.verified !== true) {
    throw new PendingAcceptanceError(`${relation.relation_key} child identity is not bound to its exact signed Create read request and receipt.`);
  }
  return { ...identity, graId, relationKey: String(relation.relation_key) };
}

function objectRevisions(db, runId, workspaceId) {
  return db.prepare(`SELECT * FROM managed_object_revisions WHERE run_id=? AND workspace_id=? ORDER BY revision,verified_at`).all(runId, workspaceId);
}

function relationRevisions(db, runId, workspaceId) {
  return db.prepare(`SELECT * FROM managed_relation_revisions WHERE run_id=? AND workspace_id=? ORDER BY revision,verified_at`).all(runId, workspaceId);
}

export function verifyCreateLive(db, manifest, options) {
  requireTables(db, CORE_TABLES, 'Core SQLite');
  const featureVersion = exactVersion(options.createVersion, 'createVersion');
  const workspaceId = requiredText(options.workspaceId, 'workspaceId');
  const allowDeletedCurrent = options.allowDeletedCurrent === true;
  const engagementId = options.engagementId ? requiredText(options.engagementId, 'engagementId') : '';
  const accepted = [];
  for (const batch of manifest.batches) {
    const runs = db.prepare(`
      SELECT DISTINCT r.* FROM feature_runs r JOIN feature_artifacts a ON a.run_id=r.run_id
      WHERE r.feature_id=? AND r.feature_version=? AND r.state='succeeded'
        AND a.kind='source' AND a.source_kind='user_import' AND a.original_name=? AND a.sha256=?
        ${engagementId ? 'AND r.engagement_id=?' : ''}
    `).all(CREATE_FEATURE_ID, featureVersion, batch.workbookName, batch.workbookSha256, ...(engagementId ? [engagementId] : []));
    const run = one(runs, `Create batch ${batch.workbookName}`);
    if (!HEX64.test(String(run.plan_digest || ''))) throw new PendingAcceptanceError(`Create Run ${run.run_id} has no frozen plan digest.`);
    const objects = objectRevisions(db, run.run_id, workspaceId);
    const relations = relationRevisions(db, run.run_id, workspaceId);
    const rowProofs = [];
    const appByElementId = new Map();
    for (const expected of batch.rows) {
      const objectCandidates = objects.filter((revision) => {
        if (revision.object_type !== OBJECT_TYPES[expected.kind]) return false;
        const source = provenance(revision);
        if (!/^object\|[0-9a-f]{64}$/u.test(String(source.targetKey || ''))) return false;
        const payload = parseJson(revision.payload_json, `${expected.elementId} object readback`);
        return containsLabel(payload, ['name', 'number', 'externalId'], expected.elementId);
      });
      const objectRevision = one(objectCandidates, `${expected.elementId} object create/readback`);
      const objectProof = trustedProjection(db, objectRevision, CREATE_FEATURE_ID, featureVersion, 'omnia.create-associate.');
      activeCurrentObject(db, objectRevision, `${expected.elementId} object`, allowDeletedCurrent);
      const rowKey = String(provenance(objectRevision).targetKey).slice('object|'.length);
      if (expected.kind === 'APP') appByElementId.set(expected.elementId, objectRevision.object_id);
      const graBase = one(objects.filter((revision) => revision.object_type === 'GRA' && provenance(revision).targetKey === `gra|${rowKey}`), `${expected.elementId} GRA create/readback`);
      const graBaseProof = trustedProjection(db, graBase, CREATE_FEATURE_ID, featureVersion, 'omnia.create-associate.');
      activeCurrentObject(db, graBase, `${expected.elementId} GRA`, allowDeletedCurrent);
      if (!containsExact(graBaseProof.payload, 'entityId', objectRevision.object_id)
        || !deepValues(graBaseProof.payload, 'name').some((value) => String(value).includes(expected.elementId))) {
        throw new PendingAcceptanceError(`${expected.elementId} GRA readback is not bound to the exact object/name.`);
      }
      const expectedContentName = String(expected.subtype || '').normalize('NFKC').trim();
      const intendedContentName = String(graBaseProof.intended?.contentName || '').normalize('NFKC').trim();
      const contentIdentity = graBaseProof.intended?.contentIdentity;
      const inkContentId = String(contentIdentity?.inkContentId || '').normalize('NFKC').trim();
      const typeId = String(contentIdentity?.typeId || '').normalize('NFKC').trim();
      if (!expectedContentName || intendedContentName !== expectedContentName || !inkContentId || !typeId
        || (!containsExact(graBaseProof.payload, 'inkContentId', inkContentId) && !containsExact(graBaseProof.payload, 'contentId', inkContentId))
        || !containsExact(graBaseProof.spec, 'inkContentId', inkContentId) || !containsExact(graBaseProof.spec, 'typeId', typeId)) {
        throw new PendingAcceptanceError(`${expected.elementId} GRA is not bound to the exact frozen ${expectedContentName || 'content'} authority identity.`);
      }
      const raitRevision = one(objects.filter((revision) => revision.object_type === 'GRA' && provenance(revision).targetKey === `gra-rait|${rowKey}`), `${expected.elementId} ${expected.rait} RAIT readback`);
      const raitProof = trustedProjection(db, raitRevision, CREATE_FEATURE_ID, featureVersion, 'omnia.create-associate.');
      if (!containsLabel(raitProof.payload, ['raitConclusionLevel', 'itElementRaitConclusionLevelName', 'value'], expected.rait)) {
        throw new PendingAcceptanceError(`${expected.elementId} has no exact ${expected.rait} live RAIT readback.`);
      }
      const evaluationRevision = one(objects.filter((revision) => revision.object_type === 'GRA' && provenance(revision).targetKey === `evaluation|${rowKey}`), `${expected.elementId} EvaluationComplete readback`);
      const evaluationProof = trustedProjection(db, evaluationRevision, CREATE_FEATURE_ID, featureVersion, 'omnia.create-associate.');
      if (!containsExact(evaluationProof.payload, 'verified', true) && !containsLabel(evaluationProof.payload, ['status'], 'EvaluationComplete')) {
        throw new PendingAcceptanceError(`${expected.elementId} evaluation is not receipt-verified complete.`);
      }
      const riskRelations = relations.filter((revision) => revision.relation_type === 'risk_control' && String(revision.relation_key).startsWith(`risk-control|${rowKey}|`));
      if (riskRelations.length !== expected.riskControlRequired) throw new PendingAcceptanceError(`${expected.elementId} risk-control count is ${riskRelations.length}; expected ${expected.riskControlRequired}.`);
      const riskControlIdentities = [];
      for (const relation of riskRelations) {
        const proof = trustedProjection(db, relation, CREATE_FEATURE_ID, featureVersion, 'omnia.create-associate.');
        activeCurrentRelation(db, relation, `${expected.elementId} ${relation.relation_key}`, allowDeletedCurrent);
        riskControlIdentities.push(verifiedCreateRiskControlIdentity(relation, proof, rowKey, graBase.object_id, workspaceId));
      }
      if (new Set(riskControlIdentities.map(({ graId: _graId, relationKey: _relationKey, ...identity }) => canonical(identity))).size !== riskControlIdentities.length) {
        throw new PendingAcceptanceError(`${expected.elementId} has duplicate receipt-backed Risk-Control child identities.`);
      }
      rowProofs.push({ expected, rowKey, objectRevision, graBase, riskRelations, riskControlIdentities });
    }
    const claimedRiskRelationIds = new Set(rowProofs.flatMap((row) => row.riskRelations.map((relation) => relation.revision_id)));
    const unclaimedRiskRelations = relations.filter((relation) => relation.relation_type === 'risk_control' && !claimedRiskRelationIds.has(relation.revision_id));
    if (unclaimedRiskRelations.length) throw new PendingAcceptanceError(`Create batch ${batch.workbookName} has ${unclaimedRiskRelations.length} extra or cross-row Risk-Control projection(s).`);
    for (const row of rowProofs) {
      const dependencyRelations = relations.filter((candidate) => String(candidate.relation_key).startsWith(`element-relation|${row.rowKey}|`));
      if (dependencyRelations.length !== row.expected.dependencies.length) {
        throw new PendingAcceptanceError(`${row.expected.elementId} dependency relation set is ${dependencyRelations.length}; expected exactly ${row.expected.dependencies.length}.`);
      }
      for (const dependency of row.expected.dependencies) {
        const targetId = appByElementId.get(dependency);
        if (!targetId) throw new PendingAcceptanceError(`${row.expected.elementId} dependency ${dependency} has no exact in-batch APP object.`);
        const expectedRelationType = DEPENDENCY_RELATION_TYPES[row.expected.kind];
        if (!expectedRelationType) throw new PendingAcceptanceError(`${row.expected.elementId} has no governed dependency relation type.`);
        const relation = one(relations.filter((candidate) => candidate.relation_type === expectedRelationType
          && candidate.relation_key === `element-relation|${row.rowKey}|${dependency}`
          && candidate.source_object_id === row.objectRevision.object_id && candidate.target_object_id === targetId), `${row.expected.elementId} -> ${dependency} relation readback`);
        trustedProjection(db, relation, CREATE_FEATURE_ID, featureVersion, 'omnia.create-associate.');
        activeCurrentRelation(db, relation, `${row.expected.elementId} -> ${dependency}`, allowDeletedCurrent);
      }
      if (row.expected.kind === 'DCNO') {
        const inheritanceRevisions = objects.filter((revision) => String(provenance(revision).targetKey || '').startsWith(`inheritance-source|${row.rowKey}|`));
        if (inheritanceRevisions.length !== row.expected.dependencies.length) {
          throw new PendingAcceptanceError(`${row.expected.elementId} inheritance-source set is ${inheritanceRevisions.length}; expected exactly ${row.expected.dependencies.length}.`);
        }
        for (const dependency of row.expected.dependencies) {
          const source = rowProofs.find((candidate) => candidate.expected.kind === 'APP' && candidate.expected.elementId === dependency);
          if (!source) throw new PendingAcceptanceError(`${row.expected.elementId} inheritance source ${dependency} has no exact in-batch APP GRA.`);
          const inheritanceKey = `inheritance-source|${row.rowKey}|${source.rowKey}`;
          const inheritance = one(inheritanceRevisions.filter((revision) => provenance(revision).targetKey === inheritanceKey), `${row.expected.elementId} <- ${dependency} inheritance readback`);
          const inheritanceProof = trustedProjection(db, inheritance, CREATE_FEATURE_ID, featureVersion, 'omnia.create-associate.');
          if (inheritance.object_id !== source.graBase.object_id
            || inheritanceProof.intended?.sourceRowKey !== source.rowKey
            || inheritanceProof.intended?.value !== row.expected.rait
            || !containsExact(inheritanceProof.payload, 'verified', true)
            || !containsLabel(inheritanceProof.payload, ['itElementRaitConclusionLevelId', 'itElementRaitConclusionLevelName', 'value'], row.expected.rait)) {
            throw new PendingAcceptanceError(`${row.expected.elementId} inheritance source ${dependency} is not an exact receipt-backed ${row.expected.rait} APP GRA readback.`);
          }
          activeCurrentObject(db, inheritance, `${row.expected.elementId} inheritance source ${dependency}`, allowDeletedCurrent);
        }
      }
    }
    accepted.push({ workbookName: batch.workbookName, workbookSha256: batch.workbookSha256, runId: run.run_id, engagementId: run.engagement_id, rows: rowProofs });
  }
  const baseRevisions = accepted.flatMap((batch) => batch.rows.flatMap((row) => [row.objectRevision, row.graBase]));
  const scopeRows = new Map(baseRevisions.map((revision) => [canonical({
    authorityInstanceId: revision.authority_instance_id, tenantOrOrgId: revision.tenant_or_org_id,
    packId: revision.pack_id, engagementId: revision.engagement_id, workspaceId: revision.workspace_id
  }), revision]));
  const runEngagements = new Set(accepted.map((batch) => String(batch.engagementId || '')));
  if (scopeRows.size !== 1 || runEngagements.size !== 1) throw new PendingAcceptanceError('Create batches do not share one exact stable authority, engagement, and Workspace scope.');
  const scopeRevision = [...scopeRows.values()][0];
  const authority = { authorityInstanceId: String(scopeRevision.authority_instance_id), tenantOrOrgId: String(scopeRevision.tenant_or_org_id),
    packId: String(scopeRevision.pack_id), engagementId: String(scopeRevision.engagement_id) };
  if (String(scopeRevision.workspace_id) !== workspaceId || !authority.authorityInstanceId || !authority.packId || !authority.engagementId
    || [...runEngagements][0] !== authority.engagementId || (engagementId && engagementId !== authority.engagementId)) {
    throw new PendingAcceptanceError('Create batches differ from the requested exact authority, engagement, or Workspace scope.');
  }
  const childOwners = new Map();
  for (const batch of accepted) for (const row of batch.rows) for (const identity of row.riskControlIdentities) {
    for (const [type, id] of [['Risk', identity.riskId], ['Control', identity.controlId]]) {
      const key = `${type}\0${id}`; const owner = childOwners.get(key);
      if (owner && owner !== identity.graId) throw new PendingAcceptanceError(`${type} ${id} is claimed by multiple Create GRAs; cross-GRA child identity is ambiguous.`);
      childOwners.set(key, identity.graId);
    }
  }
  return { schemaVersion: 'omnia.create-live-acceptance/v1', status: 'passed', featureVersion, workspaceId, authority, batches: accepted };
}

function latestDeletePlans(deleteDb) {
  requireTables(deleteDb, ['__runtime_plans'], 'Delete private SQLite');
  return deleteDb.prepare('SELECT plan_id,payload_json,updated_at FROM __runtime_plans ORDER BY updated_at').all()
    .map((row) => ({ ...row, plan: parseJson(row.payload_json, `Delete plan ${row.plan_id}`) }))
    .filter((row) => row.plan && row.plan.schemaVersion !== 'omnia.delete-catalog-snapshot/v1' && row.plan.runId);
}

function exactStringSet(values, label) {
  if (!Array.isArray(values) || values.some((value) => !String(value || '').trim())) throw new PendingAcceptanceError(`${label} is not a complete identity array.`);
  const normalized = values.map(String).sort();
  if (new Set(normalized).size !== normalized.length) throw new PendingAcceptanceError(`${label} contains duplicate identities.`);
  return normalized;
}

function deletePlanMatchesScope(plan, createResult, workspaceId) {
  const binding = plan?.binding; const safety = plan?.safety; const authority = createResult.authority;
  return plan?.schemaVersion === 'omnia.delete-plan/v5' && plan?.featureId === DELETE_FEATURE_ID
    && binding && safety && authority
    && String(binding.authorityInstanceId || '') === authority.authorityInstanceId
    && String(binding.tenantOrOrgId || '') === authority.tenantOrOrgId
    && String(binding.packId || '') === authority.packId
    && String(binding.engagementId || '') === authority.engagementId
    && String(safety.authorityInstanceId || '') === authority.authorityInstanceId
    && String(safety.tenantOrOrgId || '') === authority.tenantOrOrgId
    && String(safety.packId || '') === authority.packId
    && String(safety.engagementId || '') === authority.engagementId
    && String(binding.connectorId || '') && String(binding.connectorId || '') === String(safety.connectorId || '')
    && Number.isSafeInteger(Number(binding.sessionGeneration))
    && Number(binding.sessionGeneration) === Number(safety.sessionGeneration)
    && safety.enabled === true
    && canonical(Array.isArray(safety.workspaceIds) ? safety.workspaceIds.map(String).sort() : []) === canonical([workspaceId]);
}

function validateCompletedDeletePlan(entry, run, featureVersion, workspaceId) {
  const plan = entry.plan; const verification = plan.finalVerification;
  if (plan.planId !== plan.runId || plan.runId !== run.run_id || plan.featureVersion !== featureVersion
    || plan.planDigest !== run.plan_digest || run.engagement_id !== plan.binding.engagementId
    || !Array.isArray(plan.targets) || !plan.targets.length || !Array.isArray(plan.steps) || !plan.steps.length
    || !Array.isArray(plan.outcomes) || plan.outcomes.length !== plan.steps.length
    || plan.targets.some((target) => String(target.workspace || '') !== workspaceId)
    || plan.steps.some((step) => String(step.workspace || '') !== workspaceId)) {
    throw new PendingAcceptanceError(`Delete plan ${plan.runId} is not an exact completed ${workspaceId} plan bound to its succeeded Core Run.`);
  }
  const steps = new Map();
  for (const step of plan.steps) {
    const key = String(step.key || '');
    if (!key || steps.has(key)) throw new PendingAcceptanceError(`Delete plan ${plan.runId} has a duplicate or empty step identity.`);
    steps.set(key, step);
  }
  const outcomeStepIds = new Set();
  for (const outcome of plan.outcomes) {
    const stepId = String(outcome.stepId || '');
    if (!steps.has(stepId) || outcomeStepIds.has(stepId) || outcome.state !== 'succeeded' || !String(outcome.commandId || '')) {
      throw new PendingAcceptanceError(`Delete plan ${plan.runId} does not have one succeeded outcome for every frozen step.`);
    }
    outcomeStepIds.add(stepId);
  }
  const expectedDeleted = [...outcomeStepIds].map((stepId) => steps.get(stepId))
    .filter((step) => step.kind === 'object' || (step.kind === 'cascade' && step.objectType === 'GRA'))
    .map((step) => `${step.objectType}|${step.objectId}`).sort();
  const declaredExpected = exactStringSet(verification.expectedDeletedTargetIds, `Delete plan ${plan.runId} expectedDeletedTargetIds`);
  const declaredAbsent = exactStringSet(verification.verifiedAbsentTargetIds, `Delete plan ${plan.runId} verifiedAbsentTargetIds`);
  const capturedAt = Date.parse(String(verification.capturedAt || ''));
  if (canonical(declaredExpected) !== canonical(expectedDeleted) || canonical(declaredAbsent) !== canonical(expectedDeleted)
    || !Number.isFinite(capturedAt) || Number(verification.catalogItemCount) !== 0
    || String(verification.catalogDigest || '') !== digest([])) {
    throw new PendingAcceptanceError(`Delete plan ${plan.runId} final catalog proof differs from its exact succeeded object/GRA steps.`);
  }
  return { entry, run, capturedAt, verifiedAbsentTargetIds: declaredAbsent, steps, outcomes: new Map(plan.outcomes.map((outcome) => [String(outcome.stepId), outcome])) };
}

function latestTombstoneObject(db, target, deleteRunIds) {
  const placeholders = deleteRunIds.map(() => '?').join(',');
  return db.prepare(`SELECT * FROM managed_object_revisions WHERE authority_instance_id=? AND tenant_or_org_id=? AND pack_id=? AND engagement_id=? AND workspace_id=? AND object_type=? AND object_id=? AND run_id IN (${placeholders}) ORDER BY revision DESC,verified_at DESC LIMIT 1`)
    .get(target.authority_instance_id, target.tenant_or_org_id, target.pack_id, target.engagement_id,
      target.workspace_id, target.object_type, target.object_id, ...deleteRunIds);
}

function latestTombstoneRelation(db, target, deleteRunIds) {
  const placeholders = deleteRunIds.map(() => '?').join(',');
  return db.prepare(`SELECT * FROM managed_relation_revisions WHERE authority_instance_id=? AND tenant_or_org_id=? AND pack_id=? AND engagement_id=? AND workspace_id=? AND relation_type=? AND relation_key=? AND run_id IN (${placeholders}) ORDER BY revision DESC,verified_at DESC LIMIT 1`)
    .get(target.authority_instance_id, target.tenant_or_org_id, target.pack_id, target.engagement_id,
      target.workspace_id, target.relation_type, target.relation_key, ...deleteRunIds);
}

function exactCurrentTombstone(db, revision, kind, label) {
  const current = kind === 'object' ? currentObject(db, revision) : currentRelation(db, revision);
  if (!current || current.lifecycle !== 'deleted' || current.freshness !== 'verified_current'
    || Number(current.current_revision) !== Number(revision.revision)
    || (kind === 'relation' && (current.source_object_id !== revision.source_object_id || current.target_object_id !== revision.target_object_id))) {
    throw new PendingAcceptanceError(`${label} is not the exact deleted, verified-current Core revision.`);
  }
}

function exactMetadata(payload, expected, label) {
  const row = record(payload, label);
  if (row.deleted !== true || row.parentCommandId !== expected.parentCommandId || row.evidenceId !== expected.evidenceId
    || row.snapshotDigest !== expected.snapshotDigest || !Number.isFinite(Date.parse(String(row.tombstoneAt || '')))) {
    throw new PendingAcceptanceError(`${label} is not bound to the parent cascade command, evidence, and frozen snapshot.`);
  }
  return row;
}

function verifyGraCascadeDeletion(coreDb, livePlans, row, featureVersion, workspaceId) {
  const graId = String(row.graBase.object_id);
  const candidates = [];
  for (const livePlan of livePlans) for (const step of livePlan.entry.plan.steps) {
    if (step.kind !== 'cascade' || step.objectType !== 'GRA' || step.objectId !== graId || step.workspace !== workspaceId) continue;
    const outcome = livePlan.outcomes.get(String(step.key || ''));
    if (outcome?.state === 'succeeded' && outcome.commandId) candidates.push({ livePlan, step, outcome });
  }
  const candidate = one(candidates, `Delete cascade for GRA ${graId}`);
  const { livePlan, step, outcome } = candidate;
  if (!livePlan.verifiedAbsentTargetIds.includes(`GRA|${graId}`)) {
    throw new PendingAcceptanceError(`Delete cascade for GRA ${graId} has no exact final authoritative absence entry.`);
  }
  const parentRows = coreDb.prepare(`
    SELECT * FROM managed_object_revisions
    WHERE authority_instance_id=? AND tenant_or_org_id=? AND pack_id=? AND engagement_id=?
      AND workspace_id=? AND object_type='GRA' AND object_id=? AND run_id=? AND command_id=?
    ORDER BY revision,verified_at
  `).all(row.graBase.authority_instance_id, row.graBase.tenant_or_org_id, row.graBase.pack_id, row.graBase.engagement_id,
    workspaceId, graId, livePlan.run.run_id, outcome.commandId)
    .filter((revision) => parseJson(revision.payload_json, `GRA ${graId} Delete projection`).deleted === true);
  const parent = one(parentRows, `GRA ${graId} parent cascade tombstone`);
  exactCurrentTombstone(coreDb, parent, 'object', `GRA ${graId}`);
  const trust = trustedProjection(coreDb, parent, DELETE_FEATURE_ID, featureVersion, 'omnia.delete.');
  const commandReadbacks = coreDb.prepare(`
    SELECT e.evidence_id FROM feature_command_evidence e
    JOIN feature_operation_receipts o ON o.receipt_id=e.receipt_id AND o.command_id=e.command_id AND o.run_id=e.run_id
    WHERE e.run_id=? AND e.command_id=? AND e.evidence_type IN ('readback','reconcile') AND e.receipt_id<>'' AND e.verified=1
  `).all(parent.run_id, parent.command_id);
  if (commandReadbacks.length !== 1 || String(commandReadbacks[0].evidence_id) !== String(parent.evidence_id)) {
    throw new PendingAcceptanceError(`GRA ${graId} cascade does not have one exact receipt-backed parent readback evidence record.`);
  }
  const intended = record(trust.intended, `GRA ${graId} Delete intent`);
  const baseline = record(intended.baseline, `GRA ${graId} frozen Delete baseline`);
  const frozen = parseGraCascadeSnapshot(baseline.cascadeSnapshot, false, `GRA ${graId} frozen cascade snapshot`);
  const observed = record(trust.receiptPayload, `GRA ${graId} authoritative cascade readback`);
  const readback = parseGraCascadeSnapshot(observed.cascadeSnapshot, true, `GRA ${graId} authoritative cascade snapshot`);
  if (trust.proof.mutation_operation_id !== 'omnia.delete.gra.direct.v1'
    || trust.proof.evidence_operation_id !== 'omnia.delete.gra.reconcile.v1'
    || intended.kind !== 'object' || intended.key !== step.key || intended.objectType !== 'GRA'
    || intended.objectId !== graId || intended.workspace !== workspaceId
    || observed.deleted !== true || observed.verifiedCascade !== true || observed.objectType !== 'GRA'
    || String(observed.objectId || observed.riskAssessmentId || '') !== graId
    || canonical((observed.workspaceIds || []).map(String)) !== canonical([workspaceId])
    || frozen.identity.assessment.riskAssessmentId !== graId || frozen.identity.assessment.workspaceId !== workspaceId
    || frozen.snapshotDigest !== readback.snapshotDigest || canonical(frozen.identity) !== canonical(readback.identity)
    || canonical(step.preflight?.cascadeSnapshot) !== canonical(baseline.cascadeSnapshot)
    || canonical(step.request?.frozenCascadeSnapshot) !== canonical(baseline.cascadeSnapshot)
    || String(livePlan.entry.plan.binding.connectorId) !== String(trust.proof.connector_id)
    || Number(livePlan.entry.plan.binding.sessionGeneration) !== Number(trust.proof.session_generation)) {
    throw new PendingAcceptanceError(`GRA ${graId} cascade is not exactly bound to its plan, command, authority, receipt, frozen snapshot, and readback.`);
  }
  const expectedRelations = row.riskControlIdentities.map((identity) => ({ riskId: identity.riskId,
    riskRiskScopeId: identity.riskRiskScopeId, riskScopeId: identity.riskScopeId, controlId: identity.controlId,
    assertionType: identity.assertionType, assertion: identity.assertion })).sort((left, right) => canonical(left).localeCompare(canonical(right)));
  const frozenRelations = [...frozen.identity.riskControls].sort((left, right) => canonical(left).localeCompare(canonical(right)));
  const expectedRisks = [...new Map(expectedRelations.map((identity) => [`${identity.riskId}\0${identity.riskRiskScopeId}`,
    { riskId: identity.riskId, riskRiskScopeId: identity.riskRiskScopeId, riskScopeId: identity.riskScopeId }])).values()]
    .sort((left, right) => canonical(left).localeCompare(canonical(right)));
  const frozenRisks = frozen.identity.risks.map(({ updatedOn: _updatedOn, ...identity }) => identity)
    .sort((left, right) => canonical(left).localeCompare(canonical(right)));
  const expectedControls = [...new Set(expectedRelations.map((identity) => identity.controlId))].sort();
  const frozenControls = frozen.identity.controls.map((identity) => identity.controlId).sort();
  if (new Set(expectedRisks.map((risk) => risk.riskId)).size !== expectedRisks.length
    || canonical(expectedRelations) !== canonical(frozenRelations) || canonical(expectedRisks) !== canonical(frozenRisks)
    || canonical(expectedControls) !== canonical(frozenControls)) {
    throw new PendingAcceptanceError(`GRA ${graId} cascade child inventory is missing, additional, or differs from verified Create Risk-Control identities.`);
  }
  const metadata = { parentCommandId: String(parent.command_id), evidenceId: String(parent.evidence_id), snapshotDigest: frozen.snapshotDigest };
  const sameParentScope = (revision) => ['authority_instance_id', 'tenant_or_org_id', 'pack_id', 'engagement_id', 'workspace_id',
    'run_id', 'intent_id', 'command_id', 'evidence_id'].every((field) => String(revision[field]) === String(parent[field]));
  const objectRows = coreDb.prepare(`SELECT * FROM managed_object_revisions WHERE run_id=? AND command_id=? AND evidence_id=? ORDER BY object_type,object_id,revision`)
    .all(parent.run_id, parent.command_id, parent.evidence_id)
    .filter((revision) => parseJson(revision.payload_json, `GRA ${graId} cascade object projection`).deleted === true);
  const expectedObjectKeys = [`GRA\0${graId}`, ...expectedRisks.map((risk) => `Risk\0${risk.riskId}`), ...expectedControls.map((controlId) => `Control\0${controlId}`)].sort();
  const actualObjectKeys = objectRows.map((revision) => `${revision.object_type}\0${revision.object_id}`).sort();
  if (canonical(actualObjectKeys) !== canonical(expectedObjectKeys)) throw new PendingAcceptanceError(`GRA ${graId} has an extra or missing child object tombstone.`);
  for (const revision of objectRows) {
    if (!sameParentScope(revision)) throw new PendingAcceptanceError(`${revision.object_type} ${revision.object_id} crossed the parent cascade authority or ledger scope.`);
    exactCurrentTombstone(coreDb, revision, 'object', `${revision.object_type} ${revision.object_id}`);
    const payload = parseJson(revision.payload_json, `${revision.object_type} ${revision.object_id} tombstone`);
    exactKeys(payload, ['deleted', 'parentCommandId', 'evidenceId', 'snapshotDigest', 'tombstoneAt'], `${revision.object_type} ${revision.object_id} tombstone`);
    exactMetadata(payload, metadata, `${revision.object_type} ${revision.object_id} tombstone`);
    const source = provenance(revision);
    exactKeys(source, ['source', 'deleted', 'parentCommandId', 'evidenceId', 'snapshotDigest'], `${revision.object_type} ${revision.object_id} provenance`);
    if (source.source !== 'agent_verified_gra_cascade_delete' || source.parentCommandId !== metadata.parentCommandId
      || source.evidenceId !== metadata.evidenceId || source.snapshotDigest !== metadata.snapshotDigest) {
      throw new PendingAcceptanceError(`${revision.object_type} ${revision.object_id} provenance is not the exact parent cascade proof.`);
    }
  }
  const relationRows = coreDb.prepare(`SELECT * FROM managed_relation_revisions WHERE run_id=? AND command_id=? AND evidence_id=? ORDER BY relation_type,relation_key,revision`)
    .all(parent.run_id, parent.command_id, parent.evidence_id)
    .filter((revision) => parseJson(revision.payload_json, `GRA ${graId} cascade relation projection`).deleted === true);
  if (relationRows.length !== row.riskControlIdentities.length) throw new PendingAcceptanceError(`GRA ${graId} has an extra or missing Risk-Control tombstone.`);
  const claimedRelationKeys = new Set();
  for (const identity of row.riskControlIdentities) {
    const matches = relationRows.filter((revision) => {
      const payload = parseJson(revision.payload_json, `${revision.relation_key} tombstone`);
      return revision.relation_type === 'risk_control' && revision.relation_key === identity.relationKey
        && revision.source_object_id === identity.riskId && revision.target_object_id === identity.controlId
        && ['riskRiskScopeId', 'riskScopeId', 'assertionType', 'assertion', 'graId'].every((field) => String(payload[field] || '') === String(identity[field] || ''));
    });
    const revision = one(matches, `GRA ${graId} child relation ${identity.relationKey}`);
    if (claimedRelationKeys.has(revision.revision_id)) throw new PendingAcceptanceError(`GRA ${graId} reuses one tombstone for multiple child identities.`);
    claimedRelationKeys.add(revision.revision_id);
    if (!sameParentScope(revision)) throw new PendingAcceptanceError(`Risk-Control ${revision.relation_key} crossed the parent cascade authority or ledger scope.`);
    exactCurrentTombstone(coreDb, revision, 'relation', `Risk-Control ${revision.relation_key}`);
    const payload = parseJson(revision.payload_json, `${revision.relation_key} tombstone`);
    exactKeys(payload, ['deleted', 'parentCommandId', 'evidenceId', 'snapshotDigest', 'riskId', 'riskRiskScopeId', 'riskScopeId',
      'controlId', 'assertionType', 'assertion', 'graId', 'tombstoneAt'], `${revision.relation_key} tombstone`);
    exactMetadata(payload, metadata, `${revision.relation_key} tombstone`);
  }
  return { graId, runId: String(parent.run_id), commandId: metadata.parentCommandId, evidenceId: metadata.evidenceId,
    snapshotDigest: metadata.snapshotDigest, riskCount: expectedRisks.length, controlCount: expectedControls.length,
    riskControlCount: expectedRelations.length };
}

export function verifyDeleteLive(coreDb, deleteDb, createResult, options) {
  const featureVersion = exactVersion(options.deleteVersion, 'deleteVersion');
  const workspaceId = requiredText(options.workspaceId, 'workspaceId');
  const plans = latestDeletePlans(deleteDb).filter((entry) => entry.plan.featureVersion === featureVersion && entry.plan.state === 'completed'
    && entry.plan.finalVerification?.schemaVersion === 'omnia.delete-final-catalog-verification/v1'
    && entry.plan.finalVerification?.state === 'verified'
    && deletePlanMatchesScope(entry.plan, createResult, workspaceId));
  if (!plans.length) throw new PendingAcceptanceError(`No completed ${DELETE_FEATURE_ID}@${featureVersion} plan has verified final authoritative catalog evidence.`);
  const livePlans = plans.map((entry) => {
    const run = coreDb.prepare("SELECT * FROM feature_runs WHERE run_id=? AND feature_id=? AND feature_version=? AND state='succeeded'").get(entry.plan.runId, DELETE_FEATURE_ID, featureVersion);
    if (!run || !HEX64.test(String(run.plan_digest || '')) || run.plan_digest !== entry.plan.planDigest) return null;
    return validateCompletedDeletePlan(entry, run, featureVersion, workspaceId);
  }).filter(Boolean);
  if (!livePlans.length) throw new PendingAcceptanceError(`No private Delete verification is bound to a succeeded ${DELETE_FEATURE_ID}@${featureVersion} Core Run.`);
  const finalPlan = [...livePlans].sort((left, right) => left.capturedAt - right.capturedAt).at(-1);
  const finalVerification = finalPlan.entry.plan.finalVerification;
  const verifiedAbsent = new Set(livePlans.flatMap((entry) => entry.verifiedAbsentTargetIds));
  const createRows = createResult.batches.flatMap((batch) => batch.rows);
  const createObjects = createRows.map((row) => row.objectRevision);
  const createRelations = createResult.batches.flatMap((batch) => relationRevisions(coreDb, batch.runId, workspaceId)
    .filter((revision) => revision.relation_type !== 'risk_control'));
  const deleteRunIds = [...new Set(livePlans.map((entry) => String(entry.entry.plan.runId)))];
  for (const target of createObjects) {
    const identity = `${target.object_type}|${target.object_id}`;
    if (!verifiedAbsent.has(identity)) throw new PendingAcceptanceError(`Final authoritative catalog has no exact absence proof for ${identity}.`);
    const tombstone = latestTombstoneObject(coreDb, target, deleteRunIds);
    if (!tombstone || parseJson(tombstone.payload_json, `${identity} tombstone`).deleted !== true) throw new PendingAcceptanceError(`${identity} has no Delete-run tombstone projection.`);
    exactCurrentTombstone(coreDb, tombstone, 'object', identity);
    trustedProjection(coreDb, tombstone, DELETE_FEATURE_ID, featureVersion, 'omnia.delete.');
  }
  const cascades = createRows.map((row) => verifyGraCascadeDeletion(coreDb, livePlans, row, featureVersion, workspaceId));
  const uniqueRelations = new Map(createRelations.map((relation) => [`${relation.workspace_id}\0${relation.relation_type}\0${relation.relation_key}`, relation]));
  for (const relation of uniqueRelations.values()) {
    const tombstone = latestTombstoneRelation(coreDb, relation, deleteRunIds);
    if (!tombstone || parseJson(tombstone.payload_json, `${relation.relation_key} tombstone`).deleted !== true) throw new PendingAcceptanceError(`${relation.relation_key} has no Delete-run tombstone projection.`);
    exactCurrentTombstone(coreDb, tombstone, 'relation', `${relation.relation_type}/${relation.relation_key}`);
    trustedProjection(coreDb, tombstone, DELETE_FEATURE_ID, featureVersion, 'omnia.delete.');
  }
  return { schemaVersion: 'omnia.delete-live-acceptance/v1', status: 'passed', featureVersion, workspaceId,
    deleteRunIds, finalCatalog: { runId: finalPlan.entry.plan.runId, capturedAt: finalVerification.capturedAt, catalogItemCount: 0, catalogDigest: finalVerification.catalogDigest },
    verifiedAbsentTargetCount: createObjects.length + cascades.length, verifiedDeletedRelationCount: uniqueRelations.size,
    cascadeProofs: cascades,
    verifiedDeletedRiskCount: cascades.reduce((count, cascade) => count + cascade.riskCount, 0),
    verifiedDeletedControlCount: cascades.reduce((count, cascade) => count + cascade.controlCount, 0),
    verifiedDeletedRiskControlCount: cascades.reduce((count, cascade) => count + cascade.riskControlCount, 0) };
}

export function verifyLiveAcceptance(options) {
  const manifest = loadAcceptanceManifest(options.evidenceDirectory);
  const coreDb = new DatabaseSync(path.resolve(options.coreDb), { readOnly: true });
  let deleteDb;
  try {
    const create = verifyCreateLive(coreDb, manifest, { ...options, allowDeletedCurrent: options.phase === 'all' });
    if (options.phase === 'create') return { schemaVersion: 'omnia.create-delete-live-acceptance/v1', status: 'passed', input: { batches: 8, rows: 30, counts: manifest.counts }, create };
    deleteDb = new DatabaseSync(path.resolve(options.deleteDb), { readOnly: true });
    const deletion = verifyDeleteLive(coreDb, deleteDb, create, options);
    return { schemaVersion: 'omnia.create-delete-live-acceptance/v1', status: 'passed', input: { batches: 8, rows: 30, counts: manifest.counts }, create, deletion };
  } finally {
    if (deleteDb) deleteDb.close();
    coreDb.close();
  }
}

function argumentsFrom(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith('--')) throw new Error(`Unexpected argument: ${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
    values[name.slice(2)] = value; index += 1;
  }
  const phase = values.phase || 'all';
  if (!['create', 'all'].includes(phase)) throw new Error('--phase must be create or all.');
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  return {
    coreDb: values['core-db'] || path.join(repository, 'releases', 'data', 'stores', 'core.sqlite'),
    deleteDb: values['delete-store'] || path.join(repository, 'releases', 'data', 'features', DELETE_FEATURE_ID, 'store.sqlite'),
    evidenceDirectory: values['evidence-dir'] || path.join(repository, 'acceptance-evidence', 'create-associate-20260810'),
    createVersion: requiredText(values['create-version'], '--create-version'),
    deleteVersion: phase === 'all' ? requiredText(values['delete-version'], '--delete-version') : values['delete-version'],
    workspaceId: requiredText(values['workspace-id'], '--workspace-id'),
    engagementId: values['engagement-id'] || '', phase
  };
}

async function main() {
  let options;
  try { options = argumentsFrom(process.argv.slice(2)); }
  catch (error) {
    console.error(JSON.stringify({ schemaVersion: 'omnia.create-delete-live-acceptance/v1', status: 'invalid', error: error.message }, null, 2));
    process.exitCode = 1; return;
  }
  try {
    console.log(JSON.stringify(verifyLiveAcceptance(options), null, 2));
  } catch (error) {
    const pending = error instanceof PendingAcceptanceError;
    console.error(JSON.stringify({ schemaVersion: 'omnia.create-delete-live-acceptance/v1', status: pending ? 'pending' : 'invalid',
      error: error.message, details: Array.isArray(error.details) ? error.details : [] }, null, 2));
    process.exitCode = pending ? 2 : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
