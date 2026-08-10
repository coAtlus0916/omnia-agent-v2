import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const repository = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const { createOperationHandler } = require(path.join(repository,
  'feature-packages/create-associate/source/connector-capability/operation/handler.cjs')) as {
    createOperationHandler(): { run(operationId:string, request:any, sdk:any):Promise<any> };
  };
const worker = require(path.join(repository, 'feature-packages/create-associate/source/middle/worker.cjs')) as any;
function relationPrefix(kind:string, content:string) {
  if (kind === 'APP' && content === 'SAP S/4 HANA') return 'REL.APP.SAP_S4_HANA.';
  if (kind === 'DCNO') return 'REL.DCNO.NETWORK.';
  throw new Error(`Unsupported test relation family: ${kind}/${content}`);
}
function riskFieldPrefix(kind:string, content:string) {
  return relationPrefix(kind, content).replace(/^REL\./u, 'P1.RISK.');
}
function selectedRelations(relations:any[], kind:string, content:string, mode:'Higher'|'Lower') {
  return relations.filter((relation:any) => String(relation.relationId).startsWith(relationPrefix(kind, content))
    && String(relation[`catalogPresent${mode}`] || '').startsWith('Y'));
}

const engagementId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const riskAssessmentId = '33333333-3333-4333-8333-333333333333';
const riskId = '44444444-4444-4444-8444-444444444444';
const riskRiskScopeId = '55555555-5555-4555-8555-555555555555';
const riskScopeId = '66666666-6666-4666-8666-666666666666';

async function readCatalog(controlNumber:string, controlName = 'S/4 control') {
  const sdk = { binding: { engagementId }, invokeStep: async (stepId:string) => {
    if (stepId === 'risk-assessment-read') return {
      id: riskAssessmentId, workspaceId, updatedOn: '2026-08-06T16:13:23.000Z'
    };
    if (stepId === 'risk-catalog') return { plannedResponses: [{
      id: riskId, riskNumber: 'RAITCOR001-GRA-S4', riskRiskScopeId
    }] };
    if (stepId === 'risk-detail') return { planResponseRisk: [{
      id: riskId, riskNumber: 'RAITCOR001-GRA-S4', classificationType: 'Higher',
      riskRiskScopes: [{ id: riskRiskScopeId, riskScopeId, assertionType: '10005', assertions: ['10018'] }]
    }] };
    if (stepId === 'control-catalog') return { controls: [{
      id: '77777777-7777-4777-8777-777777777777', controlNumber, name: controlName
    }] };
    throw new Error(`Unexpected step ${stepId}`);
  } };
  return createOperationHandler().run('omnia.create-associate.risk-control.catalog.v1', {
    target: { targetIdentityKey: 's4-catalog', workspaceId }, riskAssessmentId
  }, sdk);
}

test('signed catalog boundary preserves arbitrary structured family prefixes without product-name branches', async () => {
  const fixtures = new Map([
    ['FAMILYA.01 - GRA-A', 'FAMILYA.01'],
    ['Family B.001｜display', 'FAMILYB.01'],
    ['FAMILY_C-01: display', 'FAMILYC.01'],
    ['SAPS4HANA.01 - GRA-S4', 'SAPS4HANA.01']
  ]);
  for (const [liveNumber, expected] of fixtures) {
    const catalog = await readCatalog(liveNumber);
    assert.equal(catalog.controls[0].controlNumber, expected, liveNumber);
  }
  assert.equal((await readCatalog('TOOL.05 - GRA-TOOL')).controls[0].controlNumber, 'TOOL.05');
});

test('catalog boundary canonicalizes only provable live numbers and S/4 requires its signed exact number', async () => {
  for (const liveNumber of [
    'SAP S/4 HANA．001｜display',
    'SAP-S4-HANA-01: display'
  ]) {
    const catalog = await readCatalog(liveNumber);
    assert.equal(catalog.controls[0].controlNumber, 'SAPS4HANA.01', liveNumber);
  }

  const description = 'Only authorized users have access to update the batch jobs in SAP.';
  const catalog = await readCatalog('Control 15', description);
  assert.equal(catalog.controls[0].controlNumber, '',
    'an unprovable display value must not masquerade as a stable catalog number');
  assert.equal(catalog.controls[0].name, description);
  assert.deepEqual(catalog.diagnostics.controlIdentitySamples, [{controlNumber:'Control 15', name:description}]);

  const sensitive = await readCatalog('Bearer live-secret',
    'password=hidden 99999999-9999-4999-8999-999999999999');
  assert.deepEqual(sensitive.diagnostics.controlIdentitySamples, [{
    controlNumber:'[redacted-credential]', name:'[redacted-credential] [redacted-id]'
  }]);
  assert.equal(JSON.stringify(sensitive.diagnostics).includes('live-secret'), false);
  assert.equal(JSON.stringify(sensitive.diagnostics).includes('99999999-9999-4999-8999-999999999999'), false);

  const relation = {
    relationId:'REL.APP.SAP_S4_HANA.RAITCOR011.SAPS4_15', riskName:'RAITCOR001｜S/4 risk',
    controlName:`SAPS4.15｜${description}`, classificationHigher:'Higher',
    catalogIdentityRequired:true, catalogControlNumber:'SAPS4.15', catalogIdentityStatus:'signed_live_exact',
    catalogIdentityEvidence:{evidenceRef:'recording:34ea8734', sourceTraceId:'S4HANA.RECORDING.34ea8734.CONTROL.97f3f0a3'}
  };
  assert.equal(worker.unresolvedCatalogRelations(catalog, [relation], 'Higher').length, 1,
    'S/4 must not fall back to an exact description when its signed live number is absent');

  const exact = await readCatalog('SAPS4.15 - live', description);
  assert.deepEqual(worker.unresolvedCatalogRelations(exact, [relation], 'Higher'), []);
  assert.equal(worker.unresolvedCatalogRelations({ ...exact, controls: [
    exact.controls[0],
    { ...exact.controls[0], controlId:'99999999-9999-4999-8999-999999999999' }
  ] }, [relation], 'Higher').length, 1,
  'duplicate exact live numbers must remain unresolved');
});

test('managed workbook uses one exact S/4 HANA catalog with mode-specific 18/17 links', () => {
  const parsed = worker.parseV8(fs.readFileSync(path.join(repository,
    'feature-packages/create-associate/source/managed/phase1-system-information-v8.xlsx')));
  const relations = parsed.relations.map((row:any) => ({
    relationId: row.values.relation_id,
    objectType: row.values['适用场景/对象类型'],
    catalogPresentHigher: row.values.catalog_present_higher,
    catalogPresentLower: row.values.catalog_present_lower,
    linkRequiredHigher: row.values.link_required_higher,
    linkRequiredLower: row.values.link_required_lower
  }));
  const required = (mode:'Higher'|'Lower') => relations.filter((relation:any) =>
    String(relation.relationId).startsWith(relationPrefix('APP', 'SAP S/4 HANA'))
      && String(relation[`catalogPresent${mode}`] || '').startsWith('Y')
      && relation[`linkRequired${mode}`] === 'Y');
  const higher = required('Higher');
  const lower = required('Lower');
  assert.equal(higher.length, 18);
  assert.equal(lower.length, 17);
  assert.ok(higher.every((item:any) => item.relationId.startsWith('REL.APP.SAP_S4_HANA.')));
  assert.equal(higher.some((item:any) => /\.SAP_\d+$/u.test(item.relationId)), false,
    'legacy SAP.xx identities must not survive as guessed S/4 mappings');
  assert.deepEqual(new Set(higher.map((item:any) => item.relationId.split('.').at(-1)?.split('_')[0])),
    new Set(['SAPS4']));
  assert.ok(relations.filter((item:any) => item.relationId.startsWith('REL.APP.SAP_S4_HANA.'))
    .every((item:any) => item.catalogPresentHigher === 'Y' && item.catalogPresentLower === 'Y'));
});

test('signed S/4 registry retains all 30 observed identities and resolves the 18 required Higher links', () => {
  const parsed = worker.parseV8(fs.readFileSync(path.join(repository,
    'feature-packages/create-associate/source/managed/phase1-system-information-v8.xlsx')));
  const registry = JSON.parse(fs.readFileSync(path.join(repository,
    'feature-packages/create-associate/source/managed/risk-control-catalog-identities.json'), 'utf8'));
  const family = registry.families.find((item:any) => item.relationIdPrefix === 'REL.APP.SAP_S4_HANA.');
  assert.equal(family.status, 'signed_live_exact');
  assert.equal(family.identities.length, 30);
  const identities = new Map(family.identities.map((item:any) => [item.relationId, item]));
  const sourceRows = parsed.relations.filter((row:any) =>
    String(row.values.relation_id).startsWith('REL.APP.SAP_S4_HANA.'));
  const relations = sourceRows.map((row:any) => {
    const identity:any = identities.get(row.values.relation_id);
    assert.ok(identity, row.values.relation_id);
    return {
    relationId: row.values.relation_id,
    catalogPresentHigher: row.values.catalog_present_higher,
    catalogPresentLower: row.values.catalog_present_lower,
    linkRequiredHigher: row.values.link_required_higher,
    linkRequiredLower: row.values.link_required_lower,
    classificationHigher: row.values.classification_higher,
    classificationLower: row.values.classification_lower,
    riskName: row.values['Risk标准名'],
    controlName: row.values['Control标准名'],
    catalogIdentityRequired: true,
    catalogControlNumber: identity.catalogControlNumber,
    catalogIdentityStatus: family.status,
    catalogIdentityEvidence: {evidenceRef:identity.evidenceRef, sourceTraceId:identity.sourceTraceId}
  };});
  const higher = selectedRelations(relations, 'APP', 'SAP S/4 HANA', 'Higher')
    .filter((item:any) => item.linkRequiredHigher === 'Y');
  const riskNumbers = [...new Set(higher.map((item:any) => String(item.riskName).split(/[｜|]/u, 1)[0]))];
  const risks = riskNumbers.map((riskNumber, index) => ({
    riskId:`risk-${index + 1}`, riskNumber, name:riskNumber, classification:'Higher'
  }));
  const controls = higher.map((item:any, index) => ({
    controlId:`control-${String(index + 1).padStart(2, '0')}`,
    controlNumber:item.catalogControlNumber,
    name:item.controlName
  }));
  assert.equal(higher.length, 18);
  assert.equal(risks.length, 4);
  assert.deepEqual(worker.catalogIdentityEvidenceGaps(higher), []);
  assert.deepEqual(worker.unresolvedCatalogRelations({risks, controls}, higher, 'Higher'), []);

  const driftedControls = controls.map((item:any, index) => index === 0
    ? {...item, controlNumber:'SAPS4.99', name:higher[0].controlName}
    : item);
  assert.deepEqual(worker.unresolvedCatalogRelations({risks, controls:driftedControls}, higher, 'Higher')
    .map((item:any) => item.relationId), [higher[0].relationId],
  'a matching description must not conceal an exact live Control-number drift');
});

test('risk classification is derived per Risk and writes ClassificationNA when the selected mode has zero links', () => {
  const parsed = worker.parseV8(fs.readFileSync(path.join(repository,
    'feature-packages/create-associate/source/managed/phase1-system-information-v8.xlsx')));
  const governance = {
    fields: parsed.fields.map((row:any) => ({
      fieldId:row.values.field_id,
      label:row.values['Omnia UI标准字段名'],
      higherApplicable:row.values['Higher适用'],
      lowerApplicable:row.values['Lower适用']
    })),
    relations: parsed.relations.map((row:any) => ({
      relationId:row.values.relation_id,
      riskFieldId:row.values.risk_field_id,
      riskName:row.values['Risk标准名'],
      catalogPresentHigher:row.values.catalog_present_higher,
      catalogPresentLower:row.values.catalog_present_lower,
      linkRequiredHigher:row.values.link_required_higher,
      linkRequiredLower:row.values.link_required_lower,
      classificationHigher:row.values.classification_higher,
      classificationLower:row.values.classification_lower
    }))
  };
  const classify = (kind:string, content:string, mode:'Higher'|'Lower') => {
    const selected=selectedRelations(governance.relations,kind,content,mode);
    const fields=governance.fields.filter((field:any)=>String(field.fieldId).startsWith(riskFieldPrefix(kind,content)));
    return new Map(fields.map((field:any)=>{
      const riskNumber=String(field.fieldId).split('.').at(-1);
      const relations=selected.filter((relation:any)=>relation.riskFieldId===field.fieldId);
      const classification=relations.some((relation:any)=>relation[`linkRequired${mode}`]==='Y')?mode:'ClassificationNA';
      assert.ok(relations.every((relation:any)=>relation[`classification${mode}`]===classification));
      return[riskNumber,classification];
    }));
  };
  assert.deepEqual(Object.fromEntries(classify('APP','SAP S/4 HANA','Higher')), {
    RAITCOR011:'Higher',RAITCOR001:'Higher',RAITCOR003:'Higher',RAITCOR004:'Higher',RAITCOR007:'ClassificationNA'
  });
  assert.deepEqual(Object.fromEntries(classify('APP','SAP S/4 HANA','Lower')), {
    RAITCOR011:'Lower',RAITCOR001:'Lower',RAITCOR003:'Lower',RAITCOR004:'Lower',RAITCOR007:'ClassificationNA'
  });
  assert.deepEqual(Object.fromEntries(classify('DCNO','网络','Higher')), {
    RAITCOR001:'ClassificationNA',RAITCOR008:'Higher',RAITCOR006:'Higher'
  });
  assert.deepEqual(Object.fromEntries(classify('DCNO','网络','Lower')), {
    RAITCOR001:'ClassificationNA',RAITCOR008:'Lower',RAITCOR006:'Lower'
  });
});

test('Tool dependency isolation is attempt-scoped and exact reconcile never treats a missing link as applied', async () => {
  const app = { rowKey:'app-row', dependencyRowKeys:[], stageNodes:['object'], capabilities:{ object:true } };
  const tool = { rowKey:'tool-row', dependencyRowKeys:['app-row'], stageNodes:['object','relation'],
    capabilities:{ object:true, relation:true } };
  const graph = worker.buildFrozenDependencyGraph([app, tool]);
  const toolNode = graph.find((item:any) => item.id === 'tool-row');
  assert.equal(worker.dependencyBlockedByFailure(toolNode, new Set(['app-row'])), true);
  assert.equal(worker.dependencyBlockedByFailure(toolNode, new Set()), false,
    'a fresh continuation must not persist the prior attempt failure set');

  const request = { target:{ targetIdentityKey:'tool-ticket-reconcile', workspaceId }, query:{
    riskRiskScopeId, riskScopeId, riskId,
    controlId:'77777777-7777-4777-8777-777777777777', assertionType:'10005', assertion:'10018'
  } };
  const result = await createOperationHandler().run('omnia.create-associate.risk-control.reconcile.v1', request, {
    binding:{ engagementId }, invokeStep:async(stepId:string) => {
      assert.equal(stepId, 'risk-control-detail');
      return { planResponseSelectedControl:[] };
    }
  });
  assert.equal(result.verified, false);
});
