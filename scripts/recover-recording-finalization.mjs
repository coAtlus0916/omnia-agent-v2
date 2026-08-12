import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const FEATURE_ID = 'omnia.recording';

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || '') : '';
}

function fail(message) {
  throw new Error(message);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function inside(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  return resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

function exactObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} is invalid.`);
  return value;
}

function readJson(value, label) {
  try { return exactObject(JSON.parse(String(value || '')), label); }
  catch (error) { fail(`${label} is not valid JSON: ${error.message}`); }
}

function verifyArtifactFile(dataRoot, row) {
  const artifactsRoot = path.resolve(dataRoot, 'features', FEATURE_ID, 'artifacts');
  const filename = path.resolve(dataRoot, ...String(row.managed_path || '').split('/'));
  if (!inside(artifactsRoot, filename) || !fs.statSync(filename).isFile()) fail('Committed Artifact path is invalid.');
  const bytes = fs.readFileSync(filename);
  if (bytes.length !== Number(row.size_bytes) || sha256(bytes) !== String(row.sha256)) {
    fail('Committed Artifact bytes differ from the Core record.');
  }
  return filename;
}

function updatePrivateProjection(privatePath, recordingId, runId, artifact, metrics, exportedAt) {
  const store = new DatabaseSync(privatePath);
  store.exec('BEGIN IMMEDIATE');
  try {
    const planId = `recording-run:${recordingId}`;
    const row = store.prepare('SELECT payload_json FROM __runtime_plans WHERE plan_id=?').get(planId);
    if (!row) fail('Recording private plan is unavailable.');
    const plan = readJson(row.payload_json, 'Recording private plan');
    if (String(plan.recordingId) !== recordingId || String(plan.runId) !== runId) fail('Recording private plan identity drifted.');
    if (plan.artifact?.artifactId && String(plan.artifact.artifactId) !== artifact.artifactId) {
      fail('Recording private plan is already bound to another Artifact.');
    }
    const finalized = {
      ...plan,
      state: 'finalized',
      artifact,
      metrics,
      exportedAt,
      error: '',
      updatedAt: exportedAt,
    };
    store.prepare('UPDATE __runtime_plans SET payload_json=?,updated_at=? WHERE plan_id=?')
      .run(JSON.stringify({ planId, ...finalized }), exportedAt, planId);
    store.prepare('UPDATE __runtime_plans SET payload_json=?,updated_at=? WHERE plan_id=?')
      .run(JSON.stringify({
        planId: 'recording-current', recordingId, runId, state: 'finalized',
        artifact, metrics, exportedAt, updatedAt: exportedAt,
      }), exportedAt, 'recording-current');
    const prior = store.prepare("SELECT 1 FROM __runtime_evidence WHERE plan_id=? AND checkpoint='recording_finalized' AND json_extract(payload_json,'$.details.artifactId')=?")
      .get(recordingId, artifact.artifactId);
    if (!prior) {
      const evidenceId = crypto.randomUUID();
      const payload = {
        schemaVersion: 'omnia.v5.recording-feature-evidence/v1',
        planId: recordingId,
        checkpoint: 'recording_finalized',
        occurredAt: exportedAt,
        details: { recordingId, runId, artifactId: artifact.artifactId, ...metrics, recoveredFromFrozenStream: true },
      };
      store.prepare('INSERT INTO __runtime_evidence(evidence_id,plan_id,checkpoint,payload_json,occurred_at) VALUES(?,?,?,?,?)')
        .run(evidenceId, recordingId, 'recording_finalized', JSON.stringify(payload), exportedAt);
    }
    store.exec('COMMIT');
  } catch (error) {
    store.exec('ROLLBACK');
    throw error;
  } finally {
    store.close();
  }
}

async function markPrivateFinalized(bridge, recordingId, runId, artifact, exportedAt) {
  await bridge.invoke('mark_finalized', {
    recordingId,
    runId,
    artifact,
    finalizedAt: exportedAt,
  }, { runId, timeoutMs: 120_000 });
}

async function main() {
  const productRoot = path.resolve(argument('product-root') || path.join(import.meta.dirname, '..', 'releases'));
  const recordingId = argument('recording-id').toLowerCase();
  const runId = argument('run-id').toLowerCase();
  const frozenNdjsonArgument = argument('frozen-ndjson');
  if (!UUID.test(recordingId) || !UUID.test(runId)) fail('Canonical --recording-id and --run-id are required.');

  const dataRoot = path.join(productRoot, 'data');
  const corePath = path.join(dataRoot, 'stores', 'core.sqlite');
  const privatePath = path.join(dataRoot, 'features', FEATURE_ID, 'store.sqlite');
  const pythonExecutable = path.join(productRoot, 'runtime', 'python', 'cpython-3.13.14-embed-amd64', 'python.exe');
  for (const filename of [corePath, privatePath, pythonExecutable]) {
    if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) fail(`Required release file is unavailable: ${filename}`);
  }

  const core = new DatabaseSync(corePath, { readOnly: true });
  const privateStore = new DatabaseSync(privatePath, { readOnly: true });
  const activation = core.prepare('SELECT * FROM feature_activation_heads WHERE feature_id=?').get(FEATURE_ID);
  const run = core.prepare('SELECT * FROM feature_runs WHERE run_id=? AND feature_id=?').get(runId, FEATURE_ID);
  const session = privateStore.prepare('SELECT * FROM recording_sessions WHERE recording_id=?').get(recordingId);
  const planRow = privateStore.prepare('SELECT payload_json FROM __runtime_plans WHERE plan_id=?').get(`recording-run:${recordingId}`);
  if (!activation || Number(activation.runtime_enabled) !== 1) fail('Active Recording Feature runtime is unavailable.');
  if (!run || !planRow) fail('Run or frozen private plan is unavailable.');
  if (session && String(run.run_id) !== String(session.run_id)) fail('Run and recording session identity differ.');
  if (String(run.run_id) !== runId) fail('Run identity differs from the requested recovery target.');
  const plan = readJson(planRow.payload_json, 'Recording private plan');
  if (String(plan.recordingId) !== recordingId || String(plan.runId) !== runId) fail('Frozen private plan identity differs from the requested recording.');
  if (String(plan.state) !== 'finalization_failed' && String(plan.state) !== 'finalized') fail('Recording is not eligible for finalization recovery.');

  const packageRoot = path.resolve(dataRoot, ...String(activation.package_path).split('/'));
  const pythonEntry = path.join(packageRoot, 'python', 'recording-engine.py');
  const bridgeEntry = path.join(packageRoot, 'middle', 'recording-python-bridge.cjs');
  for (const filename of [pythonEntry, bridgeEntry]) {
    if (!inside(packageRoot, filename) || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) fail('Active signed Recording package is incomplete.');
  }
  const finalizerVersion = String(activation.feature_version);
  const finalizerDigest = String(activation.package_digest);
  if (!finalizerVersion || !/^sha256:[0-9a-f]{64}$/u.test(finalizerDigest)) fail('Active Recording Feature identity is invalid.');

  const existingArtifact = run.output_artifact_id
    ? core.prepare('SELECT * FROM feature_artifacts WHERE artifact_id=? AND run_id=? AND feature_id=?').get(run.output_artifact_id, runId, FEATURE_ID)
    : null;
  if (String(run.state) === 'succeeded') {
    if (!existingArtifact) fail('Succeeded recording Run has no Core Artifact.');
    const filename = verifyArtifactFile(dataRoot, existingArtifact);
    const artifact = {
      artifactId: String(existingArtifact.artifact_id), kind: String(existingArtifact.kind),
      name: String(existingArtifact.original_name), originalName: String(existingArtifact.original_name),
      sha256: String(existingArtifact.sha256), sizeBytes: Number(existingArtifact.size_bytes), available: true, reason: '',
    };
    const metrics = plan.metrics && typeof plan.metrics === 'object' ? plan.metrics : {};
    const exportedAt = String(existingArtifact.imported_at);
    core.close();
    privateStore.close();
    process.env.OMNIA_MANAGED_PYTHON_EXECUTABLE = pythonExecutable;
    process.env.OMNIA_MANAGED_PYTHON_ENTRY = pythonEntry;
    process.env.OMNIA_FEATURE_PACKAGE_ROOT = packageRoot;
    process.env.OMNIA_FEATURE_TEMP_ROOT = path.join(dataRoot, 'temp', 'features', FEATURE_ID);
    process.env.OMNIA_FEATURE_STORE_PATH = privatePath;
    const { createPythonSidecarBridge } = require(bridgeEntry);
    const bridge = createPythonSidecarBridge({ ports: { events: { emit() {} } } });
    try { await markPrivateFinalized(bridge, recordingId, runId, artifact, exportedAt); }
    finally { await bridge.close(); }
    updatePrivateProjection(privatePath, recordingId, runId, artifact, metrics, exportedAt);
    console.log(JSON.stringify({ idempotent: true, recordingId, runId, artifact, filename }, null, 2));
    return;
  }

  if (String(run.state) !== 'failed' || Number(run.state_revision) < 1 || String(run.output_artifact_id || '') !== '') {
    fail('Recording Run is not an exact failed, uncommitted finalization candidate.');
  }
  const expectedRevision = Number(run.state_revision);
  const lastEvent = core.prepare('SELECT MAX(revision) AS revision FROM feature_run_events WHERE run_id=?').get(runId);
  if (Number(lastEvent.revision) !== expectedRevision) fail('Run event revision invariant is broken before recovery.');
  const bound = core.prepare("SELECT details_json FROM feature_run_events WHERE run_id=? AND event_type='run.processing_frozen_input_bound'").get(runId);
  if (!bound) fail('Core frozen-input binding evidence is unavailable.');
  const binding = readJson(bound.details_json, 'Core frozen-input binding evidence');
  for (const key of ['streamSizeBytes', 'streamSha256']) {
    const planKey = key;
    const bindingKey = key === 'streamSizeBytes' ? 'frozenSizeBytes' : 'frozenSha256';
    if (String(plan[planKey]) !== String(binding[bindingKey])) fail(`Frozen ${key} differs between private and Core evidence.`);
  }
  if (!SHA256.test(String(plan.streamSha256)) || !Number.isSafeInteger(Number(plan.streamSizeBytes))
    || !Number.isSafeInteger(Number(plan.streamChunkCount)) || Number(plan.streamChunkCount) < 1
    || Number(plan.streamChunkCount) > 512 || !Number.isSafeInteger(Number(binding.frozenChunkCount))
    || Number(binding.frozenChunkCount) < 1 || Number(binding.frozenChunkCount) > 256) {
    fail('Frozen stream identity is invalid.');
  }
  const rows = privateStore.prepare('SELECT sequence,event_json FROM recording_events WHERE recording_id=? ORDER BY sequence').all(recordingId);
  let eventRecords = rows;
  if (!eventRecords.length) {
    if (!frozenNdjsonArgument) fail('Staged events are unavailable; exact --frozen-ndjson evidence is required.');
    const frozenPath = path.resolve(frozenNdjsonArgument);
    if (!fs.existsSync(frozenPath) || !fs.statSync(frozenPath).isFile()) fail('Frozen NDJSON evidence is unavailable.');
    const frozenBytes = fs.readFileSync(frozenPath);
    if (frozenBytes.length !== Number(plan.streamSizeBytes) || sha256(frozenBytes) !== String(plan.streamSha256)) {
      fail('Frozen NDJSON bytes differ from the private/Core frozen-stream identity.');
    }
    const lines = frozenBytes.toString('utf8').split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (lines.some((line) => line.length === 0)) fail('Frozen NDJSON contains an empty record.');
    eventRecords = lines.map((line, index) => ({ sequence: index + 1, event_json: line }));
  }
  if (eventRecords.length !== Number(plan.eventCount) || eventRecords.length < 1) {
    fail('Event evidence count differs from the frozen plan.');
  }
  if (session && (rows.length !== Number(session.event_count) || String(session.run_id) !== runId)) {
    fail('Existing Recording session differs from its staged evidence or Run.');
  }
  const events = eventRecords.map((row, index) => {
    if (Number(row.sequence) !== index + 1) fail('Staged event sequence is not contiguous.');
    const event = readJson(row.event_json, `Recording event ${index + 1}`);
    if (String(event.observationId) !== String(plan.observationId) || Number(event.sequence) !== index + 1) fail('Staged event identity drifted.');
    if (String(event.target?.engagementId || '') !== String(plan.engagementId)) fail('Staged event escaped the frozen Engagement.');
    return event;
  });
  core.close();
  privateStore.close();

  const tempRoot = path.resolve(dataRoot, 'temp', 'features', FEATURE_ID);
  const runTempRoot = path.resolve(tempRoot, runId);
  if (!inside(tempRoot, runTempRoot)) fail('Recovery temp Run path escaped the Recording namespace.');
  fs.mkdirSync(runTempRoot, { recursive: true });
  const inputHandleId = crypto.randomUUID();
  const outputHandleId = crypto.randomUUID();
  const inputRoot = path.resolve(runTempRoot, inputHandleId);
  const outputRoot = path.resolve(runTempRoot, outputHandleId);
  if (!inside(runTempRoot, inputRoot) || !inside(runTempRoot, outputRoot)) fail('Recovery handle escaped the Run temp root.');
  fs.mkdirSync(inputRoot, { recursive: false });
  fs.mkdirSync(outputRoot, { recursive: false });
  const inputPath = path.join(inputRoot, 'input.json');
  const outputPath = path.join(outputRoot, 'output.json');
  const projection = Buffer.from(JSON.stringify({
    schemaVersion: 'omnia.recording.frozen-input/v1',
    streamSizeBytes: Number(plan.streamSizeBytes),
    streamSha256: String(plan.streamSha256),
    streamChunkCount: Number(plan.streamChunkCount),
    events,
  }), 'utf8');
  fs.writeFileSync(inputPath, projection, { flag: 'wx' });
  fs.writeFileSync(outputPath, Buffer.alloc(0), { flag: 'wx' });
  const inputHandle = {
    schemaVersion: 'omnia.python-artifact-handle/v1', handleId: inputHandleId, runId, path: inputPath,
    access: 'read', mediaType: 'application/json', originalName: 'frozen-recording.json',
    sizeBytes: projection.length, sha256: sha256(projection),
  };
  const outputName = `omnia-recording-${recordingId}.json`;
  const outputHandle = {
    schemaVersion: 'omnia.python-artifact-handle/v1', handleId: outputHandleId, runId, path: outputPath,
    access: 'write', mediaType: 'application/json', originalName: outputName, sizeBytes: 0, sha256: '',
  };
  const observationStatus = {
    schemaVersion: 'omnia.page-observation-status/v1', state: 'stopped', active: false,
    observationId: String(plan.observationId), streamId: String(plan.streamId),
    engagementId: String(plan.engagementId), startedAt: String(plan.startedAt), stoppedAt: String(plan.stoppedAt),
    complete: true, omissionCount: 0, eventCount: events.length, lastSequence: events.length,
  };

  process.env.OMNIA_MANAGED_PYTHON_EXECUTABLE = pythonExecutable;
  process.env.OMNIA_MANAGED_PYTHON_ENTRY = pythonEntry;
  process.env.OMNIA_FEATURE_PACKAGE_ROOT = packageRoot;
  process.env.OMNIA_FEATURE_TEMP_ROOT = tempRoot;
  process.env.OMNIA_FEATURE_STORE_PATH = privatePath;
  const { createPythonSidecarBridge } = require(bridgeEntry);
  const bridge = createPythonSidecarBridge({ ports: { events: { emit() {} } } });
  let transformed;
  try {
    transformed = await bridge.invoke('ingest_and_export', {
      recordingId, runId, inputHandle, outputHandle, observationStatus,
      streamSizeBytes: Number(plan.streamSizeBytes), streamSha256: String(plan.streamSha256),
    }, { runId, timeoutMs: 120_000 });
  } finally {
    await bridge.close();
  }
  const outputBytes = fs.readFileSync(outputPath);
  const outputDigest = sha256(outputBytes);
  if (outputBytes.length < 1 || Number(transformed.sizeBytes) !== outputBytes.length || String(transformed.sha256) !== outputDigest) {
    fail('Release Python output differs from its returned digest or size.');
  }
  if (Number(transformed.eventCount) !== events.length) fail('Release Python output event count differs from the staged evidence.');

  const artifactId = crypto.randomUUID();
  const relative = path.posix.join('features', FEATURE_ID, 'artifacts', artifactId, 'artifact.json');
  const artifactRoot = path.resolve(dataRoot, 'features', FEATURE_ID, 'artifacts');
  const destination = path.resolve(dataRoot, ...relative.split('/'));
  if (!inside(artifactRoot, destination)) fail('Recovery Artifact destination escaped the managed Recording root.');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(outputPath, destination, fs.constants.COPYFILE_EXCL);
  if (sha256(fs.readFileSync(destination)) !== outputDigest || fs.statSync(destination).size !== outputBytes.length) {
    fail('Recovery Artifact drifted while entering managed storage.');
  }

  const exportedAt = new Date().toISOString();
  const writableCore = new DatabaseSync(corePath);
  let committed = false;
  writableCore.exec('BEGIN IMMEDIATE');
  try {
    const current = writableCore.prepare('SELECT * FROM feature_runs WHERE run_id=? AND feature_id=?').get(runId, FEATURE_ID);
    const currentRevision = writableCore.prepare('SELECT MAX(revision) AS revision FROM feature_run_events WHERE run_id=?').get(runId);
    const artifactCount = writableCore.prepare('SELECT COUNT(*) AS count FROM feature_artifacts WHERE run_id=?').get(runId);
    if (!current || String(current.feature_version) !== String(run.feature_version)
      || String(current.state) !== 'failed' || Number(current.state_revision) !== expectedRevision
      || String(current.output_artifact_id || '') !== '' || Number(currentRevision.revision) !== expectedRevision
      || Number(artifactCount.count) !== 0) {
      fail('Recording Run changed before recovery CAS; no Artifact record was committed.');
    }
    writableCore.prepare(`
      INSERT INTO feature_artifacts(
        artifact_id,run_id,feature_id,kind,media_type,original_name,source_kind,source_ref,
        managed_path,sha256,size_bytes,source_version,imported_at,created_at
      ) VALUES(?,?,?,'result','application/json',?,'worker_output','',?,?,?,?,?,?)
    `).run(artifactId, runId, FEATURE_ID, outputName, relative, outputDigest, outputBytes.length, finalizerVersion, exportedAt, exportedAt);
    const nextRevision = expectedRevision + 1;
    const updated = writableCore.prepare(`
      UPDATE feature_runs SET state='succeeded',state_revision=?,output_artifact_id=?,last_error='',updated_at=?
      WHERE run_id=? AND feature_id=? AND feature_version=? AND state='failed' AND state_revision=? AND output_artifact_id=''
    `).run(nextRevision, artifactId, exportedAt, runId, FEATURE_ID, String(run.feature_version), expectedRevision);
    if (updated.changes !== 1) fail('Recording Run changed before recovery CAS update.');
    writableCore.prepare(`
      INSERT INTO feature_run_events(event_id,run_id,revision,from_state,to_state,event_type,details_json,occurred_at)
      VALUES(?,?,?,'failed','succeeded','recording.finalization_recovered',?,?)
    `).run(crypto.randomUUID(), runId, nextRevision, JSON.stringify({
      artifactId,
      recordingId,
      sourceFeatureVersion: String(run.feature_version),
      finalizerFeatureVersion: finalizerVersion,
      finalizerPackageDigest: finalizerDigest,
      frozenSha256: String(plan.streamSha256),
      frozenSizeBytes: Number(plan.streamSizeBytes),
      eventCount: events.length,
      mutationReplayed: false,
    }), exportedAt);
    writableCore.exec('COMMIT');
    committed = true;
  } catch (error) {
    writableCore.exec('ROLLBACK');
    throw error;
  } finally {
    writableCore.close();
    if (!committed) {
      const artifactDirectory = path.dirname(destination);
      if (!inside(artifactRoot, artifactDirectory)) fail('Refusing to remove an unverified Artifact directory.');
      fs.rmSync(artifactDirectory, { recursive: true, force: true });
    }
  }

  const artifact = {
    artifactId, kind: 'result', name: outputName, originalName: outputName,
    sha256: outputDigest, sizeBytes: outputBytes.length, available: true, reason: '',
  };
  const finalizeBridge = createPythonSidecarBridge({ ports: { events: { emit() {} } } });
  try { await markPrivateFinalized(finalizeBridge, recordingId, runId, artifact, exportedAt); }
  finally { await finalizeBridge.close(); }
  updatePrivateProjection(privatePath, recordingId, runId, artifact, transformed.metrics || {}, exportedAt);

  for (const directory of [inputRoot, outputRoot]) {
    if (!inside(runTempRoot, directory)) fail('Refusing to remove an unverified recovery handle directory.');
    fs.rmSync(directory, { recursive: true, force: true });
  }
  console.log(JSON.stringify({
    idempotent: false,
    recordingId,
    runId,
    sourceFeatureVersion: String(run.feature_version),
    finalizerFeatureVersion: finalizerVersion,
    artifact,
    artifactPath: destination,
    metrics: transformed.metrics || {},
    eventCount: transformed.eventCount,
    catalogCount: transformed.catalogCount,
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
