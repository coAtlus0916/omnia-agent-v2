'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`${name} is required.`);
  return path.resolve(process.argv[index + 1]);
}

const runtime = argument('--runtime');
const tempParent = argument('--temp-root');
const packageRoot = path.resolve(__dirname, '..');
const tempRoot = path.join(tempParent, randomUUID());
const entry = path.join(packageRoot, 'python', 'engine.py');
for (const filename of [runtime, entry]) {
  if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) throw new Error(`Scheduler smoke input is missing: ${filename}`);
}
if (!tempRoot.startsWith(`${tempParent}${path.sep}`) || tempRoot.startsWith(`${packageRoot}${path.sep}`)) {
  throw new Error('Scheduler smoke temp scope is invalid.');
}
fs.mkdirSync(tempRoot, { recursive: true });

process.env.OMNIA_MANAGED_PYTHON_EXECUTABLE = runtime;
process.env.OMNIA_MANAGED_PYTHON_ENTRY = entry;
process.env.OMNIA_FEATURE_PACKAGE_ROOT = packageRoot;
process.env.OMNIA_FEATURE_TEMP_ROOT = tempRoot;
const { createPythonSidecarBridge } = require('../middle/python-bridge.cjs');
let bridge = createPythonSidecarBridge({ timeoutMs: 15_000 });
const steps = [
  { stepId: 'relation:r1', targetKey: 'relation:r1', dependsOn: [], operationId: 'omnia.delete.infrastructure-application.disassociate.v1', effect: 'omnia_mutation' },
  { stepId: 'object:app-1', targetKey: 'APP|app-1', dependsOn: ['relation:r1'], operationId: 'omnia.delete.it-element.direct.v1', effect: 'omnia_mutation' },
  { stepId: 'object:db-1', targetKey: 'DB|db-1', dependsOn: [], operationId: 'omnia.delete.it-element.direct.v1', effect: 'omnia_mutation' }
];
const input = (outcomes) => ({ schemaVersion: 'omnia.delete-scheduler-input/v1', planId: 'plan-1', runId: 'run-1', steps, outcomes, concurrencyBudget: 1 });
const workspaceId = '11111111-1111-1111-1111-111111111111';
const db = { objectId: '22222222-2222-2222-2222-222222222222', informationId: '', workItemId: '32222222-2222-2222-2222-222222222222',
  objectType: 'DB', workspace: workspaceId, workspaceIds: [workspaceId], riskAssessmentId: '' };
const app = { objectId: '42222222-2222-2222-2222-222222222222', informationId: '', workItemId: '52222222-2222-2222-2222-222222222222',
  objectType: 'APP', workspace: workspaceId, workspaceIds: [workspaceId], riskAssessmentId: '' };
const tool = { objectId: '62222222-2222-2222-2222-222222222222', informationId: '', workItemId: '72222222-2222-2222-2222-222222222222',
  objectType: 'TOOL', workspace: workspaceId, workspaceIds: [workspaceId], riskAssessmentId: '' };
const toolEdge = { relationType: 'ItToolApplication', sourceObjectId: tool.objectId, targetObjectId: app.objectId,
  sourceObjectType: 'TOOL', targetObjectType: 'APP', sourceWorkItemId: tool.workItemId, targetWorkItemId: app.workItemId,
  sourceWorkspaceId: workspaceId, targetWorkspaceId: workspaceId };
const preflight = (target, blockers = [], relations = []) => ({ objectId: target.objectId, informationId: target.informationId,
  workItemId: target.workItemId, objectType: target.objectType, workspaceIds: target.workspaceIds, riskAssessmentId: '', blockers, relations });
const preparationInput = () => ({ schemaVersion: 'omnia.delete-preparation-compile-input/v1', planId: 'compile-plan', runId: 'compile-run',
  targets: [app, db, tool], objectPreflights: [
    preflight(app, [{ type: 'Infrastructure', id: db.objectId, workItemId: db.workItemId },
      { type: 'ITTool', id: tool.objectId, workItemId: tool.workItemId },
      { type: 'RiskAssessment', id: '82222222-2222-2222-2222-222222222222', workItemId: '' }], [toolEdge, toolEdge]),
    preflight(db, [{ type: 'Application', id: app.objectId, workItemId: app.workItemId }]),
    preflight(tool, [{ type: 'Application', id: app.objectId, workItemId: app.workItemId }], [toolEdge])
  ] });

(async () => {
  try {
    const initial = await bridge.invoke('schedule_deletion', input([]), { runId: 'run-1' });
    assert.deepEqual(initial.readyStepIds, ['relation:r1']);
    assert.deepEqual(initial.skipStepIds, []);
    assert.equal(initial.terminal, 'running');

    const isolated = await bridge.invoke('schedule_deletion', input([
      { stepId: 'relation:r1', state: 'failed', phase: 'preflight', code: 'DELETE.PREFLIGHT_DRIFT', message: 'fixture failure' }
    ]), { runId: 'run-1' });
    assert.deepEqual(isolated.readyStepIds, ['object:db-1']);
    assert.deepEqual(isolated.skipStepIds, ['object:app-1']);
    assert.equal(isolated.terminal, 'running');

    const terminal = await bridge.invoke('schedule_deletion', input([
      { stepId: 'relation:r1', state: 'failed' },
      { stepId: 'object:db-1', state: 'succeeded' }
    ]), { runId: 'run-1' });
    assert.equal(terminal.terminal, 'failed');
    assert.deepEqual(terminal.skipStepIds, ['object:app-1']);

    const uncertain = await bridge.invoke('schedule_deletion', input([
      { stepId: 'relation:r1', state: 'uncertain', commandId: 'command-1' }
    ]), { runId: 'run-1' });
    assert.equal(uncertain.terminal, 'uncertain');
    assert.deepEqual(uncertain.readyStepIds, []);

    const compiled = await bridge.invoke('compile_delete_preparation', preparationInput(), { runId: 'compile-run' });
    assert.equal(compiled.schemaVersion, 'omnia.delete-preparation-compile-output/v1');
    assert.equal(compiled.graSeeds.length, 1);
    assert.equal(compiled.derivedGraSeeds.length, 1);
    assert.equal(compiled.relationDescriptors.length, 2);
    assert.equal(compiled.dependencySkeleton.length, 6);
    assert.match(compiled.compilationDigest, /^[0-9a-f]{64}$/u);
    await bridge.close();
    bridge = createPythonSidecarBridge({ timeoutMs: 15_000 });
    const secondProcess = await bridge.invoke('compile_delete_preparation', preparationInput(), { runId: 'compile-run' });
    assert.deepEqual(secondProcess, compiled, 'the same bounded input must compile identically in a new CPython process');

    const missingEndpoint = preparationInput();
    missingEndpoint.targets.splice(1, 1); missingEndpoint.objectPreflights.splice(1, 1);
    await assert.rejects(bridge.invoke('compile_delete_preparation', missingEndpoint, { runId: 'compile-run' }),
      (error) => error.code === 'DELETE.PREPARATION_GRAPH_INCOMPLETE');
    const crossWorkspace = preparationInput(); const otherWorkspace = '99999999-9999-9999-9999-999999999999';
    crossWorkspace.targets[1] = { ...crossWorkspace.targets[1], workspace: otherWorkspace, workspaceIds: [otherWorkspace] };
    crossWorkspace.objectPreflights[1] = { ...crossWorkspace.objectPreflights[1], workspaceIds: [otherWorkspace] };
    await assert.rejects(bridge.invoke('compile_delete_preparation', crossWorkspace, { runId: 'compile-run' }),
      (error) => error.code === 'DELETE.PREPARATION_GRAPH_INVALID');
    const illegalRelation = preparationInput(); illegalRelation.objectPreflights[0].relations[0] = { ...toolEdge, relationType: 'IllegalRelation' };
    await assert.rejects(bridge.invoke('compile_delete_preparation', illegalRelation, { runId: 'compile-run' }),
      (error) => error.code === 'DELETE.PREPARATION_GRAPH_UNSUPPORTED');
    const missingGraIdentity = preparationInput(); missingGraIdentity.objectPreflights[0].blockers[2].id = '';
    await assert.rejects(bridge.invoke('compile_delete_preparation', missingGraIdentity, { runId: 'compile-run' }),
      (error) => error.code === 'DELETE.PREPARATION_INPUT_INVALID');
    const blockerWorkItemDrift = preparationInput(); blockerWorkItemDrift.objectPreflights[0].blockers[0].workItemId = app.workItemId;
    await assert.rejects(bridge.invoke('compile_delete_preparation', blockerWorkItemDrift, { runId: 'compile-run' }),
      (error) => error.code === 'DELETE.PREPARATION_GRAPH_INVALID');
    await assert.rejects(bridge.invoke('compile_delete_preparation_unlisted', preparationInput(), { runId: 'compile-run' }),
      (error) => error.code === 'PYTHON.INVOCATION_INVALID');
    process.stdout.write('delete-elements managed Python scheduler/compiler smoke passed\n');
  } finally {
    await bridge.close();
    if (!tempRoot.startsWith(`${tempParent}${path.sep}`)) throw new Error('Refusing to clean an unbounded scheduler smoke path.');
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  process.stderr.write(`${error && error.stack || error}\n`);
  process.exitCode = 1;
});
