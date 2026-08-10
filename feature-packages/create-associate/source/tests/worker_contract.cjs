'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}
function canonical(value) {
  if (value === null || ['boolean', 'string', 'number'].includes(typeof value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function fixtureReturnIntents(rowKey) {
  const body={schemaVersion:'omnia.create-associate.deterministic-return-intents/v1',blockedPendingRecording:false,blockedUnresolvedRait:false,
    description:rowKey,settings:null,relationTargets:[],riskControlCatalogRelations:[],riskControlRelations:[],riskClassifications:[],scoringItems:[],documentation:''};
  return {...body,semanticDigest:crypto.createHash('sha256').update(canonical(body)).digest('hex')};
}

const workerPath = path.resolve(process.argv[2] || path.join(__dirname, '..', 'middle', 'worker.cjs'));
const fixturePath = path.resolve(process.argv[3] || path.join(__dirname, 'capability-fixtures.json'));
const worker = require(workerPath);
const fixtures = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const stdin = fs.readFileSync(0, 'utf8').trim();
const packagedGovernancePath = path.resolve(path.dirname(fixturePath), '..', 'backend', 'governance.json');
const governance = stdin ? JSON.parse(stdin).governance : fs.existsSync(packagedGovernancePath) ? JSON.parse(fs.readFileSync(packagedGovernancePath, 'utf8')) : null;
const results = [];
const pending = [];

function loadOperationHandler() {
  const sourcePath = path.resolve(path.dirname(workerPath), '..', 'connector-capability', 'operation', 'handler.cjs');
  if (fs.existsSync(sourcePath)) return require(sourcePath).createOperationHandler;
  const operationPath = path.resolve(path.dirname(workerPath), '..', 'connector-capability', 'operation.ofop');
  requireCondition(fs.existsSync(operationPath), 'Signed Operation package is missing from the packaged fixture root.');
  const envelope = JSON.parse(fs.readFileSync(operationPath, 'utf8'));
  const member = envelope.files?.find((item) => item.path === 'operation/handler.cjs');
  requireCondition(member?.contentBase64, 'Signed Operation handler member is missing.');
  const bytes = Buffer.from(member.contentBase64, 'base64');
  requireCondition(bytes.length === member.size, 'Signed Operation handler member size drifted.');
  requireCondition(crypto.createHash('sha256').update(bytes).digest('hex') === member.sha256, 'Signed Operation handler member digest drifted.');
  const compiled = {exports: {}};
  new Function('module', 'exports', bytes.toString('utf8'))(compiled, compiled.exports);
  requireCondition(typeof compiled.exports.createOperationHandler === 'function', 'Signed Operation handler export is invalid.');
  return compiled.exports.createOperationHandler;
}

for (const fixture of fixtures.workerCases) {
  if (fixture.kind === 'return-policy-source') {
    const source=fs.readFileSync(workerPath,'utf8');
    for(const forbidden of ['RETURN.KIND_SUPPORT_UNAVAILABLE','LIVE.KIND_SUPPORT_UNAVAILABLE','RETURN.RISK_CONTROL_GOVERNANCE_MISSING','RETURN.RISK_CONTROL_CATALOG_IDENTITY_EVIDENCE_MISSING','returnIntents.blockedPendingRecording===true']) {
      requireCondition(!source.includes(forbidden),`Recording/support-matrix Return permission gate remains in Worker: ${forbidden}`);
    }
  } else if (fixture.kind === 'fresh-start-navigation') {
    const actionFor=(state,returnProgress=[],eventType='')=>worker.workflowNavigationActions({
      run:{run_id:`fixture-${state}`,state,state_revision:7},
      returnProgress,
      events:eventType?[{event_type:eventType,revision:7}]:[]
    },'return').find((item)=>item.actionId==='restart-run');
    for(const state of fixture.expectedEnabledStates){
      const action=actionFor(state,state==='returning'?[{state:'verified',command_state:'readback_verified'}]:[]);
      requireCondition(action?.enabled===true,`Explicit fresh start was not enabled for ${state}.`);
      requireCondition(action?.label===fixture.expectedLabel,`Explicit fresh-start label drifted for ${state}.`);
    }
    requireCondition(actionFor('uncertain',[{state:'uncertain',command_state:'uncertain'}])?.enabled===false,
      'Uncertain Return incorrectly allowed fresh start before read-only reconcile.');
    requireCondition(actionFor('reconciling',[])?.enabled===false,
      'Reconciling Return incorrectly allowed fresh start before read-only reconcile completed.');
    requireCondition(actionFor('failed',[],'run.restart_requested')?.enabled===false,
      'The same terminal Run revision allowed duplicate restart audit.');
  } else if (fixture.kind === 'fresh-start-cas') {
    pending.push((async()=>{
      const makeStore=(initialState,initialRevision,progress=[])=>{
        let run={run_id:`fixture-${initialState}`,state:initialState,state_revision:initialRevision};
        const calls=[];
        return{calls,current:()=>run,store:{call:async(method,input)=>{
          calls.push({method,input:input===undefined?undefined:JSON.parse(JSON.stringify(input))});
          if(method==='loadReturnProgress')return JSON.parse(JSON.stringify(progress));
          if(method==='transitionRun'){
            requireCondition(input.runId===run.run_id&&input.expectedRevision===run.state_revision,
              'Fresh-start transition did not use the exact current Run/revision CAS.');
            run={...run,state:input.toState,state_revision:run.state_revision+1};
            return run.state_revision;
          }
          if(method==='loadLatestRun')return{run:{...run},returnProgress:JSON.parse(JSON.stringify(progress)),events:[]};
          if(method==='restartRun'){
            requireCondition(input.runId===run.run_id&&input.expectedRevision===run.state_revision,
              'Fresh-start restart did not use the revision returned by old-flow closure.');
            requireCondition(['acquiring','needs_input','ready_for_review','waiting_confirmation','succeeded','failed','cancelled','not_evaluable'].includes(run.state),
              `Fixture attempted Core restart from non-stable state ${run.state}.`);
            const terminal=['succeeded','failed','cancelled','not_evaluable'].includes(run.state);
            if(!terminal)run={...run,state:'cancelled'};
            run={...run,state_revision:run.state_revision+1};
            return{state:run.state,stateRevision:run.state_revision,terminalAuditPreserved:terminal};
          }
          throw new Error(`Unexpected fresh-start fixture Store call: ${method}`);
        }}};
      };

      const converting=makeStore('converting',12,[{state:'verified',command_state:'readback_verified'}]);
      const converted=await worker.closeRunForFreshStart(converting.store,{run:{...converting.current()}},new Set());
      const transition=converting.calls.find((item)=>item.method==='transitionRun')?.input;
      requireCondition(transition?.toState==='failed'&&transition?.eventType==='run.fresh_start_force_closed',
        'Active local processing was not closed with the dedicated audited event.');
      requireCondition(transition.details?.trigger==='explicit_feature_fresh_start'
        &&transition.details?.preserveArtifacts===true&&transition.details?.preserveRevisions===true
        &&transition.details?.preserveCommands===true&&transition.details?.preserveReceipts===true
        &&transition.details?.remoteRollback===false&&transition.details?.mutationReplay===false,
        'Fresh-start closure did not preserve immutable evidence or explicitly forbid rollback/replay.');
      requireCondition(converted.initialState==='converting'&&converted.restarted.terminalAuditPreserved===true,
        'Closed active processing did not restart from its durable terminal revision.');

      const waiting=makeStore('waiting_confirmation',20,[]);
      await worker.closeRunForFreshStart(waiting.store,{run:{...waiting.current()},returnProgress:[]},new Set());
      requireCondition(!waiting.calls.some((item)=>item.method==='transitionRun')
        &&waiting.calls.find((item)=>item.method==='restartRun')?.input.expectedRevision===20,
        'Stable pre-write Run did not use Core restartRun as the sole CAS closure transaction.');

      const uncertain=makeStore('uncertain',30,[{state:'uncertain',command_state:'uncertain'}]);
      let rejected=false;
      try{await worker.closeRunForFreshStart(uncertain.store,{run:{...uncertain.current()},returnProgress:[{state:'uncertain',command_state:'uncertain'}]},new Set());}
      catch(error){rejected=error?.code==='RUN.RESTART_RECONCILE_REQUIRED';}
      requireCondition(rejected,'Uncertain Return did not require read-only reconcile before fresh start.');
      requireCondition(!uncertain.calls.some((item)=>['transitionRun','restartRun'].includes(item.method)),
        'Uncertain Return was mutated or replayed by fresh start.');
      results.push({testId:fixture.testId,status:'passed'});
    })());
    continue;
  } else if (fixture.kind === 'authority-content-name') {
    const registry={
      APP:{aliases:{'APP类型':'P1.APP.GRA.GRA_CONTENT'},pendingRecordingContentValues:[{inputValue:'Oracle EBS',expectedOmniaContentName:'Oracle eBusiness Suite'}]},
      OS:{aliases:{'OS 类型':'P1.OS.GRA.GRA_CONTENT'},pendingRecordingContentValues:[{inputValue:'AD',expectedOmniaContentName:''}]}
    };
    requireCondition(worker.authorityContentNameFor({kind:'APP',fields:{'APP类型':'Oracle EBS'}},{kindRegistry:registry},registry)==='Oracle eBusiness Suite','Oracle EBS did not use its exact declared Omnia authority name.');
    requireCondition(worker.authorityContentNameFor({kind:'OS',fields:{'OS 类型':'AD'}},{kindRegistry:registry},registry)==='AD','AD authority name was guessed without a declaration.');
  } else if (fixture.kind === 'dag') {
    const graph = worker.buildFrozenDependencyGraph(fixture.rows);
    for (const [rowKey, dependencies] of Object.entries(fixture.expectedDependencies)) {
      const node = graph.find((item) => item.id === rowKey);
      requireCondition(node, `DAG fixture row is missing: ${rowKey}`);
      requireCondition(JSON.stringify(node.dependencies) === JSON.stringify(dependencies), `Frozen DAG dependencies drifted: ${rowKey}`);
    }
  } else if (fixture.kind === 'failure-skip') {
    const graph = worker.buildFrozenDependencyGraph(fixture.rows);
    const failed = new Set(fixture.failedRowKeys);
    const blocked = graph.filter((node) => worker.dependencyBlockedByFailure(node, failed)).map((node) => node.id).sort();
    const unaffected = graph.filter((node) => !failed.has(node.id) && !worker.dependencyBlockedByFailure(node, failed)).map((node) => node.id).sort();
    requireCondition(JSON.stringify(blocked) === JSON.stringify([...fixture.expectedBlocked].sort()), `Dependent failure closure drifted: ${blocked}`);
    for (const rowKey of fixture.expectedUnaffected) requireCondition(unaffected.includes(rowKey), `Unrelated row was not preserved by failure isolation: ${rowKey}`);
    requireCondition(worker.returnExecutionPolicy({}).continueOnIsolatedFailure === true, 'Failure isolation must be enabled by default.');
  } else if (fixture.kind === 'ai-selection') {
    const selected = worker.aiReviewEligibleRows({rows: fixture.rows, excludedRowKeys: fixture.excludedRowKeys, kindRegistry: fixture.registry}).map((row) => row.rowKey);
    requireCondition(JSON.stringify(selected) === JSON.stringify(fixture.expectedRowKeys), `AI review capability selection drifted: ${selected}`);
  } else if (fixture.kind === 'ai-language') {
    requireCondition(worker.AI_REVIEW_DISPLAY_LANGUAGE === fixture.expectedLanguage, 'AI review display language drifted.');
    requireCondition(worker.AI_REVIEW_LANGUAGE_VERSION === fixture.expectedLanguageVersion, 'AI review language cache version drifted.');
    requireCondition(worker.aiReviewItemUsesChineseDisplayText(fixture.acceptedItem) === true, 'Simplified-Chinese AI review output was rejected.');
    requireCondition(worker.assertAiReviewOutputUsesChineseDisplayText({items: [fixture.acceptedItem]}) === true, 'Runtime AI output language guard rejected Simplified Chinese.');
    for (const rejectedItem of fixture.rejectedItems) {
      requireCondition(worker.aiReviewItemUsesChineseDisplayText(rejectedItem) === false, 'English-only AI review display output was accepted.');
      let rejected = false;
      try { worker.assertAiReviewOutputUsesChineseDisplayText({items: [rejectedItem]}); }
      catch (error) { rejected = error?.code === 'AI.REVIEW_OUTPUT_LANGUAGE_INVALID'; }
      requireCondition(rejected, 'English-only AI review output did not raise the retryable language error.');
    }
  } else if (fixture.kind === 'execution-policy') {
    requireCondition(worker.returnExecutionPolicy({}).continueOnIsolatedFailure === fixture.expectedDefault, 'Default failure-skip policy drifted.');
    requireCondition(worker.returnExecutionPolicy({continue_on_isolated_failure: false}).continueOnIsolatedFailure === fixture.expectedDisabled, 'Explicit failure-skip policy drifted.');
  } else if (fixture.kind === 'return-plan-capabilities') {
    const frozenRows=fixture.rows.map((planRow)=>({...planRow,returnIntents:fixtureReturnIntents(planRow.rowKey)}));
    const preparedRows = frozenRows.map((planRow) => ({
      rowKey: planRow.rowKey,
      dependencyRowKeys: [...planRow.dependencyRowKeys],
      stageNodes: [...worker.frozenStageNodes(planRow)],
      capabilities: worker.freezePlanCapabilities(planRow),
      returnIntents: JSON.parse(JSON.stringify(planRow.returnIntents))
    }));
    requireCondition(worker.assertReturnPlanCapabilities(frozenRows, preparedRows) === true, 'Prepared rows did not preserve the exact Python capability projection.');
    for (const [index, row] of preparedRows.entries()) {
      requireCondition(row.capabilities !== frozenRows[index].capabilities, `Prepared capabilities were not copied for ${row.rowKey}.`);
      requireCondition(JSON.stringify(row.capabilities) === JSON.stringify(frozenRows[index].capabilities), `Prepared capabilities drifted for ${row.rowKey}.`);
      requireCondition(Object.isFrozen(row.capabilities), `Prepared capabilities were not frozen for ${row.rowKey}.`);
    }
    const returnPlanRows = JSON.parse(JSON.stringify(preparedRows));
    requireCondition(worker.assertReturnPlanCapabilities(frozenRows, returnPlanRows) === true, 'Serialized Return-plan rows did not preserve the exact Python capability projection before confirmation.');
    const missingCapabilities = JSON.parse(JSON.stringify(returnPlanRows));
    delete missingCapabilities[0].capabilities;
    let rejected = false;
    try { worker.assertReturnPlanCapabilities(frozenRows, missingCapabilities); } catch (error) { rejected = error?.code === 'RETURN.CAPABILITY_PROJECTION_DRIFT'; }
    requireCondition(rejected, 'Confirm-return capability guard accepted a Return-plan row with omitted capabilities.');
    const missingIntents=JSON.parse(JSON.stringify(returnPlanRows));delete missingIntents[0].returnIntents;rejected=false;
    try{worker.assertReturnPlanCapabilities(frozenRows,missingIntents);}catch(error){rejected=error?.code==='RETURN.DETERMINISTIC_INTENTS_INVALID';}
    requireCondition(rejected,'Confirm-return guard accepted a Return-plan row with omitted Python intents.');
  } else if (fixture.kind === 'operation-app-relevance') {
    pending.push((async () => {
      const handler = loadOperationHandler()();
      const engagementId = '11111111-1111-4111-8111-111111111111';
      const workspaceId = '22222222-2222-4222-8222-222222222222';
      const objectId = '33333333-3333-4333-8333-333333333333';
      const workItemId = '44444444-4444-4444-8444-444444444444';
      const requestFor = (isRelevant) => ({
        target: {targetIdentityKey: 'fixture-app-settings', workspaceId},
        command: {
          commandId: '55555555-5555-4555-8555-555555555555', idempotencyKey: 'a'.repeat(64), kind: 'patch_object_settings',
          payload: {engagementId, workspaceId, objectId, typeId: 'APP-TYPE-GENERIC', isRelevant, isDataAvailable: false, mode: 'create_bootstrap'}
        }
      });
      const calls = [];
      const sdk = {
        binding: {engagementId},
        invokeStep: async (stepId, params, body) => {
          calls.push({stepId, params, body});
          if (stepId === 'object-settings-mutation-read') return {id: objectId, workItemId, itElementType: 'Application', typeId: null, isRelevant: null, isDataAvailable: null, concurrencyTabs: []};
          if (stepId === 'object-settings-mutation-workspace') return [{facetId: workspaceId}];
          if (stepId === 'object-settings-read') return {id: objectId, workItemId, number: 'APP-SETTINGS-FIXTURE', itElementType: 'Application', typeId: 'APP-TYPE-GENERIC', isRelevant: true, isDataAvailable: false, concurrencyTabs: [{entityTabTypeId: 501, updatedOn: '2026-08-06T12:00:00.000Z'}]};
          if (stepId === 'object-settings-workspace') return [{facetId: workspaceId}];
          if (stepId === 'object-settings-type-patch') {
            requireCondition(body.some((item) => item.path === '/isRelevant' && item.value === true), 'APP relevance PATCH did not write true.');
            return {id: objectId, itElementType: 'Application', typeId: 'APP-TYPE-GENERIC', isRelevant: true, concurrencyTabs: [{entityTabTypeId: 501, updatedOn: '2026-08-06T12:00:00.000Z'}]};
          }
          if (stepId === 'object-settings-data-patch') {
            requireCondition(body.some((item) => item.path === '/isDataAvailable' && item.value === false), 'APP data-availability PATCH drifted.');
            return {ok: true};
          }
          throw new Error(`Unexpected Operation fixture step: ${stepId}`);
        }
      };
      await handler.run('omnia.create-associate.object-settings.patch.v1', requestFor(true), sdk);
      requireCondition(calls.some((item) => item.stepId === 'object-settings-type-patch'), 'APP settings mutation was not invoked.');
      const readback = await handler.run('omnia.create-associate.object-settings.reconcile.v1', {
        target: {targetIdentityKey: 'fixture-app-settings', workspaceId},
        query: {objectId, typeId: 'APP-TYPE-GENERIC', isRelevant: true, isDataAvailable: false, number: 'APP-SETTINGS-FIXTURE', mode: 'create_bootstrap'}
      }, sdk);
      requireCondition(readback.verified === true, 'APP settings authoritative readback did not verify isRelevant=true.');
      let rejected = false;
      try { await handler.run('omnia.create-associate.object-settings.patch.v1', requestFor(false), sdk); } catch { rejected = true; }
      requireCondition(rejected, 'APP settings Operation accepted isRelevant=false after the true-only contract was frozen.');
      results.push({testId: fixture.testId, status: 'passed'});
    })());
    continue;
  } else if (fixture.kind === 'dcno-risk-control-recording') {
    const allDcno = governance.relations.filter((item) => String(item.relationId || '').startsWith('REL.DCNO.NETWORK.'));
    const higher = allDcno.filter((item) => String(item.catalogPresentHigher || '').startsWith('Y'));
    const required = higher.filter((item) => item.linkRequiredHigher === 'Y');
    const lower = allDcno;
    const requiredLower = lower.filter((item) => item.linkRequiredLower === 'Y');
    requireCondition(allDcno.length === 8 && higher.length === 8 && required.length === 3, 'DCNO recorded Higher governance inventory drifted.');
    requireCondition(lower.length === 8 && requiredLower.length === 2, 'DCNO Lower catalog/link governance drifted.');
    requireCondition(worker.catalogIdentityEvidenceGaps([...required,...requiredLower]).length === 0, 'DCNO required relations lack signed exact live catalog identities.');
    requireCondition(worker.unresolvedCatalogRelations(fixture.liveCatalog, required, 'Higher').length === 0, 'DCNO recorded 3-Risk/8-Control catalog does not satisfy the three exact Higher relations.');
    requireCondition(worker.unresolvedCatalogRelations({...fixture.liveCatalog,risks:fixture.liveCatalog.risks.map((risk)=>({...risk,classification:'Lower'}))}, requiredLower, 'Lower').length === 0, 'DCNO shared catalog does not satisfy the two exact Lower relations.');
  } else if (fixture.kind === 'risk-control-catalog-identity') {
    const relation=fixture.relation,catalog=fixture.liveCatalog;
    const governedS4=(Array.isArray(governance?.relations)?governance.relations:[]).filter((item)=>String(item.relationId||'').startsWith('REL.APP.SAP_S4_HANA.')
      &&(item.linkRequiredHigher==='Y'||item.linkRequiredLower==='Y'));
    const governedGaps=worker.catalogIdentityEvidenceGaps(governedS4);
    requireCondition(governedS4.length>0&&governedS4.every((item)=>item.catalogIdentityRequired===true)
      &&(governedGaps.length===0||governedGaps.length===governedS4.length),
      'Managed S/4 catalog identity evidence must be either complete or explicitly fail-closed, never partial.');
    requireCondition(worker.catalogIdentityEvidenceGaps([relation]).length===0,'Signed exact live Control identity evidence was not accepted.');
    requireCondition(worker.catalogControlMatches(catalog,relation).map((item)=>item.controlId).join(',')==='control-1',
      'Explicit catalogControlNumber did not select the one exact live Control identity.');
    requireCondition(worker.unresolvedCatalogRelations(catalog,[relation],'Higher').length===0,
      'Exact signed Risk/Control catalog identity remained unresolved.');
    const missing={...relation,catalogControlNumber:'',catalogIdentityStatus:'blocked_pending_full_live_catalog',catalogIdentityEvidence:null};
    requireCondition(worker.catalogIdentityEvidenceGaps([missing]).map((item)=>item.relationId).join(',')===relation.relationId,
      'Missing historical evidence was not retained as an audit gap.');
    requireCondition(worker.catalogControlMatches(catalog,missing).length===0,
      'A required catalog identity silently fell back to ordinal or description matching.');
    const currentExact={...missing,controlName:'SAPCUA.06｜Access to security administrative functions is authorized and appropriately restricted.'};
    requireCondition(worker.catalogControlMatches(catalog,currentExact).map((item)=>item.controlId).join(',')==='control-1',
      'Current authoritative exact Control number was rejected solely because historical recording evidence was absent.');
    requireCondition(worker.unresolvedCatalogRelations(catalog,[currentExact],'Higher').length===0,
      'Current authoritative exact Risk/Control identity did not close a recording-reference gap.');
    const reordered={risks:[...catalog.risks].reverse(),controls:[...catalog.controls].reverse()};
    requireCondition(worker.riskControlCatalogFingerprint(catalog)===worker.riskControlCatalogFingerprint(reordered),
      'Risk-Control catalog fingerprint depends on response order.');
    requireCondition(worker.riskControlCatalogFingerprint(catalog)!==worker.riskControlCatalogFingerprint({...catalog,controls:[...catalog.controls,{controlId:'control-3',controlNumber:'SAPCHARM.01',name:'new live identity'}]}),
      'Risk-Control catalog fingerprint did not detect a catalog identity change.');
  } else if (fixture.kind === 'operation-oracle-ebs-authority') {
    pending.push((async () => {
      const handler = loadOperationHandler()();
      const engagementId = '11111111-1111-4111-8111-111111111111';
      const workspaceId = '22222222-2222-4222-8222-222222222222';
      const groupId = '33333333-3333-4333-8333-333333333333';
      const request = {
        allowedWorkspaceIds: [workspaceId],
        query: {workspaceNames: ['WS-A'], graContents: [{contentName: 'Oracle eBusiness Suite', elementKind: 'APP', objectSubtype: 'Application', objectType: 'Application'}]}
      };
      const item = (key, name) => ({engagementId, key, legacyId: key, name, description: name,
        parentListName: 'Standardized Accounts List', subItems: [{engagementId, key: '66175343', legacyId: '66175343',
          name: 'Application', parentListName: 'Application type'}]});
      const run = (items) => handler.run('omnia.create-associate.authority.resolve.v1', request, {
        binding: {engagementId},
        invokeStep: async (stepId) => {
          if (stepId === 'authority-hierarchy') return {};
          if (stepId === 'authority-directory') return [{engagementId, facets: [
            {id: groupId, engagementId, facetTypeId: '5420131f-8ea2-4c3f-938f-a25745240cd0', name: 'Workspaces'},
            {id: workspaceId, engagementId, facetTypeId: 'd0c7e20c-1451-48d2-9dd5-8a6f2a51bfc0', parentId: groupId, name: 'WS-A'}
          ]}];
          if (stepId === 'authority-gra-directory') return [{engagementId, typeName: 'Standardized Accounts List', items}];
          throw new Error(`Unexpected Oracle EBS authority fixture step: ${stepId}`);
        }
      });
      const resolved = await run([item('66176468', 'Oracle eBusiness Suite')]);
      const content = resolved.graContents[0];
      requireCondition(content.contentName === 'Oracle eBusiness Suite' && content.inkContentId === '66176468'
        && content.typeId === 3 && content.itElementTypeId === '66175343',
      'Oracle EBS authority did not resolve the one exact current StandardizedAccount candidate.');
      for (const candidates of [
        [item('70000001', 'Unrelated Application')],
        [item('66176468', 'Oracle eBusiness Suite'), item('66176469', 'Oracle eBusiness Suite')]
      ]) {
        let rejected = false;
        try { await run(candidates); } catch (error) { rejected = /absent or ambiguous/u.test(String(error?.message || error)); }
        requireCondition(rejected, 'Oracle EBS authority did not fail closed on zero or multiple exact candidates.');
      }
      results.push({testId: fixture.testId, status: 'passed'});
    })());
    continue;
  } else if (fixture.kind === 'operation-dcno-authority') {
    pending.push((async () => {
      const handler = loadOperationHandler()();
      const engagementId = '11111111-1111-4111-8111-111111111111';
      const workspaceId = '22222222-2222-4222-8222-222222222222';
      const groupId = '33333333-3333-4333-8333-333333333333';
      const result = await handler.run('omnia.create-associate.authority.resolve.v1', {
        allowedWorkspaceIds: [workspaceId],
        query: {workspaceNames: ['WS-A'], graContents: [{contentName: '网络', elementKind: 'DCNO', objectSubtype: 'Network', objectType: 'Infrastructure'}]}
      }, {
        binding: {engagementId},
        invokeStep: async (stepId) => {
          if (stepId === 'authority-hierarchy') return {};
          if (stepId === 'authority-directory') return [{engagementId, facets: [
            {id: groupId, engagementId, facetTypeId: '5420131f-8ea2-4c3f-938f-a25745240cd0', name: 'Workspaces'},
            {id: workspaceId, engagementId, facetTypeId: 'd0c7e20c-1451-48d2-9dd5-8a6f2a51bfc0', parentId: groupId, name: 'WS-A'}
          ]}];
          if (stepId === 'authority-gra-directory') return [{engagementId, typeName: 'Standardized Accounts List', items: [{
            engagementId, key: '60241274', legacyId: '60241274', name: '通用网络设备', description: '通用网络设备', parentListName: 'Standardized Accounts List',
            subItems: [{engagementId, key: '66175349', legacyId: '66175349', name: 'Infrastructure_Network', parentListName: 'Infrastructure type'}]
          }]}];
          throw new Error(`Unexpected DCNO authority fixture step: ${stepId}`);
        }
      });
      const content = result.graContents[0];
      requireCondition(content.elementKind === 'DCNO' && content.objectType === 'Infrastructure' && content.objectSubtype === 'Network', 'DCNO authority object contract drifted.');
      requireCondition(content.inkContentId === '60241274' && content.typeId === 4 && content.itElementTypeId === '66175349', 'DCNO authority did not resolve the recorded Network catalog identity.');
      results.push({testId: fixture.testId, status: 'passed'});
    })());
    continue;
  } else if (fixture.kind === 'operation-control-number') {
    pending.push((async () => {
      const handler = loadOperationHandler()();
      const engagementId = '11111111-1111-4111-8111-111111111111';
      const workspaceId = '22222222-2222-4222-8222-222222222222';
      const riskAssessmentId = '33333333-3333-4333-8333-333333333333';
      const riskId = '44444444-4444-4444-8444-444444444444';
      const riskRiskScopeId = '55555555-5555-4555-8555-555555555555';
      const riskScopeId = '66666666-6666-4666-8666-666666666666';
      const controlId = '77777777-7777-4777-8777-777777777777';
      const readCatalog = async (controlNumber) => handler.run('omnia.create-associate.risk-control.catalog.v1', {
        target: {targetIdentityKey: `fixture-s4-${controlNumber}`, workspaceId}, riskAssessmentId
      }, {
        binding: {engagementId},
        invokeStep: async (stepId) => {
          if (stepId === 'risk-assessment-read') return {id: riskAssessmentId, workspaceId, updatedOn: '2026-08-06T12:00:00.000Z'};
          if (stepId === 'risk-catalog') return {plannedResponses: [{riskId, riskRiskScopeId, riskNumber: 'RAITCOR001', updatedOn: '2026-08-06T12:00:00.000Z'}]};
          if (stepId === 'risk-detail') return {planResponseRisk: [{riskId, riskNumber: 'RAITCOR001', name: 'Governed access risk', classificationType: 'Higher', riskRiskScopes: [{id: riskRiskScopeId, riskScopeId, selectedAssertion: 'DN', assertionType: '10005'}]}]};
          if (stepId === 'control-catalog') return {controls: [{controlId, controlNumber, name: 'Recorded control'}]};
          throw new Error(`Unexpected catalog fixture step: ${stepId}`);
        }
      });
      for (const observed of fixture.observedNumbers) {
        const catalog = await readCatalog(observed.value);
        requireCondition(catalog.controls.length === 1 && catalog.controls[0].controlNumber === observed.expected,
          `Recorded Control number did not structurally normalize to ${observed.expected}: ${observed.value}`);
      }
      const unchanged = await readCatalog(fixture.unchangedControl);
      requireCondition(unchanged.controls.length === 1 && unchanged.controls[0].controlNumber === fixture.unchangedControl,
        'An already canonical Control number was changed by structural normalization.');
      results.push({testId: fixture.testId, status: 'passed'});
    })());
    continue;
  } else if (fixture.kind === 'operation-app-risk-factor-category') {
    pending.push((async () => {
      const handler = loadOperationHandler()();
      const engagementId = '11111111-1111-4111-8111-111111111111';
      const workspaceId = '22222222-2222-4222-8222-222222222222';
      const riskAssessmentId = '66666666-6666-4666-8666-666666666666';
      const categoryId = '77777777-7777-4777-8777-777777777777';
      const request = {
        target: {targetIdentityKey: `fixture-${fixture.testId}`, workspaceId},
        query: {riskAssessmentId, categoryId: '', categoryName: 'IT风险评估（如果测试运行有效性）', objectType: 'Application'}
      };
      const sdk = {
        binding: {engagementId},
        invokeStep: async (stepId) => {
          if (stepId === 'risk-factor-category-assessment-read') {
            return {id: riskAssessmentId, workspaceId, type: 'Application', isDeleted: false};
          }
          if (stepId === 'risk-factor-category-directory') return fixture.directory;
          if (stepId === 'risk-factor-category-read') {
            return {id: categoryId, name: 'IT风险评估（如果测试运行有效性）', riskAssessmentId,
              workspaceId, applicable: true, isDeleted: false, updatedOn: '2026-08-06T12:00:10.000Z'};
          }
          throw new Error(`Unexpected APP category fixture step: ${stepId}`);
        }
      };
      let result;
      let error;
      try {
        result = await handler.run('omnia.create-associate.risk-factor-category.preflight.v1', request, sdk);
      } catch (caught) {
        error = caught;
      }
      if (fixture.expected === 'accepted') {
        requireCondition(!error, `Stable APP category directory was rejected: ${error?.message}`);
        requireCondition(result?.categoryId === categoryId && result?.applicable === true,
          'Stable APP category directory did not resolve the exact authoritative category.');
      } else {
        requireCondition(error, 'Ambiguous or conflicting APP category directory was accepted.');
        requireCondition(String(error.message || error).includes(fixture.errorContains),
          `APP category rejection reason drifted: ${error.message || error}`);
      }
      results.push({testId: fixture.testId, status: 'passed'});
    })());
    continue;
  } else {
    throw new Error(`Unsupported Worker fixture kind: ${fixture.kind}`);
  }
  results.push({testId: fixture.testId, status: 'passed'});
}

Promise.all(pending).then(() => {
  process.stdout.write(`${JSON.stringify({schemaVersion: 'omnia.create-associate.fixture-results/v1', results})}\n`);
}).catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});
