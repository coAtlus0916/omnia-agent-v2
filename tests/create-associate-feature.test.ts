import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { build } from 'esbuild';
import { CoreDatabase } from '../src/main/database.js';
import { OperationHost } from '../src/connector/operation-host.js';
import { FeaturePackageManager } from '../src/main/features/package-manager.js';
import { FeatureRuntimeStore } from '../src/main/features/feature-runtime-store.js';
import { FeatureWorkerSupervisor } from '../src/main/features/worker-supervisor.js';
import { canonicalJson, packageDigest, packageFile, verifyOfficialPackage } from '../src/main/features/official-package.js';
import { resolveProductPaths } from '../src/main/paths.js';

const repository = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const worker = require(path.join(repository, 'feature-packages/create-associate/source/middle/worker.cjs')) as any;
const featurePackagePath = path.join(repository, 'feature-packages/create-associate/candidates/create-associate-0.1.0.ofp');
const managedV8 = path.join(repository, 'feature-packages/create-associate/source/managed/phase1-system-information-v8.xlsx');
const operationPackagePath = path.join(repository, 'feature-packages/create-associate/candidates/create-associate-operation-0.1.0.ofop');
const managedPython = path.join(repository, 'releases/runtime/python/cpython-3.13.14-embed-amd64/python.exe');
const pythonSource = path.join(repository, 'feature-packages/create-associate/source/python');
const cipher = { encrypt: (value: string) => value, decrypt: (value: string) => value };

function sha256(bytes: Buffer): string { return crypto.createHash('sha256').update(bytes).digest('hex'); }
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => { let crc = value; for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1); return crc >>> 0; });
function zip(files:Record<string,Buffer|string>):Buffer {
  const local:Buffer[]=[];const central:Buffer[]=[];let offset=0;
  for(const [pathname,content] of Object.entries(files)){
    const name=Buffer.from(pathname,'utf8');const bytes=Buffer.from(content);let crc=0xffffffff;for(const byte of bytes)crc=CRC_TABLE[(crc^byte)&0xff]!^(crc>>>8);crc=(crc^0xffffffff)>>>0;
    const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50,0);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt32LE(crc,14);header.writeUInt32LE(bytes.length,18);header.writeUInt32LE(bytes.length,22);header.writeUInt16LE(name.length,26);local.push(header,name,bytes);
    const directory=Buffer.alloc(46);directory.writeUInt32LE(0x02014b50,0);directory.writeUInt16LE(20,4);directory.writeUInt16LE(20,6);directory.writeUInt16LE(0x800,8);directory.writeUInt32LE(crc,16);directory.writeUInt32LE(bytes.length,20);directory.writeUInt32LE(bytes.length,24);directory.writeUInt16LE(name.length,28);directory.writeUInt32LE(offset,42);central.push(directory,name);offset+=header.length+name.length+bytes.length;
  }
  const directoryBytes=Buffer.concat(central);const end=Buffer.alloc(22);const count=Object.keys(files).length;end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(count,8);end.writeUInt16LE(count,10);end.writeUInt32LE(directoryBytes.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,directoryBytes,end]);
}
function invokeManagedPython(code:string,payload:any):any{
  const result=spawnSync(managedPython,['-I','-S','-c',code,pythonSource],{cwd:repository,input:JSON.stringify(payload),encoding:'utf8',env:{...process.env,PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1'}});
  if(result.status!==0)throw new Error(result.stderr||result.stdout||'Managed CPython invocation failed.');
  return JSON.parse(result.stdout);
}
function parseUserWorkbook(bytes:Buffer,sourceArtifactId:string,governance:any):any{
  const code="import base64,json,sys\nassert sys.version_info[:3]==(3,13,14),sys.version\nsys.path.insert(0,sys.argv[1])\nfrom engine import parse_workbook\np=json.load(sys.stdin)\nr=parse_workbook(base64.b64decode(p['workbookBase64']),source_artifact_id=p['sourceArtifactId'],governance=p['governance'])\njson.dump(r,sys.stdout,separators=(',',':'),ensure_ascii=False)";
  return invokeManagedPython(code,{workbookBase64:bytes.toString('base64'),sourceArtifactId,governance});
}
function compileRuntimeWorkbook(base:Buffer,parsed:any,metadata:any):{bytes:Buffer,descriptor:any}{
  const code="import base64,json,sys\nassert sys.version_info[:3]==(3,13,14),sys.version\nsys.path.insert(0,sys.argv[1])\nfrom workbook_compile import compile_runtime_workbook\np=json.load(sys.stdin)\nb,d=compile_runtime_workbook(base64.b64decode(p['baseBase64']),parsed=p['parsed'],metadata=p['metadata'])\njson.dump({'workbookBase64':base64.b64encode(b).decode('ascii'),'descriptor':d},sys.stdout,separators=(',',':'))";
  const value=invokeManagedPython(code,{baseBase64:base.toString('base64'),parsed,metadata});return{bytes:Buffer.from(value.workbookBase64,'base64'),descriptor:value.descriptor};
}
function resign(envelope:any,privateKey:string):any{const unsigned={...envelope};delete unsigned.signature;return{...unsigned,signature:crypto.sign(null,Buffer.from(canonicalJson(unsigned)),privateKey).toString('base64')}}
function updatePackageMember(envelope:any,memberPath:string,bytes:Buffer):void{const member=envelope.files.find((item:any)=>item.path===memberPath);if(!member)throw new Error(`missing member ${memberPath}`);member.contentBase64=bytes.toString('base64');member.size=bytes.length;member.sha256=sha256(bytes);}
function createUpgradePackage(output:string):void{
  const signingRoot=path.join(process.env.USERPROFILE||'','.omnia-agent-v5','signing'); const featureKey=fs.readFileSync(path.join(signingRoot,'feature-ed25519-private.pem'),'utf8'); const operationKey=fs.readFileSync(path.join(signingRoot,'operation-ed25519-private.pem'),'utf8');
  const outer=JSON.parse(fs.readFileSync(featurePackagePath,'utf8')); const nested=JSON.parse(Buffer.from(outer.files.find((item:any)=>item.path==='connector-capability/operation.ofop').contentBase64,'base64').toString('utf8'));
  nested.version='0.1.1';nested.sequence=2;const operationManifest=JSON.parse(Buffer.from(nested.files.find((item:any)=>item.path==='manifest.json').contentBase64,'base64').toString('utf8'));operationManifest.version='0.1.1';operationManifest.sequence=2;updatePackageMember(nested,'manifest.json',Buffer.from(JSON.stringify(operationManifest,null,2)));const signedNested=resign(nested,operationKey);
  outer.version='0.1.1';outer.sequence=2;updatePackageMember(outer,'connector-capability/operation.ofop',Buffer.from(JSON.stringify(signedNested)));
  const jsonMembers=['manifest.json','frontend/surface.json','docs/manifest.json','contracts/feature-runtime.json','contracts/implementation-map.json','tests/manifest.json'];
  for(const memberPath of jsonMembers){const value=JSON.parse(Buffer.from(outer.files.find((item:any)=>item.path===memberPath).contentBase64,'base64').toString('utf8'));if(memberPath==='manifest.json'){value.version='0.1.1';value.sequence=2;for(const leaf of value.navigation.leaves)leaf.featureVersion='0.1.1';}else if(memberPath==='frontend/surface.json')value.featureVersion='0.1.1';else value.featureVersion='0.1.1';updatePackageMember(outer,memberPath,Buffer.from(JSON.stringify(value,null,2)));}
  const workerMember=outer.files.find((item:any)=>item.path==='middle/worker.cjs');updatePackageMember(outer,'middle/worker.cjs',Buffer.from(Buffer.from(workerMember.contentBase64,'base64').toString('utf8').replace("const FEATURE_VERSION = '0.1.0';","const FEATURE_VERSION = '0.1.1';")));
  fs.writeFileSync(output,JSON.stringify(resign(outer,featureKey)));
}
function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
function populatedInput(elementId:string,factors=`Risk basis for ${elementId}`,workspace='20100 APP',mode='Higher',isDataAvailable='false'):Buffer {
  const headers = ['系统ID', 'APP类型', 'System Risk Classification', 'Factors Considered', 'Omnia工作区', 'isDataAvailable'];
  const values = [elementId, 'SAP ECC', mode, factors, workspace, isDataAvailable];
  const row = (rowNumber: number, cells: string[]) => `<row r="${rowNumber}">${cells.map((value, index) => {
    const column = String.fromCharCode('A'.charCodeAt(0) + index);
    return `<c r="${column}${rowNumber}" t="inlineStr"><is><t>${xml(value)}</t></is></c>`;
  }).join('')}</row>`;
  return zip({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="IT Risk Assessment" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${row(1, headers)}${row(2, values)}</sheetData></worksheet>`
  });
}
function correctiveV3Input(elementId:string,factors=`Risk basis for ${elementId}`,workspace='20100 APP',mode='Higher'):Buffer {
  const entries=worker.zipEntries(populatedInput(elementId,factors,workspace,mode));const files:any={};for(const [name,value] of entries)files[name]=value;
  files['xl/worksheets/sheet1.xml']=Buffer.from(files['xl/worksheets/sheet1.xml'].toString('utf8').replace(/<c r="F1"[\s\S]*?<\/c>/u,'').replace(/<c r="F2"[\s\S]*?<\/c>/u,''));
  return zip(files);
}
function correctiveGovernance(legacy:any):any {
  const governance=structuredClone(legacy);const declaration=governance.fields.find((field:any)=>field.fieldId==='P1.APP.IT.IS_DATA_AVAILABLE');Object.assign(declaration,{defaultRuleId:'v4.app-is-data-available-false.v1',defaultValue:false});
  for(const kind of ['APP','DB','OS','TOOL']){const ruleId=kind==='APP'?'v8.app-description-from-element-id.v1':`v4.${kind.toLocaleLowerCase('en-US')}-description-from-element-id.v1`;if(!governance.derivationRules.some((rule:any)=>rule.ruleId===ruleId))governance.derivationRules.push({ruleId,targetFieldId:`P1.${kind}.IT.DESCRIPTION`,dependencyFieldId:`P1.${kind}.IT.ELEMENT_ID`,algorithm:'canonical_element_id',sourceTraceId:kind==='APP'?'SRC.IT元素.010':'v4:template-contract.js:phase1OfficialDerivedValues'});}
  governance.derivationRules.push({ruleId:'v4.app-is-data-available-false.v1',targetFieldId:declaration.fieldId,algorithm:'constant_boolean_false',constantValue:false,sourceTraceId:'v4:phase1:application:isDataAvailable=false'});
  governance.derivationRules.push({ruleId:'v4.phase1-gra-name-from-element-id.v1',targetFieldId:'P1.RUNTIME.GRA.NAME',dependencyFieldId:'P1.RUNTIME.IT.ELEMENT_ID',algorithm:'prefix_literal',prefix:'GRA-',sourceTraceId:'v4:omnia-phase1.js:716'});
  return governance;
}

function activateCreateFixture(database:CoreDatabase,version='0.1.0'):void{
  database.db.prepare(`INSERT INTO feature_registry(feature_id,feature_version,lifecycle,package_digest,publisher_key_id,health,activated_at) VALUES('omnia.create-associate',?,'active',?,'test-key','healthy',?)`)
    .run(version,`sha256:${'9'.repeat(64)}`,new Date().toISOString());
  database.db.prepare(`INSERT INTO feature_activation_heads(feature_id,feature_version,activation_generation,runtime_enabled,runtime_reason,package_path,package_digest,updated_at) VALUES('omnia.create-associate',?,1,1,'','test-package',?,?)`)
    .run(version,`sha256:${'9'.repeat(64)}`,new Date().toISOString());
}

test('returning Run exposes real force-cancel and restart controls, then closes by CAS without rolling back verified effects',async()=>{
  const runId='af8a6e87-4968-4a48-a183-ffa2190e92f3';
  const returnProgress=Array.from({length:88},(_item,index)=>({target_key:`target-${index}`,state:index<53?'verified':'frozen',command_state:index<53?'readback_verified':'pending'}));
  const latest:any={run:{run_id:runId,state:'returning',state_revision:7},events:[],returnProgress};
  const actions=worker.workflowNavigationActions(latest,'return');
  const restart=actions.find((item:any)=>item.actionId==='restart-run');
  const forceCancel=actions.find((item:any)=>item.actionId==='back-to-upload');
  assert.equal(restart.enabled,true);assert.match(restart.reason,/先强制取消/u);
  assert.equal(forceCancel.label,'强制取消回传');assert.equal(forceCancel.enabled,true);assert.match(forceCancel.reason,/53 项不会回滚或重放/u);

  const calls:any[]=[];let savedPlan:any=null;
  const store={call:async(method:string,input:any)=>{
    calls.push({method,input});
    if(method==='transitionRun'){
      assert.deepEqual({runId:input.runId,expectedRevision:input.expectedRevision,toState:input.toState,eventType:input.eventType},{runId,expectedRevision:7,toState:'failed',eventType:'return.force_cancelled'});
      assert.deepEqual(input.details,{verifiedTargets:53,totalTargets:88,remainingTargets:35,remoteRollback:false,mutationReplay:false});
      return 8;
    }
    if(method==='loadPlan')return{planId:runId,runId,execution:{state:'running'}};
    if(method==='savePlan'){savedPlan=input;return true;}
    throw new Error(`unexpected Store call ${method}`);
  }};
  const cancelled=await worker.forceCancelReturnRun(store,latest);
  assert.deepEqual({runId:cancelled.runId,stateRevision:cancelled.stateRevision,verified:cancelled.verified,total:cancelled.total},{runId,stateRevision:8,verified:53,total:88});
  assert.equal(savedPlan.execution.state,'force_cancelled');assert.equal(savedPlan.execution.remainingTargets,35);assert.equal(savedPlan.execution.remoteRollback,false);assert.equal(savedPlan.execution.mutationReplay,false);
  assert.equal(calls.filter((call)=>call.method==='transitionRun').length,1,'force cancel must commit one CAS Run transition');

  const stoppedActions=worker.workflowNavigationActions({...latest,run:{...latest.run,state:'failed',state_revision:8}},'return');
  assert.equal(stoppedActions.find((item:any)=>item.actionId==='restart-run').enabled,true,'restart must be enabled immediately after force cancel');
});

test('force-cancel fails closed when any Return result is uncertain',async()=>{
  let transitioned=false;
  const store={call:async(method:string)=>{if(method==='transitionRun')transitioned=true;throw new Error(`unexpected ${method}`);}};
  await assert.rejects(worker.forceCancelReturnRun(store,{run:{run_id:'run-uncertain',state:'returning',state_revision:3},returnProgress:[{state:'uncertain',command_state:'uncertain'}]}),/必须先完成只读核验/u);
  assert.equal(transitioned,false);
});

test('hidden surface-reopen fresh start mirrors safe eligibility and closes the old Run by exact CAS',async()=>{
  const latest:any={run:{run_id:'run-reopen',state:'processing',state_revision:12},events:[],returnProgress:[]};
  const actions=worker.workflowNavigationActions(latest,'validate');
  const hidden=actions.find((item:any)=>item.actionId==='fresh-start-on-reopen');
  const visible=actions.find((item:any)=>item.actionId==='restart-run');
  assert.equal(hidden.enabled,true);assert.equal(hidden.reason,visible.reason);
  const uncertainActions=worker.workflowNavigationActions({run:{run_id:'run-uncertain',state:'uncertain',state_revision:4},events:[],returnProgress:[{state:'uncertain',command_state:'uncertain'}]},'return');
  assert.equal(uncertainActions.find((item:any)=>item.actionId==='fresh-start-on-reopen').enabled,false);

  // A command still in submitted/committed/verifying has no conclusive
  // read-only outcome, so the Core force-close gate refuses it. The Surface
  // must mirror that and not advertise restart/force-cancel as available.
  const inFlightLatest:any={run:{run_id:'run-inflight',state:'returning',state_revision:9},events:[],returnProgress:[{state:'verified',command_state:'readback_verified'},{state:'submitted',command_state:'submitted'}]};
  const inFlightActions=worker.workflowNavigationActions(inFlightLatest,'return');
  assert.equal(inFlightActions.find((item:any)=>item.actionId==='restart-run').enabled,false,'restart must not appear enabled while a mutation is submitted without a conclusion');
  assert.equal(inFlightActions.find((item:any)=>item.actionId==='back-to-upload').enabled,false,'force-cancel must not appear enabled while a mutation is submitted without a conclusion');
  assert.match(inFlightActions.find((item:any)=>item.actionId==='restart-run').reason,/已提交写入但尚未得到结论/);

  let current={...latest.run};const calls:any[]=[];
  const store={call:async(method:string,input:any)=>{
    calls.push({method,input:structuredClone(input)});
    if(method==='loadReturnProgress')return[];
    if(method==='transitionRun'){
      assert.deepEqual({runId:input.runId,expectedRevision:input.expectedRevision,toState:input.toState},{runId:'run-reopen',expectedRevision:12,toState:'cancelled'});
      current={...current,state:'cancelled',state_revision:13};return 13;
    }
    if(method==='loadLatestRun')return{run:{...current},events:[],returnProgress:[]};
    if(method==='restartRun'){
      assert.deepEqual(input,{runId:'run-reopen',expectedRevision:13});
      current={...current,state_revision:14};return{state:'cancelled',stateRevision:14,terminalAuditPreserved:true};
    }
    throw new Error(`unexpected Store call ${method}`);
  }};
  const result=await worker.closeRunForFreshStart(store,latest,new Set(),'surface_reopen');
  assert.equal(result.current.run.state_revision,14);
  const transition=calls.find((item)=>item.method==='transitionRun').input;
  assert.equal(transition.eventType,'run.fresh_start_force_closed');
  assert.equal(transition.details.trigger,'surface_reopen');
  assert.equal(transition.details.remoteRollback,false);assert.equal(transition.details.mutationReplay,false);
  assert.equal(calls.filter((item)=>item.method==='restartRun').length,1);
});

test('force-cancel terminal CAS blocks every later Return command and keeps restart available',()=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'omnia-force-cancel-return-'));const paths=resolveProductPaths(temporary);const database=new CoreDatabase(paths.database,cipher);new FeaturePackageManager(database.db,paths);const store=new FeatureRuntimeStore(database.db,paths);
  const runId='af8a6e87-4968-4a48-a183-ffa2190e92f3',now=new Date().toISOString();const context={featureId:'omnia.create-associate',featureVersion:'0.1.0',allowMutation:true};
  try{
    activateCreateFixture(database);
    database.db.prepare(`INSERT INTO feature_runs(run_id,trace_id,feature_id,feature_version,engagement_id,state,state_revision,source_artifact_id,template_version_id,output_artifact_id,plan_digest,last_error,created_at,updated_at) VALUES(?,?,'omnia.create-associate','0.1.0','','returning',7,'','','',?,'',?,?)`).run(runId,crypto.randomUUID(),'a'.repeat(64),now,now);
    const revision=store.call('transitionRun',{runId,expectedRevision:7,toState:'failed',eventType:'return.force_cancelled',error:'用户强制取消；已验证 53/88 项保持不变。',details:{verifiedTargets:53,totalTargets:88,remainingTargets:35,remoteRollback:false,mutationReplay:false}},context);
    assert.equal(revision,8);
    assert.throws(()=>store.call('prepareReturnCommand',{runId,planDigest:'a'.repeat(64)},context),/not owned by the active returning Feature version/u);
    const restarted=store.call('restartRun',{runId,expectedRevision:8},context) as any;
    assert.equal(restarted.state,'failed');assert.equal(restarted.stateRevision,9);assert.equal(restarted.terminalAuditPreserved,true);
    const events=(database.db.prepare(`SELECT revision,event_type,from_state,to_state FROM feature_run_events WHERE run_id=? ORDER BY revision`).all(runId) as any[]).map((item)=>({...item}));
    assert.deepEqual(events,[{revision:8,event_type:'return.force_cancelled',from_state:'returning',to_state:'failed'},{revision:9,event_type:'run.restart_requested',from_state:'failed',to_state:'failed'}]);
  }finally{database.close();fs.rmSync(temporary,{recursive:true,force:true});}
});

function inheritedInput():Buffer{
  const row=(rowNumber:number,cells:string[])=>`<row r="${rowNumber}">${cells.map((value,index)=>`<c r="${String.fromCharCode(65+index)}${rowNumber}" t="inlineStr"><is><t>${xml(value)}</t></is></c>`).join('')}</row>`;
  const sheet=[row(1,['系统ID','APP类型','System Risk Classification','Factors Considered','Omnia工作区','isDataAvailable']),row(2,['APP-INHERIT','SAP ECC','Higher','Basis','20100 APP','false']),row(3,['数据库ID','DB 类型','Omnia工作区','关联系统ID']),row(4,['DB-INHERIT','Oracle','20100 APP','APP-INHERIT'])].join('');
  return zip({'[Content_Types].xml':'<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>','_rels/.rels':'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>','xl/workbook.xml':'<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="IT Risk Assessment" sheetId="1" r:id="rId1"/></sheets></workbook>','xl/_rels/workbook.xml.rels':'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>', 'xl/worksheets/sheet1.xml':`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheet}</sheetData></worksheet>`});
}

test('managed V8 governance and runtime-template base are exact, separate, and patched only at declared OOXML parts', () => {
  const workerSource=fs.readFileSync(path.join(repository,'feature-packages/create-associate/source/middle/worker.cjs'),'utf8');
  assert.doesNotMatch(workerSource,/require\(['"]node:(?:fs|path|http|https|net|child_process)['"]\)|(?:omnia[-]agent[-]v4|[\\/]v4[\\/])/u);
  const v8 = fs.readFileSync(managedV8);
  assert.equal(sha256(v8).toUpperCase(), worker.V8_SHA256);
  const parsedV8 = worker.parseV8(v8);
  assert.deepEqual(
    [parsedV8.fields.length, parsedV8.relations.length, parsedV8.traces.length, parsedV8.evidence.length],
    [239, 106, 180, 21]
  );
  const isRelevant=parsedV8.fields.find((row:any)=>row.values.field_id==='P1.APP.IT.IS_RELEVANT').values;
  assert.equal(isRelevant['对象子类型/区段'],''); assert.equal(isRelevant['字段用途'],''); assert.equal(isRelevant['允许值'],''); assert.equal(isRelevant['校验规则'],''); assert.equal(isRelevant.source_trace_id,'SRC.IT元素.011');
  const description=parsedV8.fields.find((row:any)=>row.values.field_id==='P1.APP.IT.DESCRIPTION').values;
  assert.equal(description['对象子类型/区段'],''); assert.equal(description['允许值'],''); assert.equal(description['校验规则'],''); assert.equal(description.source_trace_id,'SRC.IT元素.010');
  const outer = verifyOfficialPackage(JSON.parse(fs.readFileSync(featurePackagePath, 'utf8')), 'omnia-feature');
  const nested=verifyOfficialPackage(JSON.parse(packageFile(outer,'connector-capability/operation.ofop').toString('utf8')),'omnia-connector-operation');
  const standalone=verifyOfficialPackage(JSON.parse(fs.readFileSync(operationPackagePath,'utf8')),'omnia-connector-operation'); assert.equal(packageDigest(nested),packageDigest(standalone));
  for(const member of ['contracts/feature-runtime.json','contracts/implementation-map.json','tests/manifest.json','tests/vectors.json']) assert.ok(packageFile(outer,member).length>0);
  const governance = JSON.parse(packageFile(outer, 'backend/governance.json').toString('utf8'));
  const base = packageFile(outer, 'backend/runtime-template-base.xlsx');
  assert.notEqual(sha256(base).toUpperCase(), worker.V8_SHA256);
  assert.equal(governance.fields.length, 239);
  assert.equal(governance.relations.length, 106);
  assert.equal(governance.scoringItems.length, 15);
  assert.equal(governance.scoringItems.filter((item: any) => String(item.higherApplicable).startsWith('Y')).length, 14);
  assert.equal(governance.scoringItems.filter((item: any) => String(item.higherApplicable).startsWith('N')).length, 1);
  assert.equal(governance.scoringItems.filter((item: any) => String(item.lowerApplicable).includes('Lower写1')).length, 15);
  assert.equal(governance.semanticDigest, sha256(Buffer.from(canonicalJson({
    fields: governance.fields, relations: governance.relations, scoringItems: governance.scoringItems, derivationRules: governance.derivationRules
  }))));
  const corrective=correctiveGovernance(governance);const parsed = parseUserWorkbook(correctiveV3Input('APP-REAL-A'), 'source-a', corrective);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.issues.length, 0,JSON.stringify(parsed.issues));
  const formulaEntries=worker.zipEntries(correctiveV3Input('APP-FORMULA')); const formulaFiles:any={}; for(const [name,value] of formulaEntries)formulaFiles[name]=value;
  formulaFiles['xl/worksheets/sheet1.xml']=Buffer.from(formulaFiles['xl/worksheets/sheet1.xml'].toString('utf8').replace(/<c r="A2"[^>]*>[\s\S]*?<\/c>/u,'<c r="A2"><f>1+1</f><v>2</v></c>'));
  assert.throws(()=>parseUserWorkbook(zip(formulaFiles),'formula-source',corrective),/Formula cell A2 is unsupported in user input/);
  const built = compileRuntimeWorkbook(base, parsed, {
    runId: '11111111-1111-4111-8111-111111111111', sourceArtifactId: 'source-a', governanceDigest: worker.V8_SHA256
  });
  assert.equal(built.descriptor.baseDigest, sha256(base));
  const original = worker.zipEntries(base) as Map<string, Buffer>;
  const output = worker.zipEntries(built.bytes) as Map<string, Buffer>;
  const outputXml=[...output.values()].map((value)=>value.toString('utf8')).join('\n');assert.match(outputXml,/GRA-APP-REAL-A/u);assert.match(outputXml,/APP-REAL-A/u);
  const executionXml=output.get('xl/worksheets/sheet2.xml')!.toString('utf8');
  const traceXml=output.get('xl/worksheets/sheet3.xml')!.toString('utf8');
  const supportXml=output.get('xl/worksheets/sheet4.xml')!.toString('utf8');
  for(const [name,source] of [['execution',executionXml],['trace',traceXml],['support',supportXml]] as const){
    const rows=source.match(/<row\b[^>]*>/gu)||[];
    assert.ok(rows.length>1,`${name} rows`);
    assert.ok(rows.every((row)=>/\bht="[0-9.]+"/u.test(row)&&/\bcustomHeight="1"/u.test(row)),`${name} deterministic row heights`);
    assert.ok(rows.slice(1).some((row)=>Number(row.match(/\bht="([0-9.]+)"/u)?.[1]||0)>22),`${name} wrapped data height`);
  }
  assert.match(traceXml,/<pageSetup\b[^>]*pageOrder="overThenDown"[^>]*fitToWidth="2"[^>]*fitToHeight="1"/u);
  assert.equal((traceXml.match(/<col\b/gu)||[]).length,12);
  for(const header of ['sourceArtifactId','sourceSheet','sourceRow','rowKey','fieldKey','canonicalFieldId','revision','valueKind','value','status','sourceTraceId','derivationRule']) assert.match(traceXml,new RegExp(`>${header}<`,'u'));
  assert.match(executionXml,/<col\b[^>]*width="48\.00"/u);
  assert.match(supportXml,/<col\b[^>]*width="64\.00"/u);
  const mutable = new Set(['docProps/core.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml', 'xl/worksheets/sheet3.xml', 'xl/worksheets/sheet4.xml']);
  for (const [member, bytes] of original) if (!mutable.has(member)) assert.equal(sha256(output.get(member)!), sha256(bytes), member);
});

test('processing persists source and planned inherited provenance while invalid enums stay needs_input',()=>{
  const envelope=verifyOfficialPackage(JSON.parse(fs.readFileSync(featurePackagePath,'utf8')),'omnia-feature');
  const governance=correctiveGovernance(JSON.parse(packageFile(envelope,'backend/governance.json').toString('utf8')));
  const inheritedBytes=inheritedInput();const inheritedEntries=worker.zipEntries(inheritedBytes);const inheritedFiles:any={};for(const [name,value] of inheritedEntries)inheritedFiles[name]=value;inheritedFiles['xl/worksheets/sheet1.xml']=Buffer.from(inheritedFiles['xl/worksheets/sheet1.xml'].toString('utf8').replace(/<c r="F1"[\s\S]*?<\/c>/u,'').replace(/<c r="F2"[\s\S]*?<\/c>/u,''));
  const parsed=parseUserWorkbook(zip(inheritedFiles),'source-artifact-1',governance);
  assert.ok(parsed.candidates.some((item:any)=>item.valueKind==='source'));
  const inherited=parsed.candidates.find((item:any)=>item.valueKind==='inherited'); assert.ok(inherited);
  assert.equal(inherited.value,'Higher'); assert.match(inherited.provenance.sourceTraceId,/^inheritance:/u); assert.match(inherited.provenance.derivationRule,/remote_verification_required_before_return/u);
  const relevantDefault=parsed.candidates.find((item:any)=>item.canonicalFieldId==='P1.APP.IT.IS_RELEVANT'&&item.valueKind==='rule_default');assert.ok(relevantDefault);assert.equal(relevantDefault.value,false);assert.equal(relevantDefault.provenance.derivationRule,'v8.app-is-relevant-false.v1');assert.equal(relevantDefault.provenance.sourceTraceId,'SRC.IT元素.011');
  const dataDefault=parsed.candidates.find((item:any)=>item.canonicalFieldId==='P1.APP.IT.IS_DATA_AVAILABLE'&&item.valueKind==='rule_default');assert.ok(dataDefault);assert.equal(dataDefault.value,false);assert.equal(dataDefault.provenance.derivationRule,'v4.app-is-data-available-false.v1');
  const invalid=parseUserWorkbook(correctiveV3Input('APP-BAD-ENUM','Basis','20100 APP','Maybe'),'source-artifact-2',governance);
  assert.ok(invalid.issues.some((item:any)=>item.issueType==='invalid_enum'&&item.state==='needs_input'));
  const noUserData=parseUserWorkbook(correctiveV3Input('APP-NO-USER-DATA','Basis','20100 APP','Higher'),'source-artifact-3',governance);
  assert.equal(noUserData.issues.some((item:any)=>item.fieldKey.includes('P1.APP.IT.IS_DATA_AVAILABLE')),false);assert.ok(noUserData.candidates.some((item:any)=>item.canonicalFieldId==='P1.APP.IT.IS_DATA_AVAILABLE'&&item.valueKind==='rule_default'&&item.value===false));
});

test('live APP-edge validation preserves the inherited-field pre-Return verification gate',()=>{
  const candidate:any={
    value:'Lower',status:'accepted',valueKind:'inherited',revision:1,
    provenance:{sourceArtifactId:'source-artifact-1',rowKey:'DB.1',derivationRule:'planned_infrastructure_rait_from_app_edges:v1;remote_verification_required_before_return'}
  };
  const sourceApps=[{sourceType:'external',rowKey:'',elementId:'APP-1',workspaceId:'workspace-1',objectId:'object-1',riskAssessmentId:'gra-1',rait:'Higher'}];
  worker.applyLiveVerifiedInfrastructureInheritance(candidate,sourceApps,'Higher');
  assert.equal(candidate.value,'Higher');
  assert.equal(candidate.revision,2);
  assert.deepEqual(candidate.provenance.sourceApps,sourceApps);
  assert.match(candidate.provenance.derivationRule,/live_verified_app_edges/u);
  assert.match(candidate.provenance.derivationRule,/remote_verification_required_before_return/u);
  assert.equal(candidate.provenance.sourceArtifactId,'source-artifact-1','live read-back must not impersonate a Run evidence artifact');
});

test('dynamic upload surface mutates only action state while signed package retains IO authority',()=>{
  const surface=worker.uploadSurface(null,'',true);
  const fileInput=surface.actions.find((action:any)=>action.actionId==='stage-source-workbook');
  const templateOutput=surface.actions.find((action:any)=>action.actionId==='download-source-template');
  assert.equal(fileInput.enabled,true);
  assert.equal(templateOutput.enabled,true);
  assert.deepEqual(Object.keys(fileInput).sort(),['actionId','enabled','reason']);
  assert.deepEqual(Object.keys(templateOutput).sort(),['actionId','enabled','reason']);
});

test('terminal validation Run without Return ledger reopens as a fresh upload',()=>{
  for(const state of ['failed','succeeded','cancelled','not_evaluable']){
    assert.equal(worker.terminalRunReturnsToFreshUpload({run:{state},returnProgress:[]}),true,state);
  }
  assert.equal(worker.terminalRunReturnsToFreshUpload({run:{state:'failed'},returnProgress:[{command_state:'failed'}]}),false);
  assert.equal(worker.terminalRunReturnsToFreshUpload({run:{state:'uncertain'},returnProgress:[]}),false);
});

test('Core Review commit atomically persists element ID, GRA name and APP description derived revisions',()=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'omnia-derived-review-'));const paths=resolveProductPaths(temporary);const database=new CoreDatabase(paths.database,cipher);const manager=new FeaturePackageManager(database.db,paths);const store=new FeatureRuntimeStore(database.db,paths);const context={featureId:'omnia.create-associate',featureVersion:'0.2.0',allowMutation:false};
  try{
    const packagePath=path.join(repository,'feature-packages/create-associate/candidates/create-associate-0.2.0.ofp');manager.install(packagePath);const envelope=verifyOfficialPackage(JSON.parse(fs.readFileSync(packagePath,'utf8')),'omnia-feature');const governance=correctiveGovernance(JSON.parse(packageFile(envelope,'backend/governance.json').toString('utf8')));
    const managed=database.db.prepare(`SELECT managed_path FROM feature_managed_assets WHERE feature_id=? AND feature_version=? AND member_path='backend/governance.json'`).get(context.featureId,context.featureVersion) as {managed_path:string};fs.writeFileSync(path.resolve(paths.data,...managed.managed_path.split('/')),JSON.stringify(governance));
    const runId=crypto.randomUUID(),sourceArtifactId=crypto.randomUUID(),templateVersionId=crypto.randomUUID(),templateInstanceId=crypto.randomUUID(),now=new Date().toISOString();database.db.prepare(`INSERT INTO feature_runs(run_id,trace_id,feature_id,feature_version,engagement_id,state,state_revision,source_artifact_id,template_version_id,output_artifact_id,plan_digest,last_error,created_at,updated_at) VALUES(?,?,'omnia.create-associate','0.2.0','','needs_input',7,?,?,'','','',?,?)`).run(runId,crypto.randomUUID(),sourceArtifactId,templateVersionId,now,now);database.db.prepare(`INSERT INTO template_versions(template_version_id,template_id,version,status,source_artifact_id,file_digest,semantic_digest,schema_version,owner,license,authorization_ref,requested_by,published_by,published_at,created_at) VALUES(?,'test-template','1.0.0','candidate',?, ?,?,'test/v1','test','internal','','','','',?)`).run(templateVersionId,sourceArtifactId,'a'.repeat(64),'b'.repeat(64),now);database.db.prepare(`INSERT INTO template_instances(template_instance_id,run_id,template_version_id,source_artifact_id,output_artifact_id,patch_digest,semantic_digest,output_file_digest,governance_digest,state,created_at,updated_at) VALUES(?,?,?,?,?,'',?,?,?,'candidate',?,?)`).run(templateInstanceId,runId,templateVersionId,sourceArtifactId,crypto.randomUUID(),'c'.repeat(64),'d'.repeat(64),'e'.repeat(64),now,now);
    const parsed=parseUserWorkbook(correctiveV3Input('APP-LINEAGE-OLD'),'placeholder',governance);for(const candidate of parsed.candidates)if(candidate.valueKind==='source')candidate.provenance.sourceArtifactId=sourceArtifactId;store.call('recordFieldRevisions',{runId,templateInstanceId,fields:parsed.candidates},context);
    const id=parsed.candidates.find((candidate:any)=>candidate.canonicalFieldId==='P1.APP.IT.ELEMENT_ID'),gra=parsed.candidates.find((candidate:any)=>candidate.canonicalFieldId==='P1.RUNTIME.GRA.NAME'),description=parsed.candidates.find((candidate:any)=>candidate.canonicalFieldId==='P1.APP.IT.DESCRIPTION');assert.ok(id&&gra&&description);
    const base={runId,expectedRunRevision:7,revisions:[{rowKey:id.provenance.rowKey,fieldKey:id.fieldKey,expectedRevision:1,value:'APP-LINEAGE-NEW'}],issues:[],nextState:'needs_input',eventType:'review.saved_and_revalidated',excludedRowKey:'',templateInstanceId};
    assert.throws(()=>store.call('commitReviewValidation',{...base,derivedRevisions:[]},context),/atomically include every signed derived/);assert.equal((database.db.prepare(`SELECT MAX(revision) AS revision FROM feature_field_revisions WHERE run_id=? AND field_key=?`).get(runId,id.fieldKey) as any).revision,1);assert.equal((database.db.prepare(`SELECT state_revision FROM feature_runs WHERE run_id=?`).get(runId) as any).state_revision,7);
    const derivedRevisions=[{fieldKey:gra.fieldKey,expectedRevision:1,value:'GRA-APP-LINEAGE-NEW',dependencyFieldKey:id.fieldKey,dependencyRevision:2},{fieldKey:description.fieldKey,expectedRevision:1,value:'APP-LINEAGE-NEW',dependencyFieldKey:id.fieldKey,dependencyRevision:2}];const result=store.call('commitReviewValidation',{...base,derivedRevisions},context) as any;assert.equal(result.stateRevision,8);
    const latest=(fieldKey:string)=>database.db.prepare(`SELECT revision,value_json,value_kind,template_instance_id FROM feature_field_revisions WHERE run_id=? AND field_key=? ORDER BY revision DESC LIMIT 1`).get(runId,fieldKey) as any;assert.deepEqual([JSON.parse(latest(id.fieldKey).value_json),JSON.parse(latest(gra.fieldKey).value_json),JSON.parse(latest(description.fieldKey).value_json)],['APP-LINEAGE-NEW','GRA-APP-LINEAGE-NEW','APP-LINEAGE-NEW']);assert.deepEqual([latest(id.fieldKey).revision,latest(gra.fieldKey).revision,latest(description.fieldKey).revision],[2,2,2]);assert.ok([latest(id.fieldKey),latest(gra.fieldKey),latest(description.fieldKey)].every((row)=>row.template_instance_id===templateInstanceId));const event=database.db.prepare(`SELECT details_json FROM feature_run_events WHERE run_id=? AND revision=8`).get(runId) as any;assert.equal(JSON.parse(event.details_json).derivedRevisionCount,2);
    const issueRuns=[crypto.randomUUID(),crypto.randomUUID()];for(const [index,issueRun] of issueRuns.entries()){database.db.prepare(`INSERT INTO feature_runs(run_id,trace_id,feature_id,feature_version,engagement_id,state,state_revision,source_artifact_id,template_version_id,output_artifact_id,plan_digest,last_error,created_at,updated_at) VALUES(?,?,'omnia.create-associate','0.2.0','','needs_input',1,?,'','','','',?,?)`).run(issueRun,crypto.randomUUID(),`issue-source-${index}`,now,now);const issueParsed=parseUserWorkbook(correctiveV3Input('APP-SAME-ROW','basis','20100 APP','Invalid'),`issue-source-${index}`,governance);worker.recomputeLocalIssues(issueParsed);store.call('recordIssues',{runId:issueRun,issues:issueParsed.issues},context);}const durableIssues=database.db.prepare(`SELECT issue_id,run_id FROM feature_issues WHERE run_id IN (?,?) ORDER BY run_id,issue_id`).all(...issueRuns) as any[];assert.ok(durableIssues.length>=2);assert.equal(new Set(durableIssues.map((row)=>row.issue_id)).size,durableIssues.length,'same workbook coordinates in two Runs must not collide on the global issue PK');
  }finally{database.close();fs.rmSync(temporary,{recursive:true,force:true});}
});

test('two different offline inputs reuse one immutable TemplateVersion and persist distinct TemplateInstances', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-create-associate-'));
  const paths = resolveProductPaths(temporary);
  const database = new CoreDatabase(paths.database, cipher);
  const hostEntrypoint = path.join(temporary, 'feature-worker-host.cjs');
  await build({
    entryPoints: [path.join(repository, 'src/main/features/feature-worker-host.ts')], outfile: hostEntrypoint,
    bundle: true, platform: 'node', format: 'cjs', target: 'node24'
  });
  const installer = new FeaturePackageManager(database.db, paths);
  installer.install(featurePackagePath);
  const returnHost = new OperationHost();
  let returnBinding = { connectorId: 'connector-1', sessionGeneration: 5, engagementId: '11111111-1111-4111-8111-111111111111', authorityInstanceId: 'authority-test', tenantOrOrgId: 'tenant-test', packId: 'pack-test' };
  const returnWorkspaceId = '22222222-2222-4222-8222-222222222222';
  const returnApplicationId = '33333333-3333-4333-8333-333333333333';
  const returnGraId = '44444444-4444-4444-8444-444444444444';
  const installedEnvelope = verifyOfficialPackage(JSON.parse(fs.readFileSync(featurePackagePath, 'utf8')), 'omnia-feature');
  const returnGovernance = JSON.parse(packageFile(installedEnvelope, 'backend/governance.json').toString('utf8'));
  let returnStatus = 'ContentPending'; let returnRait = 'Lower'; let returnEvaluation = 'EvaluationStarted';
  let returnElementId='APP-REAL-C';
  let returnAppTypeId='old-type'; let returnRelevant=true; let returnDataAvailable=true;
  let returnObjectExists=false; let returnGraExists=false; let objectCreateCalls=0; let graCreateCalls=0;
  let objectCreateResponseLoss:''|'applied'|'not_applied'='';
  const operationAuthorization:Array<{operationId:string;mutationAuthorized:boolean}>=[];
  let returnDocumentation: any = { documentation: { editorData: '', plainText: '' }, workItems: [] };
  const factorValues = new Map<number, number>(Array.from({ length: 15 }, (_unused, index) => [index + 2, 1]));
  const riskNames = [...new Set<string>(returnGovernance.relations.map((item: any) => String(item.riskName)))];
  const controlNames = [...new Set<string>(returnGovernance.relations.map((item: any) => String(item.controlName)))];
  const guidFor = (prefix: number, index: number) => `${String(prefix + index).padStart(8, '0')}-1111-4111-8111-${String(prefix + index).padStart(12, '0')}`;
  const risks = riskNames.map((name: string, index: number) => ({ riskId: guidFor(1000, index), riskRiskScopeId: guidFor(2000, index), name, classification: 'Higher', assertion: 'Existence', updatedOn: '2026-08-03T00:00:00.000Z' }));
  const controls = controlNames.map((name: string, index: number) => ({ controlId: guidFor(3000, index), name }));
  const associatedScopes = new Map<string, any>();
  const connector = {
    registerOperation: async (input: any) => returnHost.register(input, returnBinding),
    invokeOperation: async (input: any) => {
      operationAuthorization.push({operationId:input.operationId,mutationAuthorized:input.mutationAuthorized===true});
      returnBinding = input.request.connectorBinding;
      return returnHost.invoke(input, returnBinding, async (route, routePath, body) => {
        const payload = body as any;
        if (route.stepId === 'authority-hierarchy' || route.stepId === 'authority-sections') return [{ id: returnWorkspaceId, name: returnWorkspaceId }];
        if (route.stepId === 'authority-workspaces') return [{ facetId: returnWorkspaceId, name: returnWorkspaceId }];
        if (route.stepId === 'authority-gra-directory') return [{ inkContentId: '66176475', typeId: '3', itElementTypeId: '66175343', contentName: 'SAP ECC', objectType: 'Application' }];
        if (route.stepId === 'application-search') return returnObjectExists?{ results: [{ id: returnApplicationId, number:returnElementId, workspaceId: returnWorkspaceId, itElementType: 'Application',description:JSON.stringify({editorData:`<p>${returnElementId}</p>`,suggestionsData:[],trackChangesEnableFlagInEditor:false,plainText:returnElementId}) }], totalResults: 1 }:{results:[],totalResults:0};
        if (route.stepId === 'object-create') {const loss=objectCreateResponseLoss;objectCreateResponseLoss='';objectCreateCalls+=1;if(loss==='applied')returnObjectExists=true;else if(loss!=='not_applied')returnObjectExists=true;if(loss){const error:any=new Error('commit response lost');error.code='CONNECTOR.RESPONSE_LOST';throw error;}return{id:returnApplicationId,number:'APP-REAL-C',workspaceId:returnWorkspaceId,itElementType:'Application'};}
        if (route.stepId === 'gra-directory') return returnGraExists?[{ id: returnGraId, entityId: returnApplicationId, workspaceId: returnWorkspaceId, name:returnElementId, type: 'Application' }]:[];
        if (route.stepId === 'gra-create') {returnGraExists=true;graCreateCalls+=1;return{id:returnGraId,entityId:returnApplicationId,workspaceId:returnWorkspaceId,name:returnElementId,type:'Application',inkContentId:'66176475',typeId:'3'};}
        if (route.stepId === 'object-readback') return { id: returnApplicationId, number:returnElementId, workspaceId: returnWorkspaceId, itElementType: 'Application', description: JSON.stringify({editorData:`<p>${returnElementId}</p>`,suggestionsData:[],trackChangesEnableFlagInEditor:false,plainText:returnElementId}) };
        if (route.stepId === 'object-settings-read') return {id:returnApplicationId,number:returnElementId,workspaceId:returnWorkspaceId,itElementType:'Application',typeId:returnAppTypeId,isRelevant:returnRelevant,isDataAvailable:returnDataAvailable,concurrencyTabs:[{entityTabTypeId:501,updatedOn:'settings-v1'}]};
        if (route.stepId === 'object-settings-patch') {returnAppTypeId=payload[0].value;returnRelevant=payload[1].value;returnDataAvailable=payload[2].value;return {id:returnApplicationId,number:returnElementId,workspaceId:returnWorkspaceId,itElementType:'Application',typeId:returnAppTypeId,isRelevant:returnRelevant,isDataAvailable:returnDataAvailable,concurrencyTabs:[{entityTabTypeId:501,updatedOn:'settings-v2'}]};}
        if (route.stepId === 'gra-readback') return { id: returnGraId,entityId:returnApplicationId,name:returnElementId,type:'Application',inkContentId:'66176475',typeId:'3', workspaceId: returnWorkspaceId, status: returnStatus, itElementRaitConclusionLevelId: returnRait };
        if (route.stepId === 'gra-state-read') return { id: returnGraId, workspaceId: returnWorkspaceId, status: returnStatus, itElementRaitConclusionLevelId: returnRait };
        if (route.stepId === 'gra-state-patch') { const patch = payload[0]; if (patch.path === '/status') returnStatus = patch.value; else returnRait = patch.value; return { id: returnGraId, workspaceId: returnWorkspaceId, status: returnStatus, itElementRaitConclusionLevelId: returnRait }; }
        if (route.stepId === 'risk-catalog') return { results: risks };
        if (route.stepId === 'control-catalog') return { results: controls };
        if (route.stepId === 'risk-control-validation') return [];
        if (route.stepId === 'risk-control-detail') return { scopes: [...associatedScopes.values()] };
        if (route.stepId === 'risk-control-associate') { const scope = payload.controlRiskScopes[0]; associatedScopes.set(`${scope.riskScopeId}|${scope.controlId}`, { riskId: scope.riskId, riskScopeId: scope.riskScopeId, controlId: scope.controlId, assertions: scope.assertions }); return { ok: true }; }
        if (route.stepId === 'risk-factor-directory') return { riskFactors: Array.from({ length: 15 }, (_unused, index) => ({ id: guidFor(4000, index), displayOrder: index + 2, applicable: index + 2 !== 13, riskLevel: { value: factorValues.get(index + 2), name: factorValues.get(index + 2) === 7 ? 'Higher' : 'Lower' }, riskLevelSpectrum: [{ value: 1, name: 'Lower' }, { value: 7, name: 'Higher' }] })) };
        if (route.stepId === 'risk-factor-patch') { const factorId = decodeURIComponent(routePath.split('/').at(-1)!); const index = Array.from({ length: 15 }, (_unused, item) => guidFor(4000, item)).indexOf(factorId); factorValues.set(index + 2, Number(payload[0].value.value)); return { id: factorId, riskLevel: payload[0].value }; }
        if (route.stepId === 'documentation-read') return { id: returnGraId, workspaceId: returnWorkspaceId, documentation: returnDocumentation };
        if (route.stepId === 'documentation-patch') { returnDocumentation = payload[0].value; return { id: returnGraId, workspaceId: returnWorkspaceId, documentation: returnDocumentation }; }
        if (route.stepId === 'evaluation-read') return { id: returnGraId, workspaceId: returnWorkspaceId, status: returnEvaluation };
        if (route.stepId === 'evaluation-submit') { returnEvaluation = 'EvaluationComplete'; return { id: returnGraId, workspaceId: returnWorkspaceId, status: returnEvaluation }; }
        throw new Error(`Unexpected prepare-return step: ${route.stepId}`);
      });
    }
  } as any;
  const runtime = new FeaturePackageManager(database.db, paths, undefined, { connector, workerHostEntrypoint: hostEntrypoint });
  const context = {
    connection: { transport: 'remote', connected: false, connectorId: '', sessionGeneration: 0, engagementId: '' },
    safetyLock: { enabled: false, engagementId: '', workspaceIds: [], authorityObservationId: '', stateVersion: 1, validForCurrentConnection: false, invalidReason: '' }
  } as any;
  try {
    await runtime.initializeRuntime();
    runtime.select('omnia.create-associate');
    let snapshot = runtime.snapshot(context);
    for (const [index, elementId] of ['APP-REAL-A', 'APP-REAL-B'].entries()) {
      const source = path.join(temporary, `input-${index}.xlsx`);
      fs.writeFileSync(source, populatedInput(elementId));
      const descriptor = runtime.importArtifact({
        featureId: 'omnia.create-associate', featureVersion: '0.1.0', surfaceId: 'create-associate.workbench',
        actionId: 'import-source-workbook', accept: ['.xlsx']
      }, source);
      snapshot = await runtime.action({
        featureId: 'omnia.create-associate', featureVersion: '0.1.0', surfaceId: 'create-associate.workbench',
        actionId: 'import-source-workbook', expectedStateVersion: snapshot.surface!.stateVersion, payload: { artifact: descriptor }
      }, context);
      assert.equal(snapshot.surface?.status, 'ready');
      assert.equal(snapshot.surface?.artifacts?.[0]?.kind, 'template_instance');
    }
    assert.equal((database.db.prepare('SELECT COUNT(*) AS count FROM template_versions').get() as any).count, 1);
    assert.equal((database.db.prepare('SELECT COUNT(*) AS count FROM template_instances').get() as any).count, 2);
    const instances = database.db.prepare('SELECT semantic_digest, output_file_digest FROM template_instances ORDER BY created_at').all() as any[];
    assert.notEqual(instances[0].semantic_digest, instances[1].semantic_digest);
    assert.notEqual(instances[0].output_file_digest, instances[1].output_file_digest);
    const latestRunForProgress=database.db.prepare(`SELECT run_id FROM feature_runs ORDER BY updated_at DESC LIMIT 1`).get() as any;const progressEvents=database.db.prepare(`SELECT revision,to_state FROM feature_run_events WHERE run_id=? ORDER BY revision`).all(latestRunForProgress.run_id) as any[];assert.deepEqual(snapshot.surface?.items.map((item)=>[Number(item.concurrencyToken),item.title]),progressEvents.map((event)=>[event.revision,event.to_state]));
    const provenanceRun=database.db.prepare('SELECT run_id,source_artifact_id,template_version_id FROM feature_runs ORDER BY updated_at DESC LIMIT 1').get() as any;
    const provenanceInstance=database.db.prepare('SELECT template_instance_id FROM template_instances WHERE run_id=? ORDER BY created_at DESC LIMIT 1').get(provenanceRun.run_id) as any;
    const portContext={featureId:'omnia.create-associate',featureVersion:'0.1.0',allowMutation:false};
    assert.throws(()=>(runtime as any).runtimeStore.call('recordFieldRevisions',{runId:provenanceRun.run_id,templateInstanceId:provenanceInstance.template_instance_id,fields:[{fieldKey:'derived.audit.identity',rawFieldKey:'derived identity',canonicalFieldId:'P1.APP.IT.DESCRIPTION',revision:1,valueKind:'derived',value:'FORGED',status:'accepted',provenance:{sourceArtifactId:`ofp-member:backend/governance-source-v8.xlsx:sha256:${worker.V8_SHA256.toLowerCase()}`,sourceSheet:'字段母版',sourceRow:8,rowKey:'derived-audit',fieldKey:'derived.audit.identity',sourceTraceId:'SRC.IT元素.010',derivationRule:'forged-rule'}}]},portContext),/formally declared signed governance rule/);
    assert.throws(()=>(runtime as any).runtimeStore.call('recordFieldRevisions',{runId:provenanceRun.run_id,templateInstanceId:provenanceInstance.template_instance_id,fields:[{fieldKey:'default.audit.identity',rawFieldKey:'default identity',canonicalFieldId:'P1.APP.IT.ELEMENT_ID',revision:1,valueKind:'rule_default',value:'FAKE-DEFAULT',status:'accepted',provenance:{sourceArtifactId:'ofp-member:backend/governance.json',sourceSheet:'字段字典',sourceRow:1,rowKey:'default-audit',fieldKey:'default.audit.identity',sourceTraceId:'default:test',derivationRule:'unapproved_default'}}]},portContext),/signed governance member digest|formally declared signed governance default/);
    const derivedRows=database.db.prepare("SELECT r.value_json,p.source_artifact_id,p.source_sheet,p.source_row,p.source_trace_id,p.derivation_rule FROM feature_field_revisions r JOIN feature_field_provenance p ON p.field_revision_id=r.field_revision_id WHERE r.value_kind='derived' ORDER BY r.created_at").all() as any[];
    assert.equal(derivedRows.length,2); assert.deepEqual(derivedRows.map((row)=>JSON.parse(row.value_json)),['APP-REAL-A','APP-REAL-B']);
    assert.ok(derivedRows.every((row)=>row.source_artifact_id===`ofp-member:backend/governance-source-v8.xlsx:sha256:${worker.V8_SHA256.toLowerCase()}`&&row.source_sheet==='字段母版'&&row.source_row===8&&row.source_trace_id==='SRC.IT元素.010'&&row.derivation_rule==='v8.app-description-from-element-id.v1'));
    const defaultRows=database.db.prepare("SELECT r.value_json,p.source_artifact_id,p.source_row,p.source_trace_id,p.derivation_rule FROM feature_field_revisions r JOIN feature_field_provenance p ON p.field_revision_id=r.field_revision_id WHERE r.value_kind='rule_default' ORDER BY r.created_at").all() as any[];
    assert.equal(defaultRows.length,2);assert.ok(defaultRows.every((row)=>JSON.parse(row.value_json)===false&&row.source_artifact_id===`ofp-member:backend/governance-source-v8.xlsx:sha256:${worker.V8_SHA256.toLowerCase()}`&&row.source_row===9&&row.source_trace_id==='SRC.IT元素.011'&&row.derivation_rule==='v8.app-is-relevant-false.v1'));

    const invalidEnum=path.join(temporary,'input-invalid-enum.xlsx');fs.writeFileSync(invalidEnum,populatedInput('APP-ENUM','Risk basis','20100 APP','Invalid'));
    const invalidDescriptor=runtime.importArtifact({featureId:'omnia.create-associate',featureVersion:'0.1.0',surfaceId:'create-associate.workbench',actionId:'import-source-workbook',accept:['.xlsx']},invalidEnum);
    snapshot=await runtime.action({featureId:'omnia.create-associate',featureVersion:'0.1.0',surfaceId:'create-associate.workbench',actionId:'import-source-workbook',expectedStateVersion:snapshot.surface!.stateVersion,payload:{artifact:invalidDescriptor}},context);assert.equal(snapshot.surface?.status,'blocked');
    const enumEditor=snapshot.surface!.editors!.find((item)=>item.fieldKey.includes('RAIT_CONCLUSION'))!;assert.ok(enumEditor);const invalidRevision={issueId:enumEditor.issueId,fieldKey:enumEditor.fieldKey,expectedRevision:enumEditor.expectedRevision,value:'Nope'};
    await assert.rejects(runtime.action({featureId:'omnia.create-associate',featureVersion:'0.1.0',surfaceId:'create-associate.workbench',actionId:'apply-revisions',expectedStateVersion:snapshot.surface!.stateVersion,payload:{revisions:[invalidRevision]}},context),/RAIT revision must be exactly Higher or Lower/);
    snapshot=await runtime.action({featureId:'omnia.create-associate',featureVersion:'0.1.0',surfaceId:'create-associate.workbench',actionId:'apply-revisions',expectedStateVersion:snapshot.surface!.stateVersion,payload:{revisions:[{...invalidRevision,value:'Higher'}]}},context);assert.equal(snapshot.surface?.status,'ready');assert.equal((database.db.prepare(`SELECT state FROM feature_issues WHERE issue_id=?`).get(enumEditor.issueId) as any).state,'resolved');

    const incomplete = path.join(temporary, 'input-needs-revision.xlsx');
    fs.writeFileSync(incomplete, populatedInput('APP-REAL-C', '', '22222222-2222-4222-8222-222222222222'));
    const descriptor = runtime.importArtifact({
      featureId: 'omnia.create-associate', featureVersion: '0.1.0', surfaceId: 'create-associate.workbench',
      actionId: 'import-source-workbook', accept: ['.xlsx']
    }, incomplete);
    snapshot = await runtime.action({
      featureId: 'omnia.create-associate', featureVersion: '0.1.0', surfaceId: 'create-associate.workbench',
      actionId: 'import-source-workbook', expectedStateVersion: snapshot.surface!.stateVersion, payload: { artifact: descriptor }
    }, context);
    assert.equal(snapshot.surface?.status, 'blocked');
    assert.equal(snapshot.surface?.editors?.length, 1);
    const editor = snapshot.surface!.editors![0]!;
    const initialInstance=database.db.prepare(`SELECT template_instance_id FROM template_instances WHERE run_id=? ORDER BY created_at,rowid LIMIT 1`).get(descriptor.runId) as any;
    const initialFieldRevision=database.db.prepare(`SELECT field_revision_id FROM feature_field_revisions WHERE run_id=? AND field_key=? ORDER BY revision LIMIT 1`).get(descriptor.runId,editor.fieldKey) as any;
    snapshot = await runtime.action({
      featureId: 'omnia.create-associate', featureVersion: '0.1.0', surfaceId: 'create-associate.workbench',
      actionId: 'apply-revisions', expectedStateVersion: snapshot.surface!.stateVersion,
      payload: { revisions: [{ issueId: editor.issueId, fieldKey: editor.fieldKey, expectedRevision: editor.expectedRevision, value: 'User supplied risk basis' }] }
    }, context);
    assert.equal(snapshot.surface?.status, 'ready');
    assert.equal(snapshot.surface?.editors?.length, 0);
    assert.equal((database.db.prepare("SELECT COUNT(*) AS count FROM feature_field_revisions WHERE run_id=? AND value_kind='user_revision'").get(descriptor.runId) as any).count, 1);
    assert.equal((database.db.prepare("SELECT COUNT(*) AS count FROM feature_issues WHERE run_id=? AND state='resolved'").get(descriptor.runId) as any).count, 1);
    const runInstances=database.db.prepare(`SELECT template_instance_id FROM template_instances WHERE run_id=? ORDER BY created_at,rowid`).all(descriptor.runId) as any[];assert.equal(runInstances.length,2);
    const revisedInstance=runInstances[1].template_instance_id;assert.notEqual(revisedInstance,initialInstance.template_instance_id);
    assert.equal((database.db.prepare(`SELECT field_revision_id FROM template_instance_field_revisions WHERE template_instance_id=? AND field_key=?`).get(initialInstance.template_instance_id,editor.fieldKey) as any).field_revision_id,initialFieldRevision.field_revision_id,'old TemplateInstance must retain the old field revision');
    const userRevision=database.db.prepare(`SELECT field_revision_id,template_instance_id FROM feature_field_revisions WHERE run_id=? AND field_key=? AND value_kind='user_revision'`).get(descriptor.runId,editor.fieldKey) as any;
    assert.equal(userRevision.template_instance_id,revisedInstance,'user revision legacy ownership must bind only after the revised TemplateInstance exists');
    assert.equal((database.db.prepare(`SELECT field_revision_id FROM template_instance_field_revisions WHERE template_instance_id=? AND field_key=?`).get(revisedInstance,editor.fieldKey) as any).field_revision_id,userRevision.field_revision_id,'revised TemplateInstance must snapshot the user revision');
    const revisedArtifact=database.db.prepare("SELECT managed_path FROM feature_artifacts WHERE run_id=? AND kind='template_instance' ORDER BY created_at DESC,rowid DESC LIMIT 1").get(descriptor.runId) as any;
    const revisedEntries=worker.zipEntries(fs.readFileSync(path.join(paths.data,...String(revisedArtifact.managed_path).split('/'))));
    const revisedXml=[...revisedEntries.values()].map((value:Buffer)=>value.toString('utf8')).join('\n');
    assert.match(revisedXml,new RegExp(editor.issueId)); assert.match(revisedXml,/resolved/u); assert.match(revisedXml,/user_revision/u); assert.match(revisedXml,/accepted/u);

    const engagementId = '11111111-1111-4111-8111-111111111111';
    const workspaceId = '22222222-2222-4222-8222-222222222222';
    database.db.prepare(`UPDATE workspace_safety SET enabled=1, engagement_id=?, workspace_ids_json=?, state_version=2 WHERE singleton=1`)
      .run(engagementId, JSON.stringify([workspaceId]));
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      const reviewContext = {
        connection: { transport: 'remote', connected: true, connectorId: 'connector-1', sessionGeneration: 5, engagementId,
          authorityInstanceId: 'authority-1', tenantOrOrgId: 'tenant-1', packId: 'pack-1' },
        safetyLock: { enabled: true, engagementId, workspaceIds: [workspaceId], authorityObservationId: 'observation-1', stateVersion: 2, validForCurrentConnection: true, invalidReason: '' },
        verifiedCanaryCapabilities: [{ featureId: 'omnia.create-associate', scenarioId: 'create-associate-return-v1', capabilityId: 'phase1-full-return-v1' }]
      } as any;
      snapshot = await runtime.action({
        featureId: 'omnia.create-associate', featureVersion: '0.1.0', surfaceId: 'create-associate.workbench',
        actionId: 'prepare-return', expectedStateVersion: snapshot.surface!.stateVersion, payload: {}
      }, reviewContext);
      assert.equal(snapshot.messageCards.at(-1)?.state, 'pending_confirmation');
      assert.equal(snapshot.messageCards.at(-1)?.actions?.[0]?.actionId, 'confirm-return');
      assert.ok((snapshot.messageCards.at(-1)?.details?.length || 0) > 5);
      const reviewText=snapshot.messageCards.at(-1)!.details.map((item:any)=>`${item.label}:${item.value}`).join('\n');
      assert.match(reviewText,/Pack=pack-1/u); assert.match(reviewText,/disposition=create/u); assert.match(reviewText,/post-create-resolution/u); assert.match(reviewText,/current=.*-> desired=/u); assert.match(reviewText,/Risk-Control 精确清单/u); assert.match(reviewText,/Operation=omnia\.create-associate\./u);
      assert.ok((database.db.prepare('SELECT COUNT(*) AS count FROM managed_content_intents').get() as any).count > 0);
      assert.equal((database.db.prepare("SELECT COUNT(*) AS count FROM feature_confirmations WHERE decision='pending'").get() as any).count, 1);
      const frozenAuthority=database.db.prepare(`SELECT c.authority_instance_id,c.tenant_or_org_id,c.pack_id,c.engagement_id,r.engagement_id AS run_engagement_id FROM feature_confirmations c JOIN feature_runs r ON r.run_id=c.run_id WHERE c.decision='pending'`).get() as any;
      assert.deepEqual({...frozenAuthority},{authority_instance_id:'authority-1',tenant_or_org_id:'tenant-1',pack_id:'pack-1',engagement_id:engagementId,run_engagement_id:engagementId});
      const card = snapshot.messageCards.at(-1)!;
      for(const [field,value] of [['authorityInstanceId','authority-drift'],['tenantOrOrgId','tenant-drift'],['packId','pack-drift']] as const){
        const drifted=structuredClone(reviewContext); drifted.connection[field]=value;
        await assert.rejects(runtime.action({featureId:'omnia.create-associate',featureVersion:'0.1.0',surfaceId:'create-associate.workbench',actionId:'confirm-return',expectedStateVersion:card.stateVersion,payload:{runId:card.runId,confirmationId:card.confirmationId}},drifted),/preflight changed|authority|stale|scope/i,`${field} drift must reject the frozen Return`);
      }
      snapshot = await runtime.action({
        featureId: 'omnia.create-associate', featureVersion: '0.1.0', surfaceId: 'create-associate.workbench',
        actionId: 'confirm-return', expectedStateVersion: card.stateVersion,
        payload: { runId: card.runId, confirmationId: card.confirmationId }
      }, reviewContext);
      assert.equal(snapshot.messageCards.at(-1)?.state, 'completed');
      assert.equal((database.db.prepare("SELECT COUNT(*) AS count FROM managed_content_intents WHERE state<>'verified'").get() as any).count, 0);
      assert.equal((database.db.prepare("SELECT COUNT(*) AS count FROM feature_commands WHERE state NOT IN ('readback_verified','closed_not_applied')").get() as any).count, 0);
      assert.ok((database.db.prepare('SELECT COUNT(*) AS count FROM feature_operation_receipts').get() as any).count > 0);
      assert.ok((database.db.prepare("SELECT COUNT(*) AS count FROM managed_object_revisions WHERE object_type='GRA'").get() as any).count > 10);
      assert.ok((database.db.prepare("SELECT COUNT(*) AS count FROM managed_relations WHERE relation_type='risk_control' AND freshness='verified_current'").get() as any).count>0,'Risk-Control current must advance only through receipt-backed relation projection');
      assert.equal(objectCreateCalls,1);
      assert.equal(graCreateCalls,1);
      assert.ok(operationAuthorization.some((item)=>item.operationId==='omnia.create-associate.object.create.v1'&&item.mutationAuthorized));
      assert.ok(operationAuthorization.filter((item)=>/preflight|reconcile|\.read\.|authority\.resolve|catalog/u.test(item.operationId)).every((item)=>item.mutationAuthorized===false),'read-only Operations must never be transported as authorized mutations');

      const blockedSource=path.join(temporary,'input-editable-plus-blocking.xlsx');fs.writeFileSync(blockedSource,populatedInput('APP-BLOCKED','',returnWorkspaceId));
      const blockedDescriptor=runtime.importArtifact({featureId:'omnia.create-associate',featureVersion:'0.1.0',surfaceId:'create-associate.workbench',actionId:'import-source-workbook',accept:['.xlsx']},blockedSource);
      snapshot=await runtime.action({featureId:'omnia.create-associate',featureVersion:'0.1.0',surfaceId:'create-associate.workbench',actionId:'import-source-workbook',expectedStateVersion:snapshot.surface!.stateVersion,payload:{artifact:blockedDescriptor}},reviewContext);
      const blockedEditor=snapshot.surface!.editors![0]!;const blockingIssueId=crypto.randomUUID();
      database.db.prepare(`INSERT INTO feature_issues(issue_id,run_id,field_key,issue_type,state,message,resolution_revision_id,created_at,resolved_at) VALUES(?,?,?,'contract_mismatch','blocking','non-editable contract blocker','',?,'')`).run(blockingIssueId,blockedDescriptor.runId,'blocking.contract',new Date().toISOString());
      snapshot=await runtime.action({featureId:'omnia.create-associate',featureVersion:'0.1.0',surfaceId:'create-associate.workbench',actionId:'apply-revisions',expectedStateVersion:snapshot.surface!.stateVersion,payload:{revisions:[{issueId:blockedEditor.issueId,fieldKey:blockedEditor.fieldKey,expectedRevision:blockedEditor.expectedRevision,value:'Resolved editable value'}]}},reviewContext);
      assert.equal(snapshot.surface?.status,'blocked');assert.equal(snapshot.surface?.editors?.length,0);
      assert.equal(snapshot.surface?.actions.find((item)=>item.actionId==='import-source-workbook')?.enabled,true,'real source re-import must remain available when only a non-editable blocker remains');

      const reuseSource=path.join(temporary,'input-exact-reuse.xlsx'); fs.writeFileSync(reuseSource,populatedInput('APP-REAL-C','User supplied risk basis',returnWorkspaceId));
      const reuseDescriptor=runtime.importArtifact({featureId:'omnia.create-associate',featureVersion:'0.1.0',surfaceId:'create-associate.workbench',actionId:'import-source-workbook',accept:['.xlsx']},reuseSource);
      snapshot=await runtime.action({featureId:'omnia.create-associate',featureVersion:'0.1.0',surfaceId:'create-associate.workbench',actionId:'import-source-workbook',expectedStateVersion:snapshot.surface!.stateVersion,payload:{artifact:reuseDescriptor}},reviewContext);
      snapshot=await runtime.action({featureId:'omnia.create-associate',featureVersion:'0.1.0',surfaceId:'create-associate.workbench',actionId:'prepare-return',expectedStateVersion:snapshot.surface!.stateVersion,payload:{}},reviewContext);
      const reuseCard=snapshot.messageCards.at(-1)!;
      snapshot=await runtime.action({featureId:'omnia.create-associate',featureVersion:'0.1.0',surfaceId:'create-associate.workbench',actionId:'confirm-return',expectedStateVersion:reuseCard.stateVersion,payload:{runId:reuseCard.runId,confirmationId:reuseCard.confirmationId}},reviewContext);
      assert.equal(snapshot.messageCards.at(-1)?.state,'completed');
      assert.equal(objectCreateCalls,1,'exact reuse must not POST another IT Element');
      assert.equal(graCreateCalls,1,'exact reuse must not POST another GRA');

      const exerciseResponseLoss=async(mode:'applied'|'not_applied')=>{
        returnElementId=mode==='applied'?'APP-LOSS-APPLIED':'APP-LOSS-NOT-APPLIED';returnObjectExists=false;returnGraExists=false;objectCreateResponseLoss=mode;const beforeMutations=objectCreateCalls;
        const lostSource=path.join(temporary,`input-response-lost-${mode}.xlsx`);fs.writeFileSync(lostSource,populatedInput(returnElementId,'User supplied risk basis',returnWorkspaceId));
        const lostDescriptor=runtime.importArtifact({featureId:'omnia.create-associate',featureVersion:'0.1.0',surfaceId:'create-associate.workbench',actionId:'import-source-workbook',accept:['.xlsx']},lostSource);
        snapshot=await runtime.action({featureId:'omnia.create-associate',featureVersion:'0.1.0',surfaceId:'create-associate.workbench',actionId:'import-source-workbook',expectedStateVersion:snapshot.surface!.stateVersion,payload:{artifact:lostDescriptor}},reviewContext);
        snapshot=await runtime.action({featureId:'omnia.create-associate',featureVersion:'0.1.0',surfaceId:'create-associate.workbench',actionId:'prepare-return',expectedStateVersion:snapshot.surface!.stateVersion,payload:{}},reviewContext);const lostCard=snapshot.messageCards.at(-1)!;
        snapshot=await runtime.action({featureId:'omnia.create-associate',featureVersion:'0.1.0',surfaceId:'create-associate.workbench',actionId:'confirm-return',expectedStateVersion:lostCard.stateVersion,payload:{runId:lostCard.runId,confirmationId:lostCard.confirmationId}},reviewContext);
        const uncertainCard=snapshot.messageCards.at(-1)!;assert.equal(uncertainCard.state,'uncertain');assert.equal(snapshot.surface?.status,'stale');assert.equal(objectCreateCalls,beforeMutations+1);
        const durable=database.db.prepare(`SELECT r.state,c.state AS command_state FROM feature_runs r JOIN feature_commands c ON c.run_id=r.run_id WHERE r.run_id=? AND c.operation_id='omnia.create-associate.object.create.v1' ORDER BY c.created_at DESC LIMIT 1`).get(lostDescriptor.runId) as any;assert.equal(durable.state,'uncertain');assert.equal(durable.command_state,'uncertain');
        await runtime.disposeRuntime();await runtime.initializeRuntime();runtime.select('omnia.create-associate');snapshot=runtime.snapshot(reviewContext);const recovered=snapshot.messageCards.find((item)=>item.runId===lostDescriptor.runId&&item.state==='uncertain')!;assert.ok(recovered);
        snapshot=await runtime.action({featureId:'omnia.create-associate',featureVersion:'0.1.0',surfaceId:'create-associate.workbench',actionId:'reconcile-return',expectedStateVersion:recovered.stateVersion,payload:{runId:recovered.runId,confirmationId:recovered.confirmationId}},reviewContext);assert.equal(objectCreateCalls,beforeMutations+1,'read-only reconcile must not replay the mutation');assert.equal(snapshot.messageCards.at(-1)?.state,mode==='applied'?'executing':'failed');
        if(mode==='applied'){const continueCard=snapshot.messageCards.at(-1)!;snapshot=await runtime.action({featureId:'omnia.create-associate',featureVersion:'0.1.0',surfaceId:'create-associate.workbench',actionId:'continue-return',expectedStateVersion:continueCard.stateVersion,payload:{runId:continueCard.runId,confirmationId:continueCard.confirmationId}},reviewContext);assert.equal(objectCreateCalls,beforeMutations+1,'continuation after applied reconcile must not replay the reconciled object create');}
        else assert.equal((database.db.prepare(`SELECT state FROM feature_commands WHERE run_id=? AND operation_id='omnia.create-associate.object.create.v1' ORDER BY created_at DESC LIMIT 1`).get(lostDescriptor.runId) as any).state,'closed_not_applied');
      };
      await exerciseResponseLoss('applied');await exerciseResponseLoss('not_applied');

      returnElementId='APP-REAL-C';
      returnObjectExists=false; returnGraExists=false;
      const raceSource=path.join(temporary,'input-identity-race.xlsx'); fs.writeFileSync(raceSource,populatedInput('APP-REAL-C','User supplied risk basis',returnWorkspaceId));
      const raceDescriptor=runtime.importArtifact({featureId:'omnia.create-associate',featureVersion:'0.1.0',surfaceId:'create-associate.workbench',actionId:'import-source-workbook',accept:['.xlsx']},raceSource);
      snapshot=await runtime.action({featureId:'omnia.create-associate',featureVersion:'0.1.0',surfaceId:'create-associate.workbench',actionId:'import-source-workbook',expectedStateVersion:snapshot.surface!.stateVersion,payload:{artifact:raceDescriptor}},reviewContext);
      snapshot=await runtime.action({featureId:'omnia.create-associate',featureVersion:'0.1.0',surfaceId:'create-associate.workbench',actionId:'prepare-return',expectedStateVersion:snapshot.surface!.stateVersion,payload:{}},reviewContext);
      const raceCard=snapshot.messageCards.at(-1)!; assert.match(raceCard.details.map((item:any)=>item.value).join('\n'),/post-create-resolution/u);
      returnObjectExists=true;
      await assert.rejects(runtime.action({featureId:'omnia.create-associate',featureVersion:'0.1.0',surfaceId:'create-associate.workbench',actionId:'confirm-return',expectedStateVersion:raceCard.stateVersion,payload:{runId:raceCard.runId,confirmationId:raceCard.confirmationId}},reviewContext),/preflight changed/i);
      assert.equal(objectCreateCalls,3,'identity race after confirmation review must stop before another POST');

    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
    }
  } finally {
    await runtime.disposeRuntime();
    database.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('signed core Operations enforce exact IT Element, GRA, and relationship preflight/write/read identities', async () => {
  const host = new OperationHost();
  const operationPackage = JSON.parse(fs.readFileSync(operationPackagePath, 'utf8'));
  const engagementId = '11111111-1111-4111-8111-111111111111';
  const binding = { connectorId: 'connector-1', sessionGeneration: 4, engagementId, authorityInstanceId: 'authority-test', tenantOrOrgId: 'tenant-test', packId: 'pack-test' };
  const registration = host.register({
    schemaVersion: 'omnia.operation-registration/v1', featureId: 'omnia.create-associate',
    featureVersion: '0.1.0', operationPackage
  }, binding);
  const workspaceId = '22222222-2222-4222-8222-222222222222';
  const applicationId = '33333333-3333-4333-8333-333333333333';
  const infrastructureId = '44444444-4444-4444-8444-444444444444';
  const contentId = '66176475';
  const assessmentTypeId = '3';
  const graId = '77777777-7777-4777-8777-777777777777';
  const factorId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const riskId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const controlId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const riskScopeId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const calls: Array<{ stepId: string; method: string; path: string; body: any; commitStep: boolean }> = [];
  let factorValue = 1;
  let factorSpectrum = [{ value: 1, name: 'Lower' }, { value: 7, name: 'Higher' }];
  let documentation: any = { documentation: { editorData: '', plainText: '' }, workItems: [] };
  let evaluationStatus = 'EvaluationStarted';
  let riskControlAssociated = false;
  let riskControlDetailMode: 'exact' | 'missing_assertion' | 'wrong_assertion' | 'duplicate' = 'exact';
  let invalidHiddenValidation = false;
  let forceIncompletePagination = false;
  let crossPageDuplicate=false; let prematureTotal=false;
  let omitObjectType=false,graMissingType=false,relationWrongWorkspace=false;
  let settingsTypeId='old-type',settingsRelevant=true,settingsData=true;
  let authorityConflict = false;
  const invokeHttp = async (route: any, routePath: string, body: any, execution: any) => {
    calls.push({ stepId: route.stepId, method: route.method, path: routePath, body, commitStep: execution.commitStep });
    if (route.stepId === 'authority-hierarchy') return { children: [{ id: workspaceId, name: '20100 APP' }] };
    if (route.stepId === 'authority-sections') return [{ workspaceId, displayName: '20100 APP' }];
    if (route.stepId === 'authority-workspaces') return [{ facetId: workspaceId, name: '20100 APP' }, ...(authorityConflict ? [{ facetId: '23232323-2323-4323-8323-232323232323', name: '20100 APP' }] : [])];
    if (route.stepId === 'authority-gra-directory') return [{ inkContentId: contentId, typeId: assessmentTypeId, itElementTypeId: '66175343', contentName: 'SAP ECC', objectType: 'Application' }];
    if(route.stepId==='application-search'&&crossPageDuplicate){const page=Number(body.page);const fillers=Array.from({length:499},(_unused,index)=>({id:`${String(page*1000+index).padStart(8,'0')}-1111-4111-8111-111111111111`,number:`OTHER-${page}-${index}`,workspaceId,itElementType:'Application'}));return page===1?{results:[...fillers,{id:applicationId,number:'CROSS-PAGE',workspaceId,itElementType:'Application'}],totalResults:501}:{results:[{id:applicationId,number:'CROSS-PAGE',workspaceId,itElementType:'Application'}],totalResults:501};}
    if(route.stepId==='application-search'&&prematureTotal)return {results:[{id:applicationId,number:'PREMATURE',workspaceId,itElementType:'Application'}],totalResults:2};
    if (route.stepId === 'application-search') return forceIncompletePagination
      ? { results: Array.from({ length: 500 }, (_unused, index) => ({ id: `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`, number: `OTHER-${index}`, workspaceId, itElementType: 'Application' })) }
      : { results: [{ id: applicationId, number: 'APP-REAL', workspaceId, ...(omitObjectType?{}:{itElementType:'Application'}) }], totalResults: 1 };
    if (route.stepId === 'object-create') return { id: applicationId, workspaceId, itElementType: 'Application' };
    if (route.stepId === 'object-readback') return { id: applicationId, number: 'APP-REAL', workspaceId, ...(omitObjectType?{}:{itElementType:'Application'}), description: JSON.stringify({editorData:'<p>APP-REAL</p>',suggestionsData:[],trackChangesEnableFlagInEditor:false,plainText:'APP-REAL'}) };
    if(route.stepId==='object-settings-read')return{id:applicationId,number:'APP-REAL',workspaceId,itElementType:'Application',typeId:settingsTypeId,isRelevant:settingsRelevant,isDataAvailable:settingsData,concurrencyTabs:[{entityTabTypeId:501,updatedOn:'settings-v1'}]};
    if(route.stepId==='object-settings-patch'){settingsTypeId=body[0].value;settingsRelevant=body[1].value;settingsData=body[2].value;return{id:applicationId,number:'APP-REAL',workspaceId,typeId:settingsTypeId,isRelevant:settingsRelevant,isDataAvailable:settingsData};}
    if (route.stepId === 'applications-search') return { results: relationWrongWorkspace?[{id:applicationId,workspaceId:'66666666-6666-4666-8666-666666666666'}]:[], totalResults: relationWrongWorkspace?1:0 };
    if (route.stepId === 'infrastructures-search') return { results: relationWrongWorkspace?[{id:infrastructureId,workspaceId:'66666666-6666-4666-8666-666666666666'}]:[], totalResults: relationWrongWorkspace?1:0 };
    if (route.stepId === 'relation-associate') return { ok: true };
    if (route.stepId === 'gra-directory') return graMissingType?[{id:graId,entityId:applicationId,workspaceId,name:'GRA-APP-REAL'}]:[];
    if (route.stepId === 'gra-create') return { id: graId, workspaceId, type: 'Application' };
    if (route.stepId === 'gra-readback') return { id: graId, entityId: applicationId, workspaceId, name: 'GRA-APP-REAL', type: 'Application', inkContentId: contentId, typeId: assessmentTypeId, status: 'ContentPending' };
    if (route.stepId === 'gra-state-read' || route.stepId === 'evaluation-read') return { id: graId, workspaceId, status: evaluationStatus, itElementRaitConclusionLevelId: 'Higher', documentation };
    if (route.stepId === 'risk-factor-directory') return { riskFactors: [{ id: factorId, displayOrder: 2, applicable: true, riskLevel: { value: factorValue, name: factorValue === 1 ? 'Lower' : 'Higher' }, riskLevelSpectrum: factorSpectrum }] };
    if (route.stepId === 'risk-factor-patch') { factorValue = Number(body[0].value.value); return { id: factorId, riskLevel: body[0].value }; }
    if (route.stepId === 'documentation-read') return { id: graId, workspaceId, documentation };
    if (route.stepId === 'documentation-patch') { documentation = body[0].value; return { id: graId, workspaceId, documentation }; }
    if (route.stepId === 'evaluation-submit') { evaluationStatus = 'EvaluationComplete'; return { id: graId, workspaceId, status: evaluationStatus }; }
    if (route.stepId === 'risk-control-validation') return invalidHiddenValidation ? [{}] : [];
    if(route.stepId==='risk-catalog') return {results:[{riskId,riskRiskScopeId:riskScopeId,name:'Access Risk',riskClassification:'Higher',assertion:'Existence',updatedOn:'2026-08-03T00:00:00.000Z'}]};
    if(route.stepId==='control-catalog') return {results:[{controlId,name:'Access Control'}]};
    if (route.stepId === 'risk-control-associate') { riskControlAssociated = true; return { ok: true }; }
    if (route.stepId === 'risk-control-detail') {
      if (!riskControlAssociated) return { scopes: [] };
      const assertionRows = riskControlDetailMode === 'missing_assertion' ? []
        : [{ assertion: riskControlDetailMode === 'wrong_assertion' ? 'Completeness' : 'Existence' }];
      const scope = { riskId, controlId, riskScopeId, assertions: assertionRows };
      return { scopes: riskControlDetailMode === 'duplicate' ? [scope, structuredClone(scope)] : [scope] };
    }
    throw new Error(`Unexpected signed step ${route.stepId}`);
  };
  const invoke = (operationId: string, request: Record<string, unknown>, mutationAuthorized = false) => host.invoke({
    schemaVersion: 'omnia.operation-invocation/v1', featureId: 'omnia.create-associate', featureVersion: '0.1.0',
    operationId, request, operationPackageDigest: registration.packageDigest, mutationAuthorized
  }, binding, invokeHttp);
  const authority = await invoke('omnia.create-associate.authority.resolve.v1', {
    connectorBinding: binding, allowedWorkspaceIds: [workspaceId],
    query: { workspaceNames: ['20100 APP'], graContents: [{ contentName: 'SAP ECC', objectType: 'Application' }] }
  }) as any;
  assert.equal(authority.workspaces[0].workspaceId, workspaceId);
  authorityConflict = true;
  await assert.rejects(invoke('omnia.create-associate.authority.resolve.v1', {
    connectorBinding: binding, allowedWorkspaceIds: [workspaceId],
    query: { workspaceNames: ['20100 APP'], graContents: [{ contentName: 'SAP ECC', objectType: 'Application' }] }
  }), /multiple canonical GUIDs/);
  authorityConflict = false;
  const objectTarget = { targetIdentityKey: 'Application|APP-REAL', workspaceId };
  const objectPlan = 'a'.repeat(64);
  await invoke('omnia.create-associate.object.preflight.v1', {
    connectorBinding: binding, target: objectTarget, planDigest: objectPlan,
    query: { objectType: 'Application', externalId: 'APP-REAL', workspaceId }
  });
  await invoke('omnia.create-associate.object.create.v1', {
    connectorBinding: binding, target: objectTarget, planDigest: objectPlan,
    command: { commandId: '88888888-8888-4888-8888-888888888888', idempotencyKey: '1'.repeat(64), kind: 'create_object', payload: {
      name: 'APP-REAL', workspaceId, engagementId, number: 'APP-REAL', itElementType: 'Application', description: JSON.stringify({ editorData: '<p>APP-REAL</p>', suggestionsData: [], trackChangesEnableFlagInEditor: false, plainText: 'APP-REAL' })
    } }
  }, true);
  await invoke('omnia.create-associate.object.reconcile.v1', {
    connectorBinding: binding, target: objectTarget, objectId: applicationId, query: { externalId: 'APP-REAL', objectType: 'Application', description: JSON.stringify({ editorData: '<p>APP-REAL</p>', suggestionsData: [], trackChangesEnableFlagInEditor: false, plainText: 'APP-REAL' }) }
  });
  omitObjectType=true;
  assert.equal((await invoke('omnia.create-associate.object.preflight.v1',{connectorBinding:binding,target:{targetIdentityKey:'Application|APP-REAL|missing-type',workspaceId},planDigest:'7'.repeat(64),query:{objectType:'Application',externalId:'APP-REAL',workspaceId}}) as any).found,false);
  await assert.rejects(invoke('omnia.create-associate.object.reconcile.v1',{connectorBinding:binding,target:objectTarget,objectId:applicationId,query:{externalId:'APP-REAL',objectType:'Application',description:JSON.stringify({editorData:'<p>APP-REAL</p>',suggestionsData:[],trackChangesEnableFlagInEditor:false,plainText:'APP-REAL'})}}),/identity, type/);omitObjectType=false;
  const settingsTarget={targetIdentityKey:`ObjectSettings|${applicationId}`,workspaceId};
  const settingsBefore=await invoke('omnia.create-associate.object-settings.preflight.v1',{connectorBinding:binding,target:settingsTarget,planDigest:'1'.repeat(64),objectId:applicationId}) as any;
  assert.equal(settingsBefore.concurrencyTabs[0].updatedOn,'settings-v1');
  await invoke('omnia.create-associate.object-settings.patch.v1',{connectorBinding:binding,target:settingsTarget,planDigest:'1'.repeat(64),command:{commandId:'89898989-8989-4989-8989-898989898989',idempotencyKey:'9'.repeat(64),kind:'patch_object_settings',payload:{engagementId,workspaceId,objectId:applicationId,typeId:'66175343',isRelevant:false,isDataAvailable:false,concurrencyTabId:501,concurrencyTabUpdatedOn:'settings-v1'}}},true);
  assert.equal((await invoke('omnia.create-associate.object-settings.reconcile.v1',{connectorBinding:binding,target:settingsTarget,query:{objectId:applicationId,typeId:'66175343',isRelevant:false,isDataAvailable:false,number:'APP-REAL'}}) as any).verified,true);

  const relationTarget = { targetIdentityKey: `InfrastructureApplication|${infrastructureId}|${applicationId}`, workspaceId };
  const relationPlan = 'b'.repeat(64);
  const relationQuery = { associationType: 'InfrastructureApplication', itElementId: infrastructureId, associatingEntityId: applicationId, sourceWorkspaceId: workspaceId, targetWorkspaceId: workspaceId };
  await invoke('omnia.create-associate.relation.preflight.v1', { connectorBinding: binding, target: relationTarget, planDigest: relationPlan, query: relationQuery });
  relationWrongWorkspace=true;const wrongWorkspaceRelation=await invoke('omnia.create-associate.relation.preflight.v1',{connectorBinding:binding,target:{...relationTarget,targetIdentityKey:`${relationTarget.targetIdentityKey}|wrong-workspace`},planDigest:'6'.repeat(64),query:relationQuery}) as any;assert.equal(wrongWorkspaceRelation.associated,false);relationWrongWorkspace=false;
  await invoke('omnia.create-associate.relation.associate.v1', {
    connectorBinding: binding, target: relationTarget, planDigest: relationPlan,
    command: { commandId: '99999999-9999-4999-8999-999999999999', idempotencyKey: '2'.repeat(64), kind: 'associate_relation', payload: {
      ItElementId: infrastructureId, AssociatingEntityIds: [applicationId], associationType: 'InfrastructureApplication',
      ConcurrencyTabId: 602, workspaceId, engagementId
    } }
  }, true);

  const graTarget = { targetIdentityKey: `GRA|${applicationId}|GRA-APP-REAL`, workspaceId };
  const graPlan = 'c'.repeat(64);
  graMissingType=true;assert.equal((await invoke('omnia.create-associate.gra.preflight.v1',{connectorBinding:binding,target:{...graTarget,targetIdentityKey:`${graTarget.targetIdentityKey}|missing-type`},planDigest:'5'.repeat(64),query:{entityId:applicationId,itElementType:'Application',name:'GRA-APP-REAL',workspaceId}}) as any).found,false);graMissingType=false;
  await invoke('omnia.create-associate.gra.preflight.v1', {
    connectorBinding: binding, target: graTarget, planDigest: graPlan,
    query: { entityId: applicationId, itElementType: 'Application', name: 'GRA-APP-REAL', workspaceId }
  });
  await invoke('omnia.create-associate.gra.create.v1', {
    connectorBinding: binding, target: graTarget, planDigest: graPlan,
    command: { commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', idempotencyKey: '3'.repeat(64), kind: 'create_gra', payload: {
      inkContentId: contentId, typeId: assessmentTypeId, facetId: workspaceId, entityId: applicationId,
      name: 'GRA-APP-REAL', engagementId
    } }
  }, true);
  await invoke('omnia.create-associate.gra.reconcile.v1', { connectorBinding: binding, target: graTarget, riskAssessmentId: graId,
    query: { entityId: applicationId, name: 'GRA-APP-REAL', itElementType: 'Application', inkContentId: contentId, typeId: assessmentTypeId } });

  const factorTarget = { targetIdentityKey: `RiskFactor|${graId}|${factorId}`, workspaceId };
  await invoke('omnia.create-associate.risk-factor.preflight.v1', {
    connectorBinding: binding, target: factorTarget, planDigest: 'd'.repeat(64),
    query: { riskAssessmentId: graId, itemId: 'SAP_ECC.RF.DISPLAY_ORDER_02', selectionMode: 'Higher' }
  });
  await invoke('omnia.create-associate.risk-factor.patch.v1', {
    connectorBinding: binding, target: factorTarget, planDigest: 'd'.repeat(64),
    command: { commandId: '12121212-1212-4212-8212-121212121212', idempotencyKey: '4'.repeat(64), kind: 'patch_risk_factor', payload: {
      engagementId,workspaceId,riskAssessmentId:graId,itemId:'SAP_ECC.RF.DISPLAY_ORDER_02',selectionMode:'Higher',factorId,selectedValue:7,spectrumDigest:sha256(Buffer.from(canonicalJson(factorSpectrum)))
    } }
  }, true);
  assert.equal((await invoke('omnia.create-associate.risk-factor.reconcile.v1', {
    connectorBinding: binding, target: factorTarget, query: { riskAssessmentId: graId, itemId: 'SAP_ECC.RF.DISPLAY_ORDER_02', selectionMode: 'Higher' }
  }) as any).verified, true);
  await invoke('omnia.create-associate.risk-factor.preflight.v1',{connectorBinding:binding,target:factorTarget,planDigest:'d'.repeat(64),query:{riskAssessmentId:graId,itemId:'SAP_ECC.RF.DISPLAY_ORDER_02',selectionMode:'Higher'}});
  factorSpectrum=[{value:1,name:'Lower'},{value:8,name:'Higher'}];
  await assert.rejects(invoke('omnia.create-associate.risk-factor.patch.v1',{connectorBinding:binding,target:factorTarget,planDigest:'d'.repeat(64),command:{commandId:'abababab-abab-4bab-8bab-abababababab',idempotencyKey:'4'.repeat(64),kind:'patch_risk_factor',payload:{engagementId,workspaceId,riskAssessmentId:graId,itemId:'SAP_ECC.RF.DISPLAY_ORDER_02',selectionMode:'Higher',factorId,selectedValue:7,spectrumDigest:sha256(Buffer.from(canonicalJson([{value:1,name:'Lower'},{value:7,name:'Higher'}])))}}},true),/drifted after confirmation/);
  factorSpectrum = [{ value: 2, name: 'Medium' }, { value: 7, name: 'Higher' }];
  await assert.rejects(invoke('omnia.create-associate.risk-factor.preflight.v1', {
    connectorBinding: binding, target: { targetIdentityKey: `RiskFactor|${graId}|lower-no-one`, workspaceId },
    planDigest: '8'.repeat(64), query: { riskAssessmentId: graId, itemId: 'SAP_ECC.RF.DISPLAY_ORDER_02', selectionMode: 'Lower' }
  }), /absent or ambiguous/);
  factorSpectrum = [{ value: 1, name: 'Lower A' }, { value: 1, name: 'Lower B' }, { value: 7, name: 'Higher' }];
  await assert.rejects(invoke('omnia.create-associate.risk-factor.preflight.v1', {
    connectorBinding: binding, target: { targetIdentityKey: `RiskFactor|${graId}|lower-duplicate`, workspaceId },
    planDigest: '9'.repeat(64), query: { riskAssessmentId: graId, itemId: 'SAP_ECC.RF.DISPLAY_ORDER_02', selectionMode: 'Lower' }
  }), /absent or ambiguous/);
  factorSpectrum = [{ value: 1, name: 'Lower' }, { value: 7, name: 'Higher' }];

  const documentationTarget = { targetIdentityKey: `Documentation|${graId}`, workspaceId };
  await invoke('omnia.create-associate.documentation.preflight.v1', {
    connectorBinding: binding, target: documentationTarget, planDigest: 'e'.repeat(64), riskAssessmentId: graId
  });
  await invoke('omnia.create-associate.documentation.patch.v1', {
    connectorBinding: binding, target: documentationTarget, planDigest: 'e'.repeat(64),
    command: { commandId: '13131313-1313-4313-8313-131313131313', idempotencyKey: '5'.repeat(64), kind: 'patch_documentation', payload: {
      engagementId, workspaceId, riskAssessmentId: graId, editorData: '<p>Recorded basis</p>', plainText: 'Recorded basis'
    } }
  }, true);
  assert.equal((await invoke('omnia.create-associate.documentation.reconcile.v1', {
    connectorBinding: binding, target: documentationTarget,
    query: { riskAssessmentId: graId, editorData: '<p>Recorded basis</p>', plainText: 'Recorded basis' }
  }) as any).verified, true);

  const evaluationTarget = { targetIdentityKey: `Evaluation|${graId}`, workspaceId };
  await invoke('omnia.create-associate.evaluation.preflight.v1', {
    connectorBinding: binding, target: evaluationTarget, planDigest: 'f'.repeat(64), riskAssessmentId: graId
  });
  await invoke('omnia.create-associate.evaluation.submit.v1', {
    connectorBinding: binding, target: evaluationTarget, planDigest: 'f'.repeat(64),
    command: { commandId: '14141414-1414-4414-8414-141414141414', idempotencyKey: '6'.repeat(64), kind: 'submit_evaluation', payload: {
      engagementId, workspaceId, riskAssessmentId: graId
    } }
  }, true);
  assert.equal((await invoke('omnia.create-associate.evaluation.reconcile.v1', {
    connectorBinding: binding, target: evaluationTarget, riskAssessmentId: graId
  }) as any).verified, true);

  const riskControlTarget = { targetIdentityKey: `RiskControl|${riskId}|${controlId}|Existence`, workspaceId };
  await invoke('omnia.create-associate.risk-control.preflight.v1', {
    connectorBinding: binding, target: riskControlTarget, planDigest: '0'.repeat(64),
    query: { riskId, riskClassification: 'Higher', controlId }
  });
  await invoke('omnia.create-associate.risk-control.associate.v1', {
    connectorBinding: binding, target: riskControlTarget, planDigest: '0'.repeat(64),
    command: { commandId: '15151515-1515-4515-8515-151515151515', idempotencyKey: '7'.repeat(64), kind: 'associate_risk_control', payload: {
      engagementId,workspaceId,riskAssessmentId:graId,riskName:'Access Risk',controlName:'Access Control',riskClassification:'Higher',riskId,updatedOn:'2026-08-03T00:00:00.000Z',isPurgeControlHiddenData:false,
      controlRiskScopes: [{ controlId, riskScopeId, assertionType: 'Existence', riskId, assertions: [{ assertion: 'Existence' }] }]
    } }
  }, true);
  assert.equal((await invoke('omnia.create-associate.risk-control.reconcile.v1', {
    connectorBinding: binding, target: riskControlTarget, query: { riskRiskScopeId: riskScopeId, riskId, controlId, assertion: 'Existence' }
  }) as any).verified, true);
  for (const mode of ['missing_assertion', 'wrong_assertion', 'duplicate'] as const) {
    riskControlDetailMode = mode;
    assert.equal((await invoke('omnia.create-associate.risk-control.reconcile.v1', {
      connectorBinding: binding, target: riskControlTarget, query: { riskRiskScopeId: riskScopeId, riskId, controlId, assertion: 'Existence' }
    }) as any).verified, false);
  }
  riskControlDetailMode = 'exact';
  invalidHiddenValidation = true;
  await assert.rejects(invoke('omnia.create-associate.risk-control.preflight.v1', {
    connectorBinding: binding, target: { targetIdentityKey: `${riskControlTarget.targetIdentityKey}|invalid`, workspaceId },
    planDigest: '1'.repeat(64), query: { riskId, riskClassification: 'Higher', controlId }
  }), /not an interpretable array/);
  invalidHiddenValidation = false;
  crossPageDuplicate=true;
  await assert.rejects(invoke('omnia.create-associate.object.preflight.v1',{connectorBinding:binding,target:{targetIdentityKey:'Application|CROSS-PAGE',workspaceId},planDigest:'3'.repeat(64),query:{objectType:'Application',externalId:'CROSS-PAGE',workspaceId}}),/ambiguous exact identities across completed pages/);
  crossPageDuplicate=false; prematureTotal=true;
  await assert.rejects(invoke('omnia.create-associate.object.preflight.v1',{connectorBinding:binding,target:{targetIdentityKey:'Application|PREMATURE',workspaceId},planDigest:'4'.repeat(64),query:{objectType:'Application',externalId:'PREMATURE',workspaceId}}),/terminated before its reported total/);
  prematureTotal=false;
  forceIncompletePagination = true;
  await assert.rejects(invoke('omnia.create-associate.object.preflight.v1', {
    connectorBinding: binding, target: { targetIdentityKey: 'Application|NOT-FOUND', workspaceId },
    planDigest: '2'.repeat(64), query: { objectType: 'Application', externalId: 'NOT-FOUND', workspaceId }
  }), /exceeded the signed 20-page bound/);
  assert.deepEqual(structuredClone(calls.find((call) => call.stepId === 'application-search')?.body), {
    page: 1, pageSize: 500, filters: [], sortFields: [{ field: 'number', direction: 'asc' }]
  });
  assert.deepEqual(structuredClone(calls.find((call) => call.stepId === 'relation-associate')?.body), {
    ItElementId: infrastructureId, AssociatingEntityIds: [applicationId], associationType: 'InfrastructureApplication', ConcurrencyTabId: 602
  });
  assert.equal(calls.find((call) => call.stepId === 'object-create')?.commitStep, true);
  assert.equal(calls.find((call) => call.stepId === 'gra-create')?.commitStep, true);
  assert.deepEqual(structuredClone(calls.find((call) => call.stepId === 'risk-control-validation')?.body), {
    riskId, operation: 'AddAssociation', controlIds: [controlId]
  });
  assert.equal(calls.find((call) => call.stepId === 'risk-control-validation')?.path.includes(`riskId=${riskId}&operation=AddAssociation&riskClassification=Higher`), true);
  assert.deepEqual(structuredClone(calls.find((call) => call.stepId === 'evaluation-submit')?.body), {
    riskLevelOverride: true, isPurgeControlHiddenData: false, updateQM: false, accountContents: []
  });
});

test('Core Return store rejects forged verification, illegal transitions, authority drift, and incomplete success', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-return-store-'));
  const paths = resolveProductPaths(temporary); const database = new CoreDatabase(paths.database, cipher);
  new FeaturePackageManager(database.db, paths);
  const store = new FeatureRuntimeStore(database.db, paths); const context = { featureId: 'omnia.create-associate', featureVersion: '0.1.0', allowMutation: true };
  const runId = '51515151-5151-4151-8151-515151515151'; const workspaceId = '52525252-5252-4252-8252-525252525252';
  const engagementId = '53535353-5353-4353-8353-535353535353'; const planDigest = 'a'.repeat(64); const now = new Date().toISOString();
  const binding = { connectorId: 'connector-1', sessionGeneration: 7, engagementId, authorityInstanceId: 'authority-1', tenantOrOrgId: 'tenant-1', packId: 'pack-1' };
  const authorityDigest = sha256(Buffer.from(canonicalJson({ ...binding, workspaceIds: [workspaceId] })));
  activateCreateFixture(database);
  database.db.prepare(`UPDATE workspace_safety SET enabled=1,engagement_id=?,workspace_ids_json=?,state_version=2 WHERE singleton=1`).run(engagementId, JSON.stringify([workspaceId]));
  database.db.prepare(`INSERT INTO feature_runs(run_id,trace_id,feature_id,feature_version,engagement_id,state,state_revision,source_artifact_id,template_version_id,output_artifact_id,plan_digest,last_error,created_at,updated_at) VALUES(?,?,'omnia.create-associate','0.1.0',?,'returning',3,'','','',?,'',?,?)`)
    .run(runId, '54545454-5454-4454-8454-545454545454', engagementId, planDigest, now, now);
  database.db.prepare(`INSERT INTO feature_confirmations(confirmation_id,run_id,message_id,plan_digest,connector_id,session_generation,engagement_id,authority_instance_id,tenant_or_org_id,pack_id,safety_revision,credential_digest,preflight_digest,confirmation_token_digest,decision,actor_id,decision_at,consumed_command_id,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'approved','local-user',?,'',?,?)`)
    .run('55555555-5555-4555-8555-555555555555', runId, `return:${runId}`, planDigest, binding.connectorId, binding.sessionGeneration, engagementId, binding.authorityInstanceId, binding.tenantOrOrgId, binding.packId, 2, authorityDigest, 'b'.repeat(64), 'c'.repeat(64), now, '2099-01-01T00:00:00.000Z', now);
  const targetKey = 'object|row-1';
  const operationTargetIdentityKey='target-object-row-1';
  const evidenceOperationId='omnia.create-associate.object.reconcile.v1';
  database.db.prepare(`INSERT INTO managed_content_intents(intent_id,run_id,plan_digest,target_kind,target_key,intended_revision_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?,'frozen',?,?)`)
    .run('56565656-5656-4656-8656-565656565656',runId,planDigest,'object',targetKey,JSON.stringify({kind:'object',key:targetKey,workspace:workspaceId,objectType:'Application',externalId:'APP-1',description:'APP-1',disposition:'create',mutationOperationId:'omnia.create-associate.object.create.v1',operationTargetIdentityKey,evidenceOperationIds:[evidenceOperationId]}),now,now);
  try {
    const description=JSON.stringify({editorData:'<p>APP-1</p>',suggestionsData:[],trackChangesEnableFlagInEditor:false,plainText:'APP-1'}); const mutationRequest={name:'APP-1',number:'APP-1',workspaceId,itElementType:'Application',description};
    assert.throws(()=>store.call('prepareReturnCommand',{runId,planDigest,targetKind:'object',targetKey,operationId:'omnia.create-associate.object.create.v1',request:{...mutationRequest,number:'APP-DRIFT'},evidenceOperationIds:[evidenceOperationId],evidenceTargetIdentityKey:operationTargetIdentityKey,binding,workspaceIds:[workspaceId]},context),/commandIntentValid=false/);
    const command = store.call('prepareReturnCommand', { runId, planDigest, targetKind: 'object', targetKey, operationId: 'omnia.create-associate.object.create.v1', request: mutationRequest, evidenceOperationIds:[evidenceOperationId],evidenceTargetIdentityKey:operationTargetIdentityKey,binding, workspaceIds: [workspaceId] }, context) as any;
    const resumedCommand=store.call('prepareReturnCommand',{runId,planDigest,targetKind:'object',targetKey,operationId:'omnia.create-associate.object.create.v1',request:mutationRequest,evidenceOperationIds:[evidenceOperationId],evidenceTargetIdentityKey:operationTargetIdentityKey,binding,workspaceIds:[workspaceId]},context) as any;
    assert.equal(resumedCommand.commandId,command.commandId,'an exact prepared command must resume instead of creating or rejecting a duplicate');
    assert.equal((database.db.prepare(`SELECT COUNT(*) AS count FROM feature_commands WHERE intent_id=?`).get(command.intentId) as any).count,1);
    const competingRun='67676767-6767-4767-8767-676767676767',competingPlan='e'.repeat(64),competingIntent='68686868-6868-4868-8868-686868686868';
    database.db.prepare(`INSERT INTO feature_runs(run_id,trace_id,feature_id,feature_version,engagement_id,state,state_revision,source_artifact_id,template_version_id,output_artifact_id,plan_digest,last_error,created_at,updated_at) VALUES(?,?,'omnia.create-associate','0.1.0',?,'returning',3,'','','',?,'',?,?)`).run(competingRun,'69696969-6969-4969-8969-696969696969',engagementId,competingPlan,now,now);
    database.db.prepare(`INSERT INTO feature_confirmations(confirmation_id,run_id,message_id,plan_digest,connector_id,session_generation,engagement_id,authority_instance_id,tenant_or_org_id,pack_id,safety_revision,credential_digest,preflight_digest,confirmation_token_digest,decision,actor_id,decision_at,consumed_command_id,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'approved','local-user',?,'',?,?)`).run('70707070-7070-4070-8070-707070707070',competingRun,`return:${competingRun}`,competingPlan,binding.connectorId,binding.sessionGeneration,engagementId,binding.authorityInstanceId,binding.tenantOrOrgId,binding.packId,2,authorityDigest,'f'.repeat(64),'1'.repeat(64),now,'2099-01-01T00:00:00.000Z',now);
    database.db.prepare(`INSERT INTO managed_content_intents(intent_id,run_id,plan_digest,target_kind,target_key,intended_revision_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?,'frozen',?,?)`).run(competingIntent,competingRun,competingPlan,'object',targetKey,JSON.stringify({kind:'object',key:targetKey,workspace:workspaceId,objectType:'Application',externalId:'APP-1',description:'APP-1',disposition:'create',mutationOperationId:'omnia.create-associate.object.create.v1',operationTargetIdentityKey,evidenceOperationIds:[evidenceOperationId]}),now,now);
    assert.throws(()=>store.call('prepareReturnCommand',{runId:competingRun,planDigest:competingPlan,targetKind:'object',targetKey,operationId:'omnia.create-associate.object.create.v1',request:mutationRequest,evidenceOperationIds:[evidenceOperationId],evidenceTargetIdentityKey:operationTargetIdentityKey,binding,workspaceIds:[workspaceId]},context),/owns an active create mutation/);
    const staleKey='object|row-stale',staleIdentity='target-object-row-stale',staleRequest={...mutationRequest,name:'APP-STALE',number:'APP-STALE',description:JSON.stringify({editorData:'<p>APP-STALE</p>',suggestionsData:[],trackChangesEnableFlagInEditor:false,plainText:'APP-STALE'})};
    const staleIntent=()=>JSON.stringify({kind:'object',key:staleKey,workspace:workspaceId,objectType:'Application',externalId:'APP-STALE',description:'APP-STALE',disposition:'create',mutationOperationId:'omnia.create-associate.object.create.v1',operationTargetIdentityKey:staleIdentity,evidenceOperationIds:[evidenceOperationId]});
    database.db.prepare(`INSERT INTO managed_content_intents(intent_id,run_id,plan_digest,target_kind,target_key,intended_revision_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?,'frozen',?,?)`).run('71717171-7171-4171-8171-717171717171',runId,planDigest,'object',staleKey,staleIntent(),now,now);
    const staleA=store.call('prepareReturnCommand',{runId,planDigest,targetKind:'object',targetKey:staleKey,operationId:'omnia.create-associate.object.create.v1',request:staleRequest,evidenceOperationIds:[evidenceOperationId],evidenceTargetIdentityKey:staleIdentity,binding,workspaceIds:[workspaceId]},context) as any;
    database.db.prepare(`INSERT INTO managed_content_intents(intent_id,run_id,plan_digest,target_kind,target_key,intended_revision_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?,'frozen',?,?)`).run('72727272-7272-4272-8272-727272727272',competingRun,competingPlan,'object',staleKey,staleIntent(),now,now);
    database.db.prepare(`UPDATE feature_mutation_reservations SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE owner_command_id=?`).run(staleA.commandId);
    const staleB=store.call('prepareReturnCommand',{runId:competingRun,planDigest:competingPlan,targetKind:'object',targetKey:staleKey,operationId:'omnia.create-associate.object.create.v1',request:staleRequest,evidenceOperationIds:[evidenceOperationId],evidenceTargetIdentityKey:staleIdentity,binding,workspaceIds:[workspaceId]},context) as any;assert.ok(staleB.commandId);
    assert.throws(()=>store.call('recordReturnEvidence',{runId,commandId:staleA.commandId,evidenceType:'request',commandState:'submitted',payload:{}},context),/reservation was superseded/);
    assert.throws(() => store.call('recordReturnEvidence', { runId, commandId: command.commandId, evidenceType: 'readback', commandState: 'readback_verified', payload: {verified:true}, verified: true }, context), /trusted Operation receipt/);
    assert.throws(() => store.call('recordReturnEvidence', { runId, commandId: command.commandId, evidenceType: 'commit', commandState: 'committed', payload: {}, verified: true }, context), /Illegal Return command transition/);
    store.call('recordReturnEvidence', { runId, commandId: command.commandId, evidenceType: 'preflight', commandState: 'prepared', payload: {}, verified: true }, context);
    database.db.prepare(`UPDATE feature_mutation_reservations SET absence_receipt_id='fixture-authoritative-absence' WHERE owner_command_id=? AND lifecycle='active'`).run(command.commandId);
    store.call('recordReturnEvidence', { runId, commandId: command.commandId, evidenceType: 'request', commandState: 'submitted', payload: {}, verified: true }, context);
    store.call('recordReturnEvidence', { runId, commandId: command.commandId, evidenceType: 'commit', commandState: 'committed', payload: {}, verified: true }, context);
    const objectId='57575757-5757-4757-8757-575757575757';
    const readRequest={connectorBinding:binding,target:{targetIdentityKey:operationTargetIdentityKey,workspaceId},objectId,query:{externalId:'APP-1',objectType:'Application',description}};
    const frozenSpec=store.call('freezeReturnEvidenceSpec',{runId,commandId:command.commandId,operationId:evidenceOperationId,request:readRequest},context) as any;
    const response={id:objectId}; const responseJson=canonicalJson(response); const responseDigest=sha256(Buffer.from(responseJson));
    const insertReceipt=(receiptId:string,operationId:string,targetIdentity:string)=>database.db.prepare(`INSERT INTO feature_operation_receipts(receipt_id,run_id,command_id,feature_id,feature_version,operation_package_digest,operation_id,authority_digest,connector_id,session_generation,engagement_id,authority_instance_id,tenant_or_org_id,pack_id,frozen_target_key,target_identity_key,workspace_ids_json,plan_digest,request_digest,response_digest,response_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(receiptId,runId,command.commandId,'omnia.create-associate','0.1.0',`sha256:${'d'.repeat(64)}`,operationId,authorityDigest,binding.connectorId,binding.sessionGeneration,engagementId,binding.authorityInstanceId,binding.tenantOrOrgId,binding.packId,targetKey,targetIdentity,canonicalJson([workspaceId]),planDigest,frozenSpec.requestDigest,responseDigest,responseJson,now);
    const wrongTargetReceipt='60606060-6060-4060-8060-606060606060'; insertReceipt(wrongTargetReceipt,evidenceOperationId,'same-workspace-wrong-target');
    assert.throws(()=>store.call('recordReturnEvidence',{runId,commandId:command.commandId,evidenceType:'readback',commandState:'readback_verified',payload:{...response,__operationReceiptId:wrongTargetReceipt},receiptId:wrongTargetReceipt,verified:true},context),/trusted Operation receipt/);
    const wrongOperationReceipt='61616161-6161-4161-8161-616161616161'; insertReceipt(wrongOperationReceipt,'omnia.create-associate.gra.reconcile.v1',operationTargetIdentityKey);
    assert.throws(()=>store.call('recordReturnEvidence',{runId,commandId:command.commandId,evidenceType:'readback',commandState:'readback_verified',payload:{...response,__operationReceiptId:wrongOperationReceipt},receiptId:wrongOperationReceipt,verified:true},context),/trusted Operation receipt/);
    const validReceipt='62626262-6262-4262-8262-626262626262'; insertReceipt(validReceipt,evidenceOperationId,operationTargetIdentityKey);
    store.call('recordReturnEvidence', { runId, commandId: command.commandId, evidenceType: 'readback', commandState: 'readback_verified', payload: { ...response,__operationReceiptId:validReceipt }, receiptId:validReceipt,verified: true }, context);
    assert.throws(() => store.call('projectVerifiedReturn', { runId, commandId: command.commandId, binding, workspaceId: '58585858-5858-4858-8858-585858585858', projectionKind: 'object', objectType: 'Application', objectId: '57575757-5757-4757-8757-575757575757', payload: response }, context), /authority scope|intended target/);
    store.call('projectVerifiedReturn', { runId, commandId: command.commandId, binding, workspaceId, projectionKind: 'object', objectType: 'Application', objectId, payload: response }, context);
    database.db.prepare(`INSERT INTO managed_content_intents(intent_id,run_id,plan_digest,target_kind,target_key,intended_revision_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?,'frozen',?,?)`)
      .run('59595959-5959-4959-8959-595959595959', runId, planDigest, 'field', 'field|row-1', JSON.stringify({ kind: 'field', key: 'field|row-1', workspace: workspaceId, objectType: 'GRA' }), now, now);
    assert.throws(() => store.call('finishReturn', { runId, outcome: 'succeeded' }, context), /incomplete/);
  } finally { database.close(); fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('Return intent atomically freezes Run engagement and rejects rebinding',()=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'omnia-return-engagement-'));const paths=resolveProductPaths(temporary);const database=new CoreDatabase(paths.database,cipher);
  const store=new FeatureRuntimeStore(database.db,paths);const context={featureId:'omnia.create-associate',featureVersion:'0.1.0',allowMutation:false};
  const engagementId='81818181-8181-4181-8181-818181818181',workspaceId='82828282-8282-4282-8282-828282828282';
  const binding={connectorId:'connector-1',sessionGeneration:3,engagementId,authorityInstanceId:'authority-1',tenantOrOrgId:'tenant-1',packId:'pack-1'};
  const safetyLock={enabled:true,engagementId,workspaceIds:[workspaceId],stateVersion:2};
  const plan={schemaVersion:'omnia.create-associate.return-plan/v1',authority:{...binding,workspaces:[{name:'Workspace',workspaceId}],graContents:[]},targets:[{kind:'object',key:'object|row',workspace:workspaceId}]};
  const credentialDigest=sha256(Buffer.from(canonicalJson({...binding,workspaceIds:[workspaceId]})));const now=new Date().toISOString();
  const insertRun=(runId:string,frozenEngagement='')=>database.db.prepare(`INSERT INTO feature_runs(run_id,trace_id,feature_id,feature_version,engagement_id,state,state_revision,source_artifact_id,template_version_id,output_artifact_id,plan_digest,last_error,created_at,updated_at) VALUES(?,?,'omnia.create-associate','0.1.0',?,'ready_for_review',2,'','','','','',?,?)`).run(runId,crypto.randomUUID(),frozenEngagement,now,now);
  try{
    database.db.prepare(`UPDATE workspace_safety SET enabled=1,engagement_id=?,workspace_ids_json=?,state_version=2 WHERE singleton=1`).run(engagementId,JSON.stringify([workspaceId]));
    const runId='83838383-8383-4383-8383-838383838383';insertRun(runId);
    const prepared=store.call('prepareReturnIntent',{runId,plan,connectorBinding:binding,safetyLock,credentialDigest,preflightDigest:'a'.repeat(64)},context) as any;
    assert.equal((database.db.prepare(`SELECT engagement_id FROM feature_runs WHERE run_id=?`).get(runId) as any).engagement_id,engagementId);
    const frozen=database.db.prepare(`SELECT authority_instance_id,tenant_or_org_id,pack_id,engagement_id FROM feature_confirmations WHERE run_id=?`).get(runId) as any;
    assert.deepEqual({...frozen},{authority_instance_id:'authority-1',tenant_or_org_id:'tenant-1',pack_id:'pack-1',engagement_id:engagementId});
    const approval={confirmationId:prepared.confirmationId,confirmationToken:prepared.confirmationToken,expectedStateVersion:1,connectorBinding:binding,safetyLock};const mutationContext={...context,allowMutation:true};
    store.call('approveReturnIntent',approval,mutationContext);assert.throws(()=>store.call('approveReturnIntent',approval,mutationContext),/stale|invalid|changed/i);assert.equal((database.db.prepare(`SELECT COUNT(*) AS count FROM feature_run_events WHERE run_id=? AND event_type='return.confirmed_in_comments'`).get(runId) as any).count,1);
    const reboundRun='84848484-8484-4484-8484-848484848484';insertRun(reboundRun,'85858585-8585-4585-8585-858585858585');
    assert.throws(()=>store.call('prepareReturnIntent',{runId:reboundRun,plan:{...plan,runId:reboundRun},connectorBinding:binding,safetyLock,credentialDigest,preflightDigest:'b'.repeat(64)},context),/engagement differs/);
    assert.equal((database.db.prepare(`SELECT COUNT(*) AS count FROM feature_confirmations WHERE run_id=?`).get(reboundRun) as any).count,0);
  }finally{database.close();fs.rmSync(temporary,{recursive:true,force:true});}
});

test('latest Run selection is deterministic when timestamps tie',()=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'omnia-latest-run-'));const paths=resolveProductPaths(temporary);const database=new CoreDatabase(paths.database,cipher);const store=new FeatureRuntimeStore(database.db,paths);
  const timestamp='2026-08-03T00:00:00.000Z';const insert=(runId:string)=>database.db.prepare(`INSERT INTO feature_runs(run_id,trace_id,feature_id,feature_version,engagement_id,state,state_revision,source_artifact_id,template_version_id,output_artifact_id,plan_digest,last_error,created_at,updated_at) VALUES(?,?,'omnia.create-associate','0.1.0','','succeeded',1,'','','','','',?,?)`).run(runId,crypto.randomUUID(),timestamp,timestamp);
  try{insert('86868686-8686-4686-8686-868686868686');insert('87878787-8787-4787-8787-878787878787');const latest=store.call('loadLatestRun',{}, {featureId:'omnia.create-associate',featureVersion:'0.1.0',allowMutation:false}) as any;assert.equal(latest.run.run_id,'87878787-8787-4787-8787-878787878787');}
  finally{database.close();fs.rmSync(temporary,{recursive:true,force:true});}
});

test('Return crash recovery is monotonic and never replays a mutation',()=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'omnia-return-recovery-')); const paths=resolveProductPaths(temporary); const database=new CoreDatabase(paths.database,cipher);
  const store=new FeatureRuntimeStore(database.db,paths); const context={featureId:'omnia.create-associate',featureVersion:'0.1.0',allowMutation:false}; const now=new Date().toISOString();
  const runId='71717171-7171-4171-8171-717171717171',intentId='72727272-7272-4272-8272-727272727272',commandId='73737373-7373-4373-8373-737373737373';
  try{
    database.db.prepare(`INSERT INTO feature_runs(run_id,trace_id,feature_id,feature_version,engagement_id,state,state_revision,source_artifact_id,template_version_id,output_artifact_id,plan_digest,last_error,created_at,updated_at) VALUES(?,?,'omnia.create-associate','0.1.0',?,'returning',5,'','','',?,'',?,?)`).run(runId,'74747474-7474-4474-8474-747474747474','75757575-7575-4575-8575-757575757575','e'.repeat(64),now,now);
    database.db.prepare(`INSERT INTO feature_confirmations(confirmation_id,run_id,message_id,plan_digest,connector_id,session_generation,engagement_id,authority_instance_id,tenant_or_org_id,pack_id,safety_revision,credential_digest,preflight_digest,confirmation_token_digest,decision,actor_id,decision_at,consumed_command_id,expires_at,created_at) VALUES(?,?,?,?,?,1,?,?,?,?,1,?,?,?,'approved','local-user',?,'',?,?)`).run('76767676-7676-4676-8676-767676767676',runId,`return:${runId}`,'e'.repeat(64),'connector-1','75757575-7575-4575-8575-757575757575','authority-1','tenant-1','pack-1','f'.repeat(64),'a'.repeat(64),'b'.repeat(64),now,'2099-01-01T00:00:00.000Z',now);
    database.db.prepare(`INSERT INTO managed_content_intents(intent_id,run_id,plan_digest,target_kind,target_key,intended_revision_json,state,created_at,updated_at) VALUES(?,?,?,'object','object|row','{}','commanded',?,?)`).run(intentId,runId,'e'.repeat(64),now,now);
    database.db.prepare(`INSERT INTO feature_commands(command_id,run_id,intent_id,operation_id,idempotency_key,plan_digest,request_digest,evidence_operation_ids_json,evidence_target_identity_key,evidence_request_digest,state,commit_point_at,submitted_at,completed_at,last_error,created_at) VALUES(?,?,?,?,?,?,?,'[]','','','prepared','','','','',?)`).run(commandId,runId,intentId,'omnia.create-associate.object.create.v1','c'.repeat(64),'e'.repeat(64),'d'.repeat(64),now);
    const first=store.call('loadLatestRun',{},context) as any; assert.equal(first.run.state,'returning'); assert.equal(first.run.state_revision,6); assert.equal((database.db.prepare('SELECT state FROM feature_commands WHERE command_id=?').get(commandId) as any).state,'prepared');
    const second=store.call('loadLatestRun',{},context) as any; assert.equal(second.run.state_revision,6,'repeated health must not regress or repeatedly increment recovery revision');
    database.db.prepare("UPDATE feature_runs SET state='reconciling',state_revision=7,last_error='',updated_at=? WHERE run_id=?").run(new Date(Date.now()+1000).toISOString(),runId); database.db.prepare("UPDATE feature_commands SET state='uncertain' WHERE command_id=?").run(commandId);
    const reconciled=store.call('loadLatestRun',{},context) as any; assert.equal(reconciled.run.state,'uncertain'); assert.equal(reconciled.run.state_revision,8); assert.equal((database.db.prepare('SELECT state FROM feature_commands WHERE command_id=?').get(commandId) as any).state,'uncertain');
    const again=store.call('loadLatestRun',{},context) as any; assert.equal(again.run.state_revision,8);
  }finally{database.close();fs.rmSync(temporary,{recursive:true,force:true});}
});

test('offline crash recovery persists failed Run and restores a valid high-version Surface without replay',async()=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'omnia-offline-recovery-')); const paths=resolveProductPaths(temporary); const database=new CoreDatabase(paths.database,cipher);
  const recoveryHostEntrypoint=path.join(temporary,'feature-worker-host.cjs'); await build({entryPoints:[path.join(repository,'src/main/features/feature-worker-host.ts')],outfile:recoveryHostEntrypoint,bundle:true,platform:'node',format:'cjs',packages:'external',logLevel:'silent'});
  let connectorInvocations=0; const connector={registerOperation:async()=>({accepted:true}),invokeOperation:async()=>{connectorInvocations+=1;throw new Error('unexpected connector invoke');}} as any;
  let runtime:FeaturePackageManager|null=null;
  try{
    const installer=new FeaturePackageManager(database.db,paths); installer.install(featurePackagePath);
    runtime=new FeaturePackageManager(database.db,paths,undefined,{connector,workerHostEntrypoint:recoveryHostEntrypoint}); await runtime.initializeRuntime(); runtime.select('omnia.create-associate');
    const source=path.join(temporary,'interrupted.xlsx'); fs.writeFileSync(source,populatedInput('APP-RECOVERY'));
    const descriptor=runtime.importArtifact({featureId:'omnia.create-associate',featureVersion:'0.1.0',surfaceId:'create-associate.workbench',actionId:'import-source-workbook',accept:['.xlsx']},source);
    database.db.prepare(`UPDATE feature_runs SET state='processing',state_revision=7,updated_at=? WHERE run_id=?`).run(new Date().toISOString(),descriptor.runId);
    const high={...runtime.snapshot().surface!,stateVersion:20,status:'loading' as const,statusMessage:'persisted high-version offline stage'};
    database.db.prepare(`INSERT INTO feature_surface_states(feature_id,feature_version,surface_id,state_revision,payload_json,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(feature_id) DO UPDATE SET state_revision=excluded.state_revision,payload_json=excluded.payload_json,updated_at=excluded.updated_at`).run('omnia.create-associate','0.1.0','create-associate.workbench',20,JSON.stringify(high),new Date().toISOString());
    await runtime.disposeRuntime(); runtime=new FeaturePackageManager(database.db,paths,undefined,{connector,workerHostEntrypoint:recoveryHostEntrypoint}); await runtime.initializeRuntime(); runtime.select('omnia.create-associate');
    const recovered=runtime.snapshot().surface!; assert.equal(recovered.status,'stale'); assert.equal(recovered.stateVersion,21); assert.match(recovered.scopes[0]?.id||'',/^run:/u); assert.ok(recovered.items.every((item)=>item.scopeId===recovered.scopes[0]?.id)); assert.equal(recovered.items.at(-1)?.concurrencyToken,'8'); assert.match(recovered.statusMessage,/failed.*revision 8/u); assert.equal(recovered.actions.find((item)=>item.actionId==='import-source-workbook')?.enabled,true);
    const run=database.db.prepare(`SELECT state,state_revision FROM feature_runs WHERE run_id=?`).get(descriptor.runId) as any; assert.equal(run.state,'failed');assert.equal(run.state_revision,8);
    const event=database.db.prepare(`SELECT from_state,to_state,event_type,revision FROM feature_run_events WHERE run_id=? AND event_type='run.offline_crash_recovered'`).get(descriptor.runId) as any; assert.equal(event.from_state,'processing');assert.equal(event.to_state,'failed');assert.equal(event.event_type,'run.offline_crash_recovered');assert.equal(event.revision,8);
    await runtime.disposeRuntime(); runtime=new FeaturePackageManager(database.db,paths,undefined,{connector,workerHostEntrypoint:recoveryHostEntrypoint}); await runtime.initializeRuntime(); runtime.select('omnia.create-associate'); assert.equal(runtime.snapshot().surface?.stateVersion,21); assert.equal(connectorInvocations,0);
  }finally{if(runtime)await runtime.disposeRuntime();database.close();fs.rmSync(temporary,{recursive:true,force:true});}
});

test('mutation Worker timeout is non-retryable and terminates the isolated Worker',async()=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'omnia-mutation-timeout-'));const host=path.join(temporary,'host.cjs'),workerPath=path.join(temporary,'worker.cjs');
  await build({entryPoints:[path.join(repository,'src/main/features/feature-worker-host.ts')],outfile:host,bundle:true,platform:'node',format:'cjs',packages:'external',logLevel:'silent'});
  fs.writeFileSync(workerPath,"'use strict';exports.createFeatureWorker=()=>({handleAction:async()=>new Promise(()=>{})});");
  const supervisor=new FeatureWorkerSupervisor(host,workerPath,'omnia.create-associate','0.1.0',{connectorInvoke:async()=>null,storeCall:async()=>null,emitEvent:async()=>null});
  try{await assert.rejects(supervisor.invoke('handleAction',{}, {allowMutation:true,timeoutMs:25}),(error:any)=>error.code==='FEATURE.WORKER_TIMEOUT'&&error.retryable===false);assert.equal((supervisor as any).child,null);}
  finally{await supervisor.stop();fs.rmSync(temporary,{recursive:true,force:true});}
});

test('Create Associate signed package upgrades, preserves private plans and documentation projection, then rolls back',()=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'omnia-create-upgrade-'));const paths=resolveProductPaths(temporary);const database=new CoreDatabase(paths.database,cipher);const upgradePath=path.join(temporary,'create-associate-0.1.1.ofp');
  try{
    createUpgradePackage(upgradePath);const manager=new FeaturePackageManager(database.db,paths);const first=manager.install(featurePackagePath);
    const installedRoot=path.join(paths.data,...manager.list().find((item)=>item.featureId==='omnia.create-associate')!.packagePath.split('/'));const selfTestOutput=require('node:child_process').execFileSync(process.execPath,['tests/self-test.cjs'],{cwd:installedRoot,encoding:'utf8'});assert.match(selfTestOutput,/package self-test passed/u);
    const privateStore=new (require('node:sqlite').DatabaseSync)(path.join(paths.data,'features','omnia.create-associate','store.sqlite'));privateStore.prepare(`INSERT INTO create_associate_runtime_plans(plan_id,payload_json,updated_at) VALUES('upgrade-proof','{"value":1}',?)`).run(new Date().toISOString());privateStore.close();
    const upgraded=manager.install(upgradePath);assert.equal(upgraded.featureVersion,'0.1.1');assert.equal(upgraded.activationGeneration,first.activationGeneration+1);
    const projection=database.db.prepare(`SELECT h.feature_version,h.documentation_path,d.feature_version AS docs_version,d.physical_path FROM feature_activation_heads h JOIN documentation_registry d ON d.feature_id=h.feature_id AND d.feature_version=h.feature_version WHERE h.feature_id='omnia.create-associate'`).get() as any;assert.equal(projection.feature_version,'0.1.1');assert.equal(projection.docs_version,'0.1.1');assert.equal(projection.documentation_path,projection.physical_path);
    const preserved=new (require('node:sqlite').DatabaseSync)(path.join(paths.data,'features','omnia.create-associate','store.sqlite'));assert.equal(JSON.parse((preserved.prepare(`SELECT payload_json FROM create_associate_runtime_plans WHERE plan_id='upgrade-proof'`).get() as any).payload_json).value,1);preserved.close();
    const rolled=manager.rollback('omnia.create-associate','0.1.0');assert.equal(rolled.featureVersion,'0.1.0');assert.equal(manager.list().find((item)=>item.featureId==='omnia.create-associate')?.documentationPath,first.documentationPath);
  }finally{database.close();fs.rmSync(temporary,{recursive:true,force:true});}
});
