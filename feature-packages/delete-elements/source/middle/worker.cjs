'use strict';

const crypto = require('node:crypto');
const FEATURE_ID = 'omnia.delete-elements';
const FEATURE_VERSION = '__FEATURE_VERSION__';
const OPERATIONS = Object.freeze({
  scopeRead: 'omnia.delete.scope.read.v1', catalogRead: 'omnia.delete.catalog.heavy-read.v1',
  preflight: 'omnia.delete.information.preflight.v1', direct: 'omnia.delete.information.direct.v1',
  reconcile: 'omnia.delete.information.reconcile.v1'
});
const UNSUPPORTED = Object.freeze([
  ['Workpaper','Workpaper'],['GRA','GRA'],['APP','APP'],['DB','DB'],['OS','OS'],['TOOL','TOOL'],
  ['Control','Control'],['Document','文档'],['Deficiency','Deficiency']
]);

function canonical(value){if(value===null||['boolean','string','number'].includes(typeof value))return JSON.stringify(value);if(Array.isArray(value))return`[${value.map(canonical).join(',')}]`;if(!value||typeof value!=='object')throw new Error('Non-JSON value.');return`{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;}
function digest(value){return crypto.createHash('sha256').update(canonical(value)).digest('hex');}
function fail(code,message){const error=new Error(message);error.code=code;throw error;}
function text(value,label){const result=String(value??'').trim();if(!result||result.length>200)fail('DELETE.INVALID_INPUT',`${label} is invalid.`);return result;}
function binding(value){if(!value||typeof value!=='object')fail('DELETE.BINDING_REQUIRED','Connector binding is required.');const result={connectorId:text(value.connectorId,'connectorId'),sessionGeneration:Number(value.sessionGeneration),engagementId:text(value.engagementId,'engagementId'),authorityInstanceId:text(value.authorityInstanceId,'authorityInstanceId'),tenantOrOrgId:text(value.tenantOrOrgId,'tenantOrOrgId'),packId:text(value.packId,'packId')};if(!Number.isSafeInteger(result.sessionGeneration)||result.sessionGeneration<1)fail('DELETE.BINDING_INVALID','Session generation is invalid.');return Object.freeze(result);}
function safety(value,engagementId){if(!value||value.enabled!==true||value.validForCurrentConnection!==true)fail('DELETE.SAFETY_REQUIRED',String(value&&value.invalidReason||'An enabled current safety lock is required.'));if(value.engagementId!==engagementId||!Number.isSafeInteger(value.stateVersion)||value.stateVersion<1)fail('DELETE.SAFETY_DRIFT','Safety lock binding is invalid.');const workspaceIds=[...new Set((value.workspaceIds||[]).map(String))].sort();const globalSectionIds=[...new Set((value.globalSectionIds||[]).map(String))].sort();const globalWorkspaceIds=value.globalEnabled===true?[...new Set((value.globalWorkspaceIds||[]).map(String))].sort():[];if(!workspaceIds.length||value.globalEnabled===true&&(!globalSectionIds.length||!globalWorkspaceIds.length))fail('DELETE.SAFETY_EMPTY','Safety lock has no frozen authoritative scope.');return Object.freeze({enabled:true,globalEnabled:value.globalEnabled===true,globalSectionIds,globalWorkspaceIds,connectorId:text(value.connectorId,'safety.connectorId'),sessionGeneration:Number(value.sessionGeneration),authorityInstanceId:text(value.authorityInstanceId,'safety.authorityInstanceId'),tenantOrOrgId:text(value.tenantOrOrgId,'safety.tenantOrOrgId'),packId:text(value.packId,'safety.packId'),engagementId,stateVersion:value.stateVersion,authorityObservationId:text(value.authorityObservationId,'authorityObservationId'),workspaceIds,allowedWorkspaceIds:[...new Set([...workspaceIds,...globalWorkspaceIds])].sort()});}
function assertSameAuthority(b,s){for(const key of ['connectorId','sessionGeneration','authorityInstanceId','tenantOrOrgId','packId','engagementId'])if(String(b[key])!==String(s[key]))fail('DELETE.SAFETY_BINDING_DRIFT',`Safety lock ${key} differs from the current Connector binding.`);}
function uncertain(error){return ['CONNECTOR.RESPONSE_LOST','REMOTE.MUTATION_UNCERTAIN','REMOTE.CONNECTOR_DISCONNECTED','REMOTE.IN_FLIGHT_DISCONNECTED'].includes(String(error&&error.code||''));}

function createFeatureWorker(ports){
  const connector=ports&&ports.connector;const store=ports&&ports.store;const events=ports&&ports.events;
  if(!connector||typeof connector.invoke!=='function'||!store||typeof store.call!=='function'||!events||typeof events.emit!=='function')fail('DELETE.PORTS_INVALID','Connector, Store and Event ports are required.');
  const invoke=(operationId,request)=>connector.invoke({schemaVersion:'omnia.operation-invocation/v1',featureId:FEATURE_ID,featureVersion:FEATURE_VERSION,operationId,request});
  const save=(plan)=>store.call('savePlan',{...plan,updatedAt:new Date().toISOString()});
  const load=(runId)=>store.call('loadPlan',String(runId||''));
  const credentialDigest=(b,s)=>digest({connectorId:b.connectorId,sessionGeneration:b.sessionGeneration,engagementId:b.engagementId,authorityInstanceId:b.authorityInstanceId,tenantOrOrgId:b.tenantOrOrgId,packId:b.packId,workspaceIds:s.workspaceIds});
  function target(item,s){if(!item||item.objectType!=='Information')fail('DELETE.TYPE_UNSUPPORTED','Only Information has a complete signed delete/readback Operation in 0.2.0.');const workspaceIds=[...new Set((item.workspaceIds||[]).map(String))].sort();const explicitWorkspace=workspaceIds.find(id=>s.workspaceIds.includes(id));if(!explicitWorkspace||workspaceIds.some(id=>!s.allowedWorkspaceIds.includes(id)))fail('DELETE.OUTSIDE_SAFETY','Delete target must belong to an explicitly selected Workspace and all relationship impact must stay inside the explicit/global lock union.');return{objectId:text(item.objectId,'objectId'),informationId:text(item.informationId,'informationId'),workItemId:text(item.workItemId,'workItemId'),objectType:'Information',workspaceIds,workspace:explicitWorkspace,number:String(item.number||''),name:String(item.name||''),updatedAt:text(item.updatedAt,'updatedAt')};}
  function checkedPreflight(value,t,s){if(!value||String(value.informationId)!==t.informationId||String(value.workItemId)!==t.workItemId)fail('DELETE.PREFLIGHT_IDENTITY_DRIFT','Preflight returned another target.');const workspaceIds=[...new Set((value.workspaceIds||[]).map(String))].sort();if(!workspaceIds.length||workspaceIds.some(id=>!s.allowedWorkspaceIds.includes(id)))fail('DELETE.PREFLIGHT_SCOPE_DRIFT','Preflight impact exceeds the safety lock.');if(!Array.isArray(value.blockers))fail('DELETE.PREFLIGHT_INVALID','Preflight blockers are unavailable.');return{informationId:t.informationId,workItemId:t.workItemId,workspaceIds,updatedAt:text(value.updatedAt,'preflight.updatedAt'),blockers:value.blockers,baseline:{objectId:t.objectId,informationId:t.informationId,workItemId:t.workItemId,objectType:t.objectType,workspaceIds,number:t.number,name:t.name,updatedAt:String(value.updatedAt)}};}
  async function authority(context){const b=binding(context.connectorBinding);const s=safety(context.safetyLock,b.engagementId);assertSameAuthority(b,s);const scope=await invoke(OPERATIONS.scopeRead,{connectorBinding:b});if(!scope||scope.connectorId!==b.connectorId||Number(scope.sessionGeneration)!==b.sessionGeneration||scope.engagementId!==b.engagementId||scope.authorityInstanceId!==b.authorityInstanceId||scope.tenantOrOrgId!==b.tenantOrOrgId||scope.packId!==b.packId)fail('DELETE.AUTHORITY_DRIFT','Authoritative directory no longer matches the complete Connector binding.');const ids=new Set((scope.workspaces||[]).map(w=>String(w.id||'')));if(s.allowedWorkspaceIds.some(id=>!ids.has(id)))fail('DELETE.WORKSPACE_DRIFT','A locked Workspace is absent from the current authority directory.');return{b,s,scope};}
  function scopes(scope,s){
    const result=[];const sections=new Map((scope.sections||[]).map(section=>[String(section.id||''),section]));
    const appendWorkspace=(workspace,parentId,parentLabel)=>{const wid=String(workspace.id);result.push({id:`workspace:${wid}`,parentId,kind:'workspace',level:2,label:String(workspace.name||wid),parentLabel,selected:true,initialExpanded:true,disabledReason:''});result.push({id:`type:${wid}:Information`,parentId:`workspace:${wid}`,kind:'element_type',level:3,label:'Information',parentLabel:String(workspace.name||wid),selected:true,initialExpanded:false,disabledReason:''});for(const [kind,label] of UNSUPPORTED)result.push({id:`type:${wid}:${kind}`,parentId:`workspace:${wid}`,kind:'element_type',level:3,label,parentLabel:String(workspace.name||wid),selected:false,initialExpanded:false,disabledReason:'当前版本缺少同时覆盖权威目录、实时预检、删除/解除关联和独立读回的签名 Operation，保持禁用。'});};
    for(const section of sections.values()){if(!section.id)continue;const children=(scope.workspaces||[]).filter(workspace=>String(workspace.parentSectionId||'')===String(section.id)&&s.workspaceIds.includes(String(workspace.id||'')));if(!children.length)continue;result.push({id:`section:${section.id}`,parentId:null,kind:'section',level:1,label:String(section.name||section.id),parentLabel:'所在部分',selected:true,initialExpanded:true,disabledReason:''});for(const workspace of children)appendWorkspace(workspace,`section:${section.id}`,String(section.name||section.id));}
    const unassigned=(scope.workspaces||[]).filter(workspace=>s.workspaceIds.includes(String(workspace.id||''))&&!sections.has(String(workspace.parentSectionId||'')));
    if(unassigned.length){const parentId='section:unassigned';result.push({id:parentId,parentId:null,kind:'section',level:1,label:'未归属所在部分',parentLabel:'所在部分',selected:false,initialExpanded:true,disabledReason:'Omnia 未返回这些 Workspace 的真实所在部分；仅保留准确的未归属状态，不推断规划分组。'});for(const workspace of unassigned)appendWorkspace(workspace,parentId,'未归属所在部分');}
    return result;
  }
  async function refresh(context){const {b,s,scope}=await authority(context);const catalog=await invoke(OPERATIONS.catalogRead,{connectorBinding:b,engagementId:b.engagementId,workspaceIds:s.workspaceIds});if(!catalog||!Array.isArray(catalog.items))fail('DELETE.CATALOG_INVALID','Authoritative catalog is unavailable.');const tree=scopes(scope,s);const enabledScopes=new Set(tree.filter(node=>node.kind==='element_type'&&!node.disabledReason).map(node=>node.id));const items=catalog.items.map(item=>target(item,s)).map(item=>({id:item.objectId,scopeId:`type:${item.workspace}:Information`,type:'Information',title:item.number||item.name||item.objectId,subtitle:item.name||item.number||'',selectable:enabledScopes.has(`type:${item.workspace}:Information`)&&Array.isArray(catalog.items.find(raw=>raw.objectId===item.objectId)?.blockers)&&catalog.items.find(raw=>raw.objectId===item.objectId).blockers.length===0,disabledReason:(catalog.items.find(raw=>raw.objectId===item.objectId)?.blockers||[]).length?`存在 ${(catalog.items.find(raw=>raw.objectId===item.objectId).blockers||[]).length} 个权威阻塞关系`:'',concurrencyToken:item.updatedAt})).filter(item=>enabledScopes.has(item.scopeId));await store.call('savePlan',{schemaVersion:'omnia.delete-catalog-snapshot/v1',planId:`catalog:${credentialDigest(b,s)}`,capturedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+2*60_000).toISOString(),binding:b,safetyRevision:s.stateVersion,items:catalog.items});return{schemaVersion:'omnia.declarative-feature-surface-patch/v1',status:items.length?'ready':'empty',statusMessage:items.length?`已从当前 Pack 权威读取 ${items.length} 个可审查 Information；其他类型按签名 Operation 能力明确禁用。`:'当前安全范围没有可审查的 Information；未支持类型保持禁用。',scopes:tree,items,selectedItemIds:[]};}
  async function createPlan(context,targetIds){const {b,s}=await authority(context);if(!Array.isArray(targetIds)||targetIds.length<1||targetIds.length>200||new Set(targetIds).size!==targetIds.length)fail('DELETE.TARGETS_INVALID','Select 1-200 unique targets.');const catalog=await invoke(OPERATIONS.catalogRead,{connectorBinding:b,engagementId:b.engagementId,workspaceIds:s.workspaceIds});const byId=new Map((catalog.items||[]).map(item=>[String(item.objectId),item]));const targets=targetIds.map(id=>target(byId.get(String(id)),s));const preflights=[];for(const t of targets)preflights.push(checkedPreflight(await invoke(OPERATIONS.preflight,{connectorBinding:b,target:t}),t,s));if(preflights.some(p=>p.blockers.length))fail('DELETE.BLOCKED','At least one selected target has authoritative blocking relations.');const coreRun=await store.call('createMutationRun',{engagementId:b.engagementId});const intents=targets.map((t,index)=>({kind:'object',key:`Information|${t.workspace}|${t.objectId}`,workspace:t.workspace,objectType:'Information',objectId:t.objectId,baseline:preflights[index].baseline,preflightDigest:digest(preflights[index]),mutationOperationId:OPERATIONS.direct,mutationPayload:{informationId:t.informationId},evidenceOperationIds:[OPERATIONS.reconcile],operationTargetIdentityKey:`Information|${t.workspace}|${t.objectId}`}));const corePlan={schemaVersion:'omnia.delete-intent/v1',authority:{authorityInstanceId:b.authorityInstanceId,tenantOrOrgId:b.tenantOrOrgId,packId:b.packId,engagementId:b.engagementId},targets:intents};const frozen=await store.call('prepareReturnIntent',{runId:coreRun.runId,plan:corePlan,connectorBinding:b,safetyLock:s,credentialDigest:credentialDigest(b,s),preflightDigest:digest(preflights)});const plan={schemaVersion:'omnia.delete-plan/v2',planId:coreRun.runId,runId:coreRun.runId,featureId:FEATURE_ID,featureVersion:FEATURE_VERSION,state:'pending_confirmation',stateVersion:frozen.stateVersion,confirmationId:frozen.confirmationId,confirmationToken:frozen.confirmationToken,planDigest:frozen.planDigest,binding:b,safety:s,targets,preflights,intents,results:[],nextIndex:0,createdAt:new Date().toISOString()};await save(plan);return plan;}
  function card(plan){const labels={pending_confirmation:['等待确认','多目标删除计划已持久冻结；确认时会再次校验完整 Connector binding、安全锁和每个目标。'],executing:['正在执行','逐目标提交并等待签名 Operation 的权威读回收据。'],completed:['删除完成','全部目标均有权威删除读回收据，Core 已写入 tombstone。'],failed:['删除失败','计划已失败关闭；不会自动重放外部删除。'],cancelled:['已取消','确认前计划已取消，没有提交删除。'],uncertain:['结果待核验','远端响应丢失；原命令冻结，只能执行只读 reconcile。']};const [title,summary]=labels[plan.state]||['未知状态','无法识别计划状态。'];const actions=plan.state==='pending_confirmation'?[{actionId:'cancel-delete-plan',label:'取消',effect:'local_state_write',enabled:true,reason:'',selectionMode:'none',dependencies:[]},{actionId:'confirm-delete-plan',label:'确认删除',effect:'omnia_mutation',enabled:true,reason:'',selectionMode:'none',dependencies:['remote_connector','safety_lock']}]:plan.state==='uncertain'?[{actionId:'reconcile-delete-plan',label:'只读核验',effect:'read_only',enabled:true,reason:'',selectionMode:'none',dependencies:['remote_connector','safety_lock']}]:[];return{messageId:`delete-plan:${plan.runId}`,featureId:FEATURE_ID,featureVersion:FEATURE_VERSION,surfaceId:'delete-elements.workbench',runId:plan.runId,confirmationId:plan.confirmationId,stateVersion:plan.stateVersion,state:plan.state,title,summary,details:[{label:'目标',value:`${plan.results.length}/${plan.targets.length}`},{label:'计划摘要',value:plan.planDigest}],actions};}
  async function failPlan(plan,error){
    try{await store.call('finishReturn',{runId:plan.runId,outcome:'failed',error:String(error&&error.message||error)});}catch{/* retain the first deterministic failure */}
    plan.state='failed';plan.stateVersion+=1;await save(plan);
  }
  function requireOwnedRun(run,plan){if(!run||String(run.run_id||'')!==String(plan.runId||''))fail('DELETE.RUN_IDENTITY_DRIFT','The current Core Run does not match this deletion plan.');return run;}
  async function markUncertain(plan,index,commandId,intent,error){
    try{await store.call('recordReturnEvidence',{runId:plan.runId,commandId,evidenceType:'commit',commandState:'uncertain',payload:{code:String(error&&error.code||'DELETE.RESULT_UNCERTAIN')}});}catch{/* Preserve the original post-commit uncertainty even if evidence recording is unavailable. */}
    try{await store.call('finishReturn',{runId:plan.runId,outcome:'uncertain',error:String(error&&error.message||error)});}catch{/* The saved plan remains the no-replay authority for the UI. */}
    plan.state='uncertain';plan.stateVersion+=1;plan.uncertain={index,commandId,intent};await save(plan);return plan;
  }
  async function execute(plan,context,startIndex){
    const b=binding(context.connectorBinding);const s=safety(context.safetyLock,b.engagementId);assertSameAuthority(b,s);
    await store.call('validateReturnAuthority',{runId:plan.runId,connectorBinding:b,safetyLock:s});
    plan.state='executing';plan.stateVersion+=1;await save(plan);
    for(let index=startIndex;index<plan.targets.length;index+=1){
      const t=plan.targets[index];const intent=plan.intents[index];
      const operationTarget={targetIdentityKey:intent.operationTargetIdentityKey,workspaceId:t.workspace,informationId:t.informationId,workItemId:t.workItemId};
      let before;
      try{
        before=checkedPreflight(await invoke(OPERATIONS.preflight,{connectorBinding:b,planDigest:plan.planDigest,target:operationTarget}),t,s);
        if(digest(before)!==digest(plan.preflights[index]))fail('DELETE.PREFLIGHT_DRIFT','Target changed after confirmation.');
      }catch(error){await failPlan(plan,error);throw error;}
      let command;
      try{
        command=await store.call('prepareDeletionCommand',{runId:plan.runId,planDigest:plan.planDigest,targetKind:'object',targetKey:intent.key,workspaceId:intent.workspace,binding:b,workspaceIds:s.workspaceIds,operationId:OPERATIONS.direct,request:intent.mutationPayload,evidenceOperationIds:intent.evidenceOperationIds,evidenceTargetIdentityKey:intent.operationTargetIdentityKey});
        await store.call('recordReturnEvidence',{runId:plan.runId,commandId:command.commandId,evidenceType:'request',commandState:'submitted',payload:{operationId:OPERATIONS.direct}});
      }catch(error){await failPlan(plan,error);throw error;}
      let response;
      try{
        response=await invoke(OPERATIONS.direct,{connectorBinding:b,planDigest:plan.planDigest,target:operationTarget,command:{commandId:command.commandId,idempotencyKey:command.idempotencyKey,payload:intent.mutationPayload},informationId:t.informationId});
      }catch(error){
        if(!uncertain(error)){
          await store.call('recordReturnEvidence',{runId:plan.runId,commandId:command.commandId,evidenceType:'request',commandState:'failed',payload:{code:String(error&&error.code||'DELETE.FAILED')},error:String(error&&error.message||error)});
          await failPlan(plan,error);throw error;
        }
        return markUncertain(plan,index,command.commandId,intent,error);
      }
      try{await store.call('recordReturnEvidence',{runId:plan.runId,commandId:command.commandId,evidenceType:'commit',commandState:'committed',payload:response});}
      catch(error){return markUncertain(plan,index,command.commandId,intent,error);}
      const readRequest={connectorBinding:b,target:operationTarget,informationId:t.informationId};
      let observed;
      try{
        await store.call('freezeReturnEvidenceSpec',{runId:plan.runId,commandId:command.commandId,operationId:OPERATIONS.reconcile,request:readRequest});
        observed=await invoke(OPERATIONS.reconcile,{...readRequest,receiptContext:{runId:plan.runId,commandId:command.commandId}});
        if(!observed||String(observed.informationId)!==t.informationId)fail('DELETE.READBACK_IDENTITY_DRIFT','Authoritative readback returned another target.');
        if(observed.deleted!==true)fail('DELETE.READBACK_PENDING','Authoritative readback does not yet prove deletion; the committed command will not be replayed.');
        await store.call('recordReturnEvidence',{runId:plan.runId,commandId:command.commandId,evidenceType:'readback',commandState:'readback_verified',payload:observed,receiptId:observed.__operationReceiptId});
      }catch(error){return markUncertain(plan,index,command.commandId,intent,error);}
      try{await store.call('projectVerifiedDeletion',{runId:plan.runId,commandId:command.commandId,binding:b,workspaceId:t.workspace,objectType:'Information',objectId:t.objectId});}
      catch(error){plan.results.push({objectId:t.objectId,state:'deleted_projection_failed',commandId:command.commandId});await failPlan(plan,error);return plan;}
      plan.results.push({objectId:t.objectId,state:'deleted',commandId:command.commandId});plan.nextIndex=index+1;await save(plan);
    }
    await store.call('finishReturn',{runId:plan.runId,outcome:'succeeded'});plan.state='completed';plan.stateVersion+=1;await save(plan);
    await events.emit({type:'workspace.authoritative_refresh_requested',featureId:FEATURE_ID,featureVersion:FEATURE_VERSION,engagementId:b.engagementId,workspaceIds:s.allowedWorkspaceIds,runId:plan.runId});return plan;
  }
  async function confirm(plan,context,expected){if(!plan||plan.state!=='pending_confirmation'||Number(expected)!==Number(plan.stateVersion))fail('DELETE.CONFIRMATION_STALE','Delete confirmation is stale.');const b=binding(context.connectorBinding),s=safety(context.safetyLock,b.engagementId);assertSameAuthority(b,s);await store.call('approveReturnIntent',{confirmationId:plan.confirmationId,confirmationToken:plan.confirmationToken,expectedStateVersion:1,connectorBinding:b,safetyLock:s});return execute(plan,context,0);}
  async function reconcile(plan,context){
    if(!plan||plan.state!=='uncertain'||!plan.uncertain)fail('DELETE.RECONCILE_INVALID','No uncertain command is available.');
    const b=binding(context.connectorBinding),s=safety(context.safetyLock,b.engagementId);assertSameAuthority(b,s);
    const run=requireOwnedRun(await store.call('loadLatestRun',{}),plan);
    await store.call('transitionRun',{runId:plan.runId,expectedRevision:Number(run.state_revision),toState:'reconciling',eventType:'delete.reconcile_started'});
    const index=plan.uncertain.index,t=plan.targets[index],intent=plan.uncertain.intent,commandId=plan.uncertain.commandId;
    const operationTarget={targetIdentityKey:intent.operationTargetIdentityKey,workspaceId:t.workspace,informationId:t.informationId,workItemId:t.workItemId};
    const readRequest={connectorBinding:b,target:operationTarget,informationId:t.informationId};
    try{
      await store.call('freezeReturnEvidenceSpec',{runId:plan.runId,commandId,operationId:OPERATIONS.reconcile,request:readRequest});
      const observed=await invoke(OPERATIONS.reconcile,{...readRequest,receiptContext:{runId:plan.runId,commandId}});
      if(!observed||String(observed.informationId)!==t.informationId)fail('DELETE.READBACK_IDENTITY_DRIFT','Authoritative reconcile returned another target.');
      if(observed.deleted!==true)fail('DELETE.READBACK_PENDING','Authoritative reconcile does not yet prove deletion; the committed command will not be replayed.');
      await store.call('recordReturnEvidence',{runId:plan.runId,commandId,evidenceType:'reconcile',commandState:'readback_verified',payload:observed,receiptId:observed.__operationReceiptId});
      try{await store.call('projectVerifiedDeletion',{runId:plan.runId,commandId,binding:b,workspaceId:t.workspace,objectType:'Information',objectId:t.objectId});}
      catch(error){plan.results.push({objectId:t.objectId,state:'deleted_projection_failed',commandId});await failPlan(plan,error);return plan;}
      plan.results.push({objectId:t.objectId,state:'deleted',commandId});const next=index+1;delete plan.uncertain;
      await store.call('transitionRun',{runId:plan.runId,expectedRevision:Number(run.state_revision)+1,toState:'returning',eventType:'delete.reconcile_applied'});
      return execute(plan,context,next);
    }catch(error){return markUncertain(plan,index,commandId,intent,error);}
  }
  async function handleAction(input){const context=input.context||{};if(input.actionId==='refresh-authoritative-catalog')return{surfacePatch:await refresh(context)};if(input.actionId==='create-delete-plan'){const plan=await createPlan(context,input.payload&&input.payload.targetIds);return{messageCard:card(plan)}}const plan=await load(input.payload&&input.payload.runId);if(!plan)fail('DELETE.PLAN_NOT_FOUND','Delete plan was not found.');if(input.actionId==='cancel-delete-plan'){if(plan.state!=='pending_confirmation')fail('DELETE.CANCEL_INVALID','Only an unconfirmed plan can be cancelled.');const run=requireOwnedRun(await store.call('loadLatestRun',{}),plan);await store.call('transitionRun',{runId:plan.runId,expectedRevision:Number(run.state_revision),toState:'cancelled',eventType:'delete.cancelled_in_comments'});plan.state='cancelled';plan.stateVersion+=1;await save(plan);return{messageCard:card(plan)}}if(input.actionId==='confirm-delete-plan'){const result=await confirm(plan,context,input.expectedStateVersion);return{messageCard:card(result),...(result.state==='completed'?{surfacePatch:await refresh(context)}:{})}}if(input.actionId==='reconcile-delete-plan'){const result=await reconcile(plan,context);return{messageCard:card(result),...(result.state==='completed'?{surfacePatch:await refresh(context)}:{})}}fail('DELETE.ACTION_UNKNOWN','Action is not implemented.');}
  return Object.freeze({health:()=>({schemaVersion:'omnia.feature-worker-health/v1',featureId:FEATURE_ID,featureVersion:FEATURE_VERSION,ready:true,mutationEnabled:true,requiresConnector:true,requiresSafetyLock:true,supportedTransports:['remote']}),refreshCatalog:refresh,handleAction});
}

module.exports=Object.freeze({createFeatureWorker,createDeleteElementsWorker:createFeatureWorker,FEATURE_ID,FEATURE_VERSION,OPERATIONS});
