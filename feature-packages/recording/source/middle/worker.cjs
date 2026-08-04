'use strict';

const FEATURE_ID = 'omnia.recording';
const FEATURE_VERSION = '__FEATURE_VERSION__';
const SURFACE_ID = 'recording.workbench';
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

function command(kind, context, recordingId = '', chunkIndex) {
  return {
    schemaVersion: 'omnia.v5.recording-command/v1',
    featureId: FEATURE_ID,
    featureVersion: FEATURE_VERSION,
    kind,
    connectorBinding: context.connectorBinding,
    ...(recordingId ? { recordingId } : {}),
    ...(Number.isSafeInteger(chunkIndex) ? { chunkIndex } : {})
  };
}

function actions(status) {
  const state = String(status && status.state || 'idle');
  const recording = state === 'recording';
  const paused = state === 'paused';
  const stopped = state === 'stopped';
  const exported = Boolean(status && status.exportedAt);
  return [
    { actionId: 'refresh-status', label: '刷新真实状态', presentation: 'refresh', enabled: true, reason: '' },
    { actionId: 'start-recording', label: paused ? '继续录制' : '开始录制', presentation: 'record', enabled: paused || (!recording && (!stopped || exported)), reason: recording ? '录制正在进行。' : stopped && !exported ? '当前记录已停止；请先导出录制记录。' : '' },
    { actionId: 'pause-recording', label: '暂停', presentation: 'pause', enabled: recording, reason: recording ? '' : '只有正在进行的录制可以暂停。' },
    { actionId: 'stop-recording', label: '停止', presentation: 'stop', enabled: recording || paused, reason: recording || paused ? '' : '当前没有可停止的录制。' },
    { actionId: 'export-recording', label: exported ? '已导出录制记录' : '导出录制记录', presentation: 'export', enabled: stopped && !exported, reason: exported ? '该录制记录已进入 Artifact Store，可直接下载。' : stopped ? '' : '请先停止录制。' }
  ];
}

function recorderProjection(status) {
  const capture = status && status.capture || {};
  const state = String(status && status.state || 'idle');
  return {
    state: status && status.exportedAt ? 'exported' : ['idle', 'recording', 'paused', 'stopped', 'cancelled'].includes(state) ? state : 'error',
    recordingId: String(status && status.recordingId || ''),
    startedAt: String(status && status.startedAt || ''),
    updatedAt: String(status && status.updatedAt || ''),
    elapsedMs: Math.max(0, Math.floor(Number(status && status.elapsedMs || 0))),
    eventCount: Math.max(0, Math.floor(Number(status && status.eventCount || 0))),
    interactionCount: Math.max(0, Math.floor(Number(status && status.interactionCount || 0))),
    networkRequestCount: Math.max(0, Math.floor(Number(status && status.networkRequestCount || 0))),
    riskCount: Math.max(0, Math.floor(Number(capture.riskCount || 0))),
    controlCount: Math.max(0, Math.floor(Number(capture.controlCount || 0))),
    captureState: ['idle', 'pending', 'complete', 'incomplete'].includes(capture.state) ? capture.state : 'idle',
    captureMessage: String(capture.message || '开始录制后将自动采集当前页 Risk 与 Control。'),
    exportAvailable: status && status.exportAvailable === true
  };
}

function statusPatch(status, artifacts) {
  const recorder = recorderProjection(status);
  return {
    status: recorder.state === 'recording' ? 'loading' : recorder.state === 'error' ? 'error' : 'ready',
    statusMessage: String(status && status.message || '已读取 Remote Connector 的真实录制状态。'),
    scopes: [],
    items: [],
    selectedItemIds: [],
    recorder,
    ...(artifacts ? { artifacts } : {}),
    actions: actions(status)
  };
}

function artifactProjection(artifact) {
  return {
    artifactId: artifact.artifactId,
    kind: artifact.kind,
    name: artifact.originalName,
    sha256: artifact.sha256,
    sizeBytes: artifact.sizeBytes,
    available: true,
    reason: ''
  };
}

function createFeatureWorker(ports) {
  if (!ports?.connector || typeof ports.connector.invoke !== 'function') throw new Error('Recording Feature requires the controlled Connector port.');
  if (!ports?.store || typeof ports.store.appendEvidence !== 'function' || typeof ports.store.call !== 'function') throw new Error('Recording Feature requires its evidence and Artifact store ports.');

  async function invoke(kind, context, recordingId = '', chunkIndex) {
    return ports.connector.invoke(command(kind, context, recordingId, chunkIndex));
  }

  async function save(checkpoint, value) {
    return ports.store.appendEvidence({
      schemaVersion: 'omnia.v5.recording-feature-evidence/v1',
      planId: String(value?.recordingId || 'recording'),
      checkpoint,
      occurredAt: new Date().toISOString(),
      details: value
    });
  }

  async function exportArtifact(context, recordingId) {
    const exported = await invoke('export', context, recordingId);
    const transfer = exported && exported.transfer || {};
    if (
      transfer.schemaVersion !== 'omnia.v5.recording-export-transfer/v1'
      || transfer.recordingId !== recordingId
      || !Number.isSafeInteger(transfer.sizeBytes)
      || transfer.sizeBytes < 1
      || transfer.sizeBytes > MAX_ARTIFACT_BYTES
      || !Number.isSafeInteger(transfer.chunkCount)
      || transfer.chunkCount < 1
      || transfer.chunkCount > 256
    ) throw new Error('Connector returned an invalid or unsupported recording export transfer.');
    const chunks = [];
    let received = 0;
    for (let chunkIndex = 0; chunkIndex < transfer.chunkCount; chunkIndex += 1) {
      const chunk = await invoke('export_chunk', context, recordingId, chunkIndex);
      if (
        chunk?.schemaVersion !== 'omnia.v5.recording-export-chunk/v1'
        || chunk.recordingId !== recordingId
        || chunk.chunkIndex !== chunkIndex
        || chunk.chunkCount !== transfer.chunkCount
        || typeof chunk.contentBase64 !== 'string'
      ) throw new Error(`Connector returned an invalid recording export chunk at ${chunkIndex}.`);
      const bytes = Buffer.from(chunk.contentBase64, 'base64');
      if (bytes.toString('base64') !== chunk.contentBase64 || bytes.length !== chunk.sizeBytes || bytes.length < 1) {
        throw new Error(`Connector recording export chunk ${chunkIndex} is not canonical.`);
      }
      chunks.push(bytes);
      received += bytes.length;
      if (received > transfer.sizeBytes || received > MAX_ARTIFACT_BYTES) throw new Error('Recording export exceeded its frozen transfer size.');
    }
    if (received !== transfer.sizeBytes) throw new Error('Recording export transfer ended before the full file was received.');
    const bytes = Buffer.concat(chunks, received);
    const artifact = await ports.store.call('commitStandaloneArtifact', {
      kind: 'result',
      surfaceId: SURFACE_ID,
      engagementId: String(context.connectorBinding?.engagementId || ''),
      originalName: String(transfer.fileName || `omnia-recording-${recordingId}.json`),
      mediaType: String(transfer.mediaType || 'application/json'),
      sourceRef: `connector-recording:${recordingId}`,
      contentBase64: bytes.toString('base64')
    });
    return { exported, artifact };
  }

  async function savedExport(recordingId) {
    if (!recordingId) return null;
    const plan = await ports.store.call('loadPlan', `recording-export:${recordingId}`);
    return plan?.recordingId === recordingId && plan?.artifact?.artifactId ? plan : null;
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
      supportedTransports: ['remote']
    }),
    async handleAction(input) {
      const context = input?.context || {};
      if (input.actionId === 'refresh-status') {
        const result = await invoke('status', context);
        const previous = await savedExport(result.recordingId);
        const projected = previous ? { ...result, exportedAt: previous.exportedAt } : result;
        await save('recording_status_refreshed', result);
        return { surfacePatch: statusPatch(projected, previous ? [previous.artifact] : undefined) };
      }
      if (input.actionId === 'start-recording') {
        let status = await invoke('status', context);
        const previous = await savedExport(status.recordingId);
        if (previous) status = { ...status, exportedAt: previous.exportedAt };
        if (status?.state === 'stopped' && !status.exportedAt) throw new Error('上一份录制已停止但尚未导出；请先导出录制记录。');
        const result = status?.state === 'paused'
          ? await invoke('resume', context, status.recordingId)
          : await invoke('start', context);
        await save(status?.state === 'paused' ? 'recording_resumed' : 'recording_started', result);
        return { surfacePatch: statusPatch(result) };
      }
      if (input.actionId === 'pause-recording') {
        const status = await invoke('status', context);
        const result = await invoke('pause', context, status.recordingId);
        await save('recording_paused', result);
        return { surfacePatch: statusPatch(result) };
      }
      if (input.actionId === 'stop-recording') {
        const status = await invoke('status', context);
        const result = await invoke('stop', context, status.recordingId);
        await save('recording_stopped', result);
        return { surfacePatch: statusPatch(result) };
      }
      if (input.actionId === 'export-recording') {
        const status = await invoke('status', context);
        if (status?.state !== 'stopped') throw new Error('请先停止录制，再导出录制记录。');
        const previous = await savedExport(status.recordingId);
        if (previous) return { surfacePatch: statusPatch({ ...status, exportedAt: previous.exportedAt }, [previous.artifact]) };
        const { exported, artifact } = await exportArtifact(context, status.recordingId);
        const exportedAt = new Date().toISOString();
        const projectedArtifact = artifactProjection(artifact);
        await ports.store.call('savePlan', {
          planId: `recording-export:${status.recordingId}`,
          recordingId: status.recordingId,
          exportedAt,
          artifact: projectedArtifact
        });
        await save('recording_exported', {
          recordingId: status.recordingId,
          exportedAt,
          artifactId: artifact.artifactId,
          sizeBytes: artifact.sizeBytes,
          capture: exported.capture,
          integrity: exported.integrity
        });
        return { surfacePatch: statusPatch({ ...exported, exportedAt }, [projectedArtifact]) };
      }
      throw new Error('Recording action is not implemented by this official Feature.');
    }
  });
}

module.exports = Object.freeze({ createFeatureWorker, FEATURE_ID, FEATURE_VERSION });
