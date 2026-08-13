import assert from 'node:assert/strict';
import test from 'node:test';
import type { DeclarativeFeatureSurface, DeclarativeProgress } from '../src/shared/feature-contracts.ts';
import {
  buildLiveReturnProgress,
  featureValidationProgressFromPlan,
  liveFeatureValidationPlan,
  LiveReturnProgressCoalescer,
  liveReturnProgressPublishMode
} from '../src/main/features/package-manager.ts';
import { mergeMonotonicProgress, returnProgressWaitState, shouldReleasePendingReturn } from '../src/renderer/feature-window.ts';

function declaredProgress(): DeclarativeProgress {
  const totals = [2, 2, 1, 2, 3];
  const labels = ['元素', 'GRA', '关系', 'Risk-Control', '设置'];
  return {
    label: '回传进度',
    completed: 0,
    total: 10,
    percent: 0,
    state: 'running',
    message: '',
    items: totals.map((total, index) => ({
      itemId: `return-group-${index}`,
      label: labels[index]!,
      state: 'pending',
      detail: '',
      completed: 0,
      total,
      percent: 0
    }))
  };
}

function declaredValidationProgress(): DeclarativeProgress {
  return {
    label: '校验进度', completed: 0, total: 3, percent: 0, state: 'running', message: '正在校验 0/3',
    items: ['structure', 'identity', 'workspace'].map((itemId) => ({ itemId, label: itemId, state: 'pending', detail: '等待后台校验。' }))
  };
}

test('generic live validation projection advances only for persisted real results', () => {
  const plan = { planId: 'run-1', validationProgress: { schemaVersion: 'omnia.feature-validation-progress/v1', total: 3, results: [
    { itemId: 'structure', state: 'passed', detail: '真实解析已完成。' }
  ] } };
  assert.equal(liveFeatureValidationPlan('savePlan', plan), plan);
  const first = featureValidationProgressFromPlan(declaredValidationProgress(), plan);
  assert.ok(first);
  assert.equal(first.completed, 1);
  assert.equal(first.message, '正在校验 1/3');
  assert.deepEqual(first.items.map((item) => item.state), ['passed', 'pending', 'pending']);
  assert.equal(featureValidationProgressFromPlan(declaredValidationProgress(), { ...plan, validationProgress: { ...plan.validationProgress, results: [
    ...plan.validationProgress.results, { itemId: 'unknown', state: 'passed', detail: 'invalid' }
  ] } }), null);
});

test('live Return projection accepts partially materialized ledger rows and keeps declared totals', () => {
  const projected = buildLiveReturnProgress(declaredProgress(), [
    { target_key: 'app-1', target_kind: 'object', object_type: 'Application', state: 'verified', command_state: 'readback_verified' },
    { target_key: 'settings-1', target_kind: 'field', object_type: 'Application', state: 'frozen', command_state: 'prepared' }
  ]);
  assert.ok(projected);
  assert.equal(projected.total, 10);
  assert.equal(projected.completed, 1);
  assert.equal(projected.percent, 10);
  assert.deepEqual(projected.items.map((item) => [item.completed, item.total, item.percent]), [
    [1, 2, 50], [0, 2, 0], [0, 1, 0], [0, 2, 0], [0, 3, 0]
  ]);
});

test('live Return projection never flashes completed counters backwards within one Surface revision', () => {
  const previous = buildLiveReturnProgress(declaredProgress(), [
    { target_key: 'app-1', target_kind: 'object', object_type: 'Application', state: 'verified', command_state: 'readback_verified' },
    { target_key: 'app-2', target_kind: 'object', object_type: 'Application', state: 'verified', command_state: 'readback_verified' },
    { target_key: 'gra-1', target_kind: 'object', object_type: 'GRA', state: 'verified', command_state: 'readback_verified' }
  ]);
  assert.ok(previous);
  const stale = buildLiveReturnProgress(declaredProgress(), [
    { target_key: 'app-1', target_kind: 'object', object_type: 'Application', state: 'verified', command_state: 'readback_verified' }
  ], previous);
  assert.ok(stale);
  assert.equal(stale.completed, 3);
  assert.deepEqual(stale.items.slice(0, 2).map((item) => item.completed), [2, 1]);
});

test('live Return projection fails closed when Core rows exceed an immutable Surface group total', () => {
  const rows = [0, 1, 2].map((index) => ({
    target_key: `app-${index}`,
    target_kind: 'object',
    object_type: 'Application',
    state: 'verified',
    command_state: 'readback_verified'
  }));
  assert.equal(buildLiveReturnProgress(declaredProgress(), rows), null);
});

test('live Return projection maps a real four-capsule plan without a relationship group', () => {
  const totals = [2, 2, 35, 49];
  const labels = ['元素', 'GRA', 'Risk-Control', '设置'];
  const declared: DeclarativeProgress = {
    label: '回传进度', completed: 0, total: 88, percent: 0, state: 'running', message: '',
    items: totals.map((total, index) => ({
      itemId: `return-group-${index}`,
      label: labels[index]!,
      state: 'pending', detail: '', completed: 0, total, percent: 0
    }))
  };
  const rows = [
    ...Array.from({length: 2}, (_, index) => ({target_key: `element-${index}`, target_kind: 'object', object_type: 'Application', state: 'verified', command_state: 'readback_verified'})),
    ...Array.from({length: 2}, (_, index) => ({target_key: `gra-${index}`, target_kind: 'object', object_type: 'GRA', state: 'verified', command_state: 'readback_verified'})),
    ...Array.from({length: 35}, (_, index) => ({target_key: `risk-${index}`, target_kind: 'risk_control', object_type: '', state: 'verified', command_state: 'readback_verified'})),
    ...Array.from({length: 6}, (_, index) => ({target_key: `setting-${index}`, target_kind: 'field', object_type: '', state: 'verified', command_state: 'readback_verified'})),
    {target_key: 'setting-closed', target_kind: 'field', object_type: '', state: 'frozen', command_state: 'closed_not_applied'},
    {target_key: 'setting-committed', target_kind: 'field', object_type: '', state: 'frozen', command_state: 'committed'},
    {target_key: 'setting-prepared', target_kind: 'field', object_type: '', state: 'frozen', command_state: 'prepared'}
  ];
  const projected = buildLiveReturnProgress(declared, rows);
  assert.ok(projected);
  assert.equal(projected.completed, 46);
  assert.equal(projected.total, 88);
  assert.deepEqual(projected.items.map((item) => [item.label, item.completed, item.total]), [
    ['元素', 2, 2], ['GRA', 2, 2], ['Risk-Control', 35, 35], ['设置', 7, 49]
  ]);
});

test('live Return progress coalesces ordinary completions but publishes failures and final completion immediately', async () => {
  assert.equal(liveReturnProgressPublishMode('recordReturnEvidence', {commandState: 'readback_verified'}), 'coalesced');
  assert.equal(liveReturnProgressPublishMode('recordReturnEvidence', {commandState: 'closed_not_applied'}), 'coalesced');
  assert.equal(liveReturnProgressPublishMode('recordReturnEvidence', {commandState: 'uncertain'}), 'immediate');
  assert.equal(liveReturnProgressPublishMode('recordReturnEvidence', {commandState: 'failed'}), 'immediate');
  assert.equal(liveReturnProgressPublishMode('recordReturnEvidence', {commandState: 'committed'}), null);
  assert.equal(liveReturnProgressPublishMode('finishReturn', {}), 'immediate');

  const coalescer = new LiveReturnProgressCoalescer(20);
  const published: string[] = [];
  coalescer.schedule('run-a', () => published.push('stale'));
  coalescer.schedule('run-a', () => published.push('latest'));
  coalescer.schedule('run-b', () => published.push('cancelled'));
  coalescer.schedule('run-b', () => published.push('terminal'), true);
  assert.deepEqual(published, ['terminal']);
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.deepEqual(published, ['terminal', 'latest']);
  coalescer.cancelAll();
});

function returnSurface(
  progress: DeclarativeProgress,
  stateVersion = 9,
  actionState: 'executing' | 'paused' | 'reconcile' = 'executing'
): DeclarativeFeatureSurface {
  return {
    schemaVersion: 'omnia.declarative-feature-surface/v1',
    featureId: 'omnia.create-associate',
    featureVersion: '0.2.79',
    surfaceId: 'create-associate.main',
    stateVersion,
    title: '新建与关联',
    description: '',
    density: 'compact',
    status: 'loading',
    statusMessage: '',
    scopes: [],
    items: [],
    selectedItemIds: [],
    search: '',
    actions: [
      {actionId: 'continue-return', label: '继续回传', effect: 'omnia_mutation', enabled: actionState === 'paused', reason: '', presentation: 'return', pendingPresentation: {schemaVersion: 'omnia.declarative-action-pending-presentation/v1', title: '正在继续回传', message: '继续执行。', workflowStepId: 'return'}, selectionMode: 'none'},
      {actionId: 'reconcile-return', label: '只读核验', effect: 'read_only', enabled: actionState === 'reconcile', reason: '', presentation: 'return', pendingPresentation: {schemaVersion: 'omnia.declarative-action-pending-presentation/v1', title: '正在核验', message: '只读核验。', workflowStepId: 'return'}, selectionMode: 'none'}
    ],
    workflow: {
      currentStepId: 'return',
      revision: 3,
      steps: []
    },
    progress
  };
}

test('Feature Surface renderer does not flash an older same-revision projection back to zero', () => {
  const advanced = declaredProgress();
  advanced.completed = 3;
  advanced.percent = 30;
  advanced.items[0] = {...advanced.items[0]!, completed: 2, percent: 100, state: 'passed'};
  advanced.items[1] = {...advanced.items[1]!, completed: 1, percent: 50, state: 'running'};
  const merged = mergeMonotonicProgress(returnSurface(advanced), returnSurface(declaredProgress()));
  assert.equal(merged.progress?.completed, 3);
  assert.equal(merged.progress?.percent, 30);
  assert.deepEqual(merged.progress?.items.slice(0, 2).map((item) => item.completed), [2, 1]);
});

test('Feature Surface renderer carries receipt-backed progress across an active stateVersion transition', () => {
  const advanced = declaredProgress();
  advanced.completed = 3;
  advanced.percent = 30;
  const merged = mergeMonotonicProgress(returnSurface(advanced, 9), returnSurface(declaredProgress(), 10));
  assert.equal(merged.progress?.completed, 3);
  assert.equal(merged.stateVersion, 10);
  assert.equal(returnProgressWaitState(merged), 'active');
  assert.equal(shouldReleasePendingReturn(9, merged), false);
});

test('Feature Surface renderer preserves 52/88 through pause and rejects a late zero projection', () => {
  const zero: DeclarativeProgress = {
    label: '回传进度', completed: 0, total: 88, percent: 0, state: 'running', message: '',
    items: [
      {itemId: 'elements', label: '元素', state: 'pending', detail: '', completed: 0, total: 2, percent: 0},
      {itemId: 'gra', label: 'GRA', state: 'pending', detail: '', completed: 0, total: 2, percent: 0},
      {itemId: 'risk-control', label: 'Risk-Control', state: 'pending', detail: '', completed: 0, total: 35, percent: 0},
      {itemId: 'settings', label: '设置', state: 'pending', detail: '', completed: 0, total: 49, percent: 0}
    ]
  };
  const advanced: DeclarativeProgress = {
    ...zero,
    completed: 52,
    percent: 59,
    items: [
      {...zero.items[0]!, state: 'passed', completed: 2, percent: 100},
      {...zero.items[1]!, state: 'passed', completed: 2, percent: 100},
      {...zero.items[2]!, state: 'passed', completed: 35, percent: 100},
      {...zero.items[3]!, state: 'running', completed: 13, percent: 26}
    ]
  };

  const live = mergeMonotonicProgress(returnSurface(zero, 9), returnSurface(advanced, 10));
  assert.equal(live.progress?.completed, 52);
  assert.equal(returnProgressWaitState(live), 'active');

  const paused = mergeMonotonicProgress(live, returnSurface(zero, 11, 'paused'));
  assert.equal(paused.stateVersion, 11);
  assert.equal(paused.progress?.completed, 52);
  assert.deepEqual(paused.progress?.items.map((item) => item.completed), [2, 2, 35, 13]);
  assert.equal(returnProgressWaitState(paused), 'settled');
  assert.equal(shouldReleasePendingReturn(9, paused), true);

  const afterLateZero = mergeMonotonicProgress(paused, returnSurface(zero, 10));
  assert.strictEqual(afterLateZero, paused);
  assert.equal(afterLateZero.progress?.completed, 52);
});

test('Feature Surface renderer keeps observed counters when a failed terminal projection arrives', () => {
  const advanced = declaredProgress();
  advanced.completed = 3;
  advanced.percent = 30;
  const failed = declaredProgress();
  failed.state = 'failed';
  const merged = mergeMonotonicProgress(returnSurface(advanced, 9), returnSurface(failed, 10));
  assert.equal(merged.progress?.completed, 3);
  assert.equal(merged.progress?.state, 'failed');
  assert.equal(returnProgressWaitState(merged), 'settled');
  assert.equal(shouldReleasePendingReturn(9, merged), true);
});
