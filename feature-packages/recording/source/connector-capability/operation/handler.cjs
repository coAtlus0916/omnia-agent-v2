'use strict';

const IDS = Object.freeze({
  packRead: 'omnia.recording.pack.read.v1',
  open: 'omnia.recording.observation.open.v1',
  status: 'omnia.recording.observation.status.v1',
  pause: 'omnia.recording.observation.pause.v1',
  resume: 'omnia.recording.observation.resume.v1',
  stop: 'omnia.recording.observation.stop.v1',
  readChunk: 'omnia.recording.observation.read-chunk.v1'
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OBSERVATION_ID = /^observation_[0-9a-f]{32}$/u;
const STREAM_ID = /^stream_[0-9a-f]{32}$/u;

function rows(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value && value.items)) return value.items;
  if (Array.isArray(value && value.data)) return value.data;
  return [];
}

function text(value, maximum = 500) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function identity(value) { return text(value, 200).toLowerCase(); }
function fail(message) { throw new Error(message); }
function requireBinding(request, sdk) {
  if (!sdk?.binding || !request?.connectorBinding) fail('Recording Operation requires the frozen Connector binding.');
}
function observationControl(request) {
  const observationId = text(request?.observationId, 80);
  if (!OBSERVATION_ID.test(observationId)) fail('Recording observationId is invalid.');
  return { schemaVersion: 'omnia.page-observation-control/v1', observationId };
}

function createOperationHandler() {
  return Object.freeze({
    async run(operationId, request, sdk) {
      requireBinding(request, sdk);
      if (operationId === IDS.packRead) {
        const hierarchy = rows(await sdk.invokeStep('pack-hierarchy'));
        const engagementId = identity(sdk.binding.engagementId);
        const packId = identity(sdk.binding.packId);
        const matches = hierarchy.filter((item) => {
          const observedEngagementId = identity(item && (item.engagementId || item.id));
          const observedPackId = identity(item && (item.packId || item.engagementId || item.id));
          return observedEngagementId === engagementId && (!packId || observedPackId === packId);
        });
        if (matches.length !== 1) fail('Omnia hierarchy did not return exactly one current Pack matching the frozen binding.');
        const current = matches[0];
        const name = text(current && current.name);
        if (!name) fail('Omnia hierarchy returned the current Pack without a verifiable name.');
        return {
          schemaVersion: 'omnia.recording.pack-read-result/v1', connectorId: text(sdk.binding.connectorId),
          sessionGeneration: Number(sdk.binding.sessionGeneration), engagementId,
          packId: packId || identity(current && (current.packId || current.engagementId || current.id)),
          authorityInstanceId: text(sdk.binding.authorityInstanceId), tenantOrOrgId: text(sdk.binding.tenantOrOrgId),
          name, clientName: text(current && current.clientName)
        };
      }
      if (!sdk.pageObservation) fail('Connector page observation capability is unavailable.');
      if (operationId === IDS.open) {
        const recordingId = identity(request.recordingId);
        if (!UUID.test(recordingId)) fail('Recording identity is invalid.');
        return sdk.pageObservation.open({
          schemaVersion: 'omnia.page-observation-open/v1',
          policyId: 'omnia.page-observation.current-pack.v1',
          idempotencyKey: `recording:${recordingId}`
        });
      }
      if (operationId === IDS.status) return sdk.pageObservation.status(observationControl(request));
      if (operationId === IDS.pause) return sdk.pageObservation.pause(observationControl(request));
      if (operationId === IDS.resume) return sdk.pageObservation.resume(observationControl(request));
      if (operationId === IDS.stop) return sdk.pageObservation.stop(observationControl(request));
      if (operationId === IDS.readChunk) {
        const streamId = text(request.streamId, 80);
        const offset = Number(request.offset);
        if (!STREAM_ID.test(streamId) || !Number.isSafeInteger(offset) || offset < 0 || offset % (128 * 1024) !== 0) {
          fail('Recording managed stream read is invalid.');
        }
        return sdk.pageObservation.readChunk({
          schemaVersion: 'omnia.managed-stream-read/v1', streamId, offset, maxBytes: 128 * 1024
        });
      }
      fail(`Unsupported signed Operation: ${operationId}`);
    }
  });
}

module.exports = Object.freeze({ createOperationHandler });
