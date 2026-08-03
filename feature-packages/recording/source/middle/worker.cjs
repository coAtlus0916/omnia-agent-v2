'use strict';

const FEATURE_ID = 'omnia.recording';
const FEATURE_VERSION = '__FEATURE_VERSION__';

function command(kind, context, recordingId = '') {
  return {
    schemaVersion: 'omnia.v5.recording-command/v1',
    featureId: FEATURE_ID,
    featureVersion: FEATURE_VERSION,
    kind,
    connectorBinding: context.connectorBinding,
    ...(recordingId ? { recordingId } : {})
  };
}

function actions(active) {
  return [
    { actionId: 'refresh-status', label: '刷新真实状态', enabled: true, reason: '' },
    { actionId: 'start-recording', label: '开始详细录制', enabled: !active, reason: active ? '已有录制正在进行。' : '' },
    { actionId: 'stop-export', label: '停止并导出', enabled: active, reason: active ? '' : '当前没有正在进行的录制。' },
    { actionId: 'cancel-recording', label: '取消录制', enabled: active, reason: active ? '' : '当前没有正在进行的录制。' },
    { actionId: 'capture-current-gra-catalog', label: '抓取当前 GRA Risk/Control 完整目录', enabled: !active, reason: active ? '请先停止或取消详细录制，再执行目录重抓取。' : '' }
  ];
}

function statusPatch(status, extraItems = []) {
  const active = status && status.active === true;
  const integrity = status && status.integrity || {};
  const items = [];
  if (status && status.recordingId) items.push({
    id: `recording:${status.recordingId}`,
    scopeId: 'recording-status',
    type: 'Recording',
    title: status.recordingId,
    subtitle: `事件 ${Number(status.eventCount || 0)}；交互 ${Number(status.interactionCount || 0)}；网络 ${Number(status.networkRequestCount || 0)}；完整性 ${integrity.complete === false ? 'incomplete' : 'complete'}`,
    selectable: false,
    disabledReason: '状态证据不可选择。',
    concurrencyToken: String(status.updatedAt || '')
  });
  items.push(...extraItems);
  return {
    status: active ? 'loading' : status && status.state === 'cancelled' ? 'idle' : 'ready',
    statusMessage: String(status && status.message || '已读取 Connector 真实录制状态。'),
    scopes: [{ id: 'recording-status', parentId: '', label: '连接与录制状态', parentLabel: '录制', selected: true }],
    items,
    selectedItemIds: [],
    actions: actions(active)
  };
}

function createFeatureWorker(ports) {
  if (!ports?.connector || typeof ports.connector.invoke !== 'function') throw new Error('Recording Feature requires the controlled Connector port.');
  if (!ports?.store || typeof ports.store.appendEvidence !== 'function') throw new Error('Recording Feature requires its evidence store port.');

  async function invoke(kind, context, recordingId = '') {
    return ports.connector.invoke(command(kind, context, recordingId));
  }

  async function save(checkpoint, value) {
    await ports.store.appendEvidence({
      schemaVersion: 'omnia.v5.recording-feature-evidence/v1',
      planId: String(value?.recordingId || value?.catalog?.identity?.gra?.id || 'recording'),
      checkpoint,
      occurredAt: new Date().toISOString(),
      details: value
    });
  }

  return Object.freeze({
    health: () => ({
      schemaVersion: 'omnia.feature-worker-health/v1',
      featureId: FEATURE_ID,
      featureVersion: FEATURE_VERSION,
      ready: true,
      mutationEnabled: false,
      requiresConnector: true,
      requiresSafetyLock: false,
      supportedTransports: ['local', 'remote']
    }),
    async handleAction(input) {
      const context = input?.context || {};
      if (input.actionId === 'refresh-status') {
        return { surfacePatch: statusPatch(await invoke('status', context)) };
      }
      if (input.actionId === 'start-recording') {
        const result = await invoke('start', context);
        await save('recording_started', result);
        return { surfacePatch: statusPatch(result) };
      }
      if (input.actionId === 'stop-export') {
        const status = await invoke('status', context);
        const result = await invoke('stop_export', context, status.recordingId);
        await save('recording_stopped_exported', result);
        const artifact = result.exportPath ? [{
          id: `export:${result.recordingId}`,
          scopeId: 'recording-status',
          type: 'Recording export',
          title: '详细录制证据',
          subtitle: String(result.exportPath),
          selectable: false,
          disabledReason: '导出文件已由 Connector 写入本地证据目录。',
          concurrencyToken: String(result.updatedAt || '')
        }] : [];
        return { surfacePatch: statusPatch(result, artifact) };
      }
      if (input.actionId === 'cancel-recording') {
        const status = await invoke('status', context);
        const result = await invoke('cancel', context, status.recordingId);
        await save('recording_cancelled', result);
        return { surfacePatch: statusPatch(result) };
      }
      if (input.actionId === 'capture-current-gra-catalog') {
        const result = await invoke('capture_current_gra_catalog', context);
        await save('gra_catalog_captured', {
          status: result.status,
          catalogPath: result.catalogPath,
          manifestPath: result.manifestPath,
          completeness: result.catalog?.completeness,
          identity: result.catalog?.identity
        });
        const completeness = result.catalog?.completeness || {};
        return { surfacePatch: {
          status: result.status === 'complete' ? 'ready' : 'blocked',
          statusMessage: result.status === 'complete'
            ? `完整目录抓取完成：Risk ${Number(completeness.riskCount || 0)}，Control ${Number(completeness.controlCount || 0)}。`
            : `目录抓取不完整：${(completeness.missingReasons || []).join('；') || '存在必需读取缺失。'}`,
          scopes: [{ id: 'recording-status', parentId: '', label: '连接与录制状态', parentLabel: '录制', selected: true }],
          items: [{
            id: `catalog:${result.catalog?.identity?.gra?.id || Date.now()}`,
            scopeId: 'recording-status',
            type: 'Risk/Control catalog',
            title: result.catalog?.identity?.gra?.name || result.catalog?.identity?.gra?.id || '当前 GRA 目录',
            subtitle: `${result.status}；Risk ${Number(completeness.riskCount || 0)}；Control ${Number(completeness.controlCount || 0)}；${result.catalogPath}`,
            selectable: false,
            disabledReason: '目录证据不可选择。',
            concurrencyToken: String(result.catalog?.capturedAt || '')
          }],
          selectedItemIds: [],
          actions: actions(false)
        } };
      }
      throw new Error('Recording action is not implemented by this official Feature.');
    }
  });
}

module.exports = Object.freeze({ createFeatureWorker, FEATURE_ID, FEATURE_VERSION });
