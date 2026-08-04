'use strict';

function rows(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value && value.items)) return value.items;
  if (Array.isArray(value && value.data)) return value.data;
  return [];
}

function text(value) {
  return String(value == null ? '' : value).trim();
}

function id(value) {
  return text(value).toLowerCase();
}

function workspaceIds(mapping) {
  return [...new Set(rows(mapping).map((item) => id(
    item && (item.facetId || item.workspaceFacetId || item.workspaceId || item.id)
  )).filter(Boolean))].sort();
}

function sectionDirectory(value) {
  return rows(value).map((item) => ({
    id: id(item && (item.sectionId || item.groupId || item.id)),
    name: text(item && (item.name || item.title || item.displayName))
  })).filter((item) => item.id && item.name);
}

function workspaceDirectory(value) {
  return rows(value).filter((item) => item && item.isDeleted !== true && item.deleted !== true).map((item) => ({
    id: id(item.workspaceFacetId || item.workspaceId || item.facetId || item.id),
    name: text(item.name || item.title || item.displayName),
    parentSectionId: id(item.parentSectionId || item.parentId || item.customWorkspaceGroupId || item.groupId)
  })).filter((item) => item.id && item.name && item.parentSectionId);
}

const CUSTOM_WORKSPACE = 'd0c7e20c-1451-48d2-9dd5-8a6f2a51bfc0';
const CUSTOM_WORKSPACE_GROUP = '5420131f-8ea2-4c3f-938f-a25745240cd0';
function authorityDirectory(payload, engagementId) {
  const directory = rows(payload).find((item) => id(item && item.engagementId) === id(engagementId));
  const facets = rows(directory && directory.facets);
  if (facets.some((item) => id(item && item.engagementId) !== id(engagementId))) {
    throw new Error('Omnia authority directory contained a Facet outside the current Engagement.');
  }
  const sections = facets.filter((item) => id(item && item.facetTypeId) === CUSTOM_WORKSPACE_GROUP && item.isDeleted !== true && item.deleted !== true)
    .map((item) => ({ id: id(item.id), name: text(item.name || item.value) })).filter((item) => item.id && item.name);
  const sectionIds = new Set(sections.map((item) => item.id));
  const workspaces = facets.filter((item) => id(item && item.facetTypeId) === CUSTOM_WORKSPACE && item.isDeleted !== true && item.deleted !== true)
    .map((item) => ({ id: id(item.id), name: text(item.name || item.value), parentSectionId: sectionIds.has(id(item.parentId)) ? id(item.parentId) : '' }))
    .filter((item) => item.id && item.name);
  if (!workspaces.length) throw new Error('Omnia authority directory did not return a verifiable CustomWorkspace.');
  return { sections, workspaces };
}

function blockers(payload, informationId) {
  const entity = rows(payload && payload.blockingEntities).find((item) =>
    id(item && (item.entityId || item.id)) === id(informationId)
  );
  const direct = rows(entity && entity.relatedEntities);
  const additional = [
    ...rows(payload && payload.convertingEntities),
    ...rows(payload && payload.blockingControlEntities),
    ...rows(payload && payload.accountContents)
  ];
  return [...direct, ...additional].map((item) => ({
    type: text(item && (item.relatedEntityType || item.entityType || item.type || 'relationship')),
    id: id(item && (item.relatedEntityId || item.entityId || item.id)),
    workItemId: id(item && item.workItemId)
  }));
}

async function mapLimit(values, concurrency, mapper) {
  if (!Array.isArray(values) || values.length > 2000) throw new Error('Authoritative catalog exceeds the 2000 item limit.');
  const result = new Array(values.length);
  let cursor = 0;
  async function consume() {
    while (cursor < values.length) {
      const index = cursor++;
      result[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => consume()));
  return result;
}

async function readTarget(sdk, information) {
  const informationId = id(information && (information.informationId || information.id));
  const detail = await sdk.invokeStep('information-detail', { informationId });
  const workItemId = id(detail && detail.workItemId || information && information.workItemId);
  const [workItem, mapping, blocking] = await Promise.all([
    sdk.invokeStep('work-item', { workItemId }),
    sdk.invokeStep('facet-mapping', { workItemId }),
    sdk.invokeStep('blocking-relationships', { informationId })
  ]);
  return {
    objectId: informationId,
    informationId,
    workItemId,
    objectType: 'Information',
    number: text(detail && (detail.number || detail.referenceNumber) || workItem && workItem.referenceNumber),
    name: text(detail && detail.name || information && information.name || workItem && workItem.name),
    updatedAt: text(detail && (detail.updatedAt || detail.updatedOn || detail.lastModifiedOn)),
    workspaceIds: workspaceIds(mapping),
    blockers: blockers(blocking, informationId),
    deleted: detail && (detail.isDeleted === true || detail.deleted === true)
  };
}

function createOperationHandler() {
  return Object.freeze({
    async run(operationId, request, sdk) {
      if (operationId === 'omnia.delete.scope.read.v1') {
        await sdk.invokeStep('pack-hierarchy');
        const directory = authorityDirectory(
          await sdk.invokeStep('authority-directory', { engagementId: sdk.binding.engagementId }),
          sdk.binding.engagementId
        );
        const normalizedWorkspaces = directory.workspaces;
        return {
          connectorId: sdk.binding.connectorId,
          sessionGeneration: sdk.binding.sessionGeneration,
          engagementId: sdk.binding.engagementId,
          authorityInstanceId: sdk.binding.authorityInstanceId,
          tenantOrOrgId: sdk.binding.tenantOrOrgId,
          packId: sdk.binding.packId,
          workspaceIds: normalizedWorkspaces.map((item) => item.id),
          sections: directory.sections,
          workspaces: normalizedWorkspaces
        };
      }
      if (operationId === 'omnia.delete.catalog.heavy-read.v1') {
        const collection = rows(await sdk.invokeStep('information-collection'));
        const allowed = new Set(rows(request.workspaceIds));
        const targets = await mapLimit(collection, 4, (information) => readTarget(sdk, information));
        const items = targets.filter((target) =>
          !target.deleted
          && target.workspaceIds.length > 0
          && target.workspaceIds.every((workspaceId) => allowed.has(workspaceId))
        );
        return { engagementId: sdk.binding.engagementId, items };
      }
      if (operationId === 'omnia.delete.information.preflight.v1') {
        const target = await readTarget(sdk, request.target || {});
        return {
          informationId: target.informationId,
          workItemId: target.workItemId,
          workspaceIds: target.workspaceIds,
          updatedAt: target.updatedAt,
          blockers: target.blockers
        };
      }
      if (operationId === 'omnia.delete.information.direct.v1') {
        const informationId = id(request.informationId || request.command && request.command.payload && request.command.payload.informationId);
        if (!informationId) throw new Error('Signed Information delete target is missing.');
        await sdk.invokeStep('soft-delete', { informationId });
        return { informationId, accepted: true };
      }
      if (operationId === 'omnia.delete.information.reconcile.v1') {
        const informationId = id(request.informationId);
        if (!informationId) throw new Error('Signed Information reconcile target is missing.');
        const detail = await sdk.invokeStep('information-detail', { informationId });
        return {
          informationId: id(detail && detail.id || informationId),
          deleted: detail && (detail.isDeleted === true || detail.deleted === true)
        };
      }
      throw new Error(`Unsupported signed Operation: ${operationId}`);
    }
  });
}

module.exports = Object.freeze({ createOperationHandler });
