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
        const [sections, workspaces] = await Promise.all([
          sdk.invokeStep('workspace-sections'),
          sdk.invokeStep('workspace-facets')
        ]);
        return {
          connectorId: sdk.binding.connectorId,
          sessionGeneration: sdk.binding.sessionGeneration,
          engagementId: sdk.binding.engagementId,
          workspaceIds: rows(workspaces)
            .filter((item) => item && item.isDeleted !== true && item.deleted !== true)
            .map((item) => id(item.workspaceFacetId || item.workspaceId || item.facetId || item.id))
            .filter(Boolean),
          sections: rows(sections)
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
        const target = request.target || {};
        await sdk.invokeStep('soft-delete', { informationId: id(target.informationId) });
        return { informationId: id(target.informationId), accepted: true };
      }
      if (operationId === 'omnia.delete.information.reconcile.v1') {
        const target = request.target || {};
        const detail = await sdk.invokeStep('information-detail', { informationId: id(target.informationId) });
        return {
          informationId: id(detail && detail.id || target.informationId),
          deleted: detail && (detail.isDeleted === true || detail.deleted === true)
        };
      }
      throw new Error(`Unsupported signed Operation: ${operationId}`);
    }
  });
}

module.exports = Object.freeze({ createOperationHandler });
