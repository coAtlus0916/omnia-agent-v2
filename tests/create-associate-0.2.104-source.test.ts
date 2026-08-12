import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const repository = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const sourceRoot = path.join(repository, 'feature-packages', 'create-associate', 'source');
const packageScriptPath = path.join(repository, 'scripts', 'package-create-associate-feature.mjs');
const packageScript = fs.readFileSync(packageScriptPath, 'utf8');
const workerPath = path.join(sourceRoot, 'middle', 'worker.cjs');
const bridgePath = path.join(sourceRoot, 'middle', 'create-associate-python-bridge.cjs');
const enginePath = path.join(sourceRoot, 'python', 'create-associate-engine.py');
const worker = require(workerPath) as { parseV8(bytes: Buffer): { relations: Array<{ values: Record<string, unknown> }> } };
const { createOperationHandler } = require(path.join(sourceRoot, 'connector-capability', 'operation', 'handler.cjs')) as {
  createOperationHandler(): { run(operationId: string, request: unknown, sdk: unknown): Promise<any> };
};

const EXPECTED_STORE_PORTS = [
  'approveReturnIntent', 'authorizeLegacyReturnRecovery', 'closeLegacyPartialReturn', 'commitPythonOutputHandle',
  'commitReviewValidation', 'createPythonJsonInputHandle', 'createPythonOutputHandle', 'finishReturn',
  'freezeReturnEvidenceSpec', 'inspectLegacyReturnRecovery', 'loadLatestRun', 'loadPlan', 'loadReturnProgress',
  'loadReturnReconcileSpec', 'openPythonArtifactHandle', 'prepareReturnCommand', 'prepareReturnIntent',
  'projectVerifiedReturn', 'proveOwnedCreatedObject', 'readArtifactBytes', 'readPythonJsonHandle',
  'recordBootstrapCapabilityEvidence', 'recordFieldRevisions', 'recordIssues', 'recordLegacyReturnRecoveryOutcome',
  'recordReturnEvidence', 'recordTemplateMetadata', 'releasePythonArtifactHandles', 'restartRun',
  'returnRunToReview', 'savePlan', 'saveReturnReconcileSpec', 'transitionRun', 'validateReturnAuthority'
].sort();

function actualStorePorts(): string[] {
  const source = `${fs.readFileSync(workerPath, 'utf8')}\n${fs.readFileSync(bridgePath, 'utf8')}`;
  const actual = new Set<string>();
  for (const match of source.matchAll(/(?:ports\.)?store\.call\(\s*['"]([A-Za-z][A-Za-z0-9]*)['"]/gu)) {
    actual.add(match[1]!);
  }
  const convenience: Readonly<Record<string, string>> = {
    append: 'appendEvidence', appendEvidence: 'appendEvidence', upsertManagedContent: 'upsertManagedContent',
    savePlan: 'savePlan', loadPlan: 'loadPlan'
  };
  for (const match of source.matchAll(/(?:ports\.)?store\.(append|appendEvidence|upsertManagedContent|savePlan|loadPlan)\s*\(/gu)) {
    actual.add(convenience[match[1]!]!);
  }
  return [...actual].sort();
}

function declaredStorePorts(): string[] {
  const block = packageScript.match(/storePorts\s*:\s*\[([\s\S]*?)\]/u)?.[1] || '';
  return [...block.matchAll(/['"]([A-Za-z][A-Za-z0-9]*)['"]/gu)].map((match) => match[1]!).sort();
}

test('0.2.110/112 is the live-accepted AD, code-migration and return-performance source boundary', () => {
  assert.match(packageScript, /const version = '0\.2\.110'; const sequence = 112;/u);
  assert.match(packageScript, /bridgePath:'middle\/create-associate-python-bridge\.cjs'/u);
  assert.match(packageScript, /entryPath:'python\/create-associate-engine\.py'/u);
  assert.equal(fs.statSync(bridgePath).isFile(), true);
  assert.equal(fs.statSync(enginePath).isFile(), true);
  assert.equal(fs.existsSync(path.join(sourceRoot, 'middle', 'python-bridge.cjs')), false);
  assert.equal(fs.existsSync(path.join(sourceRoot, 'python', 'engine.py')), false);
});

test('0.2.110 declares the exact 34 Store ports called by its isolated Worker and bridge', () => {
  assert.equal(EXPECTED_STORE_PORTS.length, 34);
  assert.deepEqual(actualStorePorts(), EXPECTED_STORE_PORTS);
  assert.deepEqual(declaredStorePorts(), EXPECTED_STORE_PORTS);
});

test('current Create navigation is one real leaf under the signed IT Elements group', () => {
  assert.match(packageScript,
    /groups: \[\{ id: 'it-elements', parentId: null, level: 1, label: 'IT元素', order: 10 \}\]/u);
  assert.match(packageScript,
    /leaves: \[\{ id: 'create-associate', parentId: 'it-elements', level: 2, label: '新建与关联', order: 10,/u);
});

test('Oracle EBS source governance freezes exact 12/11/7 relations, OEBS.04 dual absence, and Lower NA risks', () => {
  const parsed = worker.parseV8(fs.readFileSync(path.join(sourceRoot, 'managed', 'phase1-system-information-v8.xlsx')));
  const relations = parsed.relations.map((row) => row.values)
    .filter((row) => String(row.relation_id || '').startsWith('REL.APP.ORACLE_EBS.'));
  assert.equal(relations.length, 12);
  assert.equal(relations.filter((row) => row.link_required_higher === 'Y').length, 11);
  assert.equal(relations.filter((row) => row.link_required_lower === 'Y').length, 7);
  const unlinked = relations.find((row) => row.relation_id === 'REL.APP.ORACLE_EBS.RAITCOR001.OEBS_04');
  assert.deepEqual([unlinked?.link_required_higher, unlinked?.link_required_lower], ['N', 'N']);
  for (const riskNumber of ['RAITCOR002', 'RAITCOR011']) {
    const riskRelations = relations.filter((row) => String(row.relation_id).includes(`.${riskNumber}.`));
    assert.ok(riskRelations.length > 0, `${riskNumber} must exist in Oracle governance`);
    assert.ok(riskRelations.every((row) => row.classification_lower === 'ClassificationNA'));
  }
  assert.match(packageScript, /contentName: 'Oracle eBusiness Suite', recordedEvidenceCatalogKey: '66176468'/u);
  assert.match(packageScript, /recordedAppCategoryKey: '66175343', recordedContentType: 3/u);
});

test('Oracle EBS authority resolves only the exact current alias/key/category and fails closed on zero or duplicates', async () => {
  const engagementId = '11111111-1111-4111-8111-111111111111';
  const workspaceId = '22222222-2222-4222-8222-222222222222';
  const groupId = '33333333-3333-4333-8333-333333333333';
  const item = (key: string, name: string) => ({
    engagementId, key, legacyId: key, name, description: name, parentListName: 'Standardized Accounts List',
    subItems: [{ engagementId, key: '66175343', legacyId: '66175343', name: 'Application', parentListName: 'Application type' }]
  });
  const request = {
    allowedWorkspaceIds: [workspaceId],
    query: { workspaceNames: ['WS-A'], graContents: [{ contentName: 'Oracle eBusiness Suite', elementKind: 'APP', objectSubtype: 'Application', objectType: 'Application' }] }
  };
  const run = (items: unknown[]) => createOperationHandler().run('omnia.create-associate.authority.resolve.v1', request, {
    binding: { engagementId },
    invokeStep: async (stepId: string) => {
      if (stepId === 'authority-hierarchy') return {};
      if (stepId === 'authority-directory') return [{ engagementId, facets: [
        { id: groupId, engagementId, facetTypeId: '5420131f-8ea2-4c3f-938f-a25745240cd0', name: 'Workspaces' },
        { id: workspaceId, engagementId, facetTypeId: 'd0c7e20c-1451-48d2-9dd5-8a6f2a51bfc0', parentId: groupId, name: 'WS-A' }
      ] }];
      if (stepId === 'authority-gra-directory') return [{ engagementId, typeName: 'Standardized Accounts List', items }];
      throw new Error(`Unexpected authority step: ${stepId}`);
    }
  });
  const resolved = await run([item('66176468', 'Oracle eBusiness Suite')]);
  assert.deepEqual(
    [resolved.graContents[0].contentName, resolved.graContents[0].inkContentId, resolved.graContents[0].typeId, resolved.graContents[0].itElementTypeId],
    ['Oracle eBusiness Suite', '66176468', 3, '66175343']
  );
  await assert.rejects(run([item('70000001', 'Unrelated Application')]), /absent or ambiguous/u);
  await assert.rejects(run([item('66176468', 'Oracle eBusiness Suite'), item('66176469', 'Oracle eBusiness Suite')]), /absent or ambiguous/u);
});

test('AD and code migration freeze the exact recorded content aliases and shared Higher/Lower relations', () => {
  const parsed = worker.parseV8(fs.readFileSync(path.join(sourceRoot, 'managed', 'phase1-system-information-v8.xlsx')));
  const relations = parsed.relations.map((row) => row.values);
  const ad = relations.filter((row) => String(row.relation_id || '').startsWith('REL.OS.AD.'));
  const migration = relations.filter((row) => String(row.relation_id || '').startsWith('REL.TOOL.MIGRATION.'));
  assert.deepEqual(ad.map((row) => row.relation_id), [
    'REL.OS.AD.RAITCOR001.OS_02', 'REL.OS.AD.RAITCOR001.OS_06',
    'REL.OS.AD.RAITCOR003.OS_05', 'REL.OS.AD.RAITCOR006.OS_10'
  ]);
  assert.deepEqual(migration.map((row) => row.relation_id), [
    'REL.TOOL.MIGRATION.RAITTOOL002.TOOL_05', 'REL.TOOL.MIGRATION.RAITTOOL002.TOOL_06',
    'REL.TOOL.MIGRATION.RAITTOOL003.TOOL_10'
  ]);
  for (const row of [...ad, ...migration]) {
    assert.deepEqual([row.link_required_higher, row.link_required_lower], ['Y', 'Y']);
  }
  assert.match(packageScript, /inputValue: 'AD', expectedOmniaContentName: '通用操作系统'/u);
  assert.match(packageScript, /inputValue: '代码迁移工具', expectedOmniaContentName: '代码迁移工具'/u);
});
