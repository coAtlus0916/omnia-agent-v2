import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { CoreDatabase } from '../src/main/database.js';
import { FeaturePackageManager } from '../src/main/features/package-manager.js';
import { canonicalJson, packageDigest, verifyOfficialPackage } from '../src/main/features/official-package.js';
import { resolveProductPaths } from '../src/main/paths.js';
import { canonicalConnectorResponse, connectorResultDigest } from '../src/shared/connector-delivery.js';
import { RemoteConnectorTransport } from '../src/main/connector/remote-connector-transport.js';

const repository = path.resolve(import.meta.dirname, '..');
const featurePackage = path.join(repository, 'feature-packages/delete-elements/candidates/delete-elements-0.1.2.ofp');
const featureId = 'omnia.delete-elements';
const featureVersion = '0.1.2';
const operationId = 'omnia.delete.scope.read.v1';
const connectorId = 'connector-delivery-test';
const sessionGeneration = 19;

test('authenticated 0.3.35 generation cannot advertise durable mutation delivery', () => {
  const transport = new RemoteConnectorTransport(() => ({ bridgeUrl: '', pairId: '', token: '' }));
  Object.assign(transport as any, {
    protocolCompatible: true,
    connectorOnline: true,
    connectorVersion: '0.3.35',
    generation: 4,
    connectorStateEpoch: 7,
    remoteDiagnostics: { pid: 100 },
    protocolAdmissionIdentity: {
      stateEpoch: 7, bridgeGeneration: 4, connectorVersion: '0.3.35',
      diagnosticPid: 100, executionGeneration: 'a'.repeat(48)
    }
  });
  assert.equal(transport.supportsDurableDelivery(), false);
  (transport as any).connectorVersion = '0.3.36';
  assert.equal(transport.supportsDurableDelivery(), false, 'version drift invalidates the old admission identity');
  (transport as any).protocolAdmissionIdentity = {
    stateEpoch: 7, bridgeGeneration: 4, connectorVersion: '0.3.36',
    diagnosticPid: 100, executionGeneration: 'b'.repeat(48)
  };
  assert.equal(transport.supportsDurableDelivery(), true);
  (transport as any).remoteDiagnostics = { pid: 101 };
  assert.equal(transport.supportsDurableDelivery(), false, 'same pairing generation with a replacement PID must re-admit');
});

test('late protocol admission cannot reopen a replaced same-generation Worker', async () => {
  const transport = new RemoteConnectorTransport(() => ({ bridgeUrl: '', pairId: '', token: '' }));
  Object.assign(transport as any, {
    protocolCompatible: true, connectorOnline: true, connectorVersion: '0.3.36', generation: 4,
    connectorStateEpoch: 9, remoteDiagnostics: { pid: 200 }
  });
  let resolveAdmission!: (value: Record<string, unknown>) => void;
  (transport as any).call = () => new Promise((resolve) => { resolveAdmission = resolve; });
  const admission = (transport as any).ensureProtocolAdmission() as Promise<void>;
  Object.assign(transport as any, { connectorStateEpoch: 10, remoteDiagnostics: { pid: 201 } });
  resolveAdmission({
    schemaVersion: 'omnia.connector-protocol-admission-result/v1', admitted: true,
    version: '0.3.36', executionGeneration: 'c'.repeat(48)
  });
  await assert.rejects(admission, /identity changed during protocol admission/i);
  assert.equal(transport.supportsDurableDelivery(), false);
});

test('PackageManager abandons only exact missing read delivery and never replays a missing mutation journal', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-delivery-recovery-'));
  const paths = resolveProductPaths(root);
  const database = new CoreDatabase(paths.database, { encrypt: (value) => value, decrypt: (value) => value });
  let manager: FeaturePackageManager | null = null;
  t.after(async () => {
    if (manager) await manager.disposeRuntime();
    database.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const hostEntrypoint = path.join(root, 'feature-worker-host.cjs');
  await build({
    entryPoints: [path.join(repository, 'src/main/features/feature-worker-host.ts')],
    outfile: hostEntrypoint,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24'
  });

  const featureEnvelope = verifyOfficialPackage(JSON.parse(fs.readFileSync(featurePackage, 'utf8')), 'omnia-feature');
  const operationMember = featureEnvelope.files.find((member) => member.path === 'connector-capability/operation.ofop');
  assert.ok(operationMember);
  const operationPackage = JSON.parse(Buffer.from(operationMember.contentBase64, 'base64').toString('utf8'));
  const operationEnvelope = verifyOfficialPackage(operationPackage, 'omnia-connector-operation');
  const operationDigest = packageDigest(operationEnvelope);
  const manifestMember = operationEnvelope.files.find((member) => member.path === 'manifest.json');
  assert.ok(manifestMember);
  const operationManifest = JSON.parse(Buffer.from(manifestMember.contentBase64, 'base64').toString('utf8')) as {
    packageId: string;
    operations: Array<{ operationId: string }>;
  };

  let handlerCalls = 0;
  let legacyInvokeCalls = 0;
  let durableCapability = false;
  const ackOrder: string[] = [];
  let wrongReceiptCountOnce = true;
  const deliveryStatusRequests: any[] = [];
  const executionGeneration = 'a'.repeat(48);
  const connector: any = {
    mode: 'remote',
    start: async () => undefined,
    stop: async () => undefined,
    unavailableSnapshot: () => ({}),
    load: async () => ({}),
    connect: async () => ({}),
    refresh: async () => ({}),
    lightRead: async () => ({}),
    supportsDurableDelivery: () => durableCapability,
    registerOperation: async () => ({
      schemaVersion: 'omnia.operation-registration-result/v1',
      featureId,
      featureVersion,
      packageId: operationManifest.packageId,
      packageDigest: operationDigest,
      operationIds: operationManifest.operations.map((operation) => operation.operationId)
    }),
    deliveryStatus: async (input: any) => ({
      ...(deliveryStatusRequests.push(structuredClone(input)), {}),
      schemaVersion: 'omnia.connector-delivery-status-result/v1',
      state: 'not_found',
      requestId: input.requestId,
      resultDigest: '',
      responseJson: '',
      executionGeneration: ''
    }),
    invokeOperationWithWitness: async (input: any) => {
      handlerCalls += 1;
      const requestId = input.deliveryContext.requestId;
      const wireResponse = {
        schemaVersion: 'omnia.connector-ipc/v1' as const,
        id: requestId,
        ok: true,
        value: { scopes: [] }
      };
      return {
        ok: true,
        value: wireResponse.value,
        wireResponse,
        witness: {
          schemaVersion: 'omnia.connector-delivery-witness/v1',
          requestId,
          resultDigest: connectorResultDigest(wireResponse),
          sessionGeneration,
          executionGeneration
        }
      };
    },
    invokeOperation: async () => {
      legacyInvokeCalls += 1;
      throw new Error('durable request bypassed witness transport');
    },
    acknowledgeDelivery: async (ack: any) => {
      ackOrder.push(String(ack.resolution));
      if (ack.resolution === 'receipt_committed' && wrongReceiptCountOnce) {
        wrongReceiptCountOnce = false;
        return { acknowledged: true, clearedMutationCount: 1 };
      }
      return {
        acknowledged: true,
        clearedMutationCount: ack.resolution === 'effect_resolved' ? 1 : 0
      };
    }
  };
  manager = new FeaturePackageManager(database.db, paths, undefined, { connector, workerHostEntrypoint: hostEntrypoint });
  manager.install(featurePackage);
  await manager.initializeRuntime();
  const supervisor = (manager as any).supervisors.get(featureId);
  assert.ok(supervisor);
  const connectorInvoke = (supervisor as any).ports.connectorInvoke as (input: unknown, context: unknown) => Promise<unknown>;
  // The assertion targets PackageManager's durable port transaction, not the
  // child lifecycle. Stop the real Feature Worker before fault injection so a
  // failed assertion cannot strand a subprocess behind the test runner.
  await supervisor.stop();
  (manager as any).supervisors.clear();
  const context = { featureId, featureVersion, allowMutation: false };

  const insertPrepared = (
    requestId: string,
    runId: string,
    commandId: string,
    purpose: 'readback'|'mutation',
    preparedOperationId = operationId
  ) => {
    const now = new Date().toISOString();
    database.db.prepare(`
      INSERT INTO connector_delivery_requests(
        request_id,feature_id,feature_version,operation_id,operation_package_digest,run_id,command_id,
        connector_id,session_generation,purpose,state,wire_result_digest,execution_generation,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,'prepared','','',?,?)
    `).run(requestId, featureId, featureVersion, preparedOperationId, operationDigest, runId, commandId,
      connectorId, sessionGeneration, purpose, now, now);
  };
  const invokeReceiptRead = (runId: string, commandId: string) => connectorInvoke({
    schemaVersion: 'omnia.operation-invocation/v1',
    featureId,
    featureVersion,
    operationId,
    operationPackageDigest: operationDigest,
    mutationAuthorized: false,
    request: {
      connectorBinding: { connectorId, sessionGeneration },
      receiptContext: { runId, commandId }
    }
  }, context);

  const atomicRequestId = '00000000-0000-4000-8000-000000000000';
  insertPrepared(atomicRequestId, 'run-atomic', 'command-atomic', 'readback');
  database.db.exec(`
    CREATE TRIGGER reject_delivery_replacement
    BEFORE INSERT ON connector_delivery_requests
    WHEN NEW.run_id='run-atomic'
    BEGIN SELECT RAISE(ABORT, 'injected replacement insert failure'); END;
  `);
  await assert.rejects(invokeReceiptRead('run-atomic', 'command-atomic'), /injected replacement insert failure/);
  database.db.exec('DROP TRIGGER reject_delivery_replacement;');
  const atomicOriginal = database.db.prepare(`SELECT abandoned_at FROM connector_delivery_requests WHERE request_id=?`)
    .get(atomicRequestId) as { abandoned_at: string };
  assert.equal(atomicOriginal.abandoned_at, '');
  assert.equal(handlerCalls, 0);

  const readRequestId = '11111111-1111-4111-8111-111111111111';
  insertPrepared(readRequestId, 'run-read', 'command-read', 'readback');
  await assert.rejects(invokeReceiptRead('run-read', 'command-read'), /receipt|command|evidence/i);
  assert.equal(handlerCalls, 1);
  const abandoned = database.db.prepare(`SELECT state,abandoned_at FROM connector_delivery_requests WHERE request_id=?`)
    .get(readRequestId) as { state: string; abandoned_at: string };
  assert.equal(abandoned.state, 'prepared');
  assert.ok(Date.parse(abandoned.abandoned_at) > 0);
  const replacement = database.db.prepare(`
    SELECT request_id,state,wire_result_digest,execution_generation,abandoned_at
    FROM connector_delivery_requests WHERE run_id='run-read' AND command_id='command-read' AND request_id<>?
  `).get(readRequestId) as Record<string, unknown>;
  assert.notEqual(replacement.request_id, readRequestId);
  assert.equal((database.db.prepare(`
    SELECT COUNT(*) AS count FROM connector_delivery_requests
    WHERE run_id='run-read' AND command_id='command-read' AND request_id<>?
  `).get(readRequestId) as { count: number }).count, 1);
  assert.equal(replacement.state, 'witnessed');
  assert.equal(replacement.execution_generation, executionGeneration);
  assert.equal(replacement.abandoned_at, '');
  const recoveredWire = {
    schemaVersion: 'omnia.connector-ipc/v1' as const,
    id: String(replacement.request_id), ok: true, value: { scopes: [] }
  };
  assert.equal(replacement.wire_result_digest, connectorResultDigest(recoveredWire));
  assert.equal(canonicalConnectorResponse(recoveredWire).includes(String(replacement.request_id)), true);

  await assert.rejects(connectorInvoke({
    schemaVersion: 'omnia.operation-invocation/v1',
    featureId,
    featureVersion,
    operationId: 'omnia.delete.information.direct.v1',
    operationPackageDigest: operationDigest,
    mutationAuthorized: true,
    request: {
      command: { commandId: 'legacy-command', idempotencyKey: 'legacy-key', payload: {} },
      target: { targetIdentityKey: 'legacy-target', workspaceId: 'legacy-workspace' },
      connectorBinding: { connectorId, sessionGeneration },
      planDigest: 'legacy-plan'
    }
  }, { ...context, allowMutation: true }), /durable delivery baseline/i);
  assert.equal(legacyInvokeCalls, 0);
  assert.equal(handlerCalls, 1);

  durableCapability = true;
  const mutationRequestId = '22222222-2222-4222-8222-222222222222';
  const mutationRunId = 'run-mutation';
  const mutationCommandId = 'command-mutation';
  const mutationIntentId = 'intent-mutation';
  const workspaceId = 'workspace-mutation';
  const engagementId = 'engagement-mutation';
  const authorityInstanceId = 'authority-mutation';
  const tenantOrOrgId = 'tenant-mutation';
  const packId = 'pack-mutation';
  const targetIdentityKey = 'target-mutation';
  const planDigest = 'plan-mutation';
  const idempotencyKey = 'idempotency-mutation';
  const payload = { targetId: 'target-mutation' };
  const requestDigest = crypto.createHash('sha256').update(canonicalJson(payload)).digest('hex');
  const workspaceIds = [workspaceId];
  const binding = { connectorId, sessionGeneration, engagementId, authorityInstanceId, tenantOrOrgId, packId };
  const authorityDigest = crypto.createHash('sha256').update(canonicalJson({ ...binding, workspaceIds })).digest('hex');
  const recordedAt = new Date().toISOString();
  database.db.prepare(`
    INSERT INTO feature_runs(
      run_id,trace_id,feature_id,feature_version,engagement_id,state,state_revision,source_artifact_id,
      template_version_id,output_artifact_id,plan_digest,last_error,created_at,updated_at
    ) VALUES(?,?,?,?,?,'returning',1,'','','',?,'',?,?)
  `).run(mutationRunId, 'trace-mutation', featureId, featureVersion, engagementId, planDigest, recordedAt, recordedAt);
  database.db.prepare(`
    INSERT INTO managed_content_intents(
      intent_id,run_id,plan_digest,target_kind,target_key,intended_revision_json,state,created_at,updated_at
    ) VALUES(?,?,?,'field',?,?,'commanded',?,?)
  `).run(mutationIntentId, mutationRunId, planDigest, targetIdentityKey,
    canonicalJson({ kind: 'field', workspace: workspaceId, operationTargetIdentityKey: targetIdentityKey }),
    recordedAt, recordedAt);
  database.db.prepare(`
    INSERT INTO feature_commands(
      command_id,run_id,intent_id,operation_id,idempotency_key,plan_digest,request_digest,
      evidence_operation_ids_json,evidence_target_identity_key,evidence_request_digest,state,
      commit_point_at,submitted_at,completed_at,last_error,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,'submitted','',?,'','',?)
  `).run(mutationCommandId, mutationRunId, mutationIntentId, 'omnia.delete.information.direct.v1',
    idempotencyKey, planDigest, requestDigest, '[]', targetIdentityKey, '', recordedAt, recordedAt);
  database.db.prepare(`
    UPDATE feature_commands SET connector_request_id=?,connector_session_generation=?,connector_id=?,
      connector_operation_package_digest=?,connector_feature_version=? WHERE command_id=?
  `).run(mutationRequestId, sessionGeneration, connectorId, operationDigest, featureVersion, mutationCommandId);
  database.db.prepare(`
    INSERT INTO feature_confirmations(
      confirmation_id,run_id,message_id,plan_digest,connector_id,session_generation,engagement_id,safety_revision,
      credential_digest,preflight_digest,confirmation_token_digest,decision,actor_id,decision_at,consumed_command_id,
      expires_at,created_at,authority_instance_id,tenant_or_org_id,pack_id
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,'approved','tester',?,?,?,?,?,?,?)
  `).run('confirmation-mutation', mutationRunId, 'message-mutation', planDigest, connectorId, sessionGeneration,
    engagementId, 7, authorityDigest, 'preflight', 'token', recordedAt, mutationCommandId,
    new Date(Date.now() + 60_000).toISOString(), recordedAt, authorityInstanceId, tenantOrOrgId, packId);
  database.db.prepare(`
    INSERT OR REPLACE INTO workspace_safety(
      singleton,enabled,engagement_id,workspace_ids_json,authority_observation_id,state_version,updated_at,
      connector_id,session_generation,authority_instance_id,tenant_or_org_id,pack_id,
      global_enabled,global_section_ids_json,global_workspace_ids_json
    ) VALUES(1,1,?,?,?,?,?,?,?,?,?,?,0,'[]','[]')
  `).run(engagementId, canonicalJson(workspaceIds), 'observation-mutation', 7, recordedAt,
    connectorId, sessionGeneration, authorityInstanceId, tenantOrOrgId, packId);
  insertPrepared(mutationRequestId, mutationRunId, mutationCommandId, 'mutation', 'omnia.delete.information.direct.v1');
  await assert.rejects(connectorInvoke({
    schemaVersion: 'omnia.operation-invocation/v1',
    featureId,
    featureVersion,
    operationId: 'omnia.delete.information.direct.v1',
    operationPackageDigest: operationDigest,
    mutationAuthorized: true,
    request: {
      command: { commandId: mutationCommandId, idempotencyKey, payload },
      target: { targetIdentityKey, workspaceId },
      connectorBinding: binding,
      planDigest
    }
  }, { ...context, allowMutation: true }), (error: any) => error?.code === 'REMOTE.MUTATION_UNCERTAIN');
  assert.equal(handlerCalls, 1);
  assert.equal(legacyInvokeCalls, 0);
  const mutation = database.db.prepare(`
    SELECT d.state,d.abandoned_at,c.state AS command_state
    FROM connector_delivery_requests d JOIN feature_commands c ON c.connector_request_id=d.request_id
    WHERE d.request_id=?
  `).get(mutationRequestId) as { state: string; abandoned_at: string; command_state: string };
  assert.equal(mutation.state, 'prepared');
  assert.equal(mutation.abandoned_at, '');
  assert.equal(mutation.command_state, 'uncertain');
  assert.equal((database.db.prepare(`SELECT COUNT(*) AS count FROM connector_delivery_requests WHERE run_id=?`)
    .get(mutationRunId) as { count: number }).count, 1);
  assert.deepEqual({
    requestId: deliveryStatusRequests.at(-1)?.requestId,
    featureId: deliveryStatusRequests.at(-1)?.featureId,
    featureVersion: deliveryStatusRequests.at(-1)?.featureVersion,
    operationId: deliveryStatusRequests.at(-1)?.operationId,
    operationPackageDigest: deliveryStatusRequests.at(-1)?.operationPackageDigest,
    runId: deliveryStatusRequests.at(-1)?.runId,
    commandId: deliveryStatusRequests.at(-1)?.commandId,
    connectorId: deliveryStatusRequests.at(-1)?.connectorId,
    sessionGeneration: deliveryStatusRequests.at(-1)?.sessionGeneration
  }, {
    requestId: mutationRequestId,
    featureId,
    featureVersion,
    operationId: 'omnia.delete.information.direct.v1',
    operationPackageDigest: operationDigest,
    runId: mutationRunId,
    commandId: mutationCommandId,
    connectorId,
    sessionGeneration
  });

  const outboxRequestId = String(replacement.request_id);
  const now = new Date().toISOString();
  const outboxAck = (ackId: string, resolution: 'receipt_committed'|'effect_resolved') => ({
    schemaVersion: 'omnia.connector-delivery-ack/v1',
    ackId,
    deliveredRequestId: outboxRequestId,
    resultDigest: String(replacement.wire_result_digest),
    connectorId,
    sessionGeneration,
    executionGeneration,
    featureId,
    featureVersion,
    operationId,
    operationPackageDigest: operationDigest,
    runId: 'run-read',
    commandId: 'command-read',
    receiptId: '55555555-5555-4555-8555-555555555555',
    receiptResponseDigest: '5'.repeat(64),
    resolution,
    effectOutcome: resolution === 'effect_resolved' ? 'applied' : null,
    reconciles: resolution === 'effect_resolved' ? {
      requestId: mutationRequestId,
      featureId,
      featureVersion,
      operationId,
      operationPackageDigest: operationDigest,
      connectorId,
      sessionGeneration,
      executionGeneration
    } : null
  });
  const effectAckId = '33333333-3333-4333-8333-333333333333';
  const receiptAckId = '44444444-4444-4444-8444-444444444444';
  const insertOutbox = database.db.prepare(`
    INSERT INTO connector_delivery_ack_outbox(
      ack_id,request_id,transaction_kind,payload_json,state,attempts,last_error,created_at,updated_at,delivered_at
    ) VALUES(?,?,?,?, 'pending',0,'',?,?,'')
  `);
  // Deliberately make the final effect row older: SQL dependency, not time or
  // UUID ordering, must force receipt_committed to be delivered first.
  insertOutbox.run(effectAckId, outboxRequestId, 'effect_resolved', JSON.stringify(outboxAck(effectAckId, 'effect_resolved')),
    new Date(Date.now() - 1_000).toISOString(), now);
  insertOutbox.run(receiptAckId, outboxRequestId, 'receipt_committed', JSON.stringify(outboxAck(receiptAckId, 'receipt_committed')),
    now, now);
  await (manager as any).flushConnectorDeliveryAcks();
  assert.deepEqual(ackOrder, ['receipt_committed']);
  const rejectedReceipt = database.db.prepare(`SELECT state,last_error FROM connector_delivery_ack_outbox WHERE ack_id=?`)
    .get(receiptAckId) as { state: string; last_error: string };
  assert.equal(rejectedReceipt.state, 'pending');
  assert.match(rejectedReceipt.last_error, /acknowledgement/i);
  assert.equal((database.db.prepare(`SELECT state FROM connector_delivery_ack_outbox WHERE ack_id=?`)
    .get(effectAckId) as { state: string }).state, 'pending');
  await (manager as any).flushConnectorDeliveryAcks();
  assert.deepEqual(ackOrder, ['receipt_committed', 'receipt_committed', 'effect_resolved']);
  const outboxStates = database.db.prepare(`SELECT transaction_kind,state FROM connector_delivery_ack_outbox WHERE request_id=? ORDER BY transaction_kind`)
    .all(outboxRequestId) as Array<{ transaction_kind: string; state: string }>;
  assert.deepEqual(outboxStates.map((row) => [row.transaction_kind, row.state]), [
    ['effect_resolved', 'delivered'],
    ['receipt_committed', 'delivered']
  ]);
});
