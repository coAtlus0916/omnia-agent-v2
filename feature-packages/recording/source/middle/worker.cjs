'use strict';

const crypto = require('node:crypto');
const { createPythonSidecarBridge } = require('./python-bridge.cjs');

const FEATURE_ID = 'omnia.recording';
const FEATURE_VERSION = '__FEATURE_VERSION__';
const SURFACE_ID = 'recording.workbench';
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const STREAM_CHUNK_BYTES = 128 * 1024;
const PYTHON_TRANSFER_CHUNK_BYTES = 1024 * 1024;
const STREAM_READ_CONCURRENCY = 8;
const STREAM_CHUNKS_PER_TRANSFER = PYTHON_TRANSFER_CHUNK_BYTES / STREAM_CHUNK_BYTES;
const FINALIZATION_CHECKPOINT_SCHEMA = 'omnia.recording-finalization-checkpoint/v1';
const MAINTENANCE_RUN_ID = '00000000-0000-4000-8000-000000000000';
const RECORDING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OBSERVATION_ID = /^observation_[0-9a-f]{32}$/u;
const STREAM_ID = /^stream_[0-9a-f]{32}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const HANDLE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OPS = Object.freeze({
  packRead: 'omnia.recording.pack.read.v1', open: 'omnia.recording.observation.open.v1',
  status: 'omnia.recording.observation.status.v1', pause: 'omnia.recording.observation.pause.v1',
  resume: 'omnia.recording.observation.resume.v1', stop: 'omnia.recording.observation.stop.v1',
  readChunk: 'omnia.recording.observation.read-chunk.v1'
});

function canonicalJson(value) {
  if (value === null || ['boolean', 'string', 'number'].includes(typeof value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object') throw new Error('Recovery lineage contains a non-JSON value.');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function recordingId(value, label = 'recordingId') {
  const result = String(value || '').trim().toLowerCase();
  if (result && !RECORDING_ID.test(result)) throw new Error(`${label} is not canonical.`);
  return result;
}

function isObservationUnavailableError(error) {
  const message = String(error?.message || error);
  return /Page observation is unavailable for this Operation package|Operation package is not the active registered package|Operation package is not registered/iu.test(message);
}

function artifactProjection(artifact) {
  return {
    artifactId: String(artifact?.artifactId || ''), kind: String(artifact?.kind || 'result'),
    name: String(artifact?.originalName || artifact?.name || ''), sha256: String(artifact?.sha256 || ''),
    sizeBytes: Math.max(0, Number(artifact?.sizeBytes || 0)), available: Boolean(artifact?.artifactId),
    reason: artifact?.artifactId ? '' : 'Core Artifact 不可用。'
  };
}

function historyProjection(rows) {
  const sessions = Array.isArray(rows) ? rows : [];
  return {
    items: sessions.map((row) => ({
      id: String(row.recordingId || ''), title: `录制 ${String(row.recordingId || '').slice(0, 8)}`,
      subtitle: `${String(row.state || 'unknown')} · ${Number(row.eventCount || 0)} 个事件 · ${String(row.updatedAt || '')}`,
      scopeId: 'recording-history', type: String(row.state || 'unknown'), selectable: false,
      disabledReason: '历史录制只读；下载使用对应的 Core Artifact 卡片。', concurrencyToken: ''
    })).filter((row) => row.id),
    artifacts: sessions.map((row) => row.artifact).filter((artifact) => artifact?.artifactId).map(artifactProjection)
  };
}

function recorderProjection(status) {
  const rawState = String(status?.state || 'idle');
  const state = status?.exportedAt ? 'exported'
    : rawState === 'observing' ? 'recording'
      : rawState === 'paused' ? 'paused'
        : ['stopped', 'failed'].includes(rawState) ? 'stopped'
          : rawState === 'error' ? 'error' : 'idle';
  const metrics = status?.metrics || {};
  const startedAt = String(status?.startedAt || '');
  const updatedAt = String(status?.updatedAt || startedAt);
  const elapsedMs = startedAt && updatedAt ? Math.max(0, Date.parse(updatedAt) - Date.parse(startedAt)) : 0;
  const complete = status?.complete === true;
  const incompleteCatalogCount = Math.max(0, Number(metrics.incompleteCatalogCount || 0));
  const captureState = state === 'idle' ? 'idle' : status?.processingError || state === 'error' ? 'incomplete'
    : status?.exportedAt ? (complete && incompleteCatalogCount === 0 ? 'complete' : 'incomplete')
    : ['stopped', 'error'].includes(state) && !complete ? 'incomplete' : 'pending';
  return {
    state, recordingId: String(status?.recordingId || ''), startedAt, updatedAt, elapsedMs,
    eventCount: Math.max(0, Number(status?.eventCount || 0)),
    interactionCount: Math.max(0, Number(metrics.interactionCount || 0)),
    networkRequestCount: Math.max(0, Number(metrics.networkRequestCount || 0)),
    riskCount: Math.max(0, Number(metrics.riskCount || 0)), controlCount: Math.max(0, Number(metrics.controlCount || 0)),
    captureState,
    captureMessage: String(status?.captureMessage || (captureState === 'complete'
      ? '页面观察流完整，Python 已完成 NDJSON、目录与 Artifact 固化。'
      : captureState === 'incomplete'
        ? status?.processingError
          ? `录制固化失败：${String(status?.message || '可重试同一 stopped 观察流').slice(0, 400)}`
          : incompleteCatalogCount > 0
          ? `${incompleteCatalogCount} 个 GRA 目录缺少必需的只读证据；Artifact 保留真实 incomplete 诊断。`
          : `页面观察不完整：${String(status?.terminalReason || '存在 omission')}`
        : '正在从当前 Pack 页面采集脱敏 DOM、交互与只读 JSON response evidence。')),
    exportAvailable: Boolean(status?.exportedAt && status?.artifact?.artifactId)
  };
}

function actions(status, history) {
  const state = String(status?.state || 'idle');
  const planState = String(status?.planState || '');
  const active = state === 'observing';
  const paused = state === 'paused';
  const exported = Boolean(status?.exportedAt && status?.artifact?.artifactId);
  const processingRunState = String(status?.processingRunState || '');
  const runCanFinalize = ['processing', 'uncertain'].includes(processingRunState)
    || status?.recoveryEligible === true
    || (!processingRunState && planState === 'stop_confirmed');
  const finalizationPending = state === 'stopped' && ['stop_confirmed', 'finalizing'].includes(planState) && !exported
    && runCanFinalize && OBSERVATION_ID.test(String(status?.observationId || ''));
  const retryable = state === 'stopped' && planState === 'finalization_failed' && !exported && runCanFinalize
    && OBSERVATION_ID.test(String(status?.observationId || ''));
  const startingRetry = state === 'failed' && ['starting', 'start_uncertain'].includes(planState);
  const restartable = exported || retryable
    || (state === 'stopped' && ['finalization_failed', 'incomplete'].includes(planState))
    || (state === 'failed' && !startingRetry);
  const startEnabled = paused || state === 'idle' || startingRetry;
  return [
    { actionId: 'refresh-status', label: '刷新真实状态', enabled: true, reason: '' },
    { actionId: 'start-recording', label: paused ? '继续录制' : '开始录制', enabled: startEnabled,
      reason: active ? '录制正在进行。' : restartable ? '请使用“重新开始录制”创建新的 recordingId。' : '' },
    { actionId: 'pause-recording', label: '暂停', enabled: active, reason: active ? '' : '只有正在进行的录制可以暂停。' },
    { actionId: 'stop-recording', label: '停止', enabled: active || paused, reason: active || paused ? '' : '当前没有可停止的录制。' },
    { actionId: 'restart-recording', label: '重新开始录制', enabled: restartable,
      reason: restartable ? '保留旧录制的后台证据并创建新的 recordingId。' : '停止后的固化失败、录制失败或导出完成后可以重新开始。' },
    { actionId: 'finalize-recording', label: '后台固化', enabled: finalizationPending,
      reason: finalizationPending ? '停止已确认；正在从同一冻结 managed stream 固化。' : '没有待后台固化的已停止录制。' },
    { actionId: 'retry-finalization', label: '重试固化', enabled: retryable, reason: retryable ? '重读同一冻结 managed stream，不重放停止。' : '没有仍由当前 Connector 持有的冻结观察流。' },
    { actionId: 'export-recording', label: '导出录制记录', enabled: exported,
      reason: exported ? '下载当前 recordingId 已提交的 Core Artifact。' : '当前录制尚无已提交的 Core Artifact。' }
  ];
}

function statusPatch(status, history = []) {
  const recorder = recorderProjection(status);
  const projected = historyProjection(history);
  const currentArtifact = status?.artifact?.artifactId ? artifactProjection(status.artifact) : null;
  return {
    status: status?.processingError || recorder.state === 'error' ? 'error' : recorder.state === 'recording' ? 'loading' : 'ready',
    statusMessage: String(status?.message || '录制状态来自当前签名 Operation、Feature Processing Run 与 Core Artifact。').slice(0, 500),
    scopes: projected.items.length ? [{
      id: 'recording-history', parentId: 'recording-history', label: '录制历史', parentLabel: '录制历史', selected: false
    }] : [],
    items: projected.items, selectedItemIds: [], recorder,
    artifacts: currentArtifact ? [currentArtifact, ...projected.artifacts.filter((item) => item.artifactId !== currentArtifact.artifactId)] : projected.artifacts,
    actions: actions(status, history)
  };
}

function validateStatus(value, plan = null) {
  if (value?.schemaVersion !== 'omnia.page-observation-status/v1'
    || !OBSERVATION_ID.test(String(value.observationId || '')) || !STREAM_ID.test(String(value.streamId || ''))
    || !['observing', 'paused', 'stopped', 'failed'].includes(String(value.state || ''))
    || !Number.isSafeInteger(value.eventCount) || value.eventCount < 1
    || !Number.isSafeInteger(value.lastSequence) || value.lastSequence !== value.eventCount
    || !Number.isSafeInteger(value.omissionCount) || value.omissionCount < 0
    || (plan && (value.observationId !== plan.observationId || value.streamId !== plan.streamId))) {
    throw new Error('Connector returned an invalid or drifted page observation status.');
  }
  return value;
}

function validateChunk(value, streamId, offset) {
  if (value?.schemaVersion !== 'omnia.managed-stream-chunk/v1' || value.streamId !== streamId
    || value.mediaType !== 'application/x-ndjson' || value.offset !== offset
    || !Number.isSafeInteger(value.nextOffset) || value.nextOffset < offset
    || !Number.isSafeInteger(value.availableBytes) || value.availableBytes < value.nextOffset
    || typeof value.bytesBase64 !== 'string' || typeof value.ready !== 'boolean' || typeof value.eof !== 'boolean') {
    throw new Error('Connector returned an invalid managed stream chunk.');
  }
  const bytes = Buffer.from(value.bytesBase64, 'base64');
  if (bytes.toString('base64') !== value.bytesBase64 || bytes.length !== value.nextOffset - offset
    || (value.ready && (!SHA256.test(String(value.chunkDigest || ''))
      || crypto.createHash('sha256').update(bytes).digest('hex') !== value.chunkDigest))
    || (!value.ready && (bytes.length || value.chunkDigest !== null || value.eof))) {
    throw new Error('Managed stream chunk bytes or digest are invalid.');
  }
  return bytes;
}

function createFeatureWorker(ports) {
  if (!ports?.connector?.invoke || !ports?.store?.appendEvidence || !ports?.store?.call || !ports?.events?.emit) {
    throw new Error('Recording Feature requires Connector, Store, Evidence, and Event ports.');
  }
  const python = createPythonSidecarBridge({ ports });

  async function operation(operationId, context, request = {}) {
    if (!context?.connectorBinding) throw new Error('Recording requires a frozen Connector binding.');
    return ports.connector.invoke({
      schemaVersion: 'omnia.operation-invocation/v1', featureId: FEATURE_ID, featureVersion: FEATURE_VERSION,
      operationId, request: { connectorBinding: context.connectorBinding, ...request }
    });
  }

  async function readCurrentPack(context) {
    const binding = context.connectorBinding;
    const result = await operation(OPS.packRead, context);
    if (result?.schemaVersion !== 'omnia.recording.pack-read-result/v1'
      || String(result.connectorId || '') !== String(binding.connectorId || '')
      || Number(result.sessionGeneration) !== Number(binding.sessionGeneration)
      || String(result.engagementId || '') !== String(binding.engagementId || '').toLowerCase()
      || String(result.packId || '') !== String(binding.packId || '').toLowerCase() || !String(result.name || '').trim()) {
      throw new Error('Signed current Pack read differs from the frozen Connector binding.');
    }
    return result;
  }

  async function save(checkpoint, value) {
    return ports.store.appendEvidence({
      schemaVersion: 'omnia.v5.recording-feature-evidence/v1', planId: String(value?.recordingId || 'recording'),
      checkpoint, occurredAt: new Date().toISOString(), details: value
    });
  }

  async function savePlan(plan) {
    const exactRecordingId = recordingId(plan?.recordingId);
    const planId = `recording-run:${exactRecordingId}`;
    const expectedStoreRevision = plan?.storeRevision === undefined ? 0 : Number(plan.storeRevision);
    if (!exactRecordingId || !plan.runId || !Number.isSafeInteger(expectedStoreRevision) || expectedStoreRevision < 0
      || expectedStoreRevision >= Number.MAX_SAFE_INTEGER) {
      throw new Error('Recording plan CAS identity or revision is invalid.');
    }
    const updatedAt = new Date().toISOString();
    const next = {
      ...plan, planId, storeRevision: expectedStoreRevision + 1, updatedAt
    };
    const result = await ports.store.call('compareAndSwapPlan', {
      schemaVersion: 'omnia.feature-runtime-plan-cas/v1', planId, expectedStoreRevision, plan: next
    });
    if (result?.schemaVersion !== 'omnia.feature-runtime-plan-cas-result/v1'
      || result?.planId !== planId || result?.storeRevision !== next.storeRevision) {
      throw new Error('Recording plan CAS result is invalid.');
    }
    await ports.store.call('savePlan', {
      planId: 'recording-current', recordingId: next.recordingId, runId: next.runId,
      state: next.state, updatedAt
    });
    return next;
  }

  async function loadPlan(id = '') {
    const current = id ? { recordingId: id } : await ports.store.call('loadPlan', 'recording-current');
    const exact = recordingId(current?.recordingId);
    if (!exact) return null;
    const plan = await ports.store.call('loadPlan', `recording-run:${exact}`);
    return plan?.recordingId === exact && plan?.runId ? plan : null;
  }

  async function pythonInvoke(method, payload, runId = MAINTENANCE_RUN_ID) {
    return python.invoke(method, payload, { runId, timeoutMs: 120_000 });
  }
  async function maintenance(runId = MAINTENANCE_RUN_ID) {
    const result = await pythonInvoke('maintenance', { now: new Date().toISOString(), limit: 20 }, runId);
    return Array.isArray(result?.sessions) ? result.sessions : [];
  }
  async function safeHistory(runId = MAINTENANCE_RUN_ID) {
    try { return await maintenance(runId); } catch { return []; }
  }

  async function readChunk(context, streamId, offset) {
    const value = await operation(OPS.readChunk, context, { streamId, offset });
    return { value, bytes: validateChunk(value, streamId, offset) };
  }

  async function readChunkWindow(context, streamId, offsets) {
    if (!Array.isArray(offsets) || offsets.length < 1 || offsets.length > STREAM_READ_CONCURRENCY) {
      throw new Error('Managed stream read window is invalid.');
    }
    return Promise.all(offsets.map((offset) => readChunk(context, streamId, offset)));
  }

  function expectedStreamChunk(sizeBytes, index) {
    const offset = index * STREAM_CHUNK_BYTES;
    const nextOffset = Math.min(sizeBytes, offset + STREAM_CHUNK_BYTES);
    return { index, offset, nextOffset, sizeBytes: nextOffset - offset };
  }

  function assertObservedFrozenChunk(observed, expected, frozen) {
    const { value, bytes } = observed;
    const last = expected.index === frozen.chunkCount - 1;
    if (!value.ready || value.availableBytes !== frozen.sizeBytes || value.streamDigest !== frozen.sha256
      || value.nextOffset !== expected.nextOffset || bytes.length !== expected.sizeBytes
      || value.eof !== last || (last && value.nextOffset !== frozen.sizeBytes)) {
      throw new Error('Frozen managed stream size, digest, EOF, or chunk identity drifted.');
    }
    return bytes;
  }

  function frozenIdentity(first) {
    const sizeBytes = Number(first?.value?.availableBytes);
    const sha256 = String(first?.value?.streamDigest || '');
    const chunkCount = Math.ceil(sizeBytes / STREAM_CHUNK_BYTES);
    if (!first?.value?.ready || !SHA256.test(sha256) || !Number.isSafeInteger(sizeBytes)
      || sizeBytes < 1 || sizeBytes > MAX_ARTIFACT_BYTES || chunkCount < 1 || chunkCount > 512) {
      throw new Error('Frozen managed stream size, digest, EOF, or chunk count is invalid.');
    }
    return { sizeBytes, sha256, chunkCount };
  }

  function chunkMetadata(observed, expected, frozen) {
    const bytes = assertObservedFrozenChunk(observed, expected, frozen);
    return {
      bytes,
      metadata: {
        index: expected.index, offset: expected.offset, nextOffset: expected.nextOffset,
        sizeBytes: expected.sizeBytes, sha256: String(observed.value.chunkDigest || '')
      }
    };
  }

  function mergeVerifiedChunks(plan, observedChunks) {
    const chunks = Array.isArray(plan.streamChunks) ? plan.streamChunks.map((chunk) => ({ ...chunk })) : [];
    for (const chunk of observedChunks) {
      const existing = chunks[chunk.index];
      if (existing) {
        if (existing.index !== chunk.index || existing.offset !== chunk.offset
          || existing.nextOffset !== chunk.nextOffset || existing.sizeBytes !== chunk.sizeBytes
          || existing.sha256 !== chunk.sha256) {
          throw new Error(`Frozen managed stream chunk ${chunk.index} differs from its durable checkpoint.`);
        }
      } else {
        if (chunks.length !== chunk.index) throw new Error('Durable frozen stream chunk metadata contains a gap.');
        chunks.push(chunk);
      }
    }
    if (chunks.length > Number(plan.streamChunkCount || 0)) {
      throw new Error('Durable frozen stream chunk metadata exceeds the frozen chunk count.');
    }
    return chunks;
  }

  function validateFinalizationCheckpoint(plan) {
    const checkpoint = plan?.finalization;
    if (!checkpoint) return null;
    const frozen = {
      sizeBytes: Number(plan.streamSizeBytes), sha256: String(plan.streamSha256 || ''),
      chunkCount: Number(plan.streamChunkCount)
    };
    const transferChunkCount = Math.ceil(frozen.sizeBytes / PYTHON_TRANSFER_CHUNK_BYTES);
    if (checkpoint.schemaVersion !== FINALIZATION_CHECKPOINT_SCHEMA
      || !['transfer', 'input_ready'].includes(String(checkpoint.stage || ''))
      || !Number.isSafeInteger(checkpoint.revision) || checkpoint.revision < 1
      || !HANDLE_ID.test(String(checkpoint.transferId || ''))
      || checkpoint.transferChunkCount !== transferChunkCount
      || !Number.isSafeInteger(checkpoint.nextStreamChunkIndex) || checkpoint.nextStreamChunkIndex < 0
      || checkpoint.nextStreamChunkIndex > frozen.chunkCount
      || !Number.isSafeInteger(checkpoint.nextTransferChunkIndex) || checkpoint.nextTransferChunkIndex < 0
      || checkpoint.nextTransferChunkIndex > transferChunkCount
      || !Number.isSafeInteger(checkpoint.receivedBytes) || checkpoint.receivedBytes < 0
      || checkpoint.receivedBytes > frozen.sizeBytes
      || checkpoint.nextStreamChunkIndex !== Math.min(frozen.chunkCount, checkpoint.nextTransferChunkIndex * STREAM_CHUNKS_PER_TRANSFER)
      || checkpoint.receivedBytes !== Math.min(frozen.sizeBytes, checkpoint.nextTransferChunkIndex * PYTHON_TRANSFER_CHUNK_BYTES)) {
      throw new Error('Durable recording finalization checkpoint is invalid.');
    }
    if (checkpoint.pendingAppend) {
      const pending = checkpoint.pendingAppend;
      if (checkpoint.stage !== 'transfer' || pending.transferChunkIndex !== checkpoint.nextTransferChunkIndex
        || pending.offsetBytes !== checkpoint.receivedBytes || !Number.isSafeInteger(pending.streamStartIndex)
        || pending.streamStartIndex !== checkpoint.nextStreamChunkIndex
        || !Number.isSafeInteger(pending.streamEndIndex) || pending.streamEndIndex <= pending.streamStartIndex
        || pending.streamEndIndex > frozen.chunkCount || !Number.isSafeInteger(pending.sizeBytes)
        || pending.sizeBytes < 1 || pending.sizeBytes > PYTHON_TRANSFER_CHUNK_BYTES
        || !SHA256.test(String(pending.sha256 || ''))) {
        throw new Error('Durable recording pending append checkpoint is invalid.');
      }
    }
    if (checkpoint.stage === 'input_ready') {
      const handle = checkpoint.inputHandle;
      if (checkpoint.pendingAppend || checkpoint.nextStreamChunkIndex !== frozen.chunkCount
        || checkpoint.nextTransferChunkIndex !== transferChunkCount || checkpoint.receivedBytes !== frozen.sizeBytes
        || handle?.schemaVersion !== 'omnia.python-artifact-handle/v1'
        || handle?.handleId !== checkpoint.transferId || handle?.runId !== plan.runId
        || handle?.access !== 'read' || handle?.mediaType !== 'application/x-ndjson'
        || handle?.sizeBytes !== frozen.sizeBytes || handle?.sha256 !== frozen.sha256) {
        throw new Error('Durable recording input handle checkpoint is invalid.');
      }
    }
    return checkpoint;
  }

  async function saveFinalizationCheckpoint(plan, checkpoint, patch = {}) {
    const durable = await loadPlan(plan.recordingId);
    const expectedRevision = Number(plan?.finalization?.revision || 0);
    if (!durable || durable.runId !== plan.runId || String(durable.state || '') !== 'finalizing'
      || Number(durable?.finalization?.revision || 0) !== expectedRevision) {
      throw new Error('Recording finalization checkpoint changed before compare-and-save.');
    }
    const nextCheckpoint = { ...checkpoint, schemaVersion: FINALIZATION_CHECKPOINT_SCHEMA, revision: expectedRevision + 1 };
    const next = await savePlan({ ...durable, ...patch, state: 'finalizing', finalization: nextCheckpoint, error: '' });
    const confirmed = await loadPlan(plan.recordingId);
    if (!confirmed || confirmed.runId !== plan.runId
      || Number(confirmed?.finalization?.revision || 0) !== nextCheckpoint.revision
      || String(confirmed?.finalization?.transferId || '') !== String(nextCheckpoint.transferId || '')) {
      throw new Error('Recording finalization checkpoint was not durably saved.');
    }
    validateFinalizationCheckpoint(confirmed);
    return { ...next, finalization: nextCheckpoint };
  }

  async function releaseTransferIdentity(transferId) {
    if (!HANDLE_ID.test(String(transferId || ''))) return;
    await ports.store.call('abortPythonInputTransfer', { transferId }).catch(() => undefined);
    await ports.store.call('releasePythonArtifactHandles', { handleIds: [transferId] }).catch(() => undefined);
  }

  function isRecoverableTransferLoss(error) {
    return /Python input transfer is unavailable|Python input transfer chunk is out of order/iu.test(String(error?.message || error));
  }

  function isPlanCasMismatch(error) {
    return String(error?.code || '') === 'FEATURE.PLAN_CAS_MISMATCH';
  }

  async function resetFrozenTransfer(plan, reason) {
    const durable = await loadPlan(plan.recordingId);
    if (!durable || durable.runId !== plan.runId
      || Number(durable?.finalization?.revision || 0) !== Number(plan?.finalization?.revision || 0)) {
      throw new Error('Recording finalization checkpoint changed before transfer recovery.');
    }
    await releaseTransferIdentity(durable?.finalization?.transferId);
    const { finalization: _discarded, ...retained } = durable;
    const reset = await savePlan({
      ...retained, state: 'finalizing', transferRestartCount: Number(durable.transferRestartCount || 0) + 1,
      transferRecoveryReason: String(reason || 'Core transfer checkpoint was unavailable.').slice(0, 500), error: ''
    });
    await save('recording_transfer_reopened', {
      recordingId: plan.recordingId, runId: plan.runId, streamSha256: String(plan.streamSha256 || ''),
      streamSizeBytes: Number(plan.streamSizeBytes || 0), stopReplayed: false,
      transferRestartCount: Number(reset.transferRestartCount || 0)
    });
    return reset;
  }

  async function beginFrozenTransfer(context, plan) {
    const first = await readChunk(context, plan.streamId, 0);
    const frozen = frozenIdentity(first);
    assertSameFrozenStream(plan, frozen);
    const transferChunkCount = Math.ceil(frozen.sizeBytes / PYTHON_TRANSFER_CHUNK_BYTES);
    const transfer = await ports.store.call('beginPythonInputTransfer', {
      runId: plan.runId, originalName: `omnia-page-observation-${plan.recordingId}.ndjson`,
      mediaType: 'application/x-ndjson', expectedSizeBytes: frozen.sizeBytes,
      expectedSha256: frozen.sha256, chunkCount: transferChunkCount,
      recovery: {
        schemaVersion: 'omnia.processing-run-frozen-input-recovery/v1', externalId: plan.recordingId,
        connectorState: 'stopped', frozenSha256: frozen.sha256,
        frozenSizeBytes: frozen.sizeBytes, frozenChunkCount: transferChunkCount
      }
    });
    const transferId = String(transfer?.transferId || '');
    if (transfer?.schemaVersion !== 'omnia.python-input-transfer/v1'
      || !HANDLE_ID.test(transferId) || transfer?.runId !== plan.runId
      || transfer?.expectedSizeBytes !== frozen.sizeBytes || transfer?.expectedSha256 !== frozen.sha256
      || transfer?.chunkCount !== transferChunkCount || transfer?.nextChunkIndex !== 0
      || transfer?.receivedBytes !== 0) throw new Error('Core rejected the frozen Python input transfer.');
    const bound = await saveFinalizationCheckpoint(plan, {
      stage: 'transfer', transferId, transferChunkCount,
      nextStreamChunkIndex: 0, nextTransferChunkIndex: 0, receivedBytes: 0
    }, {
      streamSizeBytes: frozen.sizeBytes, streamSha256: frozen.sha256, streamChunkCount: frozen.chunkCount
    });
    return advanceFrozenTransfer(context, bound, first);
  }

  async function advanceFrozenTransfer(context, plan, firstObserved = null) {
    let checkpoint = validateFinalizationCheckpoint(plan);
    if (!checkpoint || checkpoint.stage !== 'transfer') throw new Error('Recording transfer checkpoint is not resumable.');
    const frozen = {
      sizeBytes: Number(plan.streamSizeBytes), sha256: String(plan.streamSha256),
      chunkCount: Number(plan.streamChunkCount)
    };
    if (checkpoint.nextStreamChunkIndex === frozen.chunkCount) {
      try {
        const handle = await ports.store.call('commitPythonInputTransfer', { transferId: checkpoint.transferId });
        if (handle?.handleId !== checkpoint.transferId || handle?.runId !== plan.runId || handle?.access !== 'read'
          || handle?.mediaType !== 'application/x-ndjson' || handle?.sizeBytes !== frozen.sizeBytes
          || handle?.sha256 !== frozen.sha256) throw new Error('Core committed Python input differs from the frozen managed stream.');
        return saveFinalizationCheckpoint(plan, { ...checkpoint, stage: 'input_ready', inputHandle: handle });
      } catch (error) {
        if (!isRecoverableTransferLoss(error)) throw error;
        return resetFrozenTransfer(plan, error);
      }
    }

    const start = checkpoint.nextStreamChunkIndex;
    const expectedWindow = Array.from(
      { length: Math.min(STREAM_CHUNKS_PER_TRANSFER, frozen.chunkCount - start) },
      (_, position) => expectedStreamChunk(frozen.sizeBytes, start + position)
    );
    const observedWindow = [];
    if (firstObserved && start === 0) observedWindow.push(firstObserved);
    const remaining = expectedWindow.slice(observedWindow.length);
    if (remaining.length) observedWindow.push(...await readChunkWindow(context, plan.streamId, remaining.map((chunk) => chunk.offset)));
    const verified = expectedWindow.map((expected, index) => chunkMetadata(observedWindow[index], expected, frozen));
    const bytes = Buffer.concat(verified.map((item) => item.bytes));
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const metadata = verified.map((item) => item.metadata);
    const streamChunks = mergeVerifiedChunks(plan, metadata);
    const pendingAppend = {
      transferChunkIndex: checkpoint.nextTransferChunkIndex, offsetBytes: checkpoint.receivedBytes,
      streamStartIndex: start, streamEndIndex: start + expectedWindow.length,
      sizeBytes: bytes.length, sha256
    };
    if (checkpoint.pendingAppend) {
      if (JSON.stringify(checkpoint.pendingAppend) !== JSON.stringify(pendingAppend)) {
        throw new Error('Frozen managed stream transfer batch differs from its durable pending checkpoint.');
      }
    } else {
      plan = await saveFinalizationCheckpoint(plan, { ...checkpoint, pendingAppend }, { streamChunks });
      checkpoint = validateFinalizationCheckpoint(plan);
    }
    try {
      const progress = await ports.store.call('appendPythonInputTransferChunk', {
        transferId: checkpoint.transferId, chunkIndex: pendingAppend.transferChunkIndex,
        offsetBytes: pendingAppend.offsetBytes, contentBase64: bytes.toString('base64'), sha256
      });
      if (progress?.acceptedChunkIndex !== pendingAppend.transferChunkIndex
        || progress?.nextChunkIndex !== pendingAppend.transferChunkIndex + 1
        || progress?.receivedBytes !== pendingAppend.offsetBytes + bytes.length
        || progress?.chunkSha256 !== sha256) throw new Error('Core Python input transfer progress drifted.');
    } catch (error) {
      if (!isRecoverableTransferLoss(error)) throw error;
      return resetFrozenTransfer(plan, error);
    }
    const { pendingAppend: _completed, ...advancedCheckpoint } = checkpoint;
    return saveFinalizationCheckpoint(plan, {
      ...advancedCheckpoint,
      nextStreamChunkIndex: pendingAppend.streamEndIndex,
      nextTransferChunkIndex: pendingAppend.transferChunkIndex + 1,
      receivedBytes: pendingAppend.offsetBytes + bytes.length
    }, { streamChunks });
  }

  function assertSameFrozenStream(plan, frozen) {
    const hasFrozenIdentity = Boolean(plan.streamSha256 || plan.streamSizeBytes || plan.streamChunkCount);
    if (!hasFrozenIdentity) return;
    if (!SHA256.test(String(plan.streamSha256 || ''))
      || !Number.isSafeInteger(plan.streamSizeBytes) || plan.streamSizeBytes < 1
      || !Number.isSafeInteger(plan.streamChunkCount) || plan.streamChunkCount < 1) {
      throw new Error('Durable frozen managed stream identity is incomplete.');
    }
    if (plan.streamSha256 !== frozen.sha256 || plan.streamSizeBytes !== frozen.sizeBytes
      || plan.streamChunkCount !== frozen.chunkCount) {
      throw new Error('Frozen managed stream differs from the first verified finalization input.');
    }
  }

  function withoutFinalizationCheckpoint(plan) {
    const { finalization: _checkpoint, transferRecoveryReason: _recoveryReason, ...retained } = plan;
    return retained;
  }

  function successorFrozenInput(plan) {
    const frozen = {
      schemaVersion: 'omnia.recording-frozen-input/v1',
      observationId: String(plan?.observationId || ''), streamId: String(plan?.streamId || ''),
      stoppedAt: String(plan?.stoppedAt || ''), eventCount: Number(plan?.eventCount),
      complete: true, omissionCount: 0,
      streamSha256: String(plan?.streamSha256 || ''), streamSizeBytes: Number(plan?.streamSizeBytes),
      streamChunkCount: Number(plan?.streamChunkCount)
    };
    if (!OBSERVATION_ID.test(frozen.observationId) || !STREAM_ID.test(frozen.streamId)
      || !frozen.stoppedAt || !Number.isSafeInteger(frozen.eventCount) || frozen.eventCount < 1
      || !SHA256.test(frozen.streamSha256) || !Number.isSafeInteger(frozen.streamSizeBytes)
      || frozen.streamSizeBytes < 1 || !Number.isSafeInteger(frozen.streamChunkCount)
      || frozen.streamChunkCount < 1) {
      throw new Error('Failed Recording Run lacks complete frozen-input evidence for successor recovery.');
    }
    return frozen;
  }

  function hasCompleteSuccessorFrozenInput(plan) {
    return SHA256.test(String(plan?.streamSha256 || ''))
      && Number.isSafeInteger(plan?.streamSizeBytes) && plan.streamSizeBytes > 0
      && Number.isSafeInteger(plan?.streamChunkCount) && plan.streamChunkCount > 0;
  }

  async function recoverFailedFinalizationSuccessor(plan) {
    if (plan?.predecessorRunId || plan?.recoveryLineage) return plan;
    if (String(plan?.state || '') !== 'finalization_failed') return plan;
    if (!hasCompleteSuccessorFrozenInput(plan)) return plan;
    const readablePredecessor = await ports.store.call('loadProcessingRun', { runId: plan.runId });
    if (['processing', 'uncertain', 'succeeded'].includes(String(readablePredecessor?.state || ''))) return plan;
    const predecessorRunId = String(plan.runId || '');
    const frozenInput = successorFrozenInput(plan);
    const successor = await ports.store.call('createSuccessorProcessingRun', {
      schemaVersion: 'omnia.processing-run-successor-request/v1', predecessorRunId,
      surfaceId: SURFACE_ID, engagementId: String(plan.engagementId || ''),
      externalId: plan.recordingId, sourceRef: `connector-recording:${plan.recordingId}`, frozenInput
    });
    if (successor?.schemaVersion !== 'omnia.processing-run/v1'
      || !RECORDING_ID.test(String(successor.runId || '')) || successor.runId === predecessorRunId
      || successor.externalId !== plan.recordingId || successor.surfaceId !== SURFACE_ID
      || successor.state !== 'processing' || successor.predecessorRunId !== predecessorRunId
      || successor.recoveryLineage?.recoveryKind !== 'frozen_input_finalize'
      || successor.recoveryLineage?.predecessorRunId !== predecessorRunId
      || JSON.stringify(successor.recoveryLineage?.frozenInput) !== JSON.stringify(frozenInput)) {
      throw new Error('Core returned an invalid or conflicting successor Processing Run.');
    }
    const lineageDigest = crypto.createHash('sha256').update(canonicalJson(successor.recoveryLineage)).digest('hex');
    const adoption = await pythonInvoke('adopt_successor_run', {
      recordingId: plan.recordingId, predecessorRunId, successorRunId: successor.runId,
      startedAt: String(plan.startedAt || ''), stoppedAt: frozenInput.stoppedAt,
      eventCount: frozenInput.eventCount, recoveryLineage: successor.recoveryLineage, lineageDigest
    }, successor.runId);
    if (adoption?.schemaVersion !== 'omnia.recording-successor-adoption/v1'
      || adoption.recordingId !== plan.recordingId || adoption.predecessorRunId !== predecessorRunId
      || adoption.successorRunId !== successor.runId || adoption.lineageDigest !== lineageDigest
      || adoption.session?.recordingId !== plan.recordingId || adoption.session?.runId !== successor.runId
      || adoption.session?.state !== 'finalizing' || adoption.session?.eventCount !== frozenInput.eventCount
      || adoption.session?.stoppedAt !== frozenInput.stoppedAt) {
      throw new Error('Python successor adoption differs from the frozen recovery lineage.');
    }
    const predecessorFinalization = plan.finalization ? {
      schemaVersion: FINALIZATION_CHECKPOINT_SCHEMA,
      stage: String(plan.finalization.stage || ''), transferId: String(plan.finalization.transferId || ''),
      nextStreamChunkIndex: Number(plan.finalization.nextStreamChunkIndex || 0),
      nextTransferChunkIndex: Number(plan.finalization.nextTransferChunkIndex || 0),
      receivedBytes: Number(plan.finalization.receivedBytes || 0)
    } : null;
    const recoveredAt = new Date().toISOString();
    const recovered = await savePlan({
      ...withoutFinalizationCheckpoint(plan), runId: successor.runId, state: 'finalizing', error: '',
      predecessorRunId, recoveryLineage: successor.recoveryLineage, predecessorFinalization,
      recoveryLineageDigest: lineageDigest, recoveredAt, stopReplayed: false
    });
    await save('recording_successor_run_adopted', {
      recordingId: plan.recordingId, predecessorRunId, successorRunId: successor.runId,
      observationId: frozenInput.observationId, streamId: frozenInput.streamId,
      eventCount: frozenInput.eventCount, stoppedAt: frozenInput.stoppedAt,
      recoveredAt, stopReplayed: false
    });
    return recovered;
  }

  async function reconcileRun(plan) {
    const run = await ports.store.call('loadProcessingRun', { runId: plan.runId });
    if (run?.state !== 'succeeded' || !run.artifact?.artifactId) return run;
    const artifact = artifactProjection(run.artifact);
    const exportedAt = String(run.updatedAt || new Date().toISOString());
    try {
      await pythonInvoke('mark_finalized', { recordingId: plan.recordingId, runId: plan.runId, artifact, finalizedAt: exportedAt }, plan.runId);
    } catch { /* Artifact is already authoritative; retention metadata can retry later. */ }
    if (plan?.finalization?.transferId) {
      await ports.store.call('releasePythonArtifactHandles', { handleIds: [plan.finalization.transferId] }).catch(() => undefined);
    }
    await savePlan({ ...withoutFinalizationCheckpoint(plan), state: 'finalized', artifact, exportedAt });
    return { ...run, artifact, exportedAt };
  }

  async function abandonPlan(plan, state, message) {
    const stoppedAt = String(plan.stoppedAt || new Date().toISOString());
    if (plan?.finalization?.transferId) await releaseTransferIdentity(plan.finalization.transferId);
    await ports.store.call('failProcessingRun', { runId: plan.runId, state: 'failed', error: message });
    await pythonInvoke('mark_state', {
      recordingId: plan.recordingId, runId: plan.runId, state: 'failed', stoppedAt, error: message
    }, plan.runId).catch(() => undefined);
    const abandoned = await savePlan({ ...withoutFinalizationCheckpoint(plan), state, stoppedAt, error: message });
    await save('recording_abandoned', { recordingId: plan.recordingId, runId: plan.runId, state, error: message });
    return abandoned;
  }

  async function persistUncertain(plan, state, error) {
    const message = String(error?.message || error).slice(0, 2000);
    await pythonInvoke('mark_state', {
      recordingId: plan.recordingId, runId: plan.runId, state: 'uncertain',
      startedAt: plan.startedAt, error: message
    }, plan.runId).catch(() => undefined);
    await savePlan({ ...plan, state, error: message });
    throw error;
  }

  async function completeStart(context, pack, plan) {
    let durablePlan = plan;
    try {
      // The current Core plan is already durable before this function is
      // entered. Persist the Feature-private Python state as well before the
      // first external PageObservation effect. Retrying a starting/uncertain
      // plan is idempotent and never creates a second recording identity.
      await pythonInvoke('mark_state', {
        recordingId: plan.recordingId, runId: plan.runId, state: 'starting', startedAt: plan.startedAt
      }, plan.runId);
      const opened = validateStatus(await operation(OPS.open, context, { recordingId: plan.recordingId }));
      if (opened.state !== 'observing' || opened.engagementId !== context.connectorBinding.engagementId) {
        throw new Error('Page observation did not bind the exact current Pack.');
      }
      durablePlan = await savePlan({
        ...durablePlan, state: 'observing', observationId: opened.observationId, streamId: opened.streamId,
        startedAt: opened.startedAt, eventCount: opened.eventCount, error: ''
      });
      await pythonInvoke('mark_state', {
        recordingId: plan.recordingId, runId: plan.runId, state: 'active', startedAt: opened.startedAt
      }, plan.runId);
      await save('recording_started', {
        recordingId: plan.recordingId, observationId: opened.observationId, streamId: opened.streamId
      });
      return { surfacePatch: statusPatch({
        ...opened, recordingId: plan.recordingId, message: `当前 Pack：${pack.name}。已开始真实页面观察。`
      }, await safeHistory(durablePlan.runId)) };
    } catch (error) {
      if (isPlanCasMismatch(error)) throw error;
      return persistUncertain(durablePlan, 'start_uncertain', error);
    }
  }

  async function finalizeStopped(context, plan, stopped) {
    try {
      const finalized = await finalizeObservation(context, plan, stopped);
      return { surfacePatch: statusPatch(finalized, await safeHistory(plan.runId)) };
    } catch (error) {
      if (isPlanCasMismatch(error)) throw error;
      const message = String(error?.message || error).slice(0, 2000);
      const canRetryFrozenStream = stopped.state === 'stopped' && stopped.complete === true && stopped.omissionCount === 0;
      const durable = await loadPlan(plan.recordingId);
      const retryPlan = durable?.recordingId === plan.recordingId && durable?.runId === plan.runId ? durable : plan;
      const inputHandleLost = retryPlan?.finalization?.stage === 'input_ready'
        && /ENOENT|No such file|input handle is unavailable|Artifact handle is unavailable/iu.test(message);
      if (canRetryFrozenStream && inputHandleLost) {
        const reset = await resetFrozenTransfer(retryPlan, message);
        return { surfacePatch: statusPatch({
          ...stopped, recordingId: plan.recordingId, planState: 'finalizing', processingRunState: 'processing',
          message: '已停止；Shell 重启后的临时输入 handle 已失效，正在对同一 frozen stream 安全重开传输，未重复 stop。'
        }, await safeHistory(plan.runId)) };
      }
      if (!canRetryFrozenStream) {
        await ports.store.call('failProcessingRun', { runId: plan.runId, state: 'failed', error: message });
      }
      await pythonInvoke('mark_state', {
        recordingId: plan.recordingId, runId: plan.runId, state: 'failed',
        stoppedAt: stopped.stoppedAt, error: message
      }, plan.runId).catch(() => undefined);
      const planState = canRetryFrozenStream ? 'finalization_failed' : 'incomplete';
      await savePlan({ ...retryPlan, state: planState, eventCount: stopped.eventCount, stoppedAt: stopped.stoppedAt, error: message });
      return { surfacePatch: statusPatch({
        ...stopped, recordingId: plan.recordingId, processingError: true, message, planState,
        processingRunState: canRetryFrozenStream ? 'processing' : 'failed'
      }, await safeHistory(plan.runId)) };
    }
  }

  async function finalizeObservation(context, plan, status) {
    if (status.state !== 'stopped' || status.complete !== true || status.omissionCount !== 0) {
      throw new Error(`页面观察不完整，不能标记为完整录制：${String(status.terminalReason || 'omission')}`);
    }
    let checkpoint = validateFinalizationCheckpoint(plan);
    if (!checkpoint) {
      plan = await beginFrozenTransfer(context, plan);
      checkpoint = validateFinalizationCheckpoint(plan);
      return {
        ...status, recordingId: plan.recordingId, planState: 'finalizing', processingRunState: 'processing',
        message: `已停止（${status.eventCount} 个事件），正在固化：已安全传输 ${Number(checkpoint?.receivedBytes || 0)}/${Number(plan.streamSizeBytes || 0)} 字节。`
      };
    }
    if (checkpoint.stage === 'transfer') {
      plan = await advanceFrozenTransfer(context, plan);
      checkpoint = validateFinalizationCheckpoint(plan);
      return {
        ...status, recordingId: plan.recordingId, planState: 'finalizing', processingRunState: 'processing',
        message: checkpoint
          ? `已停止（${status.eventCount} 个事件），正在固化：已安全传输 ${checkpoint.receivedBytes}/${Number(plan.streamSizeBytes || 0)} 字节。`
          : `已停止（${status.eventCount} 个事件），Core 传输断点已安全重开，未重复 stop。`
      };
    }
    const frozen = {
      sizeBytes: Number(plan.streamSizeBytes), sha256: String(plan.streamSha256),
      chunkCount: Number(plan.streamChunkCount)
    };
    const inputHandle = checkpoint.inputHandle;
    let outputHandle;
    let completed = false;
    try {
      outputHandle = await ports.store.call('createPythonOutputHandle', {
        runId: plan.runId, kind: 'result', mediaType: 'application/json',
        originalName: `omnia-recording-${plan.recordingId}.json`, maxBytes: MAX_ARTIFACT_BYTES
      });
      const transformed = await pythonInvoke('ingest_and_export', {
        runId: plan.runId, recordingId: plan.recordingId, inputHandle, outputHandle,
        observationStatus: status, streamSizeBytes: frozen.sizeBytes, streamSha256: frozen.sha256
      }, plan.runId);
      if (transformed?.recordingId !== plan.recordingId || transformed?.runId !== plan.runId
        || transformed?.artifact?.handleId !== outputHandle.handleId || !SHA256.test(String(transformed?.sha256 || ''))
        || !Number.isSafeInteger(transformed?.sizeBytes) || transformed.sizeBytes < 1 || transformed.sizeBytes > MAX_ARTIFACT_BYTES
        || transformed.eventCount !== status.eventCount) throw new Error('Python recording result differs from the frozen observation.');
      const committed = await ports.store.call('commitPythonOutputHandle', { handleId: outputHandle.handleId, sha256: transformed.sha256 });
      if (!committed?.artifactId || committed.sha256 !== transformed.sha256 || committed.sizeBytes !== transformed.sizeBytes) {
        throw new Error('Core committed Artifact differs from Python streaming output.');
      }
      outputHandle = null;
      const finished = await ports.store.call('finishProcessingRun', { runId: plan.runId, artifactId: committed.artifactId });
      const artifact = artifactProjection(finished.artifact || committed);
      const exportedAt = String(finished.completedAt || new Date().toISOString());
      await pythonInvoke('mark_finalized', { recordingId: plan.recordingId, runId: plan.runId, artifact, finalizedAt: exportedAt }, plan.runId).catch(() => undefined);
      const completedPlan = await savePlan({
        ...withoutFinalizationCheckpoint(plan), state: 'finalized', artifact, exportedAt,
        streamSizeBytes: frozen.sizeBytes, streamSha256: frozen.sha256,
        metrics: transformed.metrics || {}, stoppedAt: status.stoppedAt, error: ''
      });
      await save('recording_finalized', { recordingId: plan.recordingId, runId: plan.runId, artifactId: artifact.artifactId, ...transformed.metrics });
      completed = true;
      return { ...status, recordingId: plan.recordingId, artifact, exportedAt, metrics: completedPlan.metrics };
    } finally {
      const handleIds = [completed ? inputHandle?.handleId : '', outputHandle?.handleId].filter(Boolean);
      if (handleIds.length) await ports.store.call('releasePythonArtifactHandles', { handleIds }).catch(() => undefined);
    }
  }

  async function currentStatus(context, plan) {
    if (!plan) return { state: 'idle', recordingId: '', eventCount: 0, metrics: {} };
    const reconciled = await reconcileRun(plan);
    if (reconciled?.state === 'succeeded' && reconciled.artifact?.artifactId) {
      return { state: 'stopped', complete: true, recordingId: plan.recordingId, startedAt: plan.startedAt,
        updatedAt: reconciled.exportedAt, eventCount: Number(plan.eventCount || 0), metrics: plan.metrics || {},
        artifact: reconciled.artifact, exportedAt: reconciled.exportedAt, planState: 'finalized' };
    }
    if (!plan.observationId || !plan.streamId) {
      if (['starting', 'start_uncertain'].includes(String(plan.state || ''))) {
        return {
          state: 'failed', complete: false, recordingId: plan.recordingId, startedAt: plan.startedAt,
          updatedAt: plan.updatedAt, eventCount: 0, metrics: {}, planState: plan.state,
          message: '录制启动结果尚未确认；再次点击开始会使用同一 recordingId 幂等恢复，不会创建第二条观察流。'
        };
      }
      const message = '上一份录制已结束，但旧版本未保存可核验的 observationId/streamId；旧 Run 已明确关闭，可直接开始新录制。';
      await abandonPlan(plan, 'abandoned_legacy_identity', message);
      return {
        state: 'failed', complete: false, recordingId: plan.recordingId, startedAt: plan.startedAt,
        updatedAt: new Date().toISOString(), eventCount: Number(plan.eventCount || 0),
        terminalReason: 'legacy_observation_identity_missing', metrics: plan.metrics || {}, message,
        planState: 'abandoned_legacy_identity'
      };
    }
    const binding = context?.connectorBinding || {};
    const sameSession = String(plan.connectorId || '') === String(binding.connectorId || '')
      && Number(plan.sessionGeneration) === Number(binding.sessionGeneration)
      && String(plan.engagementId || '') === String(binding.engagementId || '');
    if (!sameSession) {
      const message = '原页面观察流属于旧 Connector 会话，不能跨 Connector 进程恢复。';
      await abandonPlan(plan, 'abandoned_session', message);
      return {
        state: 'failed', complete: false, recordingId: plan.recordingId, observationId: plan.observationId,
        startedAt: plan.startedAt, updatedAt: new Date().toISOString(), eventCount: Number(plan.eventCount || 0),
        terminalReason: 'connector_session_changed', metrics: plan.metrics || {}, message, planState: 'abandoned_session'
      };
    }
    try {
      const status = validateStatus(await operation(OPS.status, context, { observationId: plan.observationId }), plan);
      let reconciledPlan = plan;
      if (status.state === 'observing' && ['pausing', 'pause_uncertain', 'resuming', 'resume_uncertain', 'uncertain'].includes(plan.state)) {
        await pythonInvoke('mark_state', {
          recordingId: plan.recordingId, runId: plan.runId, state: 'active', startedAt: status.startedAt
        }, plan.runId);
        reconciledPlan = await savePlan({ ...plan, state: 'observing', eventCount: status.eventCount, error: '' });
      } else if (status.state === 'paused' && ['pausing', 'pause_uncertain', 'resuming', 'resume_uncertain', 'uncertain'].includes(plan.state)) {
        await pythonInvoke('mark_state', {
          recordingId: plan.recordingId, runId: plan.runId, state: 'paused', startedAt: status.startedAt
        }, plan.runId);
        reconciledPlan = await savePlan({ ...plan, state: 'paused', eventCount: status.eventCount, error: '' });
      } else if (status.state === 'stopped' && ['stopping', 'stop_uncertain', 'finalizing'].includes(plan.state)) {
        reconciledPlan = await savePlan({
          ...plan, state: status.complete === true && status.omissionCount === 0 ? 'stop_confirmed' : 'incomplete',
          eventCount: status.eventCount, stoppedAt: status.stoppedAt, error: ''
        });
      }
      return {
        ...status, recordingId: plan.recordingId, metrics: plan.metrics || {}, planState: reconciledPlan.state,
        processingRunState: String(reconciled?.state || '')
      };
    } catch (error) {
      if (!isObservationUnavailableError(error)) throw error;
      const detail = String(error?.message || error).slice(0, 1200);
      const message = `原页面观察流已不可读取，旧录制 Run 已关闭；可直接开始新录制。${detail ? ` ${detail}` : ''}`;
      await abandonPlan(plan, 'abandoned_observation', message);
      return {
        state: 'failed', complete: false, recordingId: plan.recordingId, observationId: plan.observationId,
        startedAt: plan.startedAt, updatedAt: new Date().toISOString(), eventCount: Number(plan.eventCount || 0),
        terminalReason: 'observation_unavailable', metrics: plan.metrics || {}, message, planState: 'abandoned_observation'
      };
    }
  }

  async function recoverSurfaceAtStartup() {
    let plan = await loadPlan();
    if (!plan) return null;
    plan = await recoverFailedFinalizationSuccessor(plan);
    if (plan.state === 'finalizing') {
      const message = plan.finalization
        ? 'Feature Worker 在固化期间重新启动；同一 frozen stream、分块摘要与 Core transfer 断点均已保留，将自动继续。'
        : 'Feature Worker 在固化开始前重新启动；同一 frozen stream identity 已保留，将自动从有界首批继续。';
      await save('recording_finalization_interrupted', {
        recordingId: plan.recordingId, runId: plan.runId, eventCount: Number(plan.eventCount || 0),
        streamSha256: String(plan.streamSha256 || ''), evidenceRetained: true, stopReplayed: false,
        transferId: String(plan?.finalization?.transferId || ''),
        nextStreamChunkIndex: Number(plan?.finalization?.nextStreamChunkIndex || 0)
      }).catch(() => undefined);
      plan = { ...plan, error: '', recoveryMessage: message };
    }
    const run = await reconcileRun(plan);
    if (plan.state === 'finalizing' && run?.state !== 'succeeded'
      && !['processing', 'uncertain'].includes(String(run?.state || ''))) {
      const message = 'Feature Worker 在固化期间重新启动，但 Core Run 已不再可固化；冻结证据保留，只允许重新开始。';
      plan = await savePlan({ ...plan, state: 'finalization_failed', error: message });
    }
    if (run?.state === 'succeeded' && run.artifact?.artifactId) {
      const artifact = artifactProjection(run.artifact);
      return statusPatch({
        state: 'stopped', complete: true, omissionCount: 0,
        recordingId: plan.recordingId, observationId: plan.observationId,
        startedAt: plan.startedAt, stoppedAt: plan.stoppedAt, updatedAt: String(run.updatedAt || plan.updatedAt || ''),
        eventCount: Number(plan.eventCount || 0), metrics: plan.metrics || {}, planState: 'finalized',
        processingRunState: 'succeeded', artifact, exportedAt: String(run.updatedAt || plan.exportedAt || new Date().toISOString()),
        message: '已从 Core committed Artifact 恢复上一份录制；可以下载或重新开始录制。'
      }, await safeHistory(plan.runId));
    }
    const planState = String(plan.state || 'failed');
    const projectedState = planState === 'paused' ? 'paused'
      : ['observing', 'pausing', 'pause_uncertain', 'resuming', 'resume_uncertain', 'uncertain'].includes(planState) ? 'observing'
        : ['stop_confirmed', 'finalizing', 'finalization_failed', 'incomplete', 'stopping', 'stop_uncertain'].includes(planState) ? 'stopped'
          : 'failed';
    const incomplete = planState === 'incomplete';
    const recoveryEligible = planState === 'finalization_failed' && !plan.predecessorRunId
      && RECORDING_ID.test(String(plan.recordingId || '')) && RECORDING_ID.test(String(plan.runId || ''))
      && OBSERVATION_ID.test(String(plan.observationId || '')) && STREAM_ID.test(String(plan.streamId || ''))
      && Boolean(plan.stoppedAt) && Number.isSafeInteger(plan.eventCount) && plan.eventCount > 0;
    const runCanFinalize = ['processing', 'uncertain'].includes(String(run?.state || '')) || recoveryEligible;
    const message = planState === 'finalizing'
      ? String(plan.recoveryMessage || '上一份录制已停止，正在从持久化断点继续固化；不会重复 stop。')
      : planState === 'finalization_failed'
      ? runCanFinalize
        ? '上一份录制已停止但固化失败；可重试同一 frozen stream，或使用“重新开始录制”保留旧证据并创建新 recordingId。'
        : '上一份录制的 Core Run 已终态收口；旧 frozen stream 与证据仍保留，请使用“重新开始录制”创建新 recordingId。'
      : incomplete
        ? '上一份录制流不完整；旧证据已保留，可使用“重新开始录制”创建新 recordingId。'
        : ['stopping', 'stop_uncertain'].includes(planState)
          ? '上次停止结果尚需通过当前 Connector 只读状态确认；请刷新真实状态。'
          : projectedState === 'observing'
            ? '已恢复上次录制的持久化控制意图；请刷新真实状态后继续操作。'
            : '已恢复上一份录制状态；可使用“重新开始录制”创建新 recordingId。';
    return statusPatch({
      state: projectedState, complete: projectedState === 'stopped' && !incomplete,
      omissionCount: incomplete ? 1 : 0, recordingId: plan.recordingId, observationId: plan.observationId,
      startedAt: plan.startedAt, stoppedAt: plan.stoppedAt, updatedAt: plan.updatedAt,
      eventCount: Number(plan.eventCount || 0), metrics: plan.metrics || {}, planState,
      processingRunState: String(run?.state || ''), processingError: ['finalization_failed', 'incomplete'].includes(planState),
      recoveryEligible,
      artifact: plan.artifact, exportedAt: plan.exportedAt, message
    }, await safeHistory(plan.runId));
  }

  return Object.freeze({
    health: async () => ({
      schemaVersion: 'omnia.feature-worker-health/v1', featureId: FEATURE_ID, featureVersion: FEATURE_VERSION,
      ready: true, mutationEnabled: false, requiresConnector: true, requiresSafetyLock: false,
      supportedTransports: ['remote'], pythonSidecar: 'cpython-3.13.14-embed-amd64',
      requiredCapability: 'omnia.page-observation.current-pack.v1',
      recoveredSurfacePatch: await recoverSurfaceAtStartup()
    }),
    async handleAction(input) {
      const context = input?.context || {};
      if (input.actionId === 'refresh-status') {
        const pack = await readCurrentPack(context);
        const plan = await loadPlan();
        const status = await currentStatus(context, plan);
        return { surfacePatch: statusPatch({ ...status, message: `当前 Pack：${pack.name}。已读取真实观察与 Artifact 状态。` }, await safeHistory(plan?.runId)) };
      }
      if (input.actionId === 'start-recording' || input.actionId === 'restart-recording') {
        const restartRequested = input.actionId === 'restart-recording';
        const pack = await readCurrentPack(context);
        let current = await loadPlan();
        if (current) {
          if (['starting', 'start_uncertain'].includes(String(current.state || ''))) {
            if (restartRequested) throw new Error('录制启动结果尚未确认；请先使用“开始录制”恢复同一 recordingId。');
            return completeStart(context, pack, current);
          }
          const status = await currentStatus(context, current);
          current = await loadPlan(current.recordingId) || current;
          if (status.state === 'observing') throw new Error('录制正在进行，不能重复开始。');
          if (status.state === 'paused') {
            if (restartRequested) throw new Error('当前录制已暂停；请先停止，再重新开始录制。');
            const resuming = { ...current, state: 'resuming', startedAt: status.startedAt, eventCount: status.eventCount };
            await pythonInvoke('mark_state', {
              recordingId: current.recordingId, runId: current.runId, state: 'resuming', startedAt: status.startedAt
            }, current.runId);
            const savedResuming = await savePlan(resuming);
            try {
              const resumed = validateStatus(await operation(OPS.resume, context, { observationId: current.observationId }), current);
              await pythonInvoke('mark_state', {
                recordingId: current.recordingId, runId: current.runId, state: 'active', startedAt: resumed.startedAt
              }, current.runId);
              await savePlan({ ...savedResuming, state: 'observing', startedAt: resumed.startedAt, eventCount: resumed.eventCount, error: '' });
              await save('recording_resumed', { recordingId: current.recordingId, observationId: current.observationId });
              return { surfacePatch: statusPatch({
                ...resumed, recordingId: current.recordingId, message: `当前 Pack：${pack.name}。已继续同一观察流。`
              }, await safeHistory(current.runId)) };
            } catch (error) {
              if (isPlanCasMismatch(error)) throw error;
              return persistUncertain(savedResuming, 'resume_uncertain', error);
            }
          }
          if (restartRequested && status.state === 'stopped'
            && ['stop_confirmed', 'finalizing'].includes(String(status.planState || ''))) {
            throw new Error('当前录制正在后台固化；固化完成或失败后才能重新开始。');
          }
          if (restartRequested && !status.exportedAt && !['stopped', 'failed'].includes(status.state)) {
            throw new Error('当前状态不能重新开始录制。');
          }
          if (status.state === 'stopped' && !status.exportedAt) {
            await abandonPlan(current, 'abandoned_finalization', '用户开始了新录制；上一份已停止录制的 Run 已明确关闭，SQLite 证据仍按 24 小时策略保留。');
          } else if (status.state === 'failed' && !String(status.planState || '').startsWith('abandoned_')) {
            await abandonPlan(current, 'abandoned_observation_failed', '用户重新开始录制；上一份失败录制的 Run 已明确关闭，后台证据仍按 24 小时策略保留。');
          }
        } else if (restartRequested) {
          throw new Error('当前没有可重新开始的旧录制；请使用“开始录制”。');
        }
        const externalId = crypto.randomUUID();
        const run = await ports.store.call('createProcessingRun', {
          surfaceId: SURFACE_ID, engagementId: String(context.connectorBinding?.engagementId || ''),
          sourceRef: `connector-recording:${externalId}`, externalId
        });
        const attemptedAt = new Date().toISOString();
        const plan = {
          recordingId: externalId, runId: run.runId, state: 'starting', observationId: '', streamId: '',
          connectorId: String(context.connectorBinding.connectorId || ''),
          sessionGeneration: Number(context.connectorBinding.sessionGeneration),
          engagementId: String(context.connectorBinding.engagementId || ''),
          startedAt: attemptedAt, eventCount: 0, metrics: {}
        };
        const savedPlan = await savePlan(plan);
        await save(restartRequested ? 'recording_restart_requested' : 'recording_start_requested', {
          recordingId: externalId, runId: run.runId, attemptedAt,
          previousRecordingId: restartRequested ? String(current?.recordingId || '') : ''
        });
        return completeStart(context, pack, savedPlan);
      }
      if (input.actionId === 'pause-recording') {
        let plan = await loadPlan();
        if (!plan) throw new Error('当前没有可暂停的录制。');
        const before = await currentStatus(context, plan);
        plan = await loadPlan(plan.recordingId) || plan;
        if (before.state !== 'observing') throw new Error('当前观察已不处于可暂停状态。');
        const pausing = { ...plan, state: 'pausing', startedAt: before.startedAt, eventCount: before.eventCount };
        await pythonInvoke('mark_state', {
          recordingId: plan.recordingId, runId: plan.runId, state: 'pausing', startedAt: before.startedAt
        }, plan.runId);
        const savedPausing = await savePlan(pausing);
        try {
          const paused = validateStatus(await operation(OPS.pause, context, { observationId: plan.observationId }), plan);
          await pythonInvoke('mark_state', {
            recordingId: plan.recordingId, runId: plan.runId, state: 'paused', startedAt: paused.startedAt
          }, plan.runId);
          await savePlan({ ...savedPausing, state: paused.state, eventCount: paused.eventCount, error: '' });
          await save('recording_paused', { recordingId: plan.recordingId, observationId: plan.observationId });
          return { surfacePatch: statusPatch({ ...paused, recordingId: plan.recordingId }, await safeHistory(plan.runId)) };
        } catch (error) {
          if (isPlanCasMismatch(error)) throw error;
          return persistUncertain(savedPausing, 'pause_uncertain', error);
        }
      }
      if (input.actionId === 'stop-recording') {
        let plan = await loadPlan();
        if (!plan) throw new Error('当前没有可停止的录制。');
        const before = await currentStatus(context, plan);
        plan = await loadPlan(plan.recordingId) || plan;
        if (before.state === 'stopped') {
          const confirmedState = before.complete === true && before.omissionCount === 0 ? 'stop_confirmed' : 'incomplete';
          const confirmed = await savePlan({
            ...plan, state: confirmedState, eventCount: before.eventCount, stoppedAt: before.stoppedAt, error: ''
          });
          return { surfacePatch: statusPatch({
            ...before, recordingId: plan.recordingId, planState: confirmed.state,
            message: confirmedState === 'stop_confirmed'
              ? `已停止（${before.eventCount} 个事件），正在固化。`
              : `已停止，但页面观察不完整：${String(before.terminalReason || '存在 omission')}`
          }, await safeHistory(plan.runId)) };
        }
        if (!['observing', 'paused'].includes(before.state)) throw new Error('当前观察已不处于可停止状态。');
        await pythonInvoke('mark_state', { recordingId: plan.recordingId, runId: plan.runId, state: 'stopping', startedAt: before.startedAt }, plan.runId);
        const stopping = await savePlan({ ...plan, state: 'stopping', startedAt: before.startedAt, eventCount: before.eventCount });
        let stopped;
        try {
          stopped = validateStatus(await operation(OPS.stop, context, { observationId: plan.observationId }), plan);
        } catch (error) {
          return persistUncertain(stopping, 'stop_uncertain', error);
        }
        await save('recording_stopped', { recordingId: plan.recordingId, observationId: plan.observationId, complete: stopped.complete, omissionCount: stopped.omissionCount });
        const confirmedState = stopped.complete === true && stopped.omissionCount === 0 ? 'stop_confirmed' : 'incomplete';
        const confirmed = await savePlan({
          ...stopping, state: confirmedState, eventCount: stopped.eventCount, stoppedAt: stopped.stoppedAt, error: ''
        });
        return { surfacePatch: statusPatch({
          ...stopped, recordingId: plan.recordingId, planState: confirmed.state,
          message: confirmedState === 'stop_confirmed'
            ? `已停止（${stopped.eventCount} 个事件），正在固化。`
            : `已停止，但页面观察不完整：${String(stopped.terminalReason || '存在 omission')}`
        }, await safeHistory(plan.runId)) };
      }
      if (input.actionId === 'finalize-recording') {
        const plan = await loadPlan();
        if (!plan || !['stop_confirmed', 'finalizing'].includes(String(plan.state || ''))) {
          throw new Error('没有已确认停止且等待固化的录制。');
        }
        const status = validateStatus(await operation(OPS.status, context, { observationId: plan.observationId }), plan);
        if (status.state !== 'stopped' || status.complete !== true || status.omissionCount !== 0) {
          throw new Error('当前 Connector 不再持有完整的已停止观察流。');
        }
        const run = await reconcileRun(plan);
        if (run?.state === 'succeeded' && run.artifact?.artifactId) {
          return { surfacePatch: statusPatch({
            ...status, recordingId: plan.recordingId, artifact: run.artifact, exportedAt: run.exportedAt
          }, await safeHistory(plan.runId)) };
        }
        if (!['processing', 'uncertain'].includes(String(run?.state || ''))) {
          throw new Error(`录制 Run 当前为 ${String(run?.state || 'missing')}，不能固化。`);
        }
        const finalizing = await savePlan({ ...plan, state: 'finalizing', error: '' });
        return finalizeStopped(context, finalizing, status);
      }
      if (input.actionId === 'retry-finalization') {
        const current = await loadPlan();
        const id = recordingId(input?.payload?.recordingId || current?.recordingId, 'recovery recordingId');
        let plan = current?.recordingId === id ? current : await loadPlan(id);
        if (!plan || plan.recordingId !== id) throw new Error('Frozen observation recovery requires the exact current recordingId.');
        const status = validateStatus(await operation(OPS.status, context, { observationId: plan.observationId }), plan);
        if (status.state !== 'stopped' || status.complete !== true || status.omissionCount !== 0) {
          throw new Error('Current Connector no longer owns a complete stopped observation stream.');
        }
        if (Number(plan.eventCount || 0) !== status.eventCount || String(plan.stoppedAt || '') !== String(status.stoppedAt || '')) {
          throw new Error('Current stopped observation status differs from the retained recovery evidence.');
        }
        if (!hasCompleteSuccessorFrozenInput(plan)) {
          const first = await readChunk(context, plan.streamId, 0);
          const frozen = frozenIdentity(first);
          assertObservedFrozenChunk(first, expectedStreamChunk(frozen.sizeBytes, 0), frozen);
          plan = await savePlan({
            ...plan, streamSha256: frozen.sha256, streamSizeBytes: frozen.sizeBytes,
            streamChunkCount: frozen.chunkCount, error: ''
          });
        }
        plan = await recoverFailedFinalizationSuccessor(plan);
        const run = await reconcileRun(plan);
        if (run?.state === 'succeeded' && run.artifact?.artifactId) {
          return { surfacePatch: statusPatch({ ...status, recordingId: id, artifact: run.artifact, exportedAt: run.exportedAt }, await safeHistory(plan.runId)) };
        }
        if (!['processing', 'uncertain'].includes(String(run?.state || ''))) {
          throw new Error(`录制 Run 当前为 ${String(run?.state || 'missing')}，不能重试固化。`);
        }
        const finalizing = await savePlan({ ...plan, state: 'finalizing', error: '' });
        return finalizeStopped(context, finalizing, status);
      }
      throw new Error('Recording action is not implemented by this official Feature.');
    },
    async shutdown() { await python.close(); }
  });
}

module.exports = Object.freeze({ createFeatureWorker, FEATURE_ID, FEATURE_VERSION });
