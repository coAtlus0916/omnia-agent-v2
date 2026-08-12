import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { OperationHost } from '../src/connector/operation-host.js';
import { canonicalJson } from '../src/main/features/official-package.js';

const repository = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const handlerSourcePath = path.join(repository, 'feature-packages/create-associate/source/connector-capability/operation/handler.cjs');
const { createOperationHandler } = require(handlerSourcePath) as { createOperationHandler(): { run(operationId:string, request:any, sdk:any):Promise<any> } };
const worker = require(path.join(repository, 'feature-packages/create-associate/source/middle/worker.cjs')) as any;
const engagementId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const applicationId = '33333333-3333-4333-8333-333333333333';
const graId = '44444444-4444-4444-8444-444444444444';
const recycledGraId = '55555555-5555-4555-8555-555555555555';

const target = { targetIdentityKey: 'Application|APP-SAP-ECC', workspaceId };
const query = { objectType: 'Application', externalId: 'APP-SAP-ECC', workspaceId, graName: 'GRA-APP-SAP-ECC', rait: 'Higher' };
const activeApplication = { id: applicationId, number: 'APP-SAP-ECC', name: 'APP-SAP-ECC', workspaceId, itElementType: 'Application', riskAssessmentId: graId };
const activeGraIndex = { externalId: graId, id: '66666666-6666-4666-8666-666666666666', entityId: applicationId,
  itElementName: 'APP-SAP-ECC', name: 'GRA-APP-SAP-ECC', workspaceId, riskAssessmentType: 'Application', itElementRaitConclusionLevelId: 'Higher' };
const activeGraDetail = { id: graId, entityId: applicationId, name: 'GRA-APP-SAP-ECC', workspaceId,
  type: 'Application', itElementRaitConclusionLevelId: 'Higher' };
const activeDetail = { ...activeApplication, graName: 'GRA-APP-SAP-ECC', graContent: { name: 'SAP ECC' }, graStatus: 1, riskAssessments: [{ id: graId }] };
const noGraDetail = { id: applicationId, number: 'APP-SAP-ECC', name: 'APP-SAP-ECC', workspaceId,
  itElementType: 'Application', graName: null, graContent: null, graStatus: 0, riskAssessments: [] };

type Scenario = {
  applications?: any[];
  infrastructures?: any[];
  workItems?: any[];
  commonAccounts?: any[];
  objectDetail?: any;
  graDetail?: any;
  graRisks?: any;
  search?: (page:number) => any;
  calls?: Array<{stepId:string; body:any}>;
};
function sdkFor(scenario: Scenario) {
  return { binding: { engagementId }, invokeStep: async (stepId:string, _parameters:any = {}, body?:any) => {
    scenario.calls?.push({ stepId, body: structuredClone(body) });
    if (stepId === 'workitem-directory') return scenario.workItems || [];
    if (stepId === 'gra-directory') return scenario.commonAccounts || [];
    if (stepId === 'application-search') return scenario.search
      ? scenario.search(Number(body.page))
      : { results: scenario.applications || [], totalResults: (scenario.applications || []).length };
    if (stepId === 'infrastructure-search') return { results: scenario.infrastructures || [], totalResults: (scenario.infrastructures || []).length };
    if (stepId === 'object-detail') return scenario.objectDetail;
    if (stepId === 'gra-detail') return scenario.graDetail;
    if (stepId === 'gra-risks') return scenario.graRisks || [];
    throw new Error(`Unexpected step ${stepId}`);
  } };
}
const resolve = (scenario:Scenario, request:any = { target, query }) => createOperationHandler().run(
  'omnia.create-associate.object.identity.resolve.v1', request, sdkFor(scenario)
);

test('generic non-APP identity resolution never promotes recycle-bin or ambiguous rows to active',async()=>{
  const infrastructureId='77777777-7777-4777-8777-777777777777';
  const genericTarget={targetIdentityKey:'Infrastructure|DB-ONE',workspaceId};
  const genericQuery={objectType:'Infrastructure',externalId:'DB-ONE',workspaceId,graName:'GRA-DB-ONE'};
  const active={id:infrastructureId,number:'DB-ONE',name:'DB-ONE',workspaceId,itElementType:'Infrastructure',typeId:'db-generic'};
  const invoke=(scenario:Scenario)=>createOperationHandler().run('omnia.create-associate.object.preflight.v1',{target:genericTarget,query:genericQuery},sdkFor({...scenario,objectDetail:scenario.objectDetail??active}));
  const exact=await invoke({infrastructures:[active]});assert.deepEqual([exact.found,exact.matchState,exact.activeCount,exact.recycleBinCount],[true,'active',1,0]);
  const recycled=await invoke({infrastructures:[{...active,isDeleted:true}]});assert.deepEqual([recycled.found,recycled.matchState],[false,'recycle_bin']);
  const ambiguous=await invoke({infrastructures:[active,{...active,id:'88888888-8888-4888-8888-888888888888',isDeleted:true}]});assert.deepEqual([ambiguous.found,ambiguous.matchState],[false,'ambiguous']);
  const recycledGra={externalId:recycledGraId,entityId:infrastructureId,itElementName:'DB-ONE',name:'GRA-DB-ONE',workspaceId,riskAssessmentType:'Infrastructure',isDeleted:true};
  const graBlocked=await invoke({infrastructures:[active],workItems:[recycledGra],commonAccounts:[{id:recycledGraId,isDeleted:true}]});assert.deepEqual([graBlocked.found,graBlocked.matchState],[false,'ambiguous']);
});

test('APP identity resolution returns create, resume, reuse, and blocks same-name recycle state', async () => {
  const calls:Array<{stepId:string;body:any}>=[];
  const clean = await resolve({ calls });
  assert.deepEqual([clean.disposition, clean.reasonCode, clean.matchState, clean.graState], ['create', 'not_found', 'none', 'none']);
  assert.deepEqual(calls.find((item)=>item.stepId==='workitem-directory')?.body,
    { workItemIds: [], engagementIds: [engagementId], workItemTypes: ['RiskFactorEvaluation'] });
  assert.deepEqual(calls.find((item)=>item.stepId==='gra-directory')?.body, { riskAssessmentType: [] });
  assert.deepEqual(calls.find((item)=>item.stepId==='application-search')?.body,
    { page: 1, pageSize: 500, filters: [], sortFields: [{ field: 'number', direction: 'asc' }] });

  const elementOnlyApplication = { ...activeApplication, riskAssessmentId: undefined };
  const resumed = await resolve({ applications:[elementOnlyApplication], objectDetail:noGraDetail });
  assert.deepEqual([resumed.disposition, resumed.reasonCode, resumed.resolved.objectId],
    ['resume', 'exact_element_without_gra', applicationId]);

  const staleIndexedAssessment = await resolve({
    applications:[{ ...activeApplication, riskAssessmentId: recycledGraId }],
    objectDetail:noGraDetail
  });
  assert.deepEqual([staleIndexedAssessment.disposition, staleIndexedAssessment.reasonCode],
    ['skip', 'active_pair_incompatible'], 'an indexed GRA identity must never be treated as element-only resume');

  const historicalDifferentGra = { externalId: recycledGraId, entityId: applicationId, itElementName: 'APP-SAP-ECC',
    name: 'GRA-APP-SAP-ECC-OLD', workspaceId, riskAssessmentType: 'Application', isDeleted: true };
  const reused = await resolve({ applications:[activeApplication], workItems:[activeGraIndex, historicalDifferentGra],
    commonAccounts:[{ id: recycledGraId, isDeleted:true }], objectDetail:activeDetail, graDetail:activeGraDetail });
  assert.deepEqual([reused.disposition, reused.reasonCode, reused.matchState, reused.resolved.riskAssessmentId],
    ['reuse', 'exact_existing_pair', 'active', graId]);
  assert.equal(Object.hasOwn(reused.item, 'concurrencyTabs'), false, 'raw object detail must be pruned');

  const recycledSameName = { externalId: recycledGraId, itElementName: 'APP-SAP-ECC', name: 'GRA-APP-SAP-ECC',
    workspaceId, riskAssessmentType: 'Application', isDeleted: true };
  const blocked = await resolve({ applications:[activeApplication], workItems:[recycledSameName],
    commonAccounts:[{ id: recycledGraId, isDeleted:true }], objectDetail:noGraDetail });
  assert.deepEqual([blocked.disposition, blocked.reasonCode, blocked.graState], ['skip', 'gra_in_recycle_bin', 'recycle_bin']);
  await assert.rejects(createOperationHandler().run('omnia.create-associate.object.create-preflight.v2',
    { target, query }, sdkFor({ applications:[activeApplication], workItems:[recycledSameName],
      commonAccounts:[{ id: recycledGraId, isDeleted:true }], objectDetail:noGraDetail })), /gra_in_recycle_bin/);
});

test('APP identity resolution fails closed on workspace, type, GRA, RAIT, and pagination drift', async () => {
  for (const [label, objectDetail, graDetail] of [
    ['workspace', { ...activeDetail, workspaceId:'77777777-7777-4777-8777-777777777777' }, activeGraDetail],
    ['type', { ...activeDetail, itElementType:'Infrastructure' }, activeGraDetail],
    ['GRA', activeDetail, { ...activeGraDetail, name:'GRA-OTHER' }],
    ['RAIT', activeDetail, { ...activeGraDetail, itElementRaitConclusionLevelId:'Lower' }]
  ] as const) {
    const result = await resolve({ applications:[activeApplication], workItems:[activeGraIndex], objectDetail, graDetail });
    assert.deepEqual([result.disposition, result.reasonCode], ['skip', 'active_pair_incompatible'], label);
  }
  const filler = (page:number, index:number) => ({ id:`${String(page * 1000 + index).padStart(8,'0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    number:`OTHER-${page}-${index}`, name:`OTHER-${page}-${index}`, workspaceId, itElementType:'Application' });
  await assert.rejects(resolve({ search:(page)=>page===1
    ? {results:[...Array.from({length:499},(_unused,index)=>filler(page,index)),activeApplication],totalResults:501}
    : {results:[activeApplication],totalResults:501} }), /ambiguous exact identities across completed pages/);
  await assert.rejects(resolve({ search:()=>({results:[activeApplication],totalResults:2}) }), /terminated before its reported total/);
  await assert.rejects(resolve({ search:(page)=>({results:Array.from({length:500},(_unused,index)=>filler(page,index)),totalResults:10_001}) }),
    /exceeded the signed 20-page bound/);
});

function workerGovernance():any {
  const envelope=JSON.parse(fs.readFileSync(path.join(repository,'feature-packages/create-associate/candidates/create-associate-0.2.0.ofp'),'utf8'));
  const governance=JSON.parse(Buffer.from(envelope.files.find((item:any)=>item.path==='backend/governance.json').contentBase64,'base64').toString('utf8'));
  for(const kind of ['APP','DB','OS','TOOL']){const ruleId=kind==='APP'?'v8.app-description-from-element-id.v1':`v4.${kind.toLocaleLowerCase('en-US')}-description-from-element-id.v1`;if(!governance.derivationRules.some((rule:any)=>rule.ruleId===ruleId))governance.derivationRules.push({ruleId,targetFieldId:`P1.${kind}.IT.DESCRIPTION`,dependencyFieldId:`P1.${kind}.IT.ELEMENT_ID`,algorithm:'canonical_element_id',sourceTraceId:kind==='APP'?'SRC.IT元素.010':'v4:template-contract.js:phase1OfficialDerivedValues'});}
  if(!governance.derivationRules.some((rule:any)=>rule.ruleId==='v4.phase1-gra-name-from-element-id.v1')) governance.derivationRules.push({ruleId:'v4.phase1-gra-name-from-element-id.v1',targetFieldId:'P1.RUNTIME.GRA.NAME',dependencyFieldId:'P1.RUNTIME.IT.ELEMENT_ID',algorithm:'prefix_literal',prefix:'GRA-',sourceTraceId:'v4:omnia-phase1.js:716'});
  governance.semanticDigest=crypto.createHash('sha256').update(canonicalJson({fields:governance.fields,relations:governance.relations,scoringItems:governance.scoringItems,derivationRules:governance.derivationRules})).digest('hex');
  return governance;
}
function applicationRow(governance:any) {
  const fields:Record<string,unknown>={};
  const values:Record<string,unknown>={'P1.APP.IT.ELEMENT_ID':'APP-SAP-ECC','P1.APP.GRA.GRA_CONTENT':'Generic','P1.APP.IT.WORKSPACE':'20100 APP','P1.APP.GRA.RAIT_CONCLUSION':'Higher','P1.APP.GRA.FACTORS_CONSIDERED':''};
  for(const [alias,fieldId] of Object.entries(governance.fieldAliases.APP)) if(Object.hasOwn(values,String(fieldId))) fields[alias]=values[String(fieldId)];
  Object.assign(fields,{'Derived GRA Name':'GRA-APP-SAP-ECC','Derived Application Description':'APP-SAP-ECC','Derived Application Is Relevant':false,'Derived Application Is Data Available':false});
  return {rowKey:'APP:2',kind:'APP',elementId:'APP-SAP-ECC',fields,relations:[],sourceSheet:'Input',sourceRow:2};
}
async function prepareApplicationDisposition(disposition:'create'|'resume'|'reuse'|'skip') {
  const governance=workerGovernance(); const row=applicationRow(governance); const calls:string[]=[];
  const identity:any={source:'live-app-identity-execution-contract/v1',found:disposition!=='create'&&disposition!=='skip',item:null,matchState:disposition==='create'?'none':disposition==='skip'?'recycle_bin':'active',graState:disposition==='reuse'?'active':disposition==='skip'?'recycle_bin':'none',disposition,reasonCode:disposition==='create'?'not_found':disposition==='resume'?'exact_element_without_gra':disposition==='reuse'?'exact_existing_pair':'gra_in_recycle_bin',resolved:null,evidence:{applicationPagesRead:1}};
  if(disposition==='resume'||disposition==='reuse') {identity.item={id:applicationId,number:row.elementId,name:row.elementId,itElementType:'Application',workspaceId,description:JSON.stringify({editorData:`<p>${row.elementId}</p>`,suggestionsData:[],trackChangesEnableFlagInEditor:false,plainText:row.elementId})};identity.resolved={objectId:applicationId,riskAssessmentId:disposition==='reuse'?graId:'',workItemId:'',workspaceId,graName:`GRA-${row.elementId}`,rait:'Higher'};}
  const selected=governance.relations.filter((item:any)=>String(item.objectType).toLocaleLowerCase('en-US').includes('application')&&!String(item.objectType).toLocaleLowerCase('en-US').includes('sap ecc')&&String(item.catalogPresentHigher||'').startsWith('Y'));
  const connector={invoke:async(input:any)=>{calls.push(input.operationId);switch(input.operationId){
    case worker.RETURN_OPERATIONS.authority:return{engagementId,workspaces:[{name:'20100 APP',workspaceId}],graContents:[{objectType:'Application',contentName:'Generic',inkContentId:'ink-generic',typeId:'gra-type-generic',itElementTypeId:'app-type-generic'}]};
    case worker.RETURN_OPERATIONS.objectIdentityResolve:return structuredClone(identity);
    case worker.RETURN_OPERATIONS.graRead:return{id:graId};
    case worker.RETURN_OPERATIONS.objectSettingsPreflight:return{typeId:'app-type-generic',isRelevant:false,isDataAvailable:true,number:row.elementId,concurrencyTabs:[{entityTabTypeId:501,updatedOn:'2026-08-04T00:00:00.000Z'}]};
    case worker.RETURN_OPERATIONS.graStatePreflight:return{status:'EvaluationStarted',itElementRaitConclusionLevelId:'Higher'};
    case worker.RETURN_OPERATIONS.riskCatalog:return{risks:[...new Map(selected.map((item:any,index:number)=>[`${item.riskName}|${item.classificationHigher}`,{name:item.riskName,classification:item.classificationHigher,riskRiskScopeId:`scope-${index}`,riskId:`risk-${index}`,assertion:`assertion-${index}`,updatedOn:'2026-08-04T00:00:00.000Z'}])).values()],controls:[...new Map(selected.map((item:any,index:number)=>[item.controlName,{name:item.controlName,controlId:`control-${index}`}])).values()]};
    case worker.RETURN_OPERATIONS.riskRead:return{verified:true};
    case worker.RETURN_OPERATIONS.evaluationPreflight:return{status:'EvaluationComplete'};
    default:throw new Error(`Unexpected Worker prepare Operation ${input.operationId}`);
  }}};
  const run={run_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',state:'ready_for_review',state_revision:7};
  const checkpoint:any={planId:run.run_id,runId:run.run_id,traceId:'trace',descriptor:{artifactId:'artifact'},parsed:{rows:[row],candidates:[],issues:[],excludedRowKeys:[]},liveValidation:{omnia_id_conflicts:{state:'passed',reason:'identity checked'},relationship_targets:{state:'passed',reason:'none'},workspace_live:{state:'passed',reason:'workspace checked'}}};
  let saved:any=null;
  const store={call:async(method:string,input:any)=>{if(method==='loadLatestRun')return{run,returnProgress:[],artifacts:[]};if(method==='loadPlan')return checkpoint;if(method==='prepareReturnIntent'){run.state='waiting_confirmation';run.state_revision+=1;return{messageId:'message',confirmationId:'confirmation',confirmationToken:'token',planDigest:'a'.repeat(64),stateVersion:run.state_revision};}if(method==='getCapabilityEvidenceState')return{verified:false};if(method==='savePlan'){saved=input;return true;}throw new Error(`Unexpected Worker store call ${method}`);}};
  const feature=worker.createFeatureWorker({store,connector,governance});
  const context={connectorBinding:{connectorId:'connector',sessionGeneration:1,engagementId,authorityInstanceId:'authority',tenantOrOrgId:'tenant',packId:'pack'},safetyLock:{workspaceIds:[workspaceId]}};
  const result=await feature.handleAction({actionId:'prepare-return',context,expectedStateVersion:7,payload:{}});
  return{result,plan:saved.returnPlan,calls};
}

test('Worker freezes APP create, resume, and reuse as distinct identity-backed plans and blocks recycle skip',async()=>{
  for(const disposition of ['create','resume','reuse'] as const){
    const prepared=await prepareApplicationDisposition(disposition);const object=prepared.plan.targets.find((item:any)=>item.key==='object|APP:2');const gra=prepared.plan.targets.find((item:any)=>item.key==='gra|APP:2');
    assert.equal(object.disposition,disposition);assert.equal(gra.disposition,disposition==='reuse'?'reuse':'create');
    assert.equal(prepared.plan.rows[0].identityResolution.operationId,'omnia.create-associate.object.identity.resolve.v1');
    assert.equal(prepared.plan.rows[0].identityResolution.disposition,disposition);
    assert.ok(prepared.calls.includes('omnia.create-associate.object.identity.resolve.v1'));
    assert.equal(prepared.calls.includes('omnia.create-associate.object.create-preflight.v2'),false,'permit preflight is execution-only');
  }
  await assert.rejects(prepareApplicationDisposition('skip'),/identity resolution blocked Return preparation: gra_in_recycle_bin/);
});

function route(stepId:string, method:'GET'|'POST', routeTemplate:string, parameters:any[] = [], bodyMode:'none'|'signed_json'='none') {
  return { stepId, method, routeTemplate, parameters, bodyMode, bodyParameter:'' };
}
function identityRoutes() { return [
  route('workitem-directory','POST','/work/v1/WorkQueries/getWorkitemDetails',[],'signed_json'),
  route('gra-directory','POST','/rapr/v0/engagements/{engagementId}/riskassessments/commonAccounts',[],'signed_json'),
  route('application-search','POST','/rapr/v0/engagements/{engagementId}/applications/search',[],'signed_json'),
  route('object-detail','GET','/rapr/v0/engagements/{engagementId}/itelement/{objectId}',[{name:'objectId',type:'guid'}]),
  route('gra-detail','GET','/rapr/v0/engagements/{engagementId}/riskassessments/{riskAssessmentId}',[{name:'riskAssessmentId',type:'guid'}]),
  route('gra-risks','GET','/rapr/v0/engagements/{engagementId}/plannedresponse/byRiskAssessmentId?riskAssessmentId={riskAssessmentId}&reviewMode=false',[{name:'riskAssessmentId',type:'guid'}])
]; }
function signedSourceOperationPackage():any {
  const packagePath=path.join(repository,'feature-packages/create-associate/candidates/create-associate-operation-0.2.0.ofop');
  const envelope=JSON.parse(fs.readFileSync(packagePath,'utf8'));
  const member=(name:string)=>envelope.files.find((item:any)=>item.path===name);
  const update=(name:string,bytes:Buffer)=>{const item=member(name);item.contentBase64=bytes.toString('base64');item.size=bytes.length;item.sha256=crypto.createHash('sha256').update(bytes).digest('hex');};
  const manifest=JSON.parse(Buffer.from(member('manifest.json').contentBase64,'base64').toString('utf8'));
  const old=manifest.operations.find((item:any)=>item.operationId==='omnia.create-associate.object.preflight.v1');
  old.grantsMutationPermit=false; delete old.permitsOperationId;
  const index=manifest.operations.findIndex((item:any)=>item.operationId==='omnia.create-associate.object.create.v1');
  manifest.operations.splice(index,0,
    {operationId:'omnia.create-associate.object.identity.resolve.v1',effect:'read_only',requestSchema:'omnia.create-associate.object-identity-resolve-request/v1',responseSchema:'omnia.create-associate.object-identity-resolve-response/v1',enabledByDefault:true,grantsMutationPermit:false,routes:identityRoutes()},
    {operationId:'omnia.create-associate.object.create-preflight.v2',effect:'read_only',requestSchema:'omnia.create-associate.object-create-preflight-request/v2',responseSchema:'omnia.create-associate.object-create-preflight-response/v2',enabledByDefault:true,grantsMutationPermit:true,permitsOperationId:'omnia.create-associate.object.create.v1',routes:identityRoutes()});
  update('manifest.json',Buffer.from(JSON.stringify(manifest,null,2)));
  update('operation/handler.cjs',fs.readFileSync(handlerSourcePath));
  const unsigned={...envelope};delete unsigned.signature;
  const key=fs.readFileSync(path.join(process.env.USERPROFILE||'','.omnia-agent-v5/signing/operation-ed25519-private.pem'),'utf8');
  envelope.signature=crypto.sign(null,Buffer.from(canonicalJson(unsigned)),key).toString('base64');
  return envelope;
}

test('OperationHost grants object-create permit only after the create-only signed preflight', async () => {
  const host=new OperationHost(); const operationPackage=signedSourceOperationPackage();
  const binding={connectorId:'connector-app-identity',sessionGeneration:1,engagementId,authorityInstanceId:'authority-test',tenantOrOrgId:'tenant-test',packId:'pack-test'};
  const registration=host.register({schemaVersion:'omnia.operation-registration/v1',featureId:'omnia.create-associate',featureVersion:'0.2.0',operationPackage},binding);
  let created=0; let recycled=false;
  const invokeHttp=async(routeDescriptor:any,_routePath:string,_body:any)=>{
    if(routeDescriptor.stepId==='workitem-directory')return recycled?[{externalId:recycledGraId,itElementName:'APP-RECYCLED',name:'GRA-APP-RECYCLED',riskAssessmentType:'Application',isDeleted:true}]:[];
    if(routeDescriptor.stepId==='gra-directory')return recycled?[{id:recycledGraId,name:'GRA-APP-RECYCLED',isDeleted:true}]:[];
    if(routeDescriptor.stepId==='application-search')return{results:[],totalResults:0};
    if(routeDescriptor.stepId==='object-create'){created+=1;return{id:applicationId};}
    throw new Error(`Unexpected route ${routeDescriptor.stepId}`);
  };
  const invoke=(operationId:string,request:any,mutationAuthorized=false)=>host.invoke({schemaVersion:'omnia.operation-invocation/v1',
    featureId:'omnia.create-associate',featureVersion:'0.2.0',operationId,request,operationPackageDigest:registration.packageDigest,
    mutationAuthorized},binding,invokeHttp);
  const planDigest='a'.repeat(64); const createRequest={connectorBinding:binding,target,planDigest,query};
  const mutation={connectorBinding:binding,target,planDigest,command:{commandId:'88888888-8888-4888-8888-888888888888',
    idempotencyKey:'b'.repeat(64),kind:'create_object',payload:{name:'APP-SAP-ECC',workspaceId,engagementId,number:'APP-SAP-ECC',
      itElementType:'Application',description:JSON.stringify({editorData:'<p>APP-SAP-ECC</p>',suggestionsData:[],trackChangesEnableFlagInEditor:false,plainText:'APP-SAP-ECC'})}}};
  assert.equal((await invoke('omnia.create-associate.object.identity.resolve.v1',createRequest) as any).disposition,'create');
  await assert.rejects(invoke('omnia.create-associate.object.create.v1',mutation,true),/permit is missing/);
  await invoke('omnia.create-associate.object.create-preflight.v2',createRequest);
  await invoke('omnia.create-associate.object.create.v1',mutation,true);
  assert.equal(created,1);

  recycled=true;
  const recycledTarget={targetIdentityKey:'Application|APP-RECYCLED',workspaceId}; const recycledPlan='c'.repeat(64);
  const recycledQuery={objectType:'Application',externalId:'APP-RECYCLED',workspaceId,graName:'GRA-APP-RECYCLED',rait:'Higher'};
  await assert.rejects(invoke('omnia.create-associate.object.create-preflight.v2',{
    connectorBinding:binding,target:recycledTarget,planDigest:recycledPlan,query:recycledQuery
  }),/identifier_recycle_bin|gra_in_recycle_bin/);
  await assert.rejects(invoke('omnia.create-associate.object.create.v1',{...mutation,target:recycledTarget,planDigest:recycledPlan,
    command:{...mutation.command,commandId:'99999999-9999-4999-8999-999999999999'}},true),/permit is missing/);
});

test('package source declares the APP identity routes and separates diagnostic and permit Operations', () => {
  const source=fs.readFileSync(path.join(repository,'scripts/package-create-associate-feature.mjs'),'utf8');
  assert.match(source,/operationId: 'omnia\.create-associate\.object\.identity\.resolve\.v1'[\s\S]*?grantsMutationPermit: false/u);
  assert.match(source,/operationId: 'omnia\.create-associate\.object\.create-preflight\.v2'[\s\S]*?grantsMutationPermit: true[\s\S]*?permitsOperationId: 'omnia\.create-associate\.object\.create\.v1'/u);
  for(const stepId of ['workitem-directory','gra-directory','application-search','object-detail','gra-detail','gra-risks']) {
    assert.match(source,new RegExp(`route\\('${stepId}'`,'u'));
  }
  const workerSource=fs.readFileSync(path.join(repository,'feature-packages/create-associate/source/middle/worker.cjs'),'utf8');
  assert.doesNotMatch(workerSource,/UNSUPPORTED\.RECYCLE_BIN_PROOF/u);
  assert.match(workerSource,/objectIdentityResolve:\s*'omnia\.create-associate\.object\.identity\.resolve\.v1'/u);
  assert.match(workerSource,/objectCreatePreflight:\s*'omnia\.create-associate\.object\.create-preflight\.v2'/u);
  assert.match(workerSource,/preflightOperation:\s*RETURN_OPERATIONS\.objectCreatePreflight[\s\S]*?reconcileOperation:RETURN_OPERATIONS\.objectIdentityResolve/u);
  assert.match(workerSource,/reconcileOperation:\s*spec\.reconcileOperation\|\|spec\.preflightOperation/u);
  assert.match(workerSource,/reconcileOperation===RETURN_OPERATIONS\.objectIdentityResolve/u);
  assert.match(workerSource,/manualUnresolved\?'uncertain'/u,'identity resolution that still says create must keep the Run uncertain');
});
