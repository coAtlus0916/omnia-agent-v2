import { randomUUID } from 'node:crypto';
import type { WorkspaceObservation } from '../../shared/contracts.js';
import { AppError } from '../../shared/errors.js';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_AUTHORITY_BYTES = 1_500_000;
const MAX_AUTHORITY_ROWS = 2_000;

type AuthorityBinding = {
  connectorId: string;
  sessionGeneration: number;
  engagementId: string;
  authorityInstanceId: string;
  tenantOrOrgId: string;
  packId: string;
};

type AuthorityEnvelope = {
  schemaVersion: string;
  profile: string;
  engagementId: string;
  source: string;
  connectorBinding: AuthorityBinding;
  sectionsPayload: unknown;
  workspaceFacetsPayload: unknown;
};

function object(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('WORKSPACE.INVALID_CONTRACT', `${label} 不是对象。`);
  }
  return value as Record<string, any>;
}

function rows(value: unknown, label: string): any[] {
  const result = Array.isArray(value)
    ? value
    : Array.isArray((value as any)?.items)
      ? (value as any).items
      : Array.isArray((value as any)?.data)
        ? (value as any).data
        : null;
  if (!result) throw new AppError('WORKSPACE.INVALID_CONTRACT', `${label} 没有返回可解析的数组。`);
  if (result.length > MAX_AUTHORITY_ROWS) {
    throw new AppError('WORKSPACE.AUTHORITY_BUDGET_EXCEEDED', `${label} 超出安全锁权威目录条目预算。`);
  }
  return result;
}

function text(value: unknown, max = 300): string {
  return String(value ?? '').normalize('NFC').trim().replace(/\s+/gu, ' ').slice(0, max);
}

function exactGuid(value: unknown): string {
  const candidate = text(value, 64).toLowerCase();
  return GUID.test(candidate) && candidate !== '00000000-0000-0000-0000-000000000000' ? candidate : '';
}

function sectionIdOf(value: Record<string, any>): string {
  return exactGuid(value.sectionId || value.sectionFacetId || value.id);
}

function workspaceIdOf(value: Record<string, any>): string {
  return exactGuid(value.workspaceFacetId || value.workspaceId || value.facetId || value.id);
}

function referencedAuthorityIds(value: unknown, allowedIds: Set<string>): Set<string> {
  const result = new Set<string>();
  const seen = new WeakSet<object>();
  let visited = 0;
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > 8 || visited >= 20_000) return;
    visited += 1;
    if (typeof candidate === 'string') {
      const id = exactGuid(candidate);
      if (allowedIds.has(id)) result.add(id);
      return;
    }
    if (!candidate || typeof candidate !== 'object') return;
    if (seen.has(candidate as object)) return;
    seen.add(candidate as object);
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, depth + 1);
      return;
    }
    for (const [key, child] of Object.entries(candidate as Record<string, unknown>)) {
      const keyId = exactGuid(key);
      if (allowedIds.has(keyId)) result.add(keyId);
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
  return result;
}

function normalizeBinding(value: unknown): AuthorityBinding {
  const binding = object(value, 'Workspace authority connectorBinding');
  const normalized: AuthorityBinding = {
    connectorId: text(binding.connectorId, 200),
    sessionGeneration: Number(binding.sessionGeneration),
    engagementId: exactGuid(binding.engagementId),
    authorityInstanceId: text(binding.authorityInstanceId, 500).toLowerCase(),
    tenantOrOrgId: text(binding.tenantOrOrgId, 200).toLowerCase(),
    packId: text(binding.packId, 200).toLowerCase()
  };
  if (!normalized.connectorId || !Number.isSafeInteger(normalized.sessionGeneration) || normalized.sessionGeneration < 1
    || !normalized.engagementId || !normalized.authorityInstanceId || !normalized.packId) {
    throw new AppError('WORKSPACE.INVALID_CONTRACT', 'Workspace authority 缺少可核验的 Connector/Pack 身份。');
  }
  return normalized;
}

export function normalizeWorkspaceAuthorityRead(input: unknown, expected: {
  connectorId: string;
  sessionGeneration: number;
  authorityInstanceId: string;
  tenantOrOrgId: string;
  packId: string;
  engagementId: string;
}): WorkspaceObservation {
  let serialized: string;
  try { serialized = JSON.stringify(input); } catch {
    throw new AppError('WORKSPACE.INVALID_CONTRACT', 'Workspace authority 响应无法序列化。');
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_AUTHORITY_BYTES) {
    throw new AppError('WORKSPACE.AUTHORITY_BUDGET_EXCEEDED', 'Workspace authority 响应超出安全锁读取预算。');
  }
  const envelope = object(input, 'Workspace authority response') as AuthorityEnvelope;
  if (envelope.schemaVersion !== 'omnia.workspace-authority-read/v1'
    || envelope.profile !== 'workspace_authority_read'
    || envelope.source !== 'omnia_authority_api') {
    throw new AppError('WORKSPACE.INVALID_CONTRACT', 'Remote Connector 返回了不兼容的 Workspace authority 合同。');
  }
  const binding = normalizeBinding(envelope.connectorBinding);
  const engagementId = exactGuid(envelope.engagementId);
  if (!engagementId || engagementId !== binding.engagementId
    || engagementId !== exactGuid(expected.engagementId)
    || binding.connectorId !== expected.connectorId
    || binding.sessionGeneration !== expected.sessionGeneration
    || binding.authorityInstanceId !== text(expected.authorityInstanceId, 500).toLowerCase()
    || binding.tenantOrOrgId !== text(expected.tenantOrOrgId, 200).toLowerCase()
    || binding.packId !== text(expected.packId, 200).toLowerCase()) {
    throw new AppError('WORKSPACE.AUTHORITY_IDENTITY_CHANGED', 'Workspace authority 响应与当前 Connector/Pack 身份不一致。');
  }

  const sectionRows = rows(envelope.sectionsPayload, 'Omnia Section authority');
  const sectionMap = new Map<string, { id: string; name: string; order: number }>();
  for (const [order, raw] of sectionRows.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const id = sectionIdOf(raw);
    const name = text(raw.name || raw.label || raw.value);
    if (!id || !name) continue;
    const item = { id, name, order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : order };
    const previous = sectionMap.get(id);
    if (previous && (previous.name !== item.name || previous.order !== item.order)) {
      throw new AppError('WORKSPACE.AUTHORITY_AMBIGUOUS', `Omnia 返回了冲突的 Section Facet ID：${id}。`);
    }
    sectionMap.set(id, item);
  }

  const workspaceRows = rows(envelope.workspaceFacetsPayload, 'Omnia Workspace Facet authority');
  const workspaceRecords = new Map<string, { raw: Record<string, any>; id: string; name: string; status: string }>();
  for (const raw of workspaceRows) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.isDeleted === true || raw.deleted === true) continue;
    const id = workspaceIdOf(raw);
    const name = text(raw.name || raw.value);
    if (!id || !name) continue;
    const item = { raw, id, name, status: text(raw.status || 'active', 50) };
    const previous = workspaceRecords.get(id);
    if (previous && (previous.name !== item.name || previous.status !== item.status)) {
      throw new AppError('WORKSPACE.AUTHORITY_AMBIGUOUS', `Omnia 返回了冲突的 Workspace Facet ID：${id}。`);
    }
    workspaceRecords.set(id, item);
  }
  if (workspaceRecords.size === 0) {
    throw new AppError('WORKSPACE.AUTHORITY_DIRECTORY_EMPTY', 'Omnia 未返回可核验的 Workspace Facet ID。');
  }

  const sectionIds = new Set(sectionMap.keys());
  const workspaceIds = new Set(workspaceRecords.keys());
  const sectionCandidatesByWorkspace = new Map<string, Set<string>>();
  for (const rawSection of sectionRows) {
    if (!rawSection || typeof rawSection !== 'object' || Array.isArray(rawSection)) continue;
    const sectionId = sectionIdOf(rawSection);
    if (!sectionMap.has(sectionId)) continue;
    for (const workspaceId of referencedAuthorityIds(rawSection, workspaceIds)) {
      const candidates = sectionCandidatesByWorkspace.get(workspaceId) || new Set<string>();
      candidates.add(sectionId);
      sectionCandidatesByWorkspace.set(workspaceId, candidates);
    }
  }

  const workspaceMap = new Map<string, { id: string; parentSectionId: string; name: string; status: string }>();
  for (const record of workspaceRecords.values()) {
    const candidates = referencedAuthorityIds(record.raw, sectionIds);
    for (const sectionId of sectionCandidatesByWorkspace.get(record.id) || []) candidates.add(sectionId);
    workspaceMap.set(record.id, {
      id: record.id,
      parentSectionId: candidates.size === 1 ? [...candidates][0] : '',
      name: record.name,
      status: record.status
    });
  }
  return {
    observationId: randomUUID(),
    profile: 'workspace_light_read',
    authorityId: binding.authorityInstanceId,
    connectorId: binding.connectorId,
    sessionGeneration: binding.sessionGeneration,
    authorityInstanceId: binding.authorityInstanceId,
    tenantOrOrgId: binding.tenantOrOrgId,
    packId: binding.packId,
    engagementId,
    capturedAt: new Date().toISOString(),
    source: envelope.source,
    coverage: 'full',
    sections: [...sectionMap.values()].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id)),
    workspaces: [...workspaceMap.values()].sort((left, right) => left.name.localeCompare(right.name, 'zh-CN') || left.id.localeCompare(right.id))
  };
}
