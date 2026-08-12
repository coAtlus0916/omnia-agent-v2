import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { buildFeatureNavigationTree } from '../src/shared/feature-navigation.ts';
import type { FeatureNavigationGroup, FeatureNavigationLeaf } from '../src/shared/feature-contracts.ts';

const groups: FeatureNavigationGroup[] = [
  { id: 'other', parentId: null, level: 1, label: '其他', order: 90 },
  { id: 'element-management', parentId: 'other', level: 2, label: '元素管理', order: 10 },
  { id: 'workpaper', parentId: null, level: 1, label: '底稿', order: 50 },
  { id: 'empty', parentId: null, level: 1, label: '空分组', order: 5 }
];
const leaf = (overrides: Partial<FeatureNavigationLeaf> & Pick<FeatureNavigationLeaf, 'id' | 'featureId' | 'label'>): FeatureNavigationLeaf => ({
  parentId: '', level: 2, order: 10, featureVersion: '1.0.0', route: `feature:${overrides.featureId}/workbench`,
  availability: 'available', reason: '', ...overrides
});

test('mixed navigation preserves root order and signed parent hierarchy', () => {
  const tree = buildFeatureNavigationTree(groups, [
    leaf({ id: 'recording', featureId: 'omnia.recording', label: '录制', order: 10 }),
    leaf({ id: 'workpaper-preparation', featureId: 'omnia.workpaper-preparation', label: '底稿编制', parentId: 'workpaper', availability: 'disabled', reason: '等待 Shell 启动激活。' }),
    leaf({ id: 'delete-elements', featureId: 'omnia.delete-elements', label: '删除元素', parentId: 'element-management', level: 3 }),
    leaf({ id: 'orphan', featureId: 'omnia.orphan', label: '孤立叶子', parentId: 'missing', level: 3 })
  ]);

  assert.deepEqual(tree.map((entry) => entry.kind === 'leaf' ? entry.leaf.label : entry.node.group.label), ['录制', '底稿', '其他']);
  const workpaper = tree.find((entry) => entry.kind === 'group' && entry.node.group.id === 'workpaper');
  assert.equal(workpaper?.kind, 'group');
  if (workpaper?.kind === 'group') {
    assert.deepEqual(workpaper.node.leaves.map((item) => item.featureId), ['omnia.workpaper-preparation']);
    assert.deepEqual({ availability: workpaper.node.leaves[0]?.availability, reason: workpaper.node.leaves[0]?.reason },
      { availability: 'disabled', reason: '等待 Shell 启动激活。' });
  }
  const other = tree.find((entry) => entry.kind === 'group' && entry.node.group.id === 'other');
  assert.equal(other?.kind, 'group');
  if (other?.kind === 'group') {
    assert.deepEqual(other.node.subgroups.map((item) => item.group.label), ['元素管理']);
    assert.deepEqual(other.node.subgroups[0]?.leaves.map((item) => item.featureId), ['omnia.delete-elements']);
  }
  assert.equal(JSON.stringify(tree).includes('omnia.orphan'), false);
  assert.equal(JSON.stringify(tree).includes('空分组'), false);
});

test('same-level ties are deterministic by localized label then stable id', () => {
  const tree = buildFeatureNavigationTree([], [
    leaf({ id: 'beta', featureId: 'omnia.beta', label: 'B', order: 10 }),
    leaf({ id: 'alpha', featureId: 'omnia.alpha', label: 'A', order: 10 })
  ]);
  assert.deepEqual(tree.map((entry) => entry.kind === 'leaf' ? entry.leaf.id : ''), ['alpha', 'beta']);
});

test('current immutable Feature candidates declare the signed IT Elements, Workpaper, and Other hierarchy', () => {
  const repo = path.resolve(import.meta.dirname, '..');
  const readManifest = (candidate: string) => {
    const envelope = JSON.parse(fs.readFileSync(path.join(repo, candidate), 'utf8'));
    const member = envelope.files.find((item: { path: string }) => item.path === 'manifest.json');
    assert.ok(member);
    return JSON.parse(Buffer.from(member.contentBase64, 'base64').toString('utf8'));
  };
  const manifests = [
    readManifest('feature-packages/create-associate/candidates/create-associate-0.2.135.ofp'),
    readManifest('feature-packages/workpaper-preparation/candidates/workpaper-preparation-0.1.4.ofp'),
    readManifest('feature-packages/recording/candidates/recording-0.4.21.ofp'),
    readManifest('feature-packages/delete-elements/candidates/delete-elements-0.3.31.ofp')
  ];
  const mergedGroups = [...new Map(manifests.flatMap((manifest) => manifest.navigation.groups)
    .map((group) => [group.id, group])).values()] as FeatureNavigationGroup[];
  const projectedLeaves = manifests.flatMap((manifest) => manifest.navigation.leaves.map((item: Omit<FeatureNavigationLeaf, 'availability' | 'reason'>) => ({
    ...item, availability: 'disabled' as const, reason: '待启动激活。'
  })));
  const tree = buildFeatureNavigationTree(mergedGroups, projectedLeaves);
  assert.deepEqual(tree.map((entry) => entry.kind === 'group' ? entry.node.group.label : entry.leaf.label), ['IT元素', '底稿', '其他']);
  assert.deepEqual(tree.map((entry) => entry.kind === 'group' ? entry.node.leaves.map((leaf) => leaf.featureId) : []), [
    ['omnia.create-associate'],
    ['omnia.workpaper-preparation'],
    ['omnia.recording', 'omnia.delete-elements']
  ]);
});
