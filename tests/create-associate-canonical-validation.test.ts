import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { packageFile, verifyOfficialPackage } from '../src/main/features/official-package.ts';

const require = createRequire(import.meta.url);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const worker = require(path.join(repository, 'feature-packages/create-associate/source/middle/worker.cjs')) as {
  deriveGraName(elementId: string): string;
  parseUserWorkbook(bytes: Buffer, artifactId: string, governance: Record<string, unknown>): any;
  validationPresentation(parsed: Record<string, unknown>, live?: Record<string, unknown>): { progress: { items: Array<{ itemId: string; state: string }> } };
  recomputeLocalIssues(parsed: Record<string, unknown>): any[];
  reviewPresentation(parsed: Record<string, unknown>): any;
  reviewBlocked(parsed: Record<string, unknown>, live?: Record<string, unknown>): boolean;
  freezeAppDataAvailability(preExisting: boolean, authoritative: unknown, signedDefault: unknown): { disposition: string; value: boolean };
  resolveFrozenAppDataAvailability(preExisting: boolean, before: Record<string, unknown>, frozen: { disposition: string; value: boolean }): boolean;
  workflowSurface(latest: Record<string, unknown>): { currentStepId: string; steps: Array<{ stepId: string; state: string }> };
  normalizeRait(value: unknown): string;
  applicationIdentityRequest(elementId: string, workspaceId: string, rait: string): any;
  inspectApplicationIdentity(resolution: any, request: any): { accepted: boolean; disposition: string; reasonCode: string; objectId: string; riskAssessmentId: string };
  RETURN_OPERATIONS: Record<string, string>;
  zip(files: Record<string, string | Buffer>): Buffer;
};

const livePassed = {
  omnia_id_conflicts: { state: 'passed', reason: 'APP 身份与回收站状态已由签名 Operation 证明。' },
  relationship_targets: { state: 'passed', reason: '关系目标已实时验证。' },
  workspace_live: { state: 'passed', reason: '工作区已实时验证。' }
};

function parsedWith(issue?: { fieldKey: string; issueType: string; state: string; message: string }) {
  return {
    rows: [{ rowKey: 'DB:2', kind: 'DB', elementId: 'DB-1', fields: { Omnia工作区: '20100 APP' } }],
    candidates: [{ rowKey: 'DB:2', rawFieldKey: 'Omnia工作区', fieldKey: 'field.workspace', provenance: { rowKey: 'DB:2' } }],
    issues: issue ? [{ issueId: `issue-${issue.issueType}`, ...issue }] : []
  };
}

function states(parsed: Record<string, unknown>, live: Record<string, unknown> = livePassed) {
  return Object.fromEntries(worker.validationPresentation(parsed, live).progress.items.map((item) => [item.itemId, item.state]));
}
function withDescriptionRules(value:any):any {
  for(const kind of ['APP','DB','OS','TOOL']){const ruleId=kind==='APP'?'v8.app-description-from-element-id.v1':`v4.${kind.toLocaleLowerCase('en-US')}-description-from-element-id.v1`;if(!value.derivationRules.some((rule:any)=>rule.ruleId===ruleId))value.derivationRules.push({ruleId,targetFieldId:`P1.${kind}.IT.DESCRIPTION`,dependencyFieldId:`P1.${kind}.IT.ELEMENT_ID`,algorithm:'canonical_element_id',sourceTraceId:kind==='APP'?'SRC.IT元素.010':'v4:template-contract.js:phase1OfficialDerivedValues'});}
  return value;
}

function governance() {
  const envelope = verifyOfficialPackage(JSON.parse(fs.readFileSync(path.join(repository, 'feature-packages/create-associate/candidates/create-associate-0.2.0.ofp'), 'utf8')), 'omnia-feature');
  const value=withDescriptionRules(JSON.parse(packageFile(envelope, 'backend/governance.json').toString('utf8')));const declaration=value.fields.find((field:any)=>field.fieldId==='P1.APP.IT.IS_DATA_AVAILABLE');if(!value.derivationRules.some((rule:any)=>rule.ruleId==='v4.app-is-data-available-false.v1')){Object.assign(declaration,{defaultRuleId:'v4.app-is-data-available-false.v1',defaultValue:false});value.derivationRules.push({ruleId:'v4.app-is-data-available-false.v1',targetFieldId:declaration.fieldId,algorithm:'constant_boolean_false',constantValue:false,sourceTraceId:'v4:phase1:application:isDataAvailable=false'});}if(!value.derivationRules.some((rule:any)=>rule.ruleId==='v4.phase1-gra-name-from-element-id.v1'))value.derivationRules.push({ruleId:'v4.phase1-gra-name-from-element-id.v1',targetFieldId:'P1.RUNTIME.GRA.NAME',dependencyFieldId:'P1.RUNTIME.IT.ELEMENT_ID',algorithm:'prefix_literal',prefix:'GRA-',sourceTraceId:'v4:omnia-phase1.js:716'});return value;
}

function workbook(sections: Array<{ headers: string[]; values: string[] }>): Buffer {
  let rowNumber=1;const rows:string[]=[];const escape=(value:string)=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
  const append=(values:string[])=>{rows.push(`<row r="${rowNumber}">${values.map((value,index)=>`<c r="${String.fromCharCode(65+index)}${rowNumber}" t="inlineStr"><is><t>${escape(value)}</t></is></c>`).join('')}</row>`);rowNumber+=1;};
  for(const section of sections){append(section.headers);append(section.values);}
  return worker.zip({'[Content_Types].xml':'<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>','_rels/.rels':'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>','xl/workbook.xml':'<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Input" sheetId="1" r:id="rId1"/></sheets></workbook>','xl/_rels/workbook.xml.rels':'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>','xl/worksheets/sheet1.xml':`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join('')}</sheetData></worksheet>`});
}

test('canonical local check cards are isolated by semantic field key', () => {
  const vectors = [
    {
      name: 'identity duplicate',
      issue: { fieldKey: 'DB:2.identity', issueType: 'conflict', state: 'blocking', message: 'duplicate' },
      failed: ['unique_names']
    },
    {
      name: 'infrastructure RAIT inheritance conflict',
      issue: { fieldKey: 'DB:2.inheritance', issueType: 'conflict', state: 'blocking', message: 'rait conflict' },
      failed: ['infrastructure_rait']
    },
    {
      name: 'missing or ambiguous infrastructure link',
      issue: { fieldKey: 'DB:2.relations', issueType: 'ambiguous', state: 'blocking', message: 'relation missing' },
      failed: ['infrastructure_links']
    },
    {
      name: 'external live target failure',
      issue: { fieldKey: 'DB:2.relationship-target-live', issueType: 'ambiguous', state: 'blocking', message: 'live target missing' },
      live: { ...livePassed, relationship_targets: { state: 'failed', reason: 'live target missing' } },
      failed: ['relationship_targets']
    }
  ];
  for (const vector of vectors) {
    const result = states(parsedWith(vector.issue), vector.live || livePassed);
    assert.deepEqual(
      ['unique_names', 'infrastructure_links', 'infrastructure_rait', 'relationship_targets'].filter((id) => result[id] === 'failed'),
      vector.failed,
      vector.name
    );
  }
});

test('missing workspace intentionally fails required-fields and workspace-presence only', () => {
  const parsed = parsedWith({ fieldKey: 'field.workspace', issueType: 'missing', state: 'needs_input', message: 'workspace missing' });
  const result = states(parsed);
  assert.equal(result.required_fields, 'failed');
  assert.equal(result.workspace_presence, 'failed');
  assert.equal(result.unique_names, 'passed');
  assert.equal(result.infrastructure_links, 'passed');
  assert.equal(result.infrastructure_rait, 'passed');
});

test('canonical validation exposes exactly 11 checks and never treats unexecuted live checks as passed', () => {
  const items = worker.validationPresentation(parsedWith()).progress.items;
  assert.deepEqual(items.map((item) => item.itemId), [
    'template_structure', 'required_fields', 'valid_values', 'unique_names', 'omnia_id_conflicts',
    'infrastructure_links', 'infrastructure_rait', 'relationship_targets', 'workspace_presence',
    'factors_considered_ai_review', 'workspace_live'
  ]);
  const byId = Object.fromEntries(items.map((item) => [item.itemId, item.state]));
  assert.equal(byId.omnia_id_conflicts, 'pending');
  assert.equal(byId.relationship_targets, 'pending');
  assert.equal(byId.workspace_live, 'pending');
  assert.equal(byId.factors_considered_ai_review, 'skipped');
});

test('the real V3 copy has no user isDataAvailable contract and emits the signed internal false default', () => {
  const legacy = verifyOfficialPackage(JSON.parse(fs.readFileSync(path.join(repository, 'feature-packages/create-associate/candidates/create-associate-0.2.0.ofp'), 'utf8')), 'omnia-feature');
  const governance = withDescriptionRules(JSON.parse(packageFile(legacy, 'backend/governance.json').toString('utf8')));
  const declaration = governance.fields.find((field: any) => field.fieldId === 'P1.APP.IT.IS_DATA_AVAILABLE');
  declaration.defaultRuleId = 'v4.app-is-data-available-false.v1';
  declaration.defaultValue = false;
  governance.derivationRules.push({ ruleId: 'v4.app-is-data-available-false.v1', targetFieldId: declaration.fieldId, algorithm: 'constant_boolean_false', constantValue: false, sourceTraceId: 'v4:phase1:application:isDataAvailable=false' });
  governance.derivationRules.push({ ruleId: 'v4.phase1-gra-name-from-element-id.v1', targetFieldId: 'P1.RUNTIME.GRA.NAME', algorithm: 'prefix_literal', prefix: 'GRA-', sourceTraceId: 'v4:omnia-phase1.js:716' });

  const bytes = fs.readFileSync(path.join(repository, 'source_files/Phase1-用户填写模板V3 - 副本.xlsx'));
  const parsed = worker.parseUserWorkbook(bytes, 'real-v3-copy', governance);
  assert.equal(parsed.candidates.some((candidate: any) => candidate.rawFieldKey === 'isDataAvailable'), false);
  const internal = parsed.candidates.filter((candidate: any) => candidate.rawFieldKey === 'Derived Application Is Data Available');
  assert.ok(internal.length > 0);
  assert.ok(internal.every((candidate: any) => candidate.value === false && candidate.valueKind === 'rule_default'));
  assert.ok(internal.every((candidate: any) => candidate.provenance.derivationRule === 'v4.app-is-data-available-false.v1'));
  assert.equal(worker.deriveGraName('TEST-APP-SAP-ECC-1'), 'GRA-TEST-APP-SAP-ECC-1');
});

test('parser structural issues survive deterministic revalidation and every blocker fails a canonical check',()=>{
  const bytes=workbook([{headers:['系统ID','APP类型','System Risk Classification','Factors Considered','Omnia工作区','未知列'],values:['APP-STRUCT','Generic','Higher','basis','20100 APP','unmapped']}]);
  const first=worker.parseUserWorkbook(bytes,'artifact-run-a',governance());const parserIssue=first.issues.find((candidate:any)=>candidate.code==='PARSER.UNMAPPED_FIELD');assert.ok(parserIssue);worker.recomputeLocalIssues(first);worker.recomputeLocalIssues(first);
  const preserved=first.issues.filter((candidate:any)=>candidate.code==='PARSER.UNMAPPED_FIELD');assert.equal(preserved.length,1);assert.equal(preserved[0].issueId,parserIssue.issueId);const checkStates=states(first);for(const blocker of first.issues.filter((candidate:any)=>['needs_input','blocking'].includes(candidate.state)))assert.equal(checkStates[blocker.checkId||'template_structure'],'failed',blocker.code);
  const second=worker.parseUserWorkbook(bytes,'artifact-run-b',governance());worker.recomputeLocalIssues(second);assert.notEqual(second.issues.find((candidate:any)=>candidate.code==='PARSER.UNMAPPED_FIELD').issueId,parserIssue.issueId,'global issue PK must be namespaced by source Run artifact');
});

test('local Review enforces all declared field limits and legal element/GRA names',()=>{
  const parsed=worker.parseUserWorkbook(workbook([{headers:['系统ID','APP类型','System Risk Classification','Factors Considered','Omnia工作区'],values:['BAD/APP','Generic','Higher','x'.repeat(8001),'W'.repeat(201)]}]),'limits-run',governance());worker.recomputeLocalIssues(parsed);
  assert.ok(parsed.issues.some((candidate:any)=>candidate.code==='LOCAL.ILLEGAL_ELEMENT_NAME'));
  assert.ok(parsed.issues.filter((candidate:any)=>candidate.code==='LOCAL.FIELD_TOO_LONG').length>=2);
  assert.equal(states(parsed).valid_values,'failed');
});

test('0.2.1 Review fails closed for external/multiple/cross-workspace inheritance and Tool, while exclusion removes only the excluded blocker',()=>{
  const multiple=worker.parseUserWorkbook(workbook([
    {headers:['系统ID','APP类型','System Risk Classification','Factors Considered','Omnia工作区'],values:['APP-A','Generic','Higher','basis','WS-A']},
    {headers:['系统ID','APP类型','System Risk Classification','Factors Considered','Omnia工作区'],values:['APP-B','Generic','Higher','basis','WS-A']},
    {headers:['数据库ID','DB 类型','Omnia工作区','关联系统ID'],values:['DB-A','Generic','WS-A','APP-A;APP-B']}
  ]),'multiple-run',governance());worker.recomputeLocalIssues(multiple);assert.ok(multiple.issues.some((candidate:any)=>candidate.code==='LOCAL.EXACTLY_ONE_APP_REQUIRED'));assert.equal(states(multiple).infrastructure_links,'failed');
  const cross=worker.parseUserWorkbook(workbook([
    {headers:['系统ID','APP类型','System Risk Classification','Factors Considered','Omnia工作区'],values:['APP-A','Generic','Higher','basis','WS-A']},
    {headers:['数据库ID','DB 类型','Omnia工作区','关联系统ID'],values:['DB-A','Generic','WS-B','APP-A']}
  ]),'cross-run',governance());worker.recomputeLocalIssues(cross);assert.ok(cross.issues.some((candidate:any)=>candidate.code==='LOCAL.CROSS_WORKSPACE_INHERITANCE'));
  const external=worker.parseUserWorkbook(workbook([{headers:['数据库ID','DB 类型','Omnia工作区','关联系统ID'],values:['DB-A','Generic','WS-A','APP-EXTERNAL']}]),'external-run',governance());worker.recomputeLocalIssues(external);assert.ok(external.issues.some((candidate:any)=>candidate.code==='UNSUPPORTED.EXTERNAL_APP_REFERENCE'&&candidate.state==='blocking'));assert.equal(states(external).relationship_targets,'failed');
  const withTool=worker.parseUserWorkbook(workbook([
    {headers:['系统ID','APP类型','System Risk Classification','Factors Considered','Omnia工作区'],values:['APP-A','Generic','Higher','basis','WS-A']},
    {headers:['IT TOOL ID','Tool 类型','System Risk Classification','Omnia工作区'],values:['TOOL-A','工单工具','Higher','WS-A']}
  ]),'exclude-run',governance());worker.recomputeLocalIssues(withTool);const tool=withTool.rows.find((row:any)=>row.kind==='TOOL');assert.equal(states(withTool).omnia_id_conflicts,'failed');withTool.excludedRowKeys=[tool.rowKey];worker.recomputeLocalIssues(withTool);assert.equal(states(withTool).valid_values,'passed');assert.equal(withTool.issues.some((candidate:any)=>candidate.code==='UNSUPPORTED.TOOL_RETURN'),false);
});

test('all four Review kinds expose v4-derived readonly Description and excluded rows contribute no issueOrder entries',()=>{
  const parsed=worker.parseUserWorkbook(workbook([
    {headers:['系统ID','APP类型','System Risk Classification','Factors Considered','Omnia工作区'],values:['APP-DESC','Generic','Higher','basis','WS-A']},
    {headers:['数据库ID','DB 类型','Omnia工作区','关联系统ID'],values:['DB-DESC','Generic','WS-A','APP-DESC']},
    {headers:['服务器ID','OS 类型','Omnia工作区','关联系统ID'],values:['OS-DESC','Generic','WS-A','APP-DESC']},
    {headers:['IT TOOL ID','Tool 类型','System Risk Classification','Omnia工作区'],values:['TOOL-DESC','工单工具','Higher','WS-A']}
  ]),'description-run',governance());worker.recomputeLocalIssues(parsed);
  const review=worker.reviewPresentation(parsed);for(const row of parsed.rows){const description=review.fields.find((field:any)=>field.rowKey===row.rowKey&&field.label==='Description（派生）');assert.ok(description,`${row.kind} Description`);assert.equal(description.currentValue,row.elementId);assert.equal(description.inputKind,'readonly');assert.equal(description.editable,false);}
  const tool=parsed.rows.find((row:any)=>row.kind==='TOOL');parsed.excludedRowKeys=[tool.rowKey];parsed.issues.push({issueId:'excluded-tool-issue',origin:'local',code:'TEST',fieldKey:`${tool.rowKey}.identity`,issueType:'conflict',state:'blocking',message:'excluded'});
  assert.equal(worker.reviewPresentation(parsed).issueOrder.some((issue:any)=>issue.rowKey===tool.rowKey),false);
});

test('APP data availability freezes new false and preserves only a pre-existing authoritative boolean without execution drift',()=>{
  const created=worker.freezeAppDataAvailability(false,undefined,false);assert.deepEqual(created,{disposition:'signed_new_default_false',value:false});assert.equal(worker.resolveFrozenAppDataAvailability(false,{isDataAvailable:true},created),false,'new APP ignores post-create server default and applies signed false');
  const existing=worker.freezeAppDataAvailability(true,true,false);assert.deepEqual(existing,{disposition:'preserve_authoritative_existing',value:true});assert.equal(worker.resolveFrozenAppDataAvailability(true,{isDataAvailable:true},existing),true);
  assert.throws(()=>worker.resolveFrozenAppDataAvailability(true,{isDataAvailable:false},existing),/changed after Review/);
  assert.throws(()=>worker.resolveFrozenAppDataAvailability(false,{isDataAvailable:false},existing),/differs between Review and execution/);
});

test('APP identity query and create/resume/reuse/skip decisions are exact and recycle-bin skip remains blocking',()=>{
  const workspaceId='22222222-2222-4222-8222-222222222222';
  const objectId='33333333-3333-4333-8333-333333333333';
  const riskAssessmentId='44444444-4444-4444-8444-444444444444';
  const request=worker.applicationIdentityRequest(' APP-SAP-ECC ',workspaceId,' higher ');
  assert.deepEqual(request.query,{objectType:'Application',externalId:'APP-SAP-ECC',workspaceId,graName:'GRA-APP-SAP-ECC',rait:'Higher'});
  assert.equal(worker.RETURN_OPERATIONS.objectIdentityResolve,'omnia.create-associate.object.identity.resolve.v1');
  assert.equal(worker.RETURN_OPERATIONS.objectCreatePreflight,'omnia.create-associate.object.create-preflight.v2');
  assert.deepEqual(worker.inspectApplicationIdentity({found:false,matchState:'none',graState:'none',resolved:null,disposition:'create',reasonCode:'not_found'},request),{accepted:true,disposition:'create',reasonCode:'not_found',objectId:'',riskAssessmentId:''});
  assert.deepEqual(worker.inspectApplicationIdentity({found:true,matchState:'active',disposition:'resume',reasonCode:'exact_element_without_gra',resolved:{objectId,riskAssessmentId:'',workspaceId,graName:'GRA-APP-SAP-ECC',rait:'Higher'}},request),{accepted:true,disposition:'resume',reasonCode:'exact_element_without_gra',objectId,riskAssessmentId:''});
  assert.deepEqual(worker.inspectApplicationIdentity({found:true,matchState:'active',disposition:'reuse',reasonCode:'exact_existing_pair',resolved:{objectId,riskAssessmentId,workspaceId,graName:'GRA-APP-SAP-ECC',rait:'Higher'}},request),{accepted:true,disposition:'reuse',reasonCode:'exact_existing_pair',objectId,riskAssessmentId});
  const skipped=worker.inspectApplicationIdentity({disposition:'skip',reasonCode:'gra_in_recycle_bin'},request);assert.equal(skipped.accepted,false);
  const parsed=parsedWith({fieldKey:'DB:2.identity',issueType:'conflict',state:'blocking',message:`identity blocked: ${skipped.reasonCode}`}) as any;parsed.issues[0].checkId='omnia_id_conflicts';
  assert.equal(states(parsed).omnia_id_conflicts,'failed');assert.equal(worker.reviewBlocked(parsed,livePassed),true);
});

test('waiting_confirmation advances the workflow to Return without marking Return completed',()=>{
  const workflow=worker.workflowSurface({run:{run_id:'run-1',state:'waiting_confirmation',state_revision:8}});
  assert.equal(workflow.currentStepId,'return');
  assert.equal(workflow.steps.find((step)=>step.stepId==='validate')?.state,'completed');
  assert.equal(workflow.steps.find((step)=>step.stepId==='return')?.state,'current');
});

test('runtime template registry identity follows the installed signed Feature version',()=>{
  const source=fs.readFileSync(path.join(repository,'feature-packages/create-associate/source/middle/worker.cjs'),'utf8');
  assert.doesNotMatch(source,/runtime-template@0\.1\.0-candidate|version:\s*'0\.1\.0-candidate'/u);
  assert.match(source,/const templateVersion = FEATURE_VERSION;/u);
  assert.match(source,/runtime-template@\$\{templateVersion\}/u);
});
