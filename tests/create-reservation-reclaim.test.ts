import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CoreDatabase } from '../src/main/database.js';
import { FeaturePackageManager } from '../src/main/features/package-manager.js';
import { FeatureRuntimeStore } from '../src/main/features/feature-runtime-store.js';
import { canonicalJson } from '../src/main/features/official-package.js';
import { resolveProductPaths } from '../src/main/paths.js';

const cipher = { encrypt: (value: string) => value, decrypt: (value: string) => value };
const require=createRequire(import.meta.url);
const worker=require('../feature-packages/create-associate/source/middle/worker.cjs') as Record<string,any>;
const featureId = 'omnia.create-associate';
const featureVersion = '0.2.148';
const context = { featureId, featureVersion, allowMutation: true };
const binding = {
  connectorId: 'connector-next-test', sessionGeneration: 9, engagementId: 'engagement-test',
  authorityInstanceId: 'authority-test', tenantOrOrgId: 'tenant-test', packId: 'pack-test'
};
const workspaceId = 'workspace-test';
const preflightOperation = 'omnia.create-associate.object.create-preflight.v2';
const reconcileOperation = 'omnia.create-associate.object.reconcile.v1';
const mutationOperation = 'omnia.create-associate.object.create.v1';

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function seedActiveFeature(database: CoreDatabase, productPaths: ReturnType<typeof resolveProductPaths>, now: string): void {
  // The PackageManager owns this generic ledger in production. Constructing it
  // here exercises the same schema without installing or starting any package.
  new FeaturePackageManager(database.db, productPaths);
  database.db.prepare(`INSERT INTO feature_registry(feature_id,feature_version,lifecycle,package_digest,publisher_key_id,health,activated_at) VALUES(?,?,'active',?,'test-key','healthy',?)`)
    .run(featureId, featureVersion, `sha256:${'a'.repeat(64)}`, now);
  database.db.prepare(`INSERT INTO feature_activation_heads(feature_id,feature_version,activation_generation,runtime_enabled,runtime_reason,package_path,package_digest,updated_at) VALUES(?,?,1,1,'','test-package',?,?)`)
    .run(featureId, featureVersion, `sha256:${'a'.repeat(64)}`, now);
  database.db.prepare(`UPDATE workspace_safety SET enabled=1,connector_id=?,session_generation=?,engagement_id=?,workspace_ids_json=?,authority_instance_id=?,tenant_or_org_id=?,pack_id=?,state_version=2 WHERE singleton=1`)
    .run(binding.connectorId,binding.sessionGeneration,binding.engagementId,JSON.stringify([workspaceId]),binding.authorityInstanceId,binding.tenantOrOrgId,binding.packId);
}

function seedFrozenCreate(
  database: CoreDatabase,
  ids: { runId: string; traceId: string; confirmationId: string; intentId: string },
  planDigest: string,
  externalId: string,
  targetKey: string,
  targetIdentityKey: string,
  now: string
): { mutationRequest: Record<string, unknown>; intended: Record<string, unknown> } {
  const authorityDigest = digest({ ...binding, workspaceIds: [workspaceId] });
  database.db.prepare(`INSERT INTO feature_runs(run_id,trace_id,feature_id,feature_version,engagement_id,state,state_revision,source_artifact_id,template_version_id,output_artifact_id,plan_digest,last_error,created_at,updated_at) VALUES(?,?,?,?,?,'returning',3,'','','',?,'',?,?)`)
    .run(ids.runId,ids.traceId,featureId,featureVersion,binding.engagementId,planDigest,now,now);
  database.db.prepare(`INSERT INTO feature_confirmations(confirmation_id,run_id,message_id,plan_digest,connector_id,session_generation,engagement_id,authority_instance_id,tenant_or_org_id,pack_id,safety_revision,credential_digest,preflight_digest,confirmation_token_digest,decision,actor_id,decision_at,consumed_command_id,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'approved','local-user',?,'',?,?)`)
    .run(ids.confirmationId,ids.runId,`return:${ids.runId}`,planDigest,binding.connectorId,binding.sessionGeneration,binding.engagementId,binding.authorityInstanceId,binding.tenantOrOrgId,binding.packId,2,authorityDigest,'b'.repeat(64),'c'.repeat(64),now,'2099-01-01T00:00:00.000Z',now);
  const intended = {
    kind: 'object', key: targetKey, workspace: workspaceId, objectType: 'Application', externalId,
    description: externalId, disposition: 'create', mutationOperationId: mutationOperation,
    operationTargetIdentityKey: targetIdentityKey,
    evidenceOperationIds: [preflightOperation,reconcileOperation]
  };
  database.db.prepare(`INSERT INTO managed_content_intents(intent_id,run_id,plan_digest,target_kind,target_key,intended_revision_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?,'frozen',?,?)`)
    .run(ids.intentId,ids.runId,planDigest,'object',targetKey,JSON.stringify(intended),now,now);
  const description=JSON.stringify({editorData:`<p>${externalId}</p>`,suggestionsData:[],trackChangesEnableFlagInEditor:false,plainText:externalId});
  return { intended, mutationRequest: { name:externalId,number:externalId,workspaceId,itElementType:'Application',description } };
}

function insertAbsenceReceipt(
  database: CoreDatabase,
  values: { receiptId: string; runId: string; commandId: string; planDigest: string; targetKey: string; targetIdentityKey: string; requestDigest: string },
  response: Record<string, unknown>,
  now: string
): void {
  const responseJson=canonicalJson(response);
  database.db.prepare(`INSERT INTO feature_operation_receipts(receipt_id,run_id,command_id,feature_id,feature_version,operation_package_digest,operation_id,authority_digest,connector_id,session_generation,engagement_id,authority_instance_id,tenant_or_org_id,pack_id,frozen_target_key,target_identity_key,workspace_ids_json,plan_digest,request_digest,response_digest,response_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(values.receiptId,values.runId,values.commandId,featureId,featureVersion,`sha256:${'d'.repeat(64)}`,preflightOperation,
      digest({...binding,workspaceIds:[workspaceId]}),binding.connectorId,binding.sessionGeneration,binding.engagementId,
      binding.authorityInstanceId,binding.tenantOrOrgId,binding.packId,values.targetKey,values.targetIdentityKey,
      canonicalJson([workspaceId]),values.planDigest,values.requestDigest,digest(response),responseJson,now);
}

test('completed create identity is reclaimed only after an exact active-and-recycle-bin absence receipt', () => {
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'omnia-create-reclaim-'));
  const productPaths=resolveProductPaths(temporary);
  const database=new CoreDatabase(productPaths.database,cipher);
  const store=new FeatureRuntimeStore(database.db,productPaths);
  const now=new Date().toISOString();
  try {
    seedActiveFeature(database,productPaths,now);
    const ids={runId:'11111111-1111-4111-8111-111111111111',traceId:'12121212-1212-4212-8212-121212121212',confirmationId:'13131313-1313-4313-8313-131313131313',intentId:'14141414-1414-4414-8414-141414141414'};
    const planDigest='1'.repeat(64),targetKey='object|row-recreate',targetIdentityKey='Application|APP-RECREATE';
    const {mutationRequest}=seedFrozenCreate(database,ids,planDigest,'APP-RECREATE',targetKey,targetIdentityKey,now);
    // This is the precise state left by an earlier verified create. It is not
    // blindly released merely because another Feature later deleted an object.
    database.db.prepare(`INSERT INTO feature_mutation_reservations(authority_instance_id,tenant_or_org_id,pack_id,engagement_id,workspace_id,logical_identity_key,owner_run_id,owner_intent_id,owner_command_id,lifecycle,acquired_at,lease_expires_at,updated_at,absence_receipt_id) VALUES(?,?,?,?,?,?,?,'old-intent','old-command','completed',?,?,?,'old-receipt')`)
      .run(binding.authorityInstanceId,binding.tenantOrOrgId,binding.packId,binding.engagementId,workspaceId,targetIdentityKey,'old-run',now,now,now);

    const command=store.call('prepareReturnCommand',{runId:ids.runId,planDigest,targetKind:'object',targetKey,
      operationId:mutationOperation,request:mutationRequest,evidenceOperationIds:[preflightOperation,reconcileOperation],
      evidenceTargetIdentityKey:targetIdentityKey,binding,workspaceIds:[workspaceId]},context) as {commandId:string};
    const reclaimed=database.db.prepare(`SELECT owner_run_id,owner_command_id,lifecycle,absence_receipt_id FROM feature_mutation_reservations WHERE logical_identity_key=?`).get(targetIdentityKey) as Record<string,unknown>;
    assert.deepEqual({...reclaimed},{owner_run_id:ids.runId,owner_command_id:command.commandId,lifecycle:'active',absence_receipt_id:''});

    const evidenceRequest={connectorBinding:binding,target:{targetIdentityKey,workspaceId},query:{externalId:'APP-RECREATE',objectType:'Application',workspaceId,graName:'GRA-APP-RECREATE',rait:'Higher'},planDigest};
    const frozen=store.call('freezeReturnEvidenceSpec',{runId:ids.runId,commandId:command.commandId,operationId:preflightOperation,request:evidenceRequest},context) as {requestDigest:string};
    const absence={source:'workspace_object_directory',found:false,item:null,matchState:'none',matchCount:0,graState:'none',graMatchCount:0,disposition:'create',reasonCode:'not_found',resolved:null,
      evidence:{applicationPagesRead:1,applicationObserved:0,applicationTotal:0,workItemCount:0,commonAccountCount:0}};
    const receiptId='15151515-1515-4515-8515-151515151515';
    insertAbsenceReceipt(database,{receiptId,runId:ids.runId,commandId:command.commandId,planDigest,targetKey,targetIdentityKey,requestDigest:frozen.requestDigest},absence,now);
    store.call('recordReturnEvidence',{runId:ids.runId,commandId:command.commandId,evidenceType:'preflight',commandState:'prepared',payload:{...absence,__operationReceiptId:receiptId},receiptId,verified:true},context);
    assert.throws(()=>store.call('recordReturnEvidence',{runId:ids.runId,commandId:command.commandId,evidenceType:'request',commandState:'submitted',payload:{operationId:mutationOperation,request:mutationRequest},verified:true},context),/reservation was superseded or released/);
    assert.equal(worker.completeObjectCreateAbsence(absence,'Application'),true);
    const claimed=store.call('bindMutationReservationEvidence',{runId:ids.runId,commandId:command.commandId,operationId:preflightOperation,receiptId,evidenceRequest},context) as Record<string,unknown>;
    assert.equal(claimed.absenceReceiptId,receiptId);
    const durable=database.db.prepare(`SELECT mr.absence_receipt_id,c.evidence_request_digest FROM feature_mutation_reservations mr JOIN feature_commands c ON c.command_id=mr.owner_command_id WHERE mr.logical_identity_key=?`).get(targetIdentityKey) as Record<string,unknown>;
    assert.deepEqual({...durable},{absence_receipt_id:receiptId,evidence_request_digest:''});
    store.call('recordReturnEvidence',{runId:ids.runId,commandId:command.commandId,evidenceType:'request',commandState:'submitted',payload:{operationId:mutationOperation,request:mutationRequest},verified:true},context);
    assert.equal((database.db.prepare(`SELECT state FROM feature_commands WHERE command_id=?`).get(command.commandId) as {state:string}).state,'submitted');
    assert.throws(()=>store.call('transitionRun',{runId:ids.runId,expectedRevision:3,toState:'failed',eventType:'return.force_cancelled',error:'unsafe force close',details:{}},context),/conclusive read-only outcome/);
    assert.equal((database.db.prepare(`SELECT state FROM feature_runs WHERE run_id=?`).get(ids.runId) as {state:string}).state,'returning');
  } finally {
    database.close();
    fs.rmSync(temporary,{recursive:true,force:true});
  }
});

test('Feature-owned absence predicates require complete zero-result evidence for APP, generic IT Element, and GRA',()=>{
  assert.equal(worker.completeObjectCreateAbsence({found:false,item:null,matchState:'none',matchCount:0,graState:'none',graMatchCount:0,disposition:'create',reasonCode:'not_found',evidence:{applicationPagesRead:1,applicationObserved:0}},'Application'),true);
  assert.equal(worker.completeObjectCreateAbsence({found:false,item:null,matchState:'none',matchCount:0,activeCount:0,recycleBinCount:0,graState:'none',graMatchCount:0,disposition:'create',reasonCode:'not_found',evidence:{pagesRead:1,observed:0}},'Infrastructure'),true);
  assert.equal(worker.completeObjectCreateAbsence({found:false,item:null,matchState:'none',matchCount:0,graState:'none',graMatchCount:0,disposition:'create',reasonCode:'not_found',evidence:{applicationPagesRead:0,applicationObserved:0}},'Application'),false);
  assert.equal(worker.completeObjectCreateAbsence({found:false,item:null,matchState:'none',matchCount:1,activeCount:0,recycleBinCount:1,graState:'none',graMatchCount:0,disposition:'create',reasonCode:'not_found',evidence:{pagesRead:1,observed:1}},'ITTool'),false);
  assert.equal(worker.completeGraCreateAbsence({found:false,item:null,evidence:{directoryMatches:0}}),true);
  assert.equal(worker.completeGraCreateAbsence({found:false,item:null,evidence:{}}),false);
});

test('a failed preflight releases only its undispatched create reservation', () => {
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'omnia-create-preflight-failed-'));
  const productPaths=resolveProductPaths(temporary);
  const database=new CoreDatabase(productPaths.database,cipher);
  const store=new FeatureRuntimeStore(database.db,productPaths);
  const now=new Date().toISOString();
  try {
    seedActiveFeature(database,productPaths,now);
    const ids={runId:'19111111-1111-4111-8111-111111111111',traceId:'19221212-1212-4212-8212-121212121212',confirmationId:'19331313-1313-4313-8313-131313131313',intentId:'19441414-1414-4414-8414-141414141414'};
    const planDigest='9'.repeat(64),targetKey='object|row-preflight-failed',targetIdentityKey='Application|APP-PREFLIGHT-FAILED';
    const {mutationRequest}=seedFrozenCreate(database,ids,planDigest,'APP-PREFLIGHT-FAILED',targetKey,targetIdentityKey,now);
    const command=store.call('prepareReturnCommand',{runId:ids.runId,planDigest,targetKind:'object',targetKey,
      operationId:mutationOperation,request:mutationRequest,evidenceOperationIds:[preflightOperation,reconcileOperation],
      evidenceTargetIdentityKey:targetIdentityKey,binding,workspaceIds:[workspaceId]},context) as {commandId:string};

    store.call('recordReturnEvidence',{runId:ids.runId,commandId:command.commandId,evidenceType:'preflight',commandState:'failed',
      payload:{code:'RETURN.PREFLIGHT_BLOCKED',message:'The identity still exists.'},verified:false,error:'The identity still exists.'},context);

    assert.deepEqual({...database.db.prepare(`
      SELECT c.state,c.submitted_at,c.connector_request_id,mr.lifecycle,mr.absence_receipt_id
      FROM feature_commands c JOIN feature_mutation_reservations mr ON mr.owner_command_id=c.command_id
      WHERE c.command_id=?
    `).get(command.commandId) as Record<string,unknown>},{
      state:'failed',submitted_at:'',connector_request_id:'',lifecycle:'released',absence_receipt_id:''
    });
    assert.equal((database.db.prepare(`SELECT COUNT(*) AS count FROM connector_delivery_requests WHERE command_id=? AND purpose='mutation'`).get(command.commandId) as {count:number}).count,0);
  } finally {
    database.close();
    fs.rmSync(temporary,{recursive:true,force:true});
  }
});

test('recycle-bin evidence cannot unlock create, while force-close releases only an unsubmitted reservation and keeps audit', () => {
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'omnia-create-force-close-'));
  const productPaths=resolveProductPaths(temporary);
  const database=new CoreDatabase(productPaths.database,cipher);
  const store=new FeatureRuntimeStore(database.db,productPaths);
  const now=new Date().toISOString();
  try {
    seedActiveFeature(database,productPaths,now);
    const ids={runId:'21111111-1111-4111-8111-111111111111',traceId:'22121212-1212-4212-8212-121212121212',confirmationId:'23131313-1313-4313-8313-131313131313',intentId:'24141414-1414-4414-8414-141414141414'};
    const planDigest='2'.repeat(64),targetKey='object|row-recycled',targetIdentityKey='Application|APP-RECYCLED';
    const {mutationRequest}=seedFrozenCreate(database,ids,planDigest,'APP-RECYCLED',targetKey,targetIdentityKey,now);
    const command=store.call('prepareReturnCommand',{runId:ids.runId,planDigest,targetKind:'object',targetKey,
      operationId:mutationOperation,request:mutationRequest,evidenceOperationIds:[preflightOperation,reconcileOperation],
      evidenceTargetIdentityKey:targetIdentityKey,binding,workspaceIds:[workspaceId]},context) as {commandId:string};
    const evidenceRequest={connectorBinding:binding,target:{targetIdentityKey,workspaceId},query:{externalId:'APP-RECYCLED',objectType:'Application',workspaceId,graName:'GRA-APP-RECYCLED',rait:'Higher'},planDigest};
    const frozen=store.call('freezeReturnEvidenceSpec',{runId:ids.runId,commandId:command.commandId,operationId:preflightOperation,request:evidenceRequest},context) as {requestDigest:string};
    const recycled={source:'workspace_object_directory',found:true,item:{id:'recycled-object'},matchState:'recycle_bin',matchCount:1,graState:'none',graMatchCount:0,disposition:'skip',reasonCode:'recycled_identity_present',resolved:null,
      evidence:{applicationPagesRead:1,applicationObserved:1,applicationTotal:1,workItemCount:0,commonAccountCount:0}};
    const receiptId='25151515-1515-4515-8515-151515151515';
    insertAbsenceReceipt(database,{receiptId,runId:ids.runId,commandId:command.commandId,planDigest,targetKey,targetIdentityKey,requestDigest:frozen.requestDigest},recycled,now);
    store.call('recordReturnEvidence',{runId:ids.runId,commandId:command.commandId,evidenceType:'preflight',commandState:'prepared',payload:{...recycled,__operationReceiptId:receiptId},receiptId,verified:true},context);
    assert.equal(worker.completeObjectCreateAbsence(recycled,'Application'),false,'Feature must reject a recycled identity before asking Core to bind its receipt');
    assert.equal((database.db.prepare(`SELECT absence_receipt_id FROM feature_mutation_reservations WHERE owner_command_id=?`).get(command.commandId) as {absence_receipt_id:string}).absence_receipt_id,'');

    const revision=store.call('transitionRun',{runId:ids.runId,expectedRevision:3,toState:'failed',eventType:'return.force_cancelled',error:'user force close',details:{reason:'test'}},context);
    assert.equal(revision,4);
    assert.equal((database.db.prepare(`SELECT lifecycle FROM feature_mutation_reservations WHERE owner_command_id=?`).get(command.commandId) as {lifecycle:string}).lifecycle,'released');
    assert.equal((database.db.prepare(`SELECT COUNT(*) AS count FROM feature_commands WHERE command_id=?`).get(command.commandId) as {count:number}).count,1,'force-close preserves command audit');
    assert.equal((database.db.prepare(`SELECT COUNT(*) AS count FROM feature_operation_receipts WHERE receipt_id=?`).get(receiptId) as {count:number}).count,1,'force-close preserves receipt audit');
    const details=JSON.parse((database.db.prepare(`SELECT details_json FROM feature_run_events WHERE run_id=? AND revision=4`).get(ids.runId) as {details_json:string}).details_json);
    assert.equal(details.releasedCreateReservations,1);
  } finally {
    database.close();
    fs.rmSync(temporary,{recursive:true,force:true});
  }
});

test('Connector Next pre-effect not-started proof releases the exact create reservation for one safe retry', async () => {
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'omnia-create-pre-effect-retry-'));
  const productPaths=resolveProductPaths(temporary);
  const database=new CoreDatabase(productPaths.database,cipher);
  const manager=new FeaturePackageManager(database.db,productPaths);
  const now=new Date().toISOString();
  const runId='31111111-1111-4111-8111-111111111111';
  const intentId='32121212-1212-4212-8212-121212121212';
  const commandId='33131313-1313-4313-8313-131313131313';
  const requestId='34141414-1414-4414-8414-141414141414';
  const executionGeneration='e'.repeat(48);
  const operationPackageDigest=`sha256:${'f'.repeat(64)}`;
  const resultDigest='a'.repeat(64);
  try {
    (manager as any).runtime={connector:{acknowledgeDelivery:async(ack:Record<string,unknown>)=>({
      acknowledged:true,clearedMutationCount:String(ack.resolution)==='closed_not_applied'?1:0
    })}};
    database.db.prepare(`INSERT INTO feature_runs(run_id,trace_id,feature_id,feature_version,engagement_id,state,state_revision,source_artifact_id,template_version_id,output_artifact_id,plan_digest,last_error,created_at,updated_at) VALUES(?,?,?,?,?,'returning',3,'','','',?,'',?,?)`)
      .run(runId,crypto.randomUUID(),featureId,featureVersion,binding.engagementId,'3'.repeat(64),now,now);
    database.db.prepare(`INSERT INTO managed_content_intents(intent_id,run_id,plan_digest,target_kind,target_key,intended_revision_json,state,created_at,updated_at) VALUES(?,?,?,'object','object|retry',?,'commanded',?,?)`)
      .run(intentId,runId,'3'.repeat(64),canonicalJson({kind:'object',disposition:'create',workspace:workspaceId,externalId:'APP-RETRY'}),now,now);
    database.db.prepare(`INSERT INTO feature_commands(command_id,run_id,intent_id,operation_id,idempotency_key,plan_digest,request_digest,evidence_operation_ids_json,evidence_target_identity_key,evidence_request_digest,state,commit_point_at,submitted_at,completed_at,last_error,created_at,connector_request_id,connector_execution_generation,connector_session_generation,connector_id,connector_operation_package_digest,connector_feature_version) VALUES(?,?,?,?,?,?,?,?,?,?,'submitted','',?,'','',?,?,?,?,?,?,?)`)
      .run(commandId,runId,intentId,mutationOperation,'retry-key','3'.repeat(64),'4'.repeat(64),canonicalJson([preflightOperation]),'Application|APP-RETRY','',now,now,requestId,executionGeneration,binding.sessionGeneration,binding.connectorId,operationPackageDigest,featureVersion);
    database.db.prepare(`INSERT INTO feature_mutation_reservations(authority_instance_id,tenant_or_org_id,pack_id,engagement_id,workspace_id,logical_identity_key,owner_run_id,owner_intent_id,owner_command_id,lifecycle,acquired_at,lease_expires_at,updated_at,absence_receipt_id) VALUES(?,?,?,?,?,'Application|APP-RETRY',?,?,?,'active',?,?,?,'verified-preflight')`)
      .run(binding.authorityInstanceId,binding.tenantOrOrgId,binding.packId,binding.engagementId,workspaceId,runId,intentId,commandId,now,now,now);
    database.db.prepare(`INSERT INTO connector_delivery_requests(request_id,feature_id,feature_version,operation_id,operation_package_digest,run_id,command_id,connector_id,session_generation,purpose,state,wire_result_digest,execution_generation,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'mutation','witnessed',?,?,?,?)`)
      .run(requestId,featureId,featureVersion,mutationOperation,operationPackageDigest,runId,commandId,binding.connectorId,binding.sessionGeneration,resultDigest,executionGeneration,now,now);

    await (manager as any).closeConnectorNextMutationNotStarted({requestId,runId,commandId,featureId,featureVersion,
      operationId:mutationOperation,operationPackageDigest,connectorId:binding.connectorId,sessionGeneration:binding.sessionGeneration,
      witness:{schemaVersion:'omnia.connector-delivery-witness/v1',requestId,resultDigest,sessionGeneration:binding.sessionGeneration,executionGeneration},
      message:'Connector proved the mutation did not start.'});

    assert.deepEqual({...database.db.prepare(`SELECT c.state AS command_state,i.state AS intent_state,d.state AS delivery_state,r.lifecycle AS reservation_lifecycle FROM feature_commands c JOIN managed_content_intents i ON i.intent_id=c.intent_id JOIN connector_delivery_requests d ON d.request_id=c.connector_request_id JOIN feature_mutation_reservations r ON r.owner_command_id=c.command_id WHERE c.command_id=?`).get(commandId) as Record<string,unknown>},
      {command_state:'closed_not_applied',intent_state:'verified',delivery_state:'effect_resolved',reservation_lifecycle:'released'});
    assert.deepEqual((database.db.prepare(`SELECT transaction_kind,state FROM connector_delivery_ack_outbox WHERE request_id=? ORDER BY CASE transaction_kind WHEN 'receipt_committed' THEN 0 ELSE 1 END`).all(requestId) as Array<Record<string,unknown>>).map((row)=>({...row})),[
      {transaction_kind:'receipt_committed',state:'delivered'},
      {transaction_kind:'effect_resolved',state:'delivered'}
    ]);
  } finally {
    await manager.disposeRuntime();
    database.close();
    fs.rmSync(temporary,{recursive:true,force:true});
  }
});
