import type { FeatureNavigationGroup, FeatureNavigationLeaf } from './feature-contracts.js';

export interface FeatureNavigationSubgroupNode {
  group: FeatureNavigationGroup;
  leaves: FeatureNavigationLeaf[];
}

export interface FeatureNavigationGroupNode {
  group: FeatureNavigationGroup;
  leaves: FeatureNavigationLeaf[];
  subgroups: FeatureNavigationSubgroupNode[];
}

export type FeatureNavigationRootNode =
  | { kind: 'leaf'; leaf: FeatureNavigationLeaf }
  | { kind: 'group'; node: FeatureNavigationGroupNode };

const byOrderLabelId = <T extends { order: number; label: string; id: string }>(left: T, right: T) =>
  left.order - right.order
  || left.label.localeCompare(right.label, 'zh-CN')
  || left.id.localeCompare(right.id);

/**
 * Builds the maximum-three-level navigation declared by signed Feature
 * manifests. Invalid/orphan nodes are omitted instead of being re-parented or
 * assigned to an invented group; package validation remains the authority for
 * rejecting malformed manifests at the installation boundary.
 */
export function buildFeatureNavigationTree(
  groups: readonly FeatureNavigationGroup[],
  leaves: readonly FeatureNavigationLeaf[]
): FeatureNavigationRootNode[] {
  const sortedLeaves = [...leaves].sort(byOrderLabelId);
  const rootNodes: FeatureNavigationRootNode[] = sortedLeaves
    .filter((leaf) => leaf.level === 2 && leaf.parentId === '')
    .map((leaf) => ({ kind: 'leaf' as const, leaf }));

  for (const group of [...groups].filter((candidate) => candidate.level === 1).sort(byOrderLabelId)) {
    const directLeaves = sortedLeaves.filter((leaf) => leaf.level === 2 && leaf.parentId === group.id);
    const subgroups = [...groups]
      .filter((candidate) => candidate.level === 2 && candidate.parentId === group.id)
      .sort(byOrderLabelId)
      .map((subgroup) => ({
        group: subgroup,
        leaves: sortedLeaves.filter((leaf) => leaf.level === 3 && leaf.parentId === subgroup.id)
      }))
      .filter((subgroup) => subgroup.leaves.length > 0);
    if (directLeaves.length > 0 || subgroups.length > 0) {
      rootNodes.push({ kind: 'group', node: { group, leaves: directLeaves, subgroups } });
    }
  }

  return rootNodes.sort((left, right) => byOrderLabelId(
    left.kind === 'leaf' ? left.leaf : left.node.group,
    right.kind === 'leaf' ? right.leaf : right.node.group
  ));
}
