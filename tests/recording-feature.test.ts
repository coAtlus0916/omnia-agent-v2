import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createRequire } from 'node:module';
import { CoreDatabase } from '../src/main/database.js';
import { FeaturePackageManager, _test as packageManagerTest } from '../src/main/features/package-manager.js';
import { FeatureRuntimeStore } from '../src/main/features/feature-runtime-store.js';
import { packageDigest, verifyOfficialPackage } from '../src/main/features/official-package.js';
import { resolveProductPaths } from '../src/main/paths.js';

const repository = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const workerSourcePath = path.join(repository, 'feature-packages', 'recording', 'source', 'middle', 'worker.cjs');
const operationSourcePath = path.join(repository, 'feature-packages', 'recording', 'source', 'connector-capability', 'operation', 'handler.cjs');
const releasePython = path.join(repository, 'releases', 'runtime', 'python', 'cpython-3.13.14-embed-amd64', 'python.exe');
const packageRoot = path.join(repository, 'feature-packages', 'recording', 'source');
const candidatePath = path.join(repository, 'feature-packages', 'recording', 'candidates', 'recording-0.4.18.ofp');
const candidate019Path = path.join(repository, 'feature-packages', 'recording', 'candidates', 'recording-0.4.19.ofp');
const operation019Path = path.join(repository, 'feature-packages', 'recording', 'candidates', 'recording-operation-0.4.19.ofop');
const recording017Path = path.join(repository, 'feature-packages', 'recording', 'candidates', 'recording-0.4.17.ofp');
const deletePackage010 = path.join(repository, 'feature-packages', 'delete-elements', 'candidates', 'delete-elements-0.1.0.ofp');
const deletePackage011 = path.join(repository, 'feature-packages', 'delete-elements', 'candidates', 'delete-elements-0.1.1.ofp');
const deletePackage0319 = path.join(repository, 'feature-packages', 'delete-elements', 'candidates', 'delete-elements-0.3.19.ofp');
const runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const recordingId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const engagementId = '11111111-1111-4111-8111-111111111111';
const observationId = `observation_${'c'.repeat(32)}`;
const streamId = `stream_${'d'.repeat(32)}`;
const cipher = { encrypt: (value: string) => value, decrypt: (value: string) => value };

function digest(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function canonical(value: any): string {
  if (value === null || ['boolean', 'string', 'number'].includes(typeof value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function resignEnvelope(envelope: any, privateKeyName: string): any {
  const signingRoot = path.join(process.env.USERPROFILE || '', '.omnia-agent-v5', 'signing');
  const privateKey = fs.readFileSync(path.join(signingRoot, privateKeyName), 'utf8');
  const unsigned = structuredClone(envelope);
  delete unsigned.signature;
  return { ...unsigned, signature: crypto.sign(null, Buffer.from(canonical(unsigned)), privateKey).toString('base64') };
}

function replaceEnvelopeBytes(envelope: any, memberPath: string, bytes: Buffer): void {
  const member = envelope.files.find((item: any) => item.path === memberPath);
  assert.ok(member, `missing envelope member ${memberPath}`);
  member.size = bytes.length;
  member.sha256 = digest(bytes);
  member.contentBase64 = bytes.toString('base64');
}

function restoreEnvironment(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function unpackEnvelope(envelope: { files: Array<{ path: string; contentBase64: string }> }, targetRoot: string): void {
  fs.mkdirSync(targetRoot, { recursive: true });
  for (const member of envelope.files) {
    const target = path.resolve(targetRoot, ...member.path.split('/'));
    assert.equal(target.startsWith(`${path.resolve(targetRoot)}${path.sep}`), true);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(member.contentBase64, 'base64'));
  }
}

test('0.4.18 to next Operation handoff is signed, fail-closed on old Connector, and exact on a capable Connector', async () => {
  const packageScript = fs.readFileSync(path.join(repository, 'scripts', 'package-recording-feature.mjs'), 'utf8');
  const legacyOperationDigest = 'sha256:27218281da622b4bf3ec7ae64fa97e4f5cc3988a34abf659aff415bc71bb5d0f';
  const legacyOperationDigests = [
    legacyOperationDigest,
    'sha256:671ce107badb4d94600af7290c2b08c922088a2e8e2f56cd9d2d2f75869480db',
    'sha256:ec1ce1cfb3c33ce3b56257477fbb48866e790a158da570f4bbbe593e5abf01e9'
  ];
  assert.match(packageScript, /const version = '0\.4\.19'/);
  assert.match(packageScript, /const sequence = 32/);
  assert.match(packageScript, /minimumShellVersion: '0\.4\.15'/,
    'resource-owner handoff must not install on a Shell without the durable handoff ledger');
  assert.match(packageScript, /ownerId: 'omnia\.page-observation\.current-pack'/);
  assert.match(packageScript, /compatibilityVersion: 1/);
  assert.match(packageScript, /capabilities: \['omnia\.page-observation\.current-pack\.v1'\]/);
  for (const sourceDigest of legacyOperationDigests) {
    assert.match(packageScript, new RegExp(sourceDigest.replace(':', '\\:')));
  }
  assert.match(packageScript, /sourceFeatureVersions: \['0\.4\.16', '0\.4\.17', '0\.4\.18'\]/);
  const packageManagerSource = fs.readFileSync(path.join(repository, 'src', 'main', 'features', 'package-manager.ts'), 'utf8');
  const startRuntimeSource = packageManagerSource.slice(packageManagerSource.indexOf('private async startRuntime'));
  const workerHealthIndex = startRuntimeSource.indexOf("supervisor.invoke('health'");
  const surfacePersistIndex = startRuntimeSource.indexOf('this.persistSurface(restored)');
  const sourceRegistrationIndex = startRuntimeSource.indexOf('await ensureExactSourceOperationRegistration');
  const prepareRegistrationIndex = startRuntimeSource.indexOf('preparedHandoff = await registerExactOperationHandoff');
  const preparedTokenPersistIndex = startRuntimeSource.indexOf('persistPreparedOperationHandoff(');
  const commitIndex = startRuntimeSource.indexOf('await commitExactOperationHandoff');
  const committedLedgerIndex = startRuntimeSource.indexOf('persistCommittedOperationHandoff(');
  const activationHeadCasIndex = startRuntimeSource.indexOf('finalizePreparedOperationHandoff(');
  const abortPendingIndex = startRuntimeSource.indexOf('markOperationHandoffAbortPending(');
  const abortRegistrationIndex = startRuntimeSource.indexOf('await abortExactOperationHandoff', abortPendingIndex);
  const committedRestoreIndex = startRuntimeSource.indexOf(
    'await restoreExactCommittedOperationHandoff', activationHeadCasIndex
  );
  const finalizeRegistrationIndex = startRuntimeSource.indexOf(
    'await finalizeExactOperationHandoff', activationHeadCasIndex
  );
  assert.ok(workerHealthIndex >= 0 && surfacePersistIndex > workerHealthIndex
    && sourceRegistrationIndex > surfacePersistIndex && prepareRegistrationIndex > sourceRegistrationIndex
    && preparedTokenPersistIndex > prepareRegistrationIndex
    && commitIndex > preparedTokenPersistIndex && committedLedgerIndex > commitIndex
    && activationHeadCasIndex > committedLedgerIndex
    && abortPendingIndex > activationHeadCasIndex && abortRegistrationIndex > abortPendingIndex
    && committedRestoreIndex > activationHeadCasIndex && finalizeRegistrationIndex > committedRestoreIndex,
  'Worker/Surface preparation must precede prepare; commit must precede the Core head CAS, and finalize must follow it');
  const legacyFeatureEnvelope = verifyOfficialPackage(JSON.parse(fs.readFileSync(candidatePath, 'utf8')), 'omnia-feature');
  const legacyOperationMember = legacyFeatureEnvelope.files.find((member) => member.path === 'connector-capability/operation.ofop')!;
  const legacyOperationEnvelope = verifyOfficialPackage(
    JSON.parse(Buffer.from(legacyOperationMember.contentBase64, 'base64').toString('utf8')),
    'omnia-connector-operation'
  );
  assert.equal(packageDigest(legacyOperationEnvelope), legacyOperationDigest);
  const legacyHandler = legacyOperationEnvelope.files.find((member) => member.path === 'operation/handler.cjs')!;
  assert.deepEqual(
    Buffer.from(legacyHandler.contentBase64, 'base64'),
    fs.readFileSync(operationSourcePath),
    '0.4.19 must preserve the 0.4.18 handler bytes so the generic ABI fingerprint stays stable'
  );
  const expectedLegacyDigests = new Map([
    ['0.4.16', legacyOperationDigests[1]], ['0.4.17', legacyOperationDigests[2]], ['0.4.18', legacyOperationDigests[0]]
  ]);
  const fingerprints = new Set<string>();
  for (const [sourceVersion, expectedDigest] of expectedLegacyDigests) {
    const sourceFeature = verifyOfficialPackage(JSON.parse(fs.readFileSync(
      path.join(repository, 'feature-packages', 'recording', 'candidates', `recording-${sourceVersion}.ofp`), 'utf8'
    )), 'omnia-feature');
    const sourceMember = sourceFeature.files.find((member) => member.path === 'connector-capability/operation.ofop')!;
    const sourceOperation = verifyOfficialPackage(
      JSON.parse(Buffer.from(sourceMember.contentBase64, 'base64').toString('utf8')), 'omnia-connector-operation'
    );
    assert.equal(packageDigest(sourceOperation), expectedDigest);
    const sourceManifest = JSON.parse(Buffer.from(sourceOperation.files.find((member) => member.path === 'manifest.json')!.contentBase64, 'base64').toString('utf8'));
    const handlerBytes = Buffer.from(sourceOperation.files.find((member) => member.path === 'operation/handler.cjs')!.contentBase64, 'base64');
    const policyBytes = Buffer.from(sourceOperation.files.find((member) => member.path === 'operation/policy.json')!.contentBase64, 'base64');
    fingerprints.add(digest(Buffer.from(canonical({
      publisherKeyId: sourceOperation.publisher.keyId,
      featureId: sourceManifest.featureId,
      packageId: sourceManifest.packageId,
      operations: sourceManifest.operations,
      handlerSha256: digest(handlerBytes), policySha256: digest(policyBytes)
    }))));
  }
  assert.deepEqual([...fingerprints], ['5cb5fb653905f7376ad2b9b76da3c37234289ee08c1e5028a17c0e8df66874b7']);

  const descriptor = {
    operationId: 'omnia.recording.observation.read-chunk.v1', effect: 'read_only',
    requestSchema: 'omnia.recording.managed-stream-read-request/v1', responseSchema: 'omnia.managed-stream-chunk/v1',
    enabledByDefault: true, grantsMutationPermit: false,
    routes: [{ stepId: 'pack-hierarchy', method: 'GET', routeTemplate: '/engagements/v1/{engagementId}/headers/hierarchy', parameters: [], bodyMode: 'none', bodyParameter: '' }]
  };
  const source: any = {
    digest: legacyOperationDigest,
    envelope: {},
    capabilityFingerprint: 'a'.repeat(64),
    manifest: {
      schemaVersion: 'omnia.connector-operation-manifest/v1', packageId: 'omnia.recording.operation',
      version: '0.4.18', sequence: 31, featureId: 'omnia.recording', operations: [descriptor]
    }
  };
  const targetDigest = `sha256:${'e'.repeat(64)}`;
  const target: any = {
    digest: targetDigest,
    envelope: {},
    capabilityFingerprint: 'a'.repeat(64),
    manifest: {
      schemaVersion: 'omnia.connector-operation-manifest/v1', packageId: 'omnia.recording.operation',
      version: '0.4.19', sequence: 32, featureId: 'omnia.recording',
      resourceOwner: {
        schemaVersion: 'omnia.operation-resource-owner/v1', ownerId: 'omnia.page-observation.current-pack',
        compatibilityVersion: 1, capabilities: ['omnia.page-observation.current-pack.v1'],
        compatibleSourcePackageDigests: legacyOperationDigests
      },
      operations: [descriptor]
    }
  };
  assert.doesNotThrow(() => packageManagerTest.assertCompatibleOperationHandoff(source, target));
  const unproven = structuredClone(target);
  unproven.manifest.resourceOwner.compatibleSourcePackageDigests = [];
  assert.throws(
    () => packageManagerTest.assertCompatibleOperationHandoff(source, unproven),
    (error: any) => error?.code === 'FEATURE.OPERATION_HANDOFF_UNPROVEN'
  );
  const abiDrift = structuredClone(target);
  abiDrift.capabilityFingerprint = 'b'.repeat(64);
  assert.throws(
    () => packageManagerTest.assertCompatibleOperationHandoff(source, abiDrift),
    (error: any) => error?.code === 'FEATURE.OPERATION_HANDOFF_UNPROVEN'
  );
  const staleSequence = structuredClone(target);
  staleSequence.manifest.sequence = 31;
  assert.throws(
    () => packageManagerTest.assertCompatibleOperationHandoff(source, staleSequence),
    (error: any) => error?.code === 'FEATURE.OPERATION_HANDOFF_UNPROVEN'
  );
  const ownerDowngradeSource = structuredClone(target);
  const ownerDowngradeTarget = structuredClone(target);
  ownerDowngradeTarget.digest = `sha256:${'8'.repeat(64)}`;
  ownerDowngradeTarget.manifest.version = '0.4.20';
  ownerDowngradeTarget.manifest.sequence = 33;
  delete ownerDowngradeTarget.manifest.resourceOwner;
  assert.throws(
    () => packageManagerTest.assertCompatibleOperationHandoff(ownerDowngradeSource, ownerDowngradeTarget),
    (error: any) => error?.code === 'FEATURE.OPERATION_OWNER_DOWNGRADE_FORBIDDEN'
  );

  const frozenIdentity = {
    recordingId: '53c4f730-4419-4a30-9da8-72dcafe0324c',
    observationId: 'observation_3913c153fe1240c4719803e2350f3dea',
    streamId: 'stream_36a65e360751c80e0161d12f70c06b80', eventCount: 1046
  };
  const before = structuredClone(frozenIdentity);
  let oldRegisterCalls = 0;
  let oldInvokeCalls = 0;
  const oldConnector: any = {
    registerOperation: async () => {
      oldRegisterCalls += 1;
      return {
        schemaVersion: 'omnia.operation-registration-result/v1',
        featureId: source.manifest.featureId, featureVersion: source.manifest.version,
        packageId: source.manifest.packageId, packageDigest: source.digest,
        operationIds: [descriptor.operationId]
      };
    },
    invokeOperation: async () => { oldInvokeCalls += 1; throw new Error('must not invoke'); }
  };
  await assert.rejects(
    packageManagerTest.ensureExactSourceOperationRegistration(oldConnector, {
      featureId: 'omnia.recording', featureVersion: '0.4.18', operationPackage: source.envelope,
      validatedOperationPackage: source
    }),
    (error: any) => error?.code === 'FEATURE.OPERATION_HANDOFF_SOURCE_REGISTRATION_UNPROVEN'
  );
  assert.equal(oldRegisterCalls, 1);
  assert.equal(oldInvokeCalls, 0, 'refused handoff must not status, stop, read, or delete an owned stream');
  assert.deepEqual(frozenIdentity, before, 'refused handoff must preserve the exact frozen recording identity');
  const mixedStandaloneConnector: any = {
    registerOperation: async () => ({
      schemaVersion: 'omnia.operation-registration-result/v1',
      featureId: source.manifest.featureId, featureVersion: source.manifest.version,
      packageId: source.manifest.packageId, packageDigest: source.digest,
      operationIds: [descriptor.operationId], registrationState: 'committed',
      registrationToken: 'c'.repeat(64), replacedPackageDigests: [`sha256:${'9'.repeat(64)}`]
    })
  };
  await assert.rejects(
    packageManagerTest.ensureExactSourceOperationRegistration(mixedStandaloneConnector, {
      featureId: 'omnia.recording', featureVersion: '0.4.18', operationPackage: source.envelope,
      validatedOperationPackage: source
    }),
    (error: any) => error?.code === 'FEATURE.OPERATION_HANDOFF_SOURCE_REGISTRATION_UNPROVEN',
    'source provenance registration must be standalone and cannot conceal another replacement handoff'
  );

  let capableRegisterCalls = 0;
  const registrationToken = 'f'.repeat(64);
  const sourceRegistrationToken = 'd'.repeat(64);
  let targetCommitted = false;
  const capableConnector: any = {
    registerOperation: async (input: any) => {
      capableRegisterCalls += 1;
      const isSource = input.featureVersion === '0.4.18';
      if (!isSource && input.schemaVersion === 'omnia.operation-registration-commit/v1') targetCommitted = true;
      return {
        schemaVersion: 'omnia.operation-registration-result/v1',
        featureId: input.featureId, featureVersion: input.featureVersion,
        packageId: target.manifest.packageId, packageDigest: isSource ? legacyOperationDigest : targetDigest,
        operationIds: [descriptor.operationId],
        registrationState: input.schemaVersion === 'omnia.operation-registration/v1'
          ? (!isSource && targetCommitted ? 'committed' : 'prepared') : 'committed',
        registrationToken: isSource ? sourceRegistrationToken : registrationToken,
        replacedPackageDigests: isSource ? [] : [legacyOperationDigest]
      };
    }
  };
  await packageManagerTest.ensureExactSourceOperationRegistration(capableConnector, {
    featureId: 'omnia.recording', featureVersion: '0.4.18', operationPackage: source.envelope,
    validatedOperationPackage: source
  });
  const prepared = await packageManagerTest.registerExactOperationHandoff(capableConnector, {
    featureId: 'omnia.recording', featureVersion: '0.4.19', operationPackage: {},
    operationManifest: target.manifest, operationPackageDigest: targetDigest,
    sourceOperationPackageDigest: legacyOperationDigest
  });
  assert.deepEqual(prepared, {
    registrationState: 'prepared', registrationToken, replacedPackageDigests: [legacyOperationDigest]
  });
  await packageManagerTest.commitExactOperationHandoff(capableConnector, {
    featureId: 'omnia.recording', featureVersion: '0.4.19', operationPackageDigest: targetDigest,
    registrationToken, operationManifest: target.manifest,
    replacedPackageDigests: [legacyOperationDigest]
  });
  await packageManagerTest.commitExactOperationHandoff(capableConnector, {
    featureId: 'omnia.recording', featureVersion: '0.4.19', operationPackageDigest: targetDigest,
    registrationToken, operationManifest: target.manifest,
    replacedPackageDigests: [legacyOperationDigest]
  });
  await packageManagerTest.restoreExactCommittedOperationHandoff(capableConnector, {
    featureId: 'omnia.recording', featureVersion: '0.4.19', operationPackage: {},
    operationManifest: target.manifest, operationPackageDigest: targetDigest,
    sourceOperationPackageDigest: legacyOperationDigest, registrationToken
  });
  await packageManagerTest.finalizeExactOperationHandoff(capableConnector, {
    featureId: 'omnia.recording', featureVersion: '0.4.19', operationPackageDigest: targetDigest,
    registrationToken, operationManifest: target.manifest, replacedPackageDigests: [legacyOperationDigest]
  });
  await packageManagerTest.finalizeExactOperationHandoff(capableConnector, {
    featureId: 'omnia.recording', featureVersion: '0.4.19', operationPackageDigest: targetDigest,
    registrationToken, operationManifest: target.manifest, replacedPackageDigests: [legacyOperationDigest]
  });
  assert.equal(capableRegisterCalls, 8,
    'source provenance is committed first and lost target commit/finalize responses retry exact tokens idempotently');
  assert.deepEqual(frozenIdentity, before, 'compatible handoff continues with the same recording/observation/stream identity');
});

test('Operation handoff head CAS is durable, retryable, and leaves the old activation untouched on mismatch', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-operation-handoff-cas-'));
  const paths = resolveProductPaths(temporary);
  const database = new CoreDatabase(paths.database, cipher);
  const featureId = 'omnia.recording';
  const sourceDigest = `sha256:${'1'.repeat(64)}`;
  const targetDigest = `sha256:${'2'.repeat(64)}`;
  const sourceOperationDigest = `sha256:${'a'.repeat(64)}`;
  const targetOperationDigest = `sha256:${'b'.repeat(64)}`;
  const source: any = {
    featureId, featureVersion: '0.4.18', activationGeneration: 7, runtimeEnabled: true, runtimeReason: '',
    packagePath: 'packages/installed/omnia.recording/0.4.18/source', packageDigest: sourceDigest,
    documentationPath: 'documentation/features/omnia.recording/0.4.18/source'
  };
  const target: any = {
    featureId, featureVersion: '0.4.19', activationGeneration: 8, runtimeEnabled: false, runtimeReason: '',
    packagePath: 'packages/installed/omnia.recording/0.4.19/target', packageDigest: targetDigest,
    documentationPath: 'documentation/features/omnia.recording/0.4.19/target'
  };
  const now = '2026-08-10T06:00:00.000Z';
  const token = '3'.repeat(64);
  try {
    packageManagerTest.ensureOperationHandoffLedger(database.db);
    database.db.prepare(`INSERT INTO feature_registry(feature_id,feature_version,lifecycle,package_digest,publisher_key_id,health,activated_at) VALUES(?,?,?,?,?,?,?)`)
      .run(featureId, source.featureVersion, 'active', sourceDigest, 'publisher', 'ready', now);
    database.db.prepare(`INSERT INTO feature_registry(feature_id,feature_version,lifecycle,package_digest,publisher_key_id,health,activated_at) VALUES(?,?,?,?,?,?,?)`)
      .run(featureId, target.featureVersion, 'candidate', targetDigest, 'publisher', 'pending_operation_handoff', now);
    database.db.prepare(`INSERT INTO documentation_registry(feature_id,feature_version,documentation_digest,lifecycle,activated_at,physical_path) VALUES(?,?,?,?,?,?)`)
      .run(featureId, source.featureVersion, 'doc-source', 'active', now, source.documentationPath);
    database.db.prepare(`INSERT INTO documentation_registry(feature_id,feature_version,documentation_digest,lifecycle,activated_at,physical_path) VALUES(?,?,?,?,?,?)`)
      .run(featureId, target.featureVersion, 'doc-target', 'candidate', now, target.documentationPath);
    database.db.prepare(`INSERT INTO feature_activation_heads(feature_id,feature_version,activation_generation,runtime_enabled,runtime_reason,package_path,package_digest,updated_at,documentation_path) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(featureId, source.featureVersion, source.activationGeneration, 1, '', source.packagePath, sourceDigest, now, source.documentationPath);
    database.db.prepare(`INSERT INTO feature_operation_handoffs(
      handoff_id,feature_id,source_feature_version,source_package_digest,source_operation_package_digest,
      source_activation_generation,target_feature_version,target_package_digest,target_operation_package_digest,
      target_activation_generation,registration_token,replaced_package_digests_json,phase,created_at,updated_at,last_error
    ) VALUES(?,?,?,?,?,?,?,?,?,?,'','[]','staged',?,?,'')`).run(
      crypto.randomUUID(), featureId, source.featureVersion, sourceDigest, sourceOperationDigest,
      source.activationGeneration, target.featureVersion, targetDigest, targetOperationDigest,
      target.activationGeneration, now, now
    );

    assert.throws(
      () => packageManagerTest.persistPreparedOperationHandoff(
        database.db, { ...source, packageDigest: `sha256:${'9'.repeat(64)}` }, target,
        token, [sourceOperationDigest], now
      ),
      (error: any) => error?.code === 'FEATURE.OPERATION_HANDOFF_LEDGER_CAS_MISMATCH'
    );
    assert.deepEqual(
      { ...(database.db.prepare('SELECT feature_version,activation_generation,runtime_enabled,package_digest FROM feature_activation_heads WHERE feature_id=?').get(featureId) as any) },
      { feature_version: source.featureVersion, activation_generation: 7, runtime_enabled: 1, package_digest: sourceDigest }
    );
    assert.equal((database.db.prepare('SELECT health FROM feature_registry WHERE feature_id=? AND feature_version=?').get(featureId, target.featureVersion) as any).health,
      'pending_operation_handoff');

    database.db.prepare("UPDATE feature_registry SET lifecycle='previous' WHERE feature_id=? AND feature_version=?")
      .run(featureId, target.featureVersion);
    assert.throws(
      () => packageManagerTest.persistPreparedOperationHandoff(
        database.db, source, target, token, [sourceOperationDigest], now
      ),
      (error: any) => error?.code === 'FEATURE.OPERATION_HANDOFF_CANDIDATE_CAS_MISMATCH'
    );
    database.db.prepare("UPDATE feature_registry SET lifecycle='candidate' WHERE feature_id=? AND feature_version=?")
      .run(featureId, target.featureVersion);
    packageManagerTest.persistPreparedOperationHandoff(
      database.db, source, target, token, [sourceOperationDigest], now
    );
    packageManagerTest.persistPreparedOperationHandoff(
      database.db, source, target, token, [sourceOperationDigest], now
    );
    assert.throws(
      () => packageManagerTest.persistPreparedOperationHandoff(
        database.db, source, target, '4'.repeat(64), [sourceOperationDigest], now
      ),
      (error: any) => error?.code === 'FEATURE.OPERATION_HANDOFF_LEDGER_CAS_MISMATCH'
    );
    assert.deepEqual(
      { ...(database.db.prepare('SELECT feature_version,activation_generation,runtime_enabled,package_digest FROM feature_activation_heads WHERE feature_id=?').get(featureId) as any) },
      { feature_version: source.featureVersion, activation_generation: 7, runtime_enabled: 1, package_digest: sourceDigest }
    );
    assert.equal((database.db.prepare('SELECT health FROM feature_registry WHERE feature_id=? AND feature_version=?').get(featureId, target.featureVersion) as any).health,
      `operation_handoff_prepared:${token}`);
    assert.equal((database.db.prepare('SELECT lifecycle FROM feature_registry WHERE feature_id=? AND feature_version=?').get(featureId, source.featureVersion) as any).lifecycle,
      'active', 'prepare must not retire or replace the old authoritative activation head');
    assert.deepEqual(
      { ...(database.db.prepare(`SELECT phase,registration_token,replaced_package_digests_json,
        source_package_digest,source_operation_package_digest,target_package_digest,target_operation_package_digest
        FROM feature_operation_handoffs WHERE feature_id=? AND phase='prepared'`).get(featureId) as any) },
      {
        phase: 'prepared', registration_token: token,
        replaced_package_digests_json: JSON.stringify([sourceOperationDigest]),
        source_package_digest: sourceDigest, source_operation_package_digest: sourceOperationDigest,
        target_package_digest: targetDigest, target_operation_package_digest: targetOperationDigest
      }
    );
    packageManagerTest.persistCommittedOperationHandoff(
      database.db, source, target, token, [sourceOperationDigest], '2026-08-10T06:00:00.500Z'
    );
    database.db.prepare('UPDATE feature_activation_heads SET activation_generation=8 WHERE feature_id=?').run(featureId);
    assert.throws(
      () => packageManagerTest.finalizePreparedOperationHandoff(
        database.db, source, target, token, '2026-08-10T06:00:01.000Z'
      ),
      (error: any) => error?.code === 'FEATURE.OPERATION_HANDOFF_HEAD_CAS_MISMATCH'
    );
    assert.equal((database.db.prepare('SELECT phase FROM feature_operation_handoffs WHERE feature_id=?').get(featureId) as any).phase,
      'committed', 'Core CAS mismatch must retain the durable committed phase for abort reconciliation');
    database.db.prepare('UPDATE feature_activation_heads SET activation_generation=7 WHERE feature_id=?').run(featureId);

    packageManagerTest.finalizePreparedOperationHandoff(
      database.db, source, target, token, '2026-08-10T06:00:01.000Z'
    );
    assert.equal((database.db.prepare('SELECT runtime_enabled FROM feature_activation_heads WHERE feature_id=?').get(featureId) as any).runtime_enabled, 1);
    assert.equal((database.db.prepare('SELECT lifecycle FROM feature_registry WHERE feature_id=? AND feature_version=?').get(featureId, source.featureVersion) as any).lifecycle, 'previous');
    assert.equal((database.db.prepare('SELECT lifecycle FROM feature_registry WHERE feature_id=? AND feature_version=?').get(featureId, target.featureVersion) as any).lifecycle, 'active');
    assert.equal((database.db.prepare('SELECT health FROM feature_registry WHERE feature_id=? AND feature_version=?').get(featureId, target.featureVersion) as any).health,
      `operation_handoff_finalize_pending:${token}`);
    assert.equal((database.db.prepare('SELECT COUNT(*) AS count FROM feature_activation_events WHERE feature_id=? AND from_version=? AND to_version=?').get(featureId, source.featureVersion, target.featureVersion) as any).count, 1);
    const restartedManager = new FeaturePackageManager(database.db, paths);
    const finalizeLedger = packageManagerTest.activeOperationHandoff(database.db, featureId)!;
    assert.equal(finalizeLedger.phase, 'finalize_pending');
    assert.equal(restartedManager.list().find((item) => item.featureId === featureId)?.packageDigest, targetDigest);
    assert.deepEqual(
      packageManagerTest.operationHandoffByToken(database.db, featureId, token),
      finalizeLedger,
      'restart must recover the exact finalize-pending target/token instead of selecting a newer candidate'
    );
    assert.throws(
      () => packageManagerTest.assertNoActiveOperationHandoff(database.db, featureId, 'Feature disable'),
      (error: any) => error?.code === 'FEATURE.OPERATION_HANDOFF_IN_PROGRESS'
    );
    packageManagerTest.completeFinalizedOperationHandoff(
      database.db, finalizeLedger, '2026-08-10T06:00:02.000Z'
    );
    assert.equal((database.db.prepare('SELECT phase FROM feature_operation_handoffs WHERE feature_id=?').get(featureId) as any).phase,
      'finalized');
    assert.equal(packageManagerTest.activeOperationHandoff(database.db, featureId), null);
    assert.equal(packageManagerTest.operationHandoffByToken(database.db, featureId, token)?.phase, 'finalized');
    const abortTargetDigest = `sha256:${'5'.repeat(64)}`;
    const abortTargetOperationDigest = `sha256:${'c'.repeat(64)}`;
    const abortToken = '6'.repeat(64);
    database.db.prepare(`INSERT INTO feature_registry(feature_id,feature_version,lifecycle,package_digest,publisher_key_id,health,activated_at)
      VALUES(?,?,'candidate',?,'publisher','operation_handoff_committed',?)`)
      .run(featureId, '0.4.20', abortTargetDigest, now);
    database.db.prepare(`INSERT INTO documentation_registry(feature_id,feature_version,documentation_digest,lifecycle,activated_at,physical_path)
      VALUES(?,?,'doc-abort','candidate',?,?)`)
      .run(featureId, '0.4.20', now, 'documentation/features/omnia.recording/0.4.20/abort');
    database.db.prepare(`INSERT INTO feature_operation_handoffs(
      handoff_id,feature_id,source_feature_version,source_package_digest,source_operation_package_digest,
      source_activation_generation,target_feature_version,target_package_digest,target_operation_package_digest,
      target_activation_generation,registration_token,replaced_package_digests_json,phase,created_at,updated_at,last_error
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'committed',?,?,'')`).run(
      crypto.randomUUID(), featureId, target.featureVersion, targetDigest, targetOperationDigest,
      target.activationGeneration, '0.4.20', abortTargetDigest, abortTargetOperationDigest, 9,
      abortToken, JSON.stringify([targetOperationDigest]), now, now
    );
    const committedAbort = packageManagerTest.activeOperationHandoff(database.db, featureId)!;
    packageManagerTest.markOperationHandoffAbortPending(
      database.db, committedAbort, new Error('injected Core CAS mismatch'), '2026-08-10T06:00:03.000Z'
    );
    const abortPending = packageManagerTest.activeOperationHandoff(database.db, featureId)!;
    assert.equal(abortPending.phase, 'abort_pending');
    packageManagerTest.completeAbortedOperationHandoff(
      database.db, abortPending, '2026-08-10T06:00:04.000Z'
    );
    assert.equal((database.db.prepare(`SELECT phase FROM feature_operation_handoffs
      WHERE target_feature_version='0.4.20'`).get() as any).phase, 'aborted');
    assert.equal((database.db.prepare(`SELECT lifecycle FROM feature_registry
      WHERE feature_id=? AND feature_version='0.4.20'`).get(featureId) as any).lifecycle, 'rejected');
  } finally {
    database.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('install refuses to remove a signed source resource owner before staging or head mutation', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-operation-owner-downgrade-'));
  const paths = resolveProductPaths(temporary);
  const database = new CoreDatabase(paths.database, cipher);
  try {
    let sourceFeature = verifyOfficialPackage(JSON.parse(fs.readFileSync(recording017Path, 'utf8')), 'omnia-feature') as any;
    const operationMember = sourceFeature.files.find((member: any) => member.path === 'connector-capability/operation.ofop')!;
    let sourceOperation = verifyOfficialPackage(
      JSON.parse(Buffer.from(operationMember.contentBase64, 'base64').toString('utf8')), 'omnia-connector-operation'
    ) as any;
    const manifestMember = sourceOperation.files.find((member: any) => member.path === 'manifest.json')!;
    const operationManifest = JSON.parse(Buffer.from(manifestMember.contentBase64, 'base64').toString('utf8'));
    operationManifest.resourceOwner = {
      schemaVersion: 'omnia.operation-resource-owner/v1', ownerId: 'omnia.page-observation.current-pack',
      compatibilityVersion: 1, capabilities: ['omnia.page-observation.current-pack.v1'],
      compatibleSourcePackageDigests: []
    };
    replaceEnvelopeBytes(sourceOperation, 'manifest.json', Buffer.from(JSON.stringify(operationManifest)));
    sourceOperation = resignEnvelope(sourceOperation, 'operation-ed25519-private.pem');
    replaceEnvelopeBytes(sourceFeature, 'connector-capability/operation.ofop', Buffer.from(JSON.stringify(sourceOperation)));
    sourceFeature = resignEnvelope(sourceFeature, 'feature-ed25519-private.pem');
    const sourcePath = path.join(temporary, 'recording-owned-0.4.17.ofp');
    fs.writeFileSync(sourcePath, JSON.stringify(sourceFeature));
    const manager = new FeaturePackageManager(database.db, paths);
    manager.install(sourcePath);
    const before = manager.list().find((item) => item.featureId === 'omnia.recording')!;
    assert.throws(
      () => manager.install(candidatePath),
      (error: any) => error?.code === 'FEATURE.OPERATION_OWNER_DOWNGRADE_FORBIDDEN'
    );
    const after = manager.list().find((item) => item.featureId === 'omnia.recording')!;
    assert.deepEqual(after, before);
    assert.equal((database.db.prepare(`SELECT COUNT(*) AS count FROM feature_registry
      WHERE feature_id='omnia.recording' AND feature_version='0.4.18'`).get() as any).count, 0,
    'owner downgrade must fail before candidate registry staging');
  } finally {
    database.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('Operation handoff abort is exact-token idempotent and never confuses Feature and Operation digests', async () => {
  const featureDigest = `sha256:${'1'.repeat(64)}`;
  const sourceOperationDigest = `sha256:${'a'.repeat(64)}`;
  const targetOperationDigest = `sha256:${'b'.repeat(64)}`;
  const registrationToken = '7'.repeat(64);
  const operationId = 'omnia.recording.observation.status.v1';
  const manifest: any = { packageId: 'omnia.recording.operation', operations: [{ operationId }] };
  let calls = 0;
  const connector: any = {
    registerOperation: async (input: any) => {
      calls += 1;
      assert.equal(input.schemaVersion, 'omnia.operation-registration-abort/v1');
      assert.equal(input.operationPackageDigest, targetOperationDigest);
      return {
        schemaVersion: 'omnia.operation-registration-result/v1', featureId: input.featureId,
        featureVersion: input.featureVersion, packageId: manifest.packageId,
        packageDigest: targetOperationDigest, operationIds: [operationId], registrationState: 'aborted',
        registrationToken, replacedPackageDigests: [sourceOperationDigest]
      };
    }
  };
  for (let attempt = 0; attempt < 2; attempt += 1) await packageManagerTest.abortExactOperationHandoff(connector, {
    featureId: 'omnia.recording', featureVersion: '0.4.19',
    operationPackageDigest: targetOperationDigest, registrationToken, operationManifest: manifest,
    sourceOperationPackageDigest: sourceOperationDigest
  });
  assert.equal(calls, 2);
  assert.notEqual(featureDigest, targetOperationDigest,
    'the fixture deliberately prevents Feature package digest from passing as Operation package identity');
});

test('one durable handoff fences a second install, rollback, and every head-disable mutation across restart', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-operation-handoff-fence-'));
  const paths = resolveProductPaths(temporary);
  const database = new CoreDatabase(paths.database, cipher);
  try {
    let manager = new FeaturePackageManager(database.db, paths);
    manager.install(deletePackage010);
    manager.install(deletePackage011);
    const head = manager.list().find((item) => item.featureId === 'omnia.delete-elements')!;
    const sourceFeature = verifyOfficialPackage(JSON.parse(fs.readFileSync(deletePackage011, 'utf8')), 'omnia-feature');
    const sourceOperationMember = sourceFeature.files.find((member) => member.path === 'connector-capability/operation.ofop')!;
    const sourceOperation = verifyOfficialPackage(
      JSON.parse(Buffer.from(sourceOperationMember.contentBase64, 'base64').toString('utf8')), 'omnia-connector-operation'
    );
    const sourceOperationDigest = packageDigest(sourceOperation);
    const targetFeatureDigest = `sha256:${'6'.repeat(64)}`;
    const targetOperationDigest = `sha256:${'7'.repeat(64)}`;
    const now = '2026-08-10T07:00:00.000Z';
    database.db.prepare(`INSERT INTO feature_operation_handoffs(
      handoff_id,feature_id,source_feature_version,source_package_digest,source_operation_package_digest,
      source_activation_generation,target_feature_version,target_package_digest,target_operation_package_digest,
      target_activation_generation,registration_token,replaced_package_digests_json,phase,created_at,updated_at,last_error
    ) VALUES(?,?,?,?,?,?,?,?,?,?,'','[]','staged',?,?,'')`).run(
      crypto.randomUUID(), head.featureId, head.featureVersion, head.packageDigest, sourceOperationDigest,
      head.activationGeneration, '0.3.20', targetFeatureDigest, targetOperationDigest,
      head.activationGeneration + 1, now, now
    );
    assert.throws(
      () => manager.install(deletePackage0319),
      (error: any) => error?.code === 'FEATURE.OPERATION_HANDOFF_IN_PROGRESS'
    );
    assert.throws(
      () => manager.rollback(head.featureId, '0.1.0'),
      (error: any) => error?.code === 'FEATURE.OPERATION_HANDOFF_IN_PROGRESS'
    );
    assert.throws(
      () => packageManagerTest.assertNoActiveOperationHandoff(database.db, head.featureId, 'Feature disable'),
      (error: any) => error?.code === 'FEATURE.OPERATION_HANDOFF_IN_PROGRESS'
    );
    manager = new FeaturePackageManager(database.db, paths);
    const recovered = packageManagerTest.activeOperationHandoff(database.db, head.featureId)!;
    assert.equal(recovered.phase, 'staged');
    assert.equal(recovered.sourcePackageDigest, head.packageDigest);
    assert.equal(recovered.sourceOperationPackageDigest, sourceOperationDigest);
    assert.equal(manager.list().find((item) => item.featureId === head.featureId)?.packageDigest, head.packageDigest,
      'restart must keep the source head authoritative while the single handoff is active');
  } finally {
    database.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('legacy orphan evidence is never auto-claimed from Recording Worker health', () => {
  const worker = fs.readFileSync(workerSourcePath, 'utf8');
  const packageManager = fs.readFileSync(path.join(repository, 'src', 'main', 'features', 'package-manager.ts'), 'utf8');
  assert.doesNotMatch(worker, /resourceRecoveryClaims|operation-resource-recovery-claim/u,
    'a Feature-private plan is not immutable proof of the creator Operation owner');
  assert.doesNotMatch(packageManager, /health\.resourceRecoveryClaims|resourceRecoveryAttestations/u);
  assert.match(packageManager, /legacy[\s\S]*orphan[\s\S]*remain quarantined/u);
});

test('recording control intents are durable before generic PageObservation effects and no recording Connector command exists', () => {
  const worker = fs.readFileSync(workerSourcePath, 'utf8');
  const operation = fs.readFileSync(operationSourcePath, 'utf8');
  const actions = worker.slice(worker.indexOf("if (input.actionId === 'start-recording' || input.actionId === 'restart-recording')"));
  const starting = actions.indexOf("recordingId: externalId, runId: run.runId, state: 'starting'");
  const savedStartingPlan = actions.indexOf('const savedPlan = await savePlan(plan)');
  const opening = actions.indexOf('return completeStart(context, pack, savedPlan)');
  const pausing = actions.indexOf("state: 'pausing', startedAt: before.startedAt");
  const pause = actions.indexOf('operation(OPS.pause');
  const resuming = actions.indexOf("state: 'resuming', startedAt: status.startedAt");
  const resume = actions.indexOf('operation(OPS.resume');
  const stopping = actions.indexOf("state: 'stopping', startedAt: before.startedAt");
  const stop = actions.indexOf('operation(OPS.stop');

  assert.ok(starting >= 0 && savedStartingPlan > starting && opening > savedStartingPlan,
    'start intent must persist in the Core plan before completeStart opens the observation');
  assert.match(worker, /async function completeStart[\s\S]*?operation\(OPS\.open/);
  assert.ok(pausing >= 0 && pause > pausing, 'pause intent must persist before observation pause');
  assert.ok(resuming >= 0 && resume > resuming, 'resume intent must persist before observation resume');
  assert.ok(stopping >= 0 && stop > stopping, 'stop intent must persist before observation stop');
  assert.match(worker, /async function completeStart[\s\S]*?pythonInvoke\('mark_state',[\s\S]*?state: 'starting'[\s\S]*?operation\(OPS\.open/);
  assert.match(worker, /before\.state === 'stopped'[\s\S]*?state: confirmedState/);
  assert.match(worker, /actionId: 'finalize-recording'[\s\S]*?finalizationPending/);
  assert.match(worker, /start_uncertain[\s\S]*?completeStart\(context, pack, current\)/);
  assert.doesNotMatch(operation, /recordingCommand|recording_command|sdk\.request\s*\(/);
  assert.match(operation, /sdk\.pageObservation\.open/);
  assert.match(operation, /sdk\.pageObservation\.pause/);
  assert.match(operation, /sdk\.pageObservation\.resume/);
  assert.match(operation, /sdk\.pageObservation\.stop/);
  assert.match(operation, /sdk\.pageObservation\.readChunk/);
  assert.match(worker, /type: String\(row\.state \|\| 'unknown'\), selectable: false/);
  assert.match(worker, /abandoned_legacy_identity/);
  assert.match(worker, /input\?\.payload\?\.recordingId \|\| current\?\.recordingId/);
  assert.match(worker, /beginPythonInputTransfer/);
  assert.match(worker, /assertSameFrozenStream\(plan, frozen\)/);
  assert.match(worker, /const STREAM_READ_CONCURRENCY = 8/);
  assert.match(worker, /FINALIZATION_CHECKPOINT_SCHEMA/);
  assert.match(worker, /pendingAppend/);
  assert.match(worker, /saveFinalizationCheckpoint/);
  assert.match(worker, /compareAndSwapPlan/);
  assert.match(worker, /expectedStoreRevision/);
  assert.match(worker, /isPlanCasMismatch[\s\S]*?FEATURE\.PLAN_CAS_MISMATCH/);
  assert.match(worker, /async function finalizeStopped[\s\S]*?if \(isPlanCasMismatch\(error\)\) throw error/);
  assert.doesNotMatch(worker, /failProcessingRun'[\s\S]{0,180}?\.catch\(/,
    'authoritative Core Run failure must not be caught and ignored');
  assert.doesNotMatch(worker, /loadProcessingRun'[\s\S]{0,180}?\.catch\(/,
    'authoritative Core Run state reads must not be caught and converted to a false missing state');
  assert.match(worker, /Promise\.all\(offsets\.map/);
  assert.doesNotMatch(worker, /scanFrozenStream|transferFrozenStream/);
  assert.match(worker, /scopeId: 'recording-history'[\s\S]*?disabledReason:[\s\S]*?concurrencyToken: ''/);
  assert.match(worker, /scopes: projected\.items\.length \? \[\{/);
  assert.match(worker, /actionId: 'export-recording'[\s\S]*?enabled: exported/);
});

test('Core allocates frozen-input, recovery, and completion revisions transactionally and reuses identical output Artifacts', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-recording-core-cas-'));
  const paths = resolveProductPaths(temporary);
  fs.mkdirSync(path.join(paths.data, 'features', 'omnia.recording'), { recursive: true });
  const database = new CoreDatabase(paths.database, cipher);
  const store = new FeatureRuntimeStore(database.db, paths);
  const context = { featureId: 'omnia.recording', featureVersion: '0.4.3', allowMutation: false };
  const frozen = Buffer.from('{"schemaVersion":"omnia.page-observation-event/v1"}\n', 'utf8');
  const frozenSha256 = digest(frozen);
  const createRun = (externalId: string) => store.call('createProcessingRun', {
    surfaceId: 'recording.workbench', engagementId, sourceRef: `connector-recording:${externalId}`, externalId
  }, context) as any;
  const begin = (processingRunId: string, externalId: string) => store.call('beginPythonInputTransfer', {
    runId: processingRunId, originalName: `omnia-page-observation-${externalId}.ndjson`,
    mediaType: 'application/x-ndjson', expectedSizeBytes: frozen.length, expectedSha256: frozenSha256, chunkCount: 1,
    recovery: {
      schemaVersion: 'omnia.processing-run-frozen-input-recovery/v1', externalId, connectorState: 'stopped',
      frozenSha256, frozenSizeBytes: frozen.length, frozenChunkCount: 1
    }
  }, context) as any;
  try {
    const planId = `recording-run:${recordingId}`;
    const initialPlan = { planId, storeRevision: 1, recordingId, runId, state: 'finalizing' };
    const inserted = store.call('compareAndSwapPlan', {
      schemaVersion: 'omnia.feature-runtime-plan-cas/v1', planId, expectedStoreRevision: 0, plan: initialPlan
    }, context) as any;
    assert.equal(inserted.storeRevision, 1);
    assert.deepEqual(store.call('loadPlan', planId, context), initialPlan);
    assert.throws(() => store.call('compareAndSwapPlan', {
      schemaVersion: 'omnia.feature-runtime-plan-cas/v1', planId, expectedStoreRevision: 0,
      plan: { ...initialPlan, storeRevision: 1, state: 'finalization_failed' }
    }, context), (error: any) => error?.code === 'FEATURE.PLAN_CAS_MISMATCH');
    const advancedPlan = { ...initialPlan, storeRevision: 2, state: 'finalization_failed' };
    assert.equal((store.call('compareAndSwapPlan', {
      schemaVersion: 'omnia.feature-runtime-plan-cas/v1', planId, expectedStoreRevision: 1, plan: advancedPlan
    }, context) as any).storeRevision, 2);
    assert.throws(() => store.call('savePlan', advancedPlan, context),
      (error: any) => error?.code === 'FEATURE.PLAN_CAS_REQUIRED');

    const firstExternalId = '12121212-1212-4121-8121-121212121212';
    const first = createRun(firstExternalId);
    const firstTransfer = begin(first.runId, firstExternalId);
    const firstAfterBinding = database.db.prepare('SELECT state,state_revision FROM feature_runs WHERE run_id=?').get(first.runId) as any;
    assert.deepEqual({ ...firstAfterBinding }, { state: 'processing', state_revision: 2 });
    assert.deepEqual((database.db.prepare('SELECT revision,event_type FROM feature_run_events WHERE run_id=? ORDER BY revision').all(first.runId) as any[])
      .map((row) => [row.revision, row.event_type]), [[1, 'run.processing_started'], [2, 'run.processing_frozen_input_bound']]);
    const duplicateTransfer = begin(first.runId, firstExternalId);
    assert.equal((database.db.prepare("SELECT COUNT(*) AS count FROM feature_run_events WHERE run_id=? AND event_type='run.processing_frozen_input_bound'").get(first.runId) as any).count, 1);
    assert.equal((database.db.prepare('SELECT state_revision FROM feature_runs WHERE run_id=?').get(first.runId) as any).state_revision, 2);
    store.call('abortPythonInputTransfer', { transferId: firstTransfer.transferId }, context);
    store.call('abortPythonInputTransfer', { transferId: duplicateTransfer.transferId }, context);

    const outputBytes = Buffer.from(JSON.stringify({ recordingId: firstExternalId, totalEvents: 1 }), 'utf8');
    const commitOutput = () => {
      const handle = store.call('createPythonOutputHandle', {
        runId: first.runId, kind: 'result', mediaType: 'application/json',
        originalName: `omnia-recording-${firstExternalId}.json`, maxBytes: 1024 * 1024
      }, context) as any;
      fs.writeFileSync(handle.path, outputBytes);
      return store.call('commitPythonOutputHandle', { handleId: handle.handleId, sha256: digest(outputBytes) }, context) as any;
    };
    const committed = commitOutput();
    const repeatedCommit = commitOutput();
    assert.equal(repeatedCommit.artifactId, committed.artifactId);
    assert.equal(repeatedCommit.idempotent, true);
    assert.equal((database.db.prepare('SELECT COUNT(*) AS count FROM feature_artifacts WHERE run_id=?').get(first.runId) as any).count, 1);
    const finished = store.call('finishProcessingRun', { runId: first.runId, artifactId: committed.artifactId }, context) as any;
    assert.equal(finished.stateRevision, 3);
    const repeatedFinish = store.call('finishProcessingRun', { runId: first.runId, artifactId: committed.artifactId }, context) as any;
    assert.equal(repeatedFinish.stateRevision, 3);
    assert.equal(repeatedFinish.idempotent, true);

    const uncertainExternalId = '34343434-3434-4343-8343-343434343434';
    const uncertain = createRun(uncertainExternalId);
    const failed = store.call('failProcessingRun', { runId: uncertain.runId, state: 'uncertain', error: 'response unknown' }, context) as any;
    assert.equal(failed.stateRevision, 2);
    const recoveredTransfer = begin(uncertain.runId, uncertainExternalId);
    const recovered = database.db.prepare('SELECT state,state_revision,last_error FROM feature_runs WHERE run_id=?').get(uncertain.runId) as any;
    assert.deepEqual({ ...recovered }, { state: 'processing', state_revision: 4, last_error: '' });
    assert.deepEqual((database.db.prepare('SELECT revision,event_type FROM feature_run_events WHERE run_id=? ORDER BY revision').all(uncertain.runId) as any[])
      .map((row) => [row.revision, row.event_type]), [
        [1, 'run.processing_started'], [2, 'run.processing_uncertain'],
        [3, 'run.processing_frozen_input_bound'], [4, 'run.processing_recovered_from_frozen_input']
      ]);
    store.call('abortPythonInputTransfer', { transferId: recoveredTransfer.transferId }, context);
  } finally {
    database.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('Core creates one auditable successor for an artifact-free failed Recording Run and rejects side-effectful predecessors', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-recording-successor-'));
  const paths = resolveProductPaths(temporary);
  fs.mkdirSync(path.join(paths.data, 'features', 'omnia.recording'), { recursive: true });
  let database = new CoreDatabase(paths.database, cipher);
  const predecessorContext = { featureId: 'omnia.recording', featureVersion: '0.4.16', allowMutation: false };
  const successorContext = { featureId: 'omnia.recording', featureVersion: '0.4.18', allowMutation: false };
  const frozenInput = {
    schemaVersion: 'omnia.recording-frozen-input/v1', observationId, streamId,
    stoppedAt: '2026-08-09T14:23:30.595Z', eventCount: 1046, complete: true, omissionCount: 0,
    streamSha256: 'e'.repeat(64), streamSizeBytes: 9_437_184, streamChunkCount: 72
  };
  const requestFor = (predecessorRunId: string, externalId: string) => ({
    schemaVersion: 'omnia.processing-run-successor-request/v1', predecessorRunId,
    surfaceId: 'recording.workbench', engagementId,
    externalId, sourceRef: `connector-recording:${externalId}`, frozenInput
  });
  try {
    let store = new FeatureRuntimeStore(database.db, paths);
    const predecessor = store.call('createProcessingRun', {
      surfaceId: 'recording.workbench', engagementId,
      sourceRef: `connector-recording:${recordingId}`, externalId: recordingId
    }, predecessorContext) as any;
    database.db.prepare("UPDATE feature_runs SET state='failed',state_revision=2,last_error='reconciled' WHERE run_id=?")
      .run(predecessor.runId);
    database.db.prepare(`
      INSERT INTO feature_run_events(event_id,run_id,revision,from_state,to_state,event_type,details_json,occurred_at)
      VALUES(?,?,2,'processing','failed','recording.terminal_projection_reconciled',?,?)
    `).run(crypto.randomUUID(), predecessor.runId,
      JSON.stringify({ privateState: 'finalization_failed', evidenceRetained: true, mutationReplayed: false }),
      '2026-08-10T00:00:00.000Z');

    const first = store.call('createSuccessorProcessingRun', requestFor(predecessor.runId, recordingId), successorContext) as any;
    assert.equal(first.state, 'processing');
    assert.equal(first.predecessorRunId, predecessor.runId);
    assert.equal(first.externalId, recordingId);
    assert.equal(first.recoveryLineage.frozenInput.observationId, observationId);
    assert.equal(first.recoveryLineage.frozenInput.streamId, streamId);
    assert.equal((database.db.prepare('SELECT state FROM feature_runs WHERE run_id=?').get(predecessor.runId) as any).state, 'failed');

    database.close();
    database = new CoreDatabase(paths.database, cipher);
    store = new FeatureRuntimeStore(database.db, paths);
    const afterCrash = store.call('createSuccessorProcessingRun', requestFor(predecessor.runId, recordingId), successorContext) as any;
    assert.equal(afterCrash.runId, first.runId);
    assert.equal(afterCrash.idempotent, true);
    assert.equal((database.db.prepare(`
      SELECT COUNT(*) AS count FROM feature_run_events
      WHERE event_type='run.processing_started'
        AND json_extract(details_json,'$.recoveryLineage.predecessorRunId')=?
    `).get(predecessor.runId) as any).count, 1, 'crash retry must not create a duplicate successor');
    assert.throws(
      () => store.call('createSuccessorProcessingRun', requestFor(predecessor.runId, recordingId), {
        featureId: 'omnia.delete-elements', featureVersion: '0.4.18', allowMutation: false
      }),
      /only to the Recording Feature/u
    );
    assert.throws(
      () => store.call('createSuccessorProcessingRun', requestFor(predecessor.runId, recordingId), {
        featureId: 'omnia.recording', featureVersion: '0.4.19', allowMutation: false
      }),
      (error: any) => error?.code === 'FEATURE.PROCESSING_RUN_SUCCESSOR_CONFLICT'
    );

    const mutatedId = '56565656-5656-4656-8656-565656565656';
    const mutated = store.call('createProcessingRun', {
      surfaceId: 'recording.workbench', engagementId,
      sourceRef: `connector-recording:${mutatedId}`, externalId: mutatedId
    }, predecessorContext) as any;
    store.call('failProcessingRun', { runId: mutated.runId, error: 'failed' }, predecessorContext);
    database.db.prepare("UPDATE feature_runs SET state_revision=3,last_error='upgrade reconciled' WHERE run_id=?")
      .run(mutated.runId);
    database.db.prepare(`
      INSERT INTO feature_run_events(event_id,run_id,revision,from_state,to_state,event_type,details_json,occurred_at)
      VALUES(?,?,3,'failed','failed','recording.terminal_projection_reconciled',?,?)
    `).run(crypto.randomUUID(), mutated.runId, JSON.stringify({
      privateState: 'finalization_failed', evidenceRetained: true, mutationReplayed: false
    }), '2026-08-10T00:00:00.000Z');
    database.db.prepare(`
      INSERT INTO managed_content_intents(intent_id,run_id,plan_digest,target_kind,target_key,intended_revision_json,state,created_at,updated_at)
      VALUES(?,?,?,?,?,'{}','failed',?,?)
    `).run(crypto.randomUUID(), mutated.runId, 'f'.repeat(64), 'object', 'forbidden',
      '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z');
    assert.throws(
      () => store.call('createSuccessorProcessingRun', requestFor(mutated.runId, mutatedId), successorContext),
      /not eligible for side-effect-free successor recovery/u
    );
  } finally {
    database.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('Windows fsync EPERM is tolerated only for the complete authorized regular output file', () => {
  assert.equal(fs.existsSync(releasePython) && fs.statSync(releasePython).isFile(), true, 'release-owned CPython 3.13.14 is required');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-recording-fsync-'));
  const authorized = path.join(temporary, 'authorized.json');
  const other = path.join(temporary, 'other.json');
  const script = String.raw`
import errno
import os
import sys

sys.path.insert(0, sys.argv[1])
import export as recording_export

authorized, other = sys.argv[2], sys.argv[3]
with open(other, "wb") as stream:
    stream.write(b"abc")

original_fsync = recording_export.os.fsync
original_name = recording_export.os.name
try:
    recording_export.os.name = "nt"
    def fail_with(code):
        def failure(_descriptor):
            raise OSError(code, "forced fsync failure")
        return failure

    with open(authorized, "wb") as stream:
        stream.write(b"abc")
        recording_export.os.fsync = fail_with(errno.EPERM)
        recording_export._flush_and_sync_managed_output(stream, authorized, 3)

    rejected_wrong_file = False
    try:
        with open(authorized, "wb") as stream:
            stream.write(b"abc")
            recording_export.os.fsync = fail_with(errno.EPERM)
            recording_export._flush_and_sync_managed_output(stream, other, 3)
    except OSError as error:
        rejected_wrong_file = error.errno == errno.EPERM
    assert rejected_wrong_file

    rejected_other_errno = False
    try:
        with open(authorized, "wb") as stream:
            stream.write(b"abc")
            recording_export.os.fsync = fail_with(errno.EIO)
            recording_export._flush_and_sync_managed_output(stream, authorized, 3)
    except OSError as error:
        rejected_other_errno = error.errno == errno.EIO
    assert rejected_other_errno
finally:
    recording_export.os.fsync = original_fsync
    recording_export.os.name = original_name
`;
  try {
    const result = spawnSync(releasePython, ['-I', '-S', '-E', '-B', '-c', script, path.join(packageRoot, 'python'), authorized, other], {
      cwd: temporary, encoding: 'utf8', windowsHide: true
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('release-owned Python retains validated current rows after ingest failure and purges them exactly after 24 hours', { timeout: 30_000 }, async () => {
  assert.equal(fs.existsSync(releasePython) && fs.statSync(releasePython).isFile(), true, 'release-owned CPython 3.13.14 is required');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-recording-failed-ingest-'));
  const featureDataRoot = path.join(temporary, 'data', 'features', 'omnia.recording');
  const tempRoot = path.join(temporary, 'runtime-temp');
  const storePath = path.join(featureDataRoot, 'store.sqlite');
  fs.mkdirSync(featureDataRoot, { recursive: true });
  fs.mkdirSync(tempRoot, { recursive: true });
  fs.writeFileSync(storePath, '');
  const environmentKeys = [
    'OMNIA_MANAGED_PYTHON_EXECUTABLE', 'OMNIA_MANAGED_PYTHON_ENTRY', 'OMNIA_FEATURE_PACKAGE_ROOT',
    'OMNIA_FEATURE_TEMP_ROOT', 'OMNIA_FEATURE_STORE_PATH'
  ];
  const previous = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  process.env.OMNIA_MANAGED_PYTHON_EXECUTABLE = releasePython;
  process.env.OMNIA_MANAGED_PYTHON_ENTRY = path.join(packageRoot, 'python', 'engine.py');
  process.env.OMNIA_FEATURE_PACKAGE_ROOT = packageRoot;
  process.env.OMNIA_FEATURE_TEMP_ROOT = tempRoot;
  process.env.OMNIA_FEATURE_STORE_PATH = storePath;
  const failedRunId = '45454545-4545-4454-8454-454545454545';
  const failedRecordingId = '56565656-5656-4565-8565-565656565656';
  const inputHandleId = '67676767-6767-4676-8676-676767676767';
  const outputHandleId = '78787878-7878-4787-8787-787878787878';
  const failedObservationId = `observation_${'a'.repeat(32)}`;
  const failedStreamId = `stream_${'b'.repeat(32)}`;
  const startedAt = '2026-08-05T02:00:00.000Z';
  const stoppedAt = '2026-08-05T03:00:00.000Z';
  const { createPythonSidecarBridge } = require(path.join(packageRoot, 'middle', 'python-bridge.cjs')) as {
    createPythonSidecarBridge: (options: unknown) => {
      invoke(method: string, payload: unknown, options: { runId: string; timeoutMs: number }): Promise<any>;
      close(): Promise<void>;
    };
  };
  const bridge = createPythonSidecarBridge({ ports: { events: { emit: async () => undefined } } });
  try {
    await bridge.invoke('mark_state', { recordingId: failedRecordingId, runId: failedRunId, state: 'starting', startedAt }, { runId: failedRunId, timeoutMs: 10_000 });
    await bridge.invoke('mark_state', { recordingId: failedRecordingId, runId: failedRunId, state: 'active', startedAt }, { runId: failedRunId, timeoutMs: 10_000 });
    await bridge.invoke('mark_state', { recordingId: failedRecordingId, runId: failedRunId, state: 'stopping', startedAt }, { runId: failedRunId, timeoutMs: 10_000 });
    const events = Array.from({ length: 501 }, (_, index) => ({
      schemaVersion: 'omnia.page-observation-event/v1', observationId: failedObservationId,
      sequence: index === 500 ? 999 : index + 1,
      occurredAt: new Date(Date.parse(startedAt) + index + 1).toISOString(),
      target: { engagementId }, kind: index === 0 ? 'observation.started' : 'page.interaction', payload: {}
    }));
    const ndjson = Buffer.from(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
    const inputRoot = path.join(tempRoot, failedRunId, inputHandleId);
    const outputRoot = path.join(tempRoot, failedRunId, outputHandleId);
    fs.mkdirSync(inputRoot, { recursive: true });
    fs.mkdirSync(outputRoot, { recursive: true });
    const inputPath = path.join(inputRoot, 'observation.ndjson');
    const outputPath = path.join(outputRoot, 'recording.json');
    fs.writeFileSync(inputPath, ndjson);
    fs.writeFileSync(outputPath, '');
    const inputHandle = {
      schemaVersion: 'omnia.python-artifact-handle/v1', handleId: inputHandleId, runId: failedRunId,
      path: inputPath, access: 'read', mediaType: 'application/x-ndjson', originalName: 'observation.ndjson',
      sizeBytes: ndjson.length, sha256: digest(ndjson)
    };
    const outputHandle = {
      schemaVersion: 'omnia.python-artifact-handle/v1', handleId: outputHandleId, runId: failedRunId,
      path: outputPath, access: 'write', mediaType: 'application/json', originalName: 'recording.json', sizeBytes: 0, sha256: ''
    };
    await assert.rejects(
      bridge.invoke('ingest_and_export', {
        recordingId: failedRecordingId, runId: failedRunId, inputHandle, outputHandle,
        observationStatus: {
          schemaVersion: 'omnia.page-observation-status/v1', observationId: failedObservationId, streamId: failedStreamId,
          state: 'stopped', complete: true, omissionCount: 0, eventCount: 501, lastSequence: 501,
          engagementId, startedAt, stoppedAt
        },
        streamSizeBytes: ndjson.length, streamSha256: digest(ndjson)
      }, { runId: failedRunId, timeoutMs: 20_000 }),
      (error: any) => error?.code === 'RECORDING.EVENT_SEQUENCE_INVALID'
    );
    const retained = await bridge.invoke('maintenance', { now: '2026-08-06T02:59:59.999Z', limit: 20 }, { runId: failedRunId, timeoutMs: 10_000 });
    assert.equal(retained.sessions.length, 1);
    assert.equal(retained.sessions[0].recordingId, failedRecordingId);
    assert.equal(retained.sessions[0].state, 'failed');
    assert.equal(retained.sessions[0].eventCount, 500);
    const purged = await bridge.invoke('maintenance', { now: '2026-08-06T03:00:00.000Z', limit: 20 }, { runId: failedRunId, timeoutMs: 10_000 });
    assert.deepEqual(purged.purgedRecordingIds, [failedRecordingId]);
    assert.deepEqual(purged.sessions, []);
  } finally {
    await bridge.close();
    restoreEnvironment(previous);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('release CPython atomically adopts a stale stopping session for one exact successor lineage', { timeout: 30_000 }, async () => {
  assert.equal(fs.existsSync(releasePython) && fs.statSync(releasePython).isFile(), true, 'release-owned CPython 3.13.14 is required');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-recording-python-successor-'));
  const featureDataRoot = path.join(temporary, 'data', 'features', 'omnia.recording');
  const tempRoot = path.join(temporary, 'runtime-temp');
  const storePath = path.join(featureDataRoot, 'store.sqlite');
  fs.mkdirSync(featureDataRoot, { recursive: true });
  fs.mkdirSync(tempRoot, { recursive: true });
  fs.writeFileSync(storePath, '');
  const keys = ['OMNIA_MANAGED_PYTHON_EXECUTABLE', 'OMNIA_MANAGED_PYTHON_ENTRY', 'OMNIA_FEATURE_PACKAGE_ROOT',
    'OMNIA_FEATURE_TEMP_ROOT', 'OMNIA_FEATURE_STORE_PATH'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.OMNIA_MANAGED_PYTHON_EXECUTABLE = releasePython;
  process.env.OMNIA_MANAGED_PYTHON_ENTRY = path.join(packageRoot, 'python', 'engine.py');
  process.env.OMNIA_FEATURE_PACKAGE_ROOT = packageRoot;
  process.env.OMNIA_FEATURE_TEMP_ROOT = tempRoot;
  process.env.OMNIA_FEATURE_STORE_PATH = storePath;
  const predecessorRunId = '60664a82-102b-42e4-9163-78009fd8aa1f';
  const successorRunId = '71775b93-213c-43f5-a274-89110fe9bb20';
  const exactRecordingId = '53c4f730-4419-4a30-9da8-72dcafe0324c';
  const startedAt = '2026-08-09T14:00:00.000Z';
  const stoppedAt = '2026-08-09T14:23:30.595Z';
  const frozenInput = {
    schemaVersion: 'omnia.recording-frozen-input/v1', observationId, streamId, stoppedAt,
    eventCount: 1046, complete: true, omissionCount: 0, streamSha256: 'a'.repeat(64),
    streamSizeBytes: 9_437_184, streamChunkCount: 72
  };
  const lineage = {
    schemaVersion: 'omnia.processing-run-recovery-lineage/v1', recoveryKind: 'frozen_input_finalize',
    predecessorRunId, predecessorFeatureVersion: '0.4.16', predecessorStateRevision: 2,
    predecessorCreatedAt: '2026-08-09T14:00:00.000Z', externalId: exactRecordingId, frozenInput
  };
  const lineageDigest = digest(Buffer.from(canonical(lineage)));
  const { createPythonSidecarBridge } = require(path.join(packageRoot, 'middle', 'python-bridge.cjs')) as any;
  const bridge = createPythonSidecarBridge({ ports: { events: { emit: async () => undefined } } });
  try {
    await bridge.invoke('mark_state', {
      recordingId: exactRecordingId, runId: predecessorRunId, state: 'starting', startedAt
    }, { runId: predecessorRunId, timeoutMs: 10_000 });
    await bridge.invoke('mark_state', {
      recordingId: exactRecordingId, runId: predecessorRunId, state: 'active', startedAt
    }, { runId: predecessorRunId, timeoutMs: 10_000 });
    await bridge.invoke('mark_state', {
      recordingId: exactRecordingId, runId: predecessorRunId, state: 'stopping', startedAt
    }, { runId: predecessorRunId, timeoutMs: 10_000 });
    const privateStore = new DatabaseSync(storePath);
    privateStore.prepare("UPDATE recording_sessions SET metadata_json=? WHERE recording_id=?")
      .run(JSON.stringify({ retained: 'metadata' }), exactRecordingId);
    privateStore.close();
    const payload = {
      recordingId: exactRecordingId, predecessorRunId, successorRunId, startedAt, stoppedAt,
      eventCount: 1046, recoveryLineage: lineage, lineageDigest
    };
    const adopted = await bridge.invoke('adopt_successor_run', payload, { runId: successorRunId, timeoutMs: 10_000 });
    assert.equal(adopted.idempotent, false);
    const repeated = await bridge.invoke('adopt_successor_run', payload, { runId: successorRunId, timeoutMs: 10_000 });
    assert.equal(repeated.idempotent, true);
    const verification = new DatabaseSync(storePath);
    const session = verification.prepare('SELECT * FROM recording_sessions WHERE recording_id=?').get(exactRecordingId) as any;
    assert.equal(session.run_id, successorRunId);
    assert.equal(session.state, 'finalizing');
    assert.equal(session.started_at, startedAt);
    assert.equal(session.stopped_at, stoppedAt);
    assert.equal(session.event_count, 1046);
    assert.deepEqual(JSON.parse(session.metadata_json), { retained: 'metadata' });
    assert.equal((verification.prepare('SELECT COUNT(*) AS count FROM recording_run_recoveries').get() as any).count, 1);
    verification.close();

    const driftedLineage = { ...lineage, predecessorStateRevision: 3 };
    await assert.rejects(
      bridge.invoke('adopt_successor_run', {
        ...payload, recoveryLineage: driftedLineage,
        lineageDigest: digest(Buffer.from(canonical(driftedLineage)))
      }, { runId: successorRunId, timeoutMs: 10_000 }),
      (error: any) => error?.code === 'RECORDING.SUCCESSOR_AUDIT_CONFLICT'
    );

    const thirdRecordingId = '81818181-8181-4818-8181-818181818181';
    const thirdOwnerRunId = '82828282-8282-4828-8282-828282828282';
    const claimedPredecessor = '83838383-8383-4838-8383-838383838383';
    const claimedSuccessor = '84848484-8484-4848-8484-848484848484';
    await bridge.invoke('mark_state', {
      recordingId: thirdRecordingId, runId: thirdOwnerRunId, state: 'starting', startedAt
    }, { runId: thirdOwnerRunId, timeoutMs: 10_000 });
    const thirdFrozen = { ...frozenInput };
    const thirdLineage = {
      ...lineage, predecessorRunId: claimedPredecessor, externalId: thirdRecordingId, frozenInput: thirdFrozen
    };
    await assert.rejects(bridge.invoke('adopt_successor_run', {
      recordingId: thirdRecordingId, predecessorRunId: claimedPredecessor, successorRunId: claimedSuccessor,
      startedAt, stoppedAt, eventCount: 1046, recoveryLineage: thirdLineage,
      lineageDigest: digest(Buffer.from(canonical(thirdLineage)))
    }, { runId: claimedSuccessor, timeoutMs: 10_000 }),
    (error: any) => error?.code === 'RECORDING.SUCCESSOR_OWNER_CONFLICT');

    const unauditedRecordingId = '85858585-8585-4858-8585-858585858585';
    const unauditedPredecessor = '86868686-8686-4868-8686-868686868686';
    const unauditedSuccessor = '87878787-8787-4878-8787-878787878787';
    await bridge.invoke('mark_state', {
      recordingId: unauditedRecordingId, runId: unauditedSuccessor, state: 'starting', startedAt
    }, { runId: unauditedSuccessor, timeoutMs: 10_000 });
    const unauditedLineage = {
      ...lineage, predecessorRunId: unauditedPredecessor, externalId: unauditedRecordingId
    };
    await assert.rejects(bridge.invoke('adopt_successor_run', {
      recordingId: unauditedRecordingId, predecessorRunId: unauditedPredecessor, successorRunId: unauditedSuccessor,
      startedAt, stoppedAt, eventCount: 1046, recoveryLineage: unauditedLineage,
      lineageDigest: digest(Buffer.from(canonical(unauditedLineage)))
    }, { runId: unauditedSuccessor, timeoutMs: 10_000 }),
    (error: any) => error?.code === 'RECORDING.SUCCESSOR_AUDIT_MISSING');

    const artifactRecordingId = '88888888-8888-4888-8888-888888888888';
    const artifactPredecessor = '89898989-8989-4898-8989-898989898989';
    const artifactSuccessor = '90909090-9090-4909-8909-909090909090';
    await bridge.invoke('mark_state', {
      recordingId: artifactRecordingId, runId: artifactPredecessor, state: 'starting', startedAt
    }, { runId: artifactPredecessor, timeoutMs: 10_000 });
    const artifactStore = new DatabaseSync(storePath);
    artifactStore.prepare("UPDATE recording_sessions SET state='finalized',artifact_json='{}' WHERE recording_id=?")
      .run(artifactRecordingId);
    artifactStore.close();
    const artifactLineage = {
      ...lineage, predecessorRunId: artifactPredecessor, externalId: artifactRecordingId
    };
    await assert.rejects(bridge.invoke('adopt_successor_run', {
      recordingId: artifactRecordingId, predecessorRunId: artifactPredecessor, successorRunId: artifactSuccessor,
      startedAt, stoppedAt, eventCount: 1046, recoveryLineage: artifactLineage,
      lineageDigest: digest(Buffer.from(canonical(artifactLineage)))
    }, { runId: artifactSuccessor, timeoutMs: 10_000 }),
    (error: any) => error?.code === 'RECORDING.SUCCESSOR_ARTIFACT_CONFLICT');
  } finally {
    await bridge.close();
    restoreEnvironment(previous);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('0.4.18 recovers the same legacy frozen stream through probe, successor, CAS, and staged Artifact without another stop', { timeout: 60_000 }, async () => {
  assert.equal(fs.existsSync(releasePython) && fs.statSync(releasePython).isFile(), true, 'release-owned CPython 3.13.14 is required');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-recording-onsite-successor-'));
  const paths = resolveProductPaths(temporary);
  const featureRoot = path.join(paths.data, 'features', 'omnia.recording');
  const tempRoot = path.join(paths.temp, 'features', 'omnia.recording');
  const storePath = path.join(featureRoot, 'store.sqlite');
  fs.mkdirSync(featureRoot, { recursive: true });
  fs.mkdirSync(tempRoot, { recursive: true });
  fs.writeFileSync(storePath, '');
  const keys = ['OMNIA_MANAGED_PYTHON_EXECUTABLE', 'OMNIA_MANAGED_PYTHON_ENTRY', 'OMNIA_FEATURE_PACKAGE_ROOT',
    'OMNIA_FEATURE_TEMP_ROOT', 'OMNIA_FEATURE_STORE_PATH'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.OMNIA_MANAGED_PYTHON_EXECUTABLE = releasePython;
  process.env.OMNIA_MANAGED_PYTHON_ENTRY = path.join(packageRoot, 'python', 'engine.py');
  process.env.OMNIA_FEATURE_PACKAGE_ROOT = packageRoot;
  process.env.OMNIA_FEATURE_TEMP_ROOT = tempRoot;
  process.env.OMNIA_FEATURE_STORE_PATH = storePath;
  const legacyRunId = '60664a82-102b-42e4-9163-78009fd8aa1f';
  const exactRecordingId = '53c4f730-4419-4a30-9da8-72dcafe0324c';
  const exactObservationId = `observation_${'9'.repeat(32)}`;
  const exactStreamId = `stream_${'8'.repeat(32)}`;
  const startedAt = '2026-08-09T14:00:00.000Z';
  const stoppedAt = '2026-08-09T14:23:30.595Z';
  const events = Array.from({ length: 1046 }, (_, index) => ({
    schemaVersion: 'omnia.page-observation-event/v1', observationId: exactObservationId, sequence: index + 1,
    occurredAt: new Date(Date.parse(startedAt) + index + 1).toISOString(), target: { engagementId },
    kind: index === 0 ? 'observation.started' : index === 1045 ? 'observation.stopped' : 'page.interaction', payload: {}
  }));
  const bytes = Buffer.from(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
  const database = new CoreDatabase(paths.database, cipher);
  const runtimeStore = new FeatureRuntimeStore(database.db, paths);
  const context = { featureId: 'omnia.recording', featureVersion: '0.4.18', allowMutation: false };
  const operationIds: string[] = [];
  let loseFirstSuccessorResponse = true;
  let seedBridge: any = null;
  let worker: any = null;
  try {
    database.db.prepare(`
      INSERT INTO feature_runs(
        run_id,trace_id,feature_id,feature_version,engagement_id,state,state_revision,
        source_artifact_id,template_version_id,output_artifact_id,plan_digest,last_error,created_at,updated_at
      ) VALUES(?,?,?,?,?,'failed',2,'','','',?,'upgrade reconciled',?,?)
    `).run(legacyRunId, crypto.randomUUID(), 'omnia.recording', '0.4.16', engagementId, 'a'.repeat(64), startedAt, stoppedAt);
    database.db.prepare(`
      INSERT INTO feature_run_events(event_id,run_id,revision,from_state,to_state,event_type,details_json,occurred_at)
      VALUES(?,?,1,'','processing','run.processing_started',?,?)
    `).run(crypto.randomUUID(), legacyRunId, JSON.stringify({
      surfaceId: 'recording.workbench', externalId: exactRecordingId,
      sourceRef: `connector-recording:${exactRecordingId}`
    }), startedAt);
    database.db.prepare(`
      INSERT INTO feature_run_events(event_id,run_id,revision,from_state,to_state,event_type,details_json,occurred_at)
      VALUES(?,?,2,'processing','failed','recording.terminal_projection_reconciled',?,?)
    `).run(crypto.randomUUID(), legacyRunId, JSON.stringify({
      privateState: 'finalization_failed', evidenceRetained: true, mutationReplayed: false
    }), stoppedAt);
    runtimeStore.call('savePlan', {
      planId: `recording-run:${exactRecordingId}`, recordingId: exactRecordingId, runId: legacyRunId,
      state: 'finalization_failed', observationId: exactObservationId, streamId: exactStreamId,
      connectorId: 'remote-connector', sessionGeneration: 27, engagementId,
      startedAt, stoppedAt, eventCount: 1046, metrics: {}, error: 'upgrade reconciled'
    }, context);
    runtimeStore.call('savePlan', {
      planId: 'recording-current', recordingId: exactRecordingId, runId: legacyRunId,
      state: 'finalization_failed', updatedAt: stoppedAt
    }, context);
    const { createPythonSidecarBridge } = require(path.join(packageRoot, 'middle', 'python-bridge.cjs')) as any;
    seedBridge = createPythonSidecarBridge({ ports: { events: { emit: async () => undefined } } });
    await seedBridge.invoke('mark_state', {
      recordingId: exactRecordingId, runId: legacyRunId, state: 'starting', startedAt
    }, { runId: legacyRunId, timeoutMs: 10_000 });
    await seedBridge.invoke('mark_state', {
      recordingId: exactRecordingId, runId: legacyRunId, state: 'active', startedAt
    }, { runId: legacyRunId, timeoutMs: 10_000 });
    await seedBridge.invoke('mark_state', {
      recordingId: exactRecordingId, runId: legacyRunId, state: 'stopping', startedAt
    }, { runId: legacyRunId, timeoutMs: 10_000 });
    await seedBridge.close();
    seedBridge = null;

    const { createFeatureWorker } = require(workerSourcePath) as any;
    worker = createFeatureWorker({
      connector: { invoke: async (input: any) => {
        operationIds.push(input.operationId);
        if (input.operationId === 'omnia.recording.observation.status.v1') return {
          schemaVersion: 'omnia.page-observation-status/v1', observationId: exactObservationId, streamId: exactStreamId,
          state: 'stopped', complete: true, omissionCount: 0, eventCount: 1046, lastSequence: 1046,
          engagementId, startedAt, stoppedAt, updatedAt: stoppedAt
        };
        if (input.operationId === 'omnia.recording.observation.read-chunk.v1') {
          const offset = Number(input.request.offset);
          const nextOffset = Math.min(bytes.length, offset + 128 * 1024);
          const chunk = bytes.subarray(offset, nextOffset);
          return {
            schemaVersion: 'omnia.managed-stream-chunk/v1', streamId: exactStreamId,
            mediaType: 'application/x-ndjson', offset, nextOffset, availableBytes: bytes.length,
            bytesBase64: chunk.toString('base64'), ready: true, eof: nextOffset === bytes.length,
            chunkDigest: digest(chunk), streamDigest: digest(bytes)
          };
        }
        throw new Error(`unexpected operation ${input.operationId}`);
      } },
      store: {
        call: async (method: string, payload: any) => {
          const result = runtimeStore.call(method, payload, context);
          if (method === 'createSuccessorProcessingRun' && loseFirstSuccessorResponse) {
            loseFirstSuccessorResponse = false;
            throw new Error('simulated crash after Core successor commit');
          }
          return result;
        },
        appendEvidence: async (payload: any) => runtimeStore.call('appendEvidence', payload, context)
      },
      events: { emit: async () => undefined }
    });
    const health = await worker.health();
    assert.equal(health.recoveredSurfacePatch.actions.find((item: any) => item.actionId === 'retry-finalization').enabled, true);
    const actionContext = { connectorBinding: {
      connectorId: 'remote-connector', sessionGeneration: 27, engagementId,
      packId: engagementId, authorityInstanceId: 'authority', tenantOrOrgId: 'tenant'
    } };
    await assert.rejects(
      worker.handleAction({ actionId: 'retry-finalization', payload: { recordingId: exactRecordingId }, context: actionContext }),
      /simulated crash after Core successor commit/u
    );
    const afterCoreCrash = runtimeStore.call('loadPlan', `recording-run:${exactRecordingId}`, context) as any;
    assert.equal(afterCoreCrash.storeRevision, 1, 'the no-revision legacy plan must first CAS the frozen probe to revision 1');
    assert.equal(afterCoreCrash.runId, legacyRunId, 'a crash before private adoption must leave the plan on its predecessor');
    assert.equal((database.db.prepare(`
      SELECT COUNT(*) AS count FROM feature_run_events
      WHERE event_type='run.processing_started'
        AND json_extract(details_json,'$.recoveryLineage.predecessorRunId')=?
    `).get(legacyRunId) as any).count, 1);
    await worker.handleAction({ actionId: 'retry-finalization', payload: { recordingId: exactRecordingId }, context: actionContext });
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const plan = runtimeStore.call('loadPlan', `recording-run:${exactRecordingId}`, context) as any;
      if (plan.state === 'finalized') break;
      assert.equal(plan.state, 'finalizing', JSON.stringify({ state: plan.state, error: plan.error, finalization: plan.finalization }));
      await worker.handleAction({ actionId: 'finalize-recording', payload: {}, context: actionContext });
    }
    const plan = runtimeStore.call('loadPlan', `recording-run:${exactRecordingId}`, context) as any;
    assert.equal(plan.recordingId, exactRecordingId);
    assert.equal(plan.observationId, exactObservationId);
    assert.equal(plan.streamId, exactStreamId);
    assert.equal(plan.eventCount, 1046);
    assert.equal(plan.stoppedAt, stoppedAt);
    assert.equal(plan.predecessorRunId, legacyRunId);
    assert.notEqual(plan.runId, legacyRunId);
    assert.equal(plan.state, 'finalized');
    assert.ok(plan.artifact?.artifactId);
    assert.equal(operationIds.filter((id) => id === 'omnia.recording.observation.stop.v1').length, 0);
    assert.equal((database.db.prepare(`
      SELECT COUNT(*) AS count FROM feature_run_events
      WHERE event_type='run.processing_started'
        AND json_extract(details_json,'$.recoveryLineage.predecessorRunId')=?
    `).get(legacyRunId) as any).count, 1);
    const privateVerification = new DatabaseSync(storePath);
    const session = privateVerification.prepare('SELECT run_id,state,event_count,stopped_at,artifact_json FROM recording_sessions WHERE recording_id=?')
      .get(exactRecordingId) as any;
    assert.equal(session.run_id, plan.runId);
    assert.equal(session.state, 'finalized');
    assert.equal(session.event_count, 1046);
    assert.equal(session.stopped_at, stoppedAt);
    assert.ok(JSON.parse(session.artifact_json).artifactId);
    privateVerification.close();
  } finally {
    if (seedBridge) await seedBridge.close();
    if (worker) await worker.shutdown();
    database.close();
    restoreEnvironment(previous);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('a legacy terminal recording without observation identity is closed and cannot block a new real recording identity', { timeout: 20_000 }, async () => {
  assert.equal(fs.existsSync(releasePython) && fs.statSync(releasePython).isFile(), true, 'release-owned CPython 3.13.14 is required');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-recording-legacy-plan-'));
  const featureDataRoot = path.join(temporary, 'data', 'features', 'omnia.recording');
  const tempRoot = path.join(temporary, 'runtime-temp');
  const storePath = path.join(featureDataRoot, 'store.sqlite');
  fs.mkdirSync(featureDataRoot, { recursive: true });
  fs.mkdirSync(tempRoot, { recursive: true });
  fs.writeFileSync(storePath, '');
  const environmentKeys = [
    'OMNIA_MANAGED_PYTHON_EXECUTABLE', 'OMNIA_MANAGED_PYTHON_ENTRY', 'OMNIA_FEATURE_PACKAGE_ROOT',
    'OMNIA_FEATURE_TEMP_ROOT', 'OMNIA_FEATURE_STORE_PATH'
  ];
  const previous = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  process.env.OMNIA_MANAGED_PYTHON_EXECUTABLE = releasePython;
  process.env.OMNIA_MANAGED_PYTHON_ENTRY = path.join(packageRoot, 'python', 'engine.py');
  process.env.OMNIA_FEATURE_PACKAGE_ROOT = packageRoot;
  process.env.OMNIA_FEATURE_TEMP_ROOT = tempRoot;
  process.env.OMNIA_FEATURE_STORE_PATH = storePath;

  const legacyRecordingId = '10101010-1010-4010-8010-101010101010';
  const legacyRunId = '20202020-2020-4020-8020-202020202020';
  const newRunId = '30303030-3030-4030-8030-303030303030';
  const connectorId = 'remote-connector';
  const sessionGeneration = 19;
  const packId = engagementId;
  const plans = new Map<string, any>([
    ['recording-current', { planId: 'recording-current', recordingId: legacyRecordingId, runId: legacyRunId, state: 'finalizing' }],
    [`recording-run:${legacyRecordingId}`, {
      planId: `recording-run:${legacyRecordingId}`, recordingId: legacyRecordingId, runId: legacyRunId,
      state: 'finalizing',
      eventCount: 1587, streamSha256: '65fff6c856998e303189a2a35bd59b51754402673887bd8c574015be17edb9d8',
      stoppedAt: '2026-08-06T07:04:00.281Z', error: ''
    }]
  ]);
  const failedRuns: string[] = [];
  const operationIds: string[] = [];
  const { createFeatureWorker } = require(workerSourcePath) as { createFeatureWorker: (ports: any) => any };
  const worker = createFeatureWorker({
    connector: {
      invoke: async (input: any) => {
        operationIds.push(input.operationId);
        if (input.operationId === 'omnia.recording.pack.read.v1') return {
          schemaVersion: 'omnia.recording.pack-read-result/v1', connectorId, sessionGeneration,
          engagementId, packId, authorityInstanceId: 'authority', tenantOrOrgId: 'tenant', name: 'TEST'
        };
        if (input.operationId === 'omnia.recording.observation.open.v1') return {
          schemaVersion: 'omnia.page-observation-status/v1', observationId, streamId,
          state: 'observing', complete: false, omissionCount: 0, eventCount: 1, lastSequence: 1,
          engagementId, startedAt: '2026-08-06T15:30:00.000Z', updatedAt: '2026-08-06T15:30:00.000Z'
        };
        throw new Error(`unexpected operation ${input.operationId}`);
      }
    },
    store: {
      appendEvidence: async () => undefined,
      call: async (method: string, payload: any) => {
        if (method === 'loadPlan') return plans.get(String(payload)) || null;
        if (method === 'compareAndSwapPlan') {
          const current = plans.get(payload.planId);
          const currentRevision = Number(current?.storeRevision || 0);
          if (currentRevision !== payload.expectedStoreRevision) {
            const error: any = new Error('Feature plan changed before compare-and-swap.');
            error.code = 'FEATURE.PLAN_CAS_MISMATCH';
            throw error;
          }
          assert.equal(payload.plan.storeRevision, payload.expectedStoreRevision + 1);
          plans.set(payload.planId, structuredClone(payload.plan));
          return {
            schemaVersion: 'omnia.feature-runtime-plan-cas-result/v1', planId: payload.planId,
            storeRevision: payload.plan.storeRevision, updatedAt: payload.plan.updatedAt
          };
        }
        if (method === 'savePlan') { plans.set(payload.planId, structuredClone(payload)); return structuredClone(payload); }
        if (method === 'loadProcessingRun') return payload.runId === legacyRunId
          ? { runId: legacyRunId, state: 'failed' }
          : { runId: payload.runId, state: 'processing' };
        if (method === 'failProcessingRun') { failedRuns.push(payload.runId); return { runId: payload.runId, state: 'failed' }; }
        if (method === 'createProcessingRun') return { runId: newRunId, externalId: payload.externalId, state: 'processing' };
        throw new Error(`unexpected store method ${method}`);
      }
    },
    events: { emit: async () => undefined }
  });
  try {
    const health = await worker.health();
    assert.equal(plans.get(`recording-run:${legacyRecordingId}`).state, 'finalization_failed',
      'a Worker restart must convert an orphaned finalizing plan into an explicit retry/restart state');
    const stopIndex = health.recoveredSurfacePatch.actions.findIndex((action: any) => action.actionId === 'stop-recording');
    const restartIndex = health.recoveredSurfacePatch.actions.findIndex((action: any) => action.actionId === 'restart-recording');
    assert.equal(restartIndex, stopIndex + 1);
    assert.equal(health.recoveredSurfacePatch.actions[restartIndex].enabled, true,
      'startup recovery must enable restart immediately without requiring a manual status refresh');
    assert.equal(health.recoveredSurfacePatch.actions.find((action: any) => action.actionId === 'retry-finalization').enabled, false,
      'a Core-failed legacy Run must not advertise frozen-input retry');
    const result = await worker.handleAction({
      actionId: 'restart-recording', payload: {}, context: {
        connectorBinding: { connectorId, sessionGeneration, engagementId, packId, authorityInstanceId: 'authority', tenantOrOrgId: 'tenant' }
      }
    });
    const current = plans.get('recording-current');
    assert.equal(failedRuns.includes(legacyRunId), true);
    assert.notEqual(current.recordingId, legacyRecordingId);
    assert.equal(current.runId, newRunId);
    assert.equal(current.state, 'observing');
    assert.equal(result.surfacePatch.recorder.state, 'recording');
    assert.deepEqual(operationIds, ['omnia.recording.pack.read.v1', 'omnia.recording.observation.open.v1']);
  } finally {
    await worker.shutdown();
    restoreEnvironment(previous);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('worker completes the player lifecycle, recovers failed finalization, exports independently, and starts a new recording', { timeout: 30_000 }, async () => {
  assert.equal(fs.existsSync(releasePython) && fs.statSync(releasePython).isFile(), true, 'release-owned CPython 3.13.14 is required');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-recording-worker-chain-'));
  const featureDataRoot = path.join(temporary, 'data', 'features', 'omnia.recording');
  const tempRoot = path.join(temporary, 'runtime-temp');
  const storePath = path.join(featureDataRoot, 'store.sqlite');
  fs.mkdirSync(featureDataRoot, { recursive: true });
  fs.mkdirSync(tempRoot, { recursive: true });
  fs.writeFileSync(storePath, '');
  const environmentKeys = [
    'OMNIA_MANAGED_PYTHON_EXECUTABLE', 'OMNIA_MANAGED_PYTHON_ENTRY', 'OMNIA_FEATURE_PACKAGE_ROOT',
    'OMNIA_FEATURE_TEMP_ROOT', 'OMNIA_FEATURE_STORE_PATH'
  ];
  const previous = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  process.env.OMNIA_MANAGED_PYTHON_EXECUTABLE = releasePython;
  process.env.OMNIA_MANAGED_PYTHON_ENTRY = path.join(packageRoot, 'python', 'engine.py');
  process.env.OMNIA_FEATURE_PACKAGE_ROOT = packageRoot;
  process.env.OMNIA_FEATURE_TEMP_ROOT = tempRoot;
  process.env.OMNIA_FEATURE_STORE_PATH = storePath;

  const firstRunId = '91919191-9191-4919-8919-919191919191';
  const secondRunId = '92929292-9292-4929-8929-929292929292';
  const artifactId = '93939393-9393-4939-8939-939393939393';
  const connectorId = 'remote-connector';
  const sessionGeneration = 27;
  const firstObservationId = `observation_${'1'.repeat(32)}`;
  const firstStreamId = `stream_${'2'.repeat(32)}`;
  const secondObservationId = `observation_${'3'.repeat(32)}`;
  const secondStreamId = `stream_${'4'.repeat(32)}`;
  const startedAt = new Date(Date.now() - (5 * 60_000)).toISOString();
  const stoppedAt = new Date().toISOString();
  const completedAt = new Date(Date.parse(stoppedAt) + 1_000).toISOString();
  const lifecycleEvents = [
    ['observation.started', {}],
    ['page.interaction', { type: 'click', selector: 'button' }],
    ['observation.paused', {}],
    ['observation.resumed', {}],
    ['page.interaction', { type: 'click', selector: 'input' }],
  ];
  const paddedInteractions = Array.from({ length: 1_581 }, (_, index) => [
    'page.interaction',
    { type: 'input', selector: `input[data-recording-index="${index}"]`, redactedText: 'x'.repeat(6_200) }
  ]);
  const events = [
    ...lifecycleEvents,
    ...paddedInteractions,
    ['observation.stopped', {}]
  ].map(([kind, payload], index) => ({
    schemaVersion: 'omnia.page-observation-event/v1', observationId: firstObservationId, sequence: index + 1,
    occurredAt: new Date(Date.parse(startedAt) + index + 1).toISOString(), target: { engagementId }, kind, payload
  }));
  const ndjson = Buffer.from(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
  let streamBytes = ndjson;
  const plans = new Map<string, any>();
  const runs = new Map<string, any>();
  const transfers = new Map<string, { expected: any; chunks: Buffer[]; chunkIndexes: Set<number> }>();
  const handles = new Map<string, any>();
  const operationIds: string[] = [];
  const readCounts = new Map<number, number>();
  const acceptedTransferChunks: Array<{ transferId: string; chunkIndex: number }> = [];
  const runIds = [firstRunId, secondRunId];
  let runIndex = 0;
  let handleIndex = 0;
  let openIndex = 0;
  let observationState = 'idle';
  let observationEventCount = 0;
  let activeObservationId = '';
  let activeStreamId = '';
  let failFirstArtifactCommit = true;
  let activeChunkReads = 0;
  let peakChunkReads = 0;
  let holdNextAppend = false;
  let appendStartedResolve: (() => void) | null = null;
  const heldAppend = {} as { reject?: (error: Error) => void };

  const nextUuid = () => `${String(++handleIndex).padStart(8, '0')}-0000-4000-8000-${String(handleIndex).padStart(12, '0')}`;
  const currentPlan = () => {
    const current = plans.get('recording-current');
    return current ? plans.get(`recording-run:${current.recordingId}`) : null;
  };
  const observationStatus = () => ({
    schemaVersion: 'omnia.page-observation-status/v1', observationId: activeObservationId, streamId: activeStreamId,
    state: observationState, complete: observationState === 'stopped', omissionCount: 0,
    eventCount: observationEventCount, lastSequence: observationEventCount, engagementId, startedAt,
    updatedAt: observationState === 'stopped' ? stoppedAt : startedAt,
    ...(observationState === 'stopped' ? { stoppedAt } : {})
  });
  const createManagedHandle = (runIdValue: string, mediaType: string, originalName: string, access: string, bytes = Buffer.alloc(0)) => {
    const handleId = nextUuid();
    const root = path.join(tempRoot, runIdValue, handleId);
    fs.mkdirSync(root, { recursive: true });
    const filename = path.join(root, originalName);
    fs.writeFileSync(filename, bytes);
    const handle = {
      schemaVersion: 'omnia.python-artifact-handle/v1', handleId, runId: runIdValue, path: filename,
      access, mediaType, originalName, sizeBytes: bytes.length, sha256: bytes.length ? digest(bytes) : ''
    };
    handles.set(handleId, handle);
    return handle;
  };
  const { createFeatureWorker } = require(workerSourcePath) as { createFeatureWorker: (ports: any) => any };
  const workerPorts = {
    connector: {
      invoke: async (input: any) => {
        operationIds.push(input.operationId);
        if (input.operationId === 'omnia.recording.pack.read.v1') return {
          schemaVersion: 'omnia.recording.pack-read-result/v1', connectorId, sessionGeneration,
          engagementId, packId: engagementId, authorityInstanceId: 'authority', tenantOrOrgId: 'tenant', name: 'TEST'
        };
        if (input.operationId === 'omnia.recording.observation.open.v1') {
          assert.equal(currentPlan()?.state, 'starting', 'Core plan must be durable before observation open');
          const identities: [string, string] = openIndex++ === 0
            ? [firstObservationId, firstStreamId] : [secondObservationId, secondStreamId];
          [activeObservationId, activeStreamId] = identities;
          observationState = 'observing'; observationEventCount = 1;
          return observationStatus();
        }
        if (input.operationId === 'omnia.recording.observation.status.v1') return observationStatus();
        if (input.operationId === 'omnia.recording.observation.pause.v1') {
          assert.equal(currentPlan()?.state, 'pausing');
          observationState = 'paused'; observationEventCount = 3; return observationStatus();
        }
        if (input.operationId === 'omnia.recording.observation.resume.v1') {
          assert.equal(currentPlan()?.state, 'resuming');
          observationState = 'observing'; observationEventCount = 4; return observationStatus();
        }
        if (input.operationId === 'omnia.recording.observation.stop.v1') {
          assert.equal(currentPlan()?.state, 'stopping');
          observationState = 'stopped'; observationEventCount = events.length; return observationStatus();
        }
        if (input.operationId === 'omnia.recording.observation.read-chunk.v1') {
          assert.equal(input.request.streamId, firstStreamId);
          const offset = Number(input.request.offset);
          assert.equal(Number.isSafeInteger(offset) && offset >= 0 && offset % (128 * 1024) === 0, true);
          assert.equal(offset < streamBytes.length, true);
          readCounts.set(offset, (readCounts.get(offset) || 0) + 1);
          activeChunkReads += 1;
          peakChunkReads = Math.max(peakChunkReads, activeChunkReads);
          try {
            await new Promise((resolve) => setTimeout(resolve, 4));
            const nextOffset = Math.min(streamBytes.length, offset + (128 * 1024));
            const bytes = streamBytes.subarray(offset, nextOffset);
            return {
              schemaVersion: 'omnia.managed-stream-chunk/v1', streamId: firstStreamId,
              mediaType: 'application/x-ndjson', offset, nextOffset,
              availableBytes: streamBytes.length, bytesBase64: bytes.toString('base64'), ready: true,
              eof: nextOffset === streamBytes.length, chunkDigest: digest(bytes), streamDigest: digest(streamBytes)
            };
          } finally {
            activeChunkReads -= 1;
          }
        }
        throw new Error(`unexpected operation ${input.operationId}`);
      }
    },
    store: {
      appendEvidence: async () => undefined,
      call: async (method: string, payload: any) => {
        if (method === 'loadPlan') return structuredClone(plans.get(String(payload)) || null);
        if (method === 'compareAndSwapPlan') {
          const current = plans.get(payload.planId);
          const currentRevision = Number(current?.storeRevision || 0);
          if (currentRevision !== payload.expectedStoreRevision) {
            const error: any = new Error('Feature plan changed before compare-and-swap.');
            error.code = 'FEATURE.PLAN_CAS_MISMATCH';
            throw error;
          }
          assert.equal(payload.plan.storeRevision, payload.expectedStoreRevision + 1);
          plans.set(payload.planId, structuredClone(payload.plan));
          return {
            schemaVersion: 'omnia.feature-runtime-plan-cas-result/v1', planId: payload.planId,
            storeRevision: payload.plan.storeRevision, updatedAt: payload.plan.updatedAt
          };
        }
        if (method === 'savePlan') { plans.set(payload.planId, structuredClone(payload)); return structuredClone(payload); }
        if (method === 'createProcessingRun') {
          const nextRunId = runIds[runIndex++];
          assert.ok(nextRunId, 'the fixture must provide a Run identity for each recording start');
          const created = { runId: nextRunId, state: 'processing', externalId: payload.externalId };
          runs.set(created.runId, created); return structuredClone(created);
        }
        if (method === 'loadProcessingRun') return structuredClone(runs.get(payload.runId) || null);
        if (method === 'failProcessingRun') {
          const failed = { ...(runs.get(payload.runId) || { runId: payload.runId }), state: 'failed', error: payload.error };
          runs.set(payload.runId, failed); return structuredClone(failed);
        }
        if (method === 'beginPythonInputTransfer') {
          const transferId = nextUuid();
          transfers.set(transferId, { expected: structuredClone(payload), chunks: [], chunkIndexes: new Set() });
          return {
            schemaVersion: 'omnia.python-input-transfer/v1', transferId, runId: payload.runId,
            expectedSizeBytes: payload.expectedSizeBytes, expectedSha256: payload.expectedSha256,
            chunkCount: payload.chunkCount, nextChunkIndex: 0, receivedBytes: 0
          };
        }
        if (method === 'appendPythonInputTransferChunk') {
          if (holdNextAppend) {
            holdNextAppend = false;
            appendStartedResolve?.();
            await new Promise<void>((_resolve, reject) => { heldAppend.reject = reject; });
          }
          const transfer = transfers.get(payload.transferId);
          if (!transfer) throw new Error('Python input transfer is unavailable or not owned by this Feature version.');
          if (payload.chunkIndex !== transfer.chunks.length || transfer.chunkIndexes.has(payload.chunkIndex)) {
            throw new Error('Python input transfer chunk is out of order.');
          }
          const bytes = Buffer.from(payload.contentBase64, 'base64');
          assert.ok(bytes.length > 0 && bytes.length <= 1024 * 1024,
            'parallel reads must still enter Core through bounded 1 MiB transfer chunks');
          transfer.chunks.push(bytes);
          transfer.chunkIndexes.add(payload.chunkIndex);
          acceptedTransferChunks.push({ transferId: payload.transferId, chunkIndex: payload.chunkIndex });
          return {
            schemaVersion: 'omnia.python-input-transfer-progress/v1', transferId: payload.transferId,
            acceptedChunkIndex: payload.chunkIndex, nextChunkIndex: payload.chunkIndex + 1,
            receivedBytes: transfer.chunks.reduce((total, chunk) => total + chunk.length, 0),
            chunkSha256: digest(bytes)
          };
        }
        if (method === 'abortPythonInputTransfer') { transfers.delete(payload.transferId); return { aborted: true }; }
        if (method === 'commitPythonInputTransfer') {
          const transfer = transfers.get(payload.transferId);
          if (!transfer) throw new Error('Python input transfer is unavailable or not owned by this Feature version.');
          const bytes = Buffer.concat(transfer.chunks);
          assert.equal(bytes.length, transfer.expected.expectedSizeBytes); assert.equal(digest(bytes), transfer.expected.expectedSha256);
          const root = path.join(tempRoot, transfer.expected.runId, payload.transferId);
          fs.mkdirSync(root, { recursive: true });
          const filename = path.join(root, transfer.expected.originalName);
          fs.writeFileSync(filename, bytes);
          const handle = {
            schemaVersion: 'omnia.python-artifact-handle/v1', handleId: payload.transferId,
            runId: transfer.expected.runId, path: filename, access: 'read',
            mediaType: transfer.expected.mediaType, originalName: transfer.expected.originalName,
            sizeBytes: bytes.length, sha256: digest(bytes)
          };
          handles.set(payload.transferId, handle);
          transfers.delete(payload.transferId);
          return handle;
        }
        if (method === 'createPythonOutputHandle') {
          return createManagedHandle(payload.runId, payload.mediaType, payload.originalName, 'write');
        }
        if (method === 'commitPythonOutputHandle') {
          const handle = handles.get(payload.handleId); assert.ok(handle);
          const bytes = fs.readFileSync(handle.path); assert.equal(digest(bytes), payload.sha256);
          if (failFirstArtifactCommit) { failFirstArtifactCommit = false; throw new Error('simulated Core Artifact commit failure'); }
          return { artifactId, kind: 'result', originalName: handle.originalName, sha256: payload.sha256, sizeBytes: bytes.length };
        }
        if (method === 'finishProcessingRun') {
          const artifact = { artifactId, kind: 'result', originalName: 'recording.json', sha256: digest(fs.readFileSync([...handles.values()].at(-1).path)), sizeBytes: fs.statSync([...handles.values()].at(-1).path).size };
          const finished = { ...(runs.get(payload.runId) || { runId: payload.runId }), state: 'succeeded', artifact, completedAt };
          runs.set(payload.runId, finished); return structuredClone(finished);
        }
        if (method === 'releasePythonArtifactHandles') {
          for (const handleId of payload.handleIds) handles.delete(handleId);
          return { released: payload.handleIds };
        }
        throw new Error(`unexpected store method ${method}`);
      }
    },
    events: { emit: async () => undefined }
  };
  let worker = createFeatureWorker(workerPorts);
  const context = { connectorBinding: { connectorId, sessionGeneration, engagementId, packId: engagementId, authorityInstanceId: 'authority', tenantOrOrgId: 'tenant' } };
  try {
    const started = await worker.handleAction({ actionId: 'start-recording', payload: {}, context });
    const firstRecordingId = started.surfacePatch.recorder.recordingId;
    assert.equal(started.surfacePatch.recorder.state, 'recording');
    const paused = await worker.handleAction({ actionId: 'pause-recording', payload: {}, context });
    assert.equal(paused.surfacePatch.recorder.state, 'paused');
    const resumed = await worker.handleAction({ actionId: 'start-recording', payload: {}, context });
    assert.equal(resumed.surfacePatch.recorder.state, 'recording');
    const operationsBeforeStop = operationIds.length;
    const stopStartedAt = Date.now();
    const stopped = await worker.handleAction({ actionId: 'stop-recording', payload: {}, context });
    assert.ok(Date.now() - stopStartedAt < 250, 'foreground stop must return without entering stream transfer');
    assert.equal(stopped.surfacePatch.recorder.recordingId, firstRecordingId);
    assert.equal(stopped.surfacePatch.recorder.state, 'stopped');
    assert.equal(stopped.surfacePatch.recorder.captureState, 'pending');
    assert.match(stopped.surfacePatch.statusMessage, new RegExp(`已停止（${events.length} 个事件），正在固化`));
    assert.equal(currentPlan().state, 'stop_confirmed');
    assert.deepEqual(operationIds.slice(operationsBeforeStop), ['omnia.recording.observation.status.v1', 'omnia.recording.observation.stop.v1'],
      'foreground stop must not scan or finalize the frozen stream');
    assert.equal(stopped.surfacePatch.actions.find((action: any) => action.actionId === 'stop-recording').enabled, false);
    assert.equal(stopped.surfacePatch.actions.find((action: any) => action.actionId === 'finalize-recording').enabled, true);
    assert.equal(stopped.surfacePatch.actions.find((action: any) => action.actionId === 'export-recording').enabled, false,
      'export must remain disabled before the current Core Artifact commit');
    const expectedStreamChunks = Math.ceil(ndjson.length / (128 * 1024));
    assert.ok(ndjson.length > 9_433_532, 'the regression stream must exceed the real failed 9.4 MiB recording');
    const totalReads = () => [...readCounts.values()].reduce((sum, count) => sum + count, 0);
    const runFinalizationAction = async (actionId = 'finalize-recording') => {
      const beforeReads = totalReads();
      const result = await worker.handleAction({ actionId, payload: {}, context });
      assert.ok(totalReads() - beforeReads <= 8, 'each background action may read at most one bounded 1 MiB window');
      return result;
    };

    holdNextAppend = true;
    const appendStarted = new Promise<void>((resolve) => { appendStartedResolve = resolve; });
    const interruptedAction = worker.handleAction({ actionId: 'finalize-recording', payload: {}, context });
    await appendStarted;
    assert.equal(currentPlan().state, 'finalizing');
    assert.equal(currentPlan().finalization.nextStreamChunkIndex, 0);
    assert.equal(currentPlan().finalization.receivedBytes, 0);
    assert.equal(currentPlan().finalization.pendingAppend.transferChunkIndex, 0,
      'the pending append identity must be durable before the Core port is allowed to resolve');
    const rejectHeldAppend = heldAppend.reject;
    assert.ok(rejectHeldAppend);
    rejectHeldAppend(new Error('FEATURE.WORKER_EXITED while the Core append request was in flight'));
    const interrupted = await interruptedAction;
    assert.equal(interrupted.surfacePatch.recorder.captureState, 'incomplete');
    assert.equal(currentPlan().state, 'finalization_failed');
    assert.equal(currentPlan().finalization.nextStreamChunkIndex, 0,
      'an exited Worker must not advance a batch whose Core response was never observed');
    assert.equal(currentPlan().finalization.receivedBytes, 0);

    const firstBatch = await runFinalizationAction('retry-finalization');
    assert.equal(firstBatch.surfacePatch.recorder.captureState, 'pending');
    assert.equal(currentPlan().state, 'finalizing');
    assert.equal(currentPlan().finalization.nextStreamChunkIndex, 8);
    assert.equal(currentPlan().streamChunks.length, 8);
    const firstTransferId = currentPlan().finalization.transferId;

    await worker.shutdown();
    worker = createFeatureWorker(workerPorts);
    const resumedHealth = await worker.health();
    assert.equal(resumedHealth.recoveredSurfacePatch.actions.find((action: any) => action.actionId === 'finalize-recording').enabled, true,
      'a Worker restart must leave the persisted finalization checkpoint eligible for automatic background resume');
    await runFinalizationAction();
    assert.equal(currentPlan().finalization.transferId, firstTransferId);
    assert.equal(currentPlan().finalization.nextStreamChunkIndex, 16,
      'a Worker restart with the same Shell Store must continue the exact Core transfer');

    transfers.clear();
    await runFinalizationAction();
    assert.equal(currentPlan().state, 'finalizing');
    assert.equal(currentPlan().finalization, undefined,
      'loss of the Shell in-memory transfer must retire the ambiguous transfer before reopening');
    assert.equal(currentPlan().transferRestartCount, 1);

    streamBytes = Buffer.from(ndjson.toString('utf8').replace('"selector":"input"', '"selector":"other"'), 'utf8');
    const drifted = await runFinalizationAction();
    assert.equal(drifted.surfacePatch.recorder.captureState, 'incomplete');
    assert.match(drifted.surfacePatch.statusMessage, /differs from the first verified finalization input/);
    assert.equal(currentPlan().streamSha256, digest(ndjson), 'reopen must retain the first bound frozen digest');

    streamBytes = ndjson;
    let background = await runFinalizationAction('retry-finalization');
    for (let step = 0; step < 200 && currentPlan().state === 'finalizing'; step += 1) {
      background = await runFinalizationAction();
    }
    assert.equal(peakChunkReads, 8, 'the worker must use the declared bounded parallel read window');
    assert.equal(background.surfacePatch.recorder.captureState, 'incomplete');
    assert.equal(currentPlan().state, 'finalization_failed');
    assert.equal(currentPlan().finalization.stage, 'input_ready',
      'an Artifact commit failure must retain the already committed frozen input handle for retry');
    assert.equal(currentPlan().streamChunks.length, expectedStreamChunks,
      'all 128 KiB chunk identities must be durably retained before Python processing');
    assert.equal(runs.get(firstRunId).state, 'processing', 'retryable finalization must keep the Processing Run recoverable');
    const stopIndex = background.surfacePatch.actions.findIndex((action: any) => action.actionId === 'stop-recording');
    const restartIndex = background.surfacePatch.actions.findIndex((action: any) => action.actionId === 'restart-recording');
    assert.equal(restartIndex, stopIndex + 1, 'restart must be projected immediately to the right of stop');
    assert.equal(background.surfacePatch.actions[restartIndex].enabled, true,
      'finalization failure must enable a fresh recording without requiring export recovery');
    assert.equal(background.surfacePatch.actions.find((action: any) => action.actionId === 'start-recording').enabled, false,
      'the ordinary start/resume action must not compete with explicit restart after finalization failure');
    assert.equal(background.surfacePatch.actions.find((action: any) => action.actionId === 'retry-finalization').enabled, true,
      'same-generation finalization failure must retain retry when Core is explicitly still processing');
    const acceptedByTransfer = new Map<string, number[]>();
    for (const item of acceptedTransferChunks) {
      const indexes = acceptedByTransfer.get(item.transferId) || [];
      indexes.push(item.chunkIndex);
      acceptedByTransfer.set(item.transferId, indexes);
    }
    for (const indexes of acceptedByTransfer.values()) {
      assert.equal(new Set(indexes).size, indexes.length, 'one Core transfer must never append the same chunk index twice');
    }
    const readsBeforeArtifactRetry = totalReads();
    const recovered = await runFinalizationAction('retry-finalization');
    assert.equal(totalReads(), readsBeforeArtifactRetry,
      'Artifact retry must reuse the committed Core frozen input without rereading the Connector stream');
    assert.equal(recovered.surfacePatch.recorder.recordingId, firstRecordingId);
    assert.equal(recovered.surfacePatch.recorder.exportAvailable, true);
    assert.equal(currentPlan().state, 'finalized');
    assert.equal(recovered.surfacePatch.artifacts.some((artifact: any) => artifact.artifactId === artifactId && artifact.available), true,
      'the real Core Artifact must be exposed through the generic download card');
    const exportAction = recovered.surfacePatch.actions.find((action: any) => action.actionId === 'export-recording');
    assert.equal(exportAction?.enabled, true, 'the real export action is enabled only after the current Artifact commit');
    assert.equal(recovered.surfacePatch.artifacts[0].artifactId, artifactId,
      'the current committed Artifact must be first so the generic export presentation binds the exact current recording');
    const recoveredHealth = await worker.health();
    assert.equal(recoveredHealth.recoveredSurfacePatch.recorder.captureState, 'complete',
      'startup recovery of a succeeded Run must preserve complete=true with omissionCount=0');
    assert.equal(recoveredHealth.recoveredSurfacePatch.recorder.exportAvailable, true,
      'startup recovery must expose the exact current committed Artifact for export');
    const second = await worker.handleAction({ actionId: 'restart-recording', payload: {}, context });
    assert.notEqual(second.surfacePatch.recorder.recordingId, firstRecordingId);
    assert.equal(second.surfacePatch.recorder.state, 'recording');
    assert.equal(second.surfacePatch.actions.find((action: any) => action.actionId === 'export-recording')?.enabled, false,
      'a new or failed current recording must not bind export to a historical Artifact');
    assert.equal(second.surfacePatch.artifacts.some((artifact: any) => artifact.artifactId === artifactId), true,
      'the regression must retain a historical Artifact while proving current export stays disabled');
    assert.equal(runs.get(firstRunId).state, 'succeeded');
    assert.equal(currentPlan().runId, secondRunId);
  } finally {
    await worker.shutdown();
    restoreEnvironment(previous);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('release-owned CPython ingests and exports 5,002 events with 5,000 interactions across bounded SQLite batches', { timeout: 30_000 }, async () => {
  assert.equal(fs.existsSync(releasePython) && fs.statSync(releasePython).isFile(), true, 'release-owned CPython 3.13.14 is required');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-recording-batch-'));
  const candidateRoot = path.join(temporary, 'candidate');
  const candidateEnvelope = verifyOfficialPackage(JSON.parse(fs.readFileSync(candidatePath, 'utf8')), 'omnia-feature');
  unpackEnvelope(candidateEnvelope, candidateRoot);
  const featureDataRoot = path.join(temporary, 'data', 'features', 'omnia.recording');
  const tempRoot = path.join(temporary, 'runtime-temp');
  const storePath = path.join(featureDataRoot, 'store.sqlite');
  fs.mkdirSync(featureDataRoot, { recursive: true });
  fs.mkdirSync(tempRoot, { recursive: true });
  fs.writeFileSync(storePath, '');

  const environmentKeys = [
    'OMNIA_MANAGED_PYTHON_EXECUTABLE', 'OMNIA_MANAGED_PYTHON_ENTRY', 'OMNIA_FEATURE_PACKAGE_ROOT',
    'OMNIA_FEATURE_TEMP_ROOT', 'OMNIA_FEATURE_STORE_PATH'
  ];
  const previous = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  process.env.OMNIA_MANAGED_PYTHON_EXECUTABLE = releasePython;
  process.env.OMNIA_MANAGED_PYTHON_ENTRY = path.join(candidateRoot, 'python', 'engine.py');
  process.env.OMNIA_FEATURE_PACKAGE_ROOT = candidateRoot;
  process.env.OMNIA_FEATURE_TEMP_ROOT = tempRoot;
  process.env.OMNIA_FEATURE_STORE_PATH = storePath;

  const { createPythonSidecarBridge } = require(path.join(candidateRoot, 'middle', 'python-bridge.cjs')) as {
    createPythonSidecarBridge: (options: unknown) => {
      invoke(method: string, payload: unknown, options: { runId: string; timeoutMs: number }): Promise<any>;
      close(): Promise<void>;
    };
  };
  const bridge = createPythonSidecarBridge({ ports: { events: { emit: async () => undefined } } });
  const batchRunId = '10101010-1010-4010-8010-101010101010';
  const batchRecordingId = '20202020-2020-4020-8020-202020202020';
  try {
    const startedAt = '2026-08-05T02:00:00.000Z';
    const stoppedAt = '2026-08-05T02:05:00.000Z';
    await bridge.invoke('mark_state', {
      recordingId: batchRecordingId, runId: batchRunId, state: 'starting', startedAt
    }, { runId: batchRunId, timeoutMs: 10_000 });
    await bridge.invoke('mark_state', {
      recordingId: batchRecordingId, runId: batchRunId, state: 'active', startedAt
    }, { runId: batchRunId, timeoutMs: 10_000 });
    await bridge.invoke('mark_state', {
      recordingId: batchRecordingId, runId: batchRunId, state: 'stopping', startedAt
    }, { runId: batchRunId, timeoutMs: 10_000 });

    const events = Array.from({ length: 5_002 }, (_, index) => ({
      schemaVersion: 'omnia.page-observation-event/v1', observationId, sequence: index + 1,
      occurredAt: new Date(Date.parse(startedAt) + index + 1).toISOString(), target: { engagementId },
      kind: index === 0 ? 'observation.started' : index === 5_001 ? 'observation.stopped' : 'page.interaction',
      payload: index > 0 && index < 5_001 ? { type: 'click', ordinal: index } : {}
    }));
    const ndjson = Buffer.from(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
    const inputHandleId = '30303030-3030-4030-8030-303030303030';
    const outputHandleId = '40404040-4040-4040-8040-404040404040';
    const inputRoot = path.join(tempRoot, batchRunId, inputHandleId);
    const outputRoot = path.join(tempRoot, batchRunId, outputHandleId);
    fs.mkdirSync(inputRoot, { recursive: true });
    fs.mkdirSync(outputRoot, { recursive: true });
    const inputPath = path.join(inputRoot, 'observation.ndjson');
    const outputPath = path.join(outputRoot, 'recording.json');
    fs.writeFileSync(inputPath, ndjson);
    fs.writeFileSync(outputPath, '');
    const inputHandle = {
      schemaVersion: 'omnia.python-artifact-handle/v1', handleId: inputHandleId, runId: batchRunId,
      path: inputPath, access: 'read', mediaType: 'application/x-ndjson', originalName: 'observation.ndjson',
      sizeBytes: ndjson.length, sha256: digest(ndjson)
    };
    const outputHandle = {
      schemaVersion: 'omnia.python-artifact-handle/v1', handleId: outputHandleId, runId: batchRunId,
      path: outputPath, access: 'write', mediaType: 'application/json', originalName: 'recording.json',
      sizeBytes: 0, sha256: ''
    };
    const transformed = await bridge.invoke('ingest_and_export', {
      recordingId: batchRecordingId, runId: batchRunId, inputHandle, outputHandle,
      observationStatus: {
        schemaVersion: 'omnia.page-observation-status/v1', observationId, streamId,
        state: 'stopped', complete: true, omissionCount: 0, eventCount: events.length,
        lastSequence: events.length, engagementId, startedAt, stoppedAt
      },
      streamSizeBytes: ndjson.length, streamSha256: digest(ndjson)
    }, { runId: batchRunId, timeoutMs: 20_000 });
    assert.equal(transformed.eventCount, 5_002);
    assert.equal(transformed.metrics.interactionCount, 5_000);
    assert.equal(transformed.catalogCount, 0);
    assert.equal(transformed.sha256, digest(fs.readFileSync(outputPath)));
    const artifact = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.equal(artifact.totalEvents, 5_002);
    assert.equal(artifact.events.length, 5_002);
  } finally {
    await bridge.close();
    restoreEnvironment(previous);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('release-owned CPython persists, reconstructs, exports, finalizes, and purges one real recording after 24 hours', { timeout: 30_000 }, async () => {
  assert.equal(fs.existsSync(releasePython) && fs.statSync(releasePython).isFile(), true, 'release-owned CPython 3.13.14 is required');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-recording-python-'));
  const candidateRoot = path.join(temporary, 'candidate');
  const candidateEnvelope = verifyOfficialPackage(JSON.parse(fs.readFileSync(candidatePath, 'utf8')), 'omnia-feature');
  unpackEnvelope(candidateEnvelope, candidateRoot);
  const featureDataRoot = path.join(temporary, 'data', 'features', 'omnia.recording');
  const tempRoot = path.join(temporary, 'runtime-temp');
  const storePath = path.join(featureDataRoot, 'store.sqlite');
  fs.mkdirSync(featureDataRoot, { recursive: true });
  fs.mkdirSync(tempRoot, { recursive: true });
  fs.writeFileSync(storePath, '');

  const environmentKeys = [
    'OMNIA_MANAGED_PYTHON_EXECUTABLE', 'OMNIA_MANAGED_PYTHON_ENTRY', 'OMNIA_FEATURE_PACKAGE_ROOT',
    'OMNIA_FEATURE_TEMP_ROOT', 'OMNIA_FEATURE_STORE_PATH'
  ];
  const previous = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  process.env.OMNIA_MANAGED_PYTHON_EXECUTABLE = releasePython;
  process.env.OMNIA_MANAGED_PYTHON_ENTRY = path.join(candidateRoot, 'python', 'engine.py');
  process.env.OMNIA_FEATURE_PACKAGE_ROOT = candidateRoot;
  process.env.OMNIA_FEATURE_TEMP_ROOT = tempRoot;
  process.env.OMNIA_FEATURE_STORE_PATH = storePath;

  const { createPythonSidecarBridge } = require(path.join(candidateRoot, 'middle', 'python-bridge.cjs')) as {
    createPythonSidecarBridge: (options: unknown) => {
      invoke(method: string, payload: unknown, options: { runId: string; timeoutMs: number }): Promise<any>;
      close(): Promise<void>;
    };
  };
  const bridge = createPythonSidecarBridge({ ports: { events: { emit: async () => undefined } } });
  try {
    const startedAt = '2026-08-05T00:00:00.000Z';
    const stoppedAt = '2026-08-05T01:00:00.000Z';
    await bridge.invoke('mark_state', { recordingId, runId, state: 'starting', startedAt }, { runId, timeoutMs: 10_000 });
    await bridge.invoke('mark_state', { recordingId, runId, state: 'active', startedAt }, { runId, timeoutMs: 10_000 });
    await bridge.invoke('mark_state', { recordingId, runId, state: 'pausing', startedAt }, { runId, timeoutMs: 10_000 });
    await bridge.invoke('mark_state', { recordingId, runId, state: 'paused', startedAt }, { runId, timeoutMs: 10_000 });
    await bridge.invoke('mark_state', { recordingId, runId, state: 'resuming', startedAt }, { runId, timeoutMs: 10_000 });
    await bridge.invoke('mark_state', { recordingId, runId, state: 'active', startedAt }, { runId, timeoutMs: 10_000 });
    await bridge.invoke('mark_state', { recordingId, runId, state: 'stopping', startedAt }, { runId, timeoutMs: 10_000 });

    const graId = '22222222-2222-4222-8222-222222222222';
    const workspaceId = '33333333-3333-4333-8333-333333333333';
    const elementId = '44444444-4444-4444-8444-444444444444';
    const riskId = '55555555-5555-4555-8555-555555555555';
    const scopeId = '66666666-6666-4666-8666-666666666666';
    const controlId = '77777777-7777-4777-8777-777777777777';
    const groupId = '88888888-8888-4888-8888-888888888888';
    const factorId = '99999999-9999-4999-8999-999999999999';
    const events: Array<Record<string, unknown>> = [];
    const push = (kind: string, payload: Record<string, unknown> = {}) => {
      const sequence = events.length + 1;
      events.push({
        schemaVersion: 'omnia.page-observation-event/v1', observationId, sequence,
        occurredAt: new Date(Date.parse(startedAt) + sequence).toISOString(),
        target: { engagementId }, kind, payload
      });
    };
    const response = (requestId: string, url: string, body: unknown) => {
      const bytes = Buffer.from(JSON.stringify(body), 'utf8');
      push('network.response', { requestId, method: 'GET', url, status: 200 });
      push('network.response-body.segment', {
        requestId, encoding: 'utf8-json-base64', partIndex: 0, partCount: 1,
        bodyDigest: digest(bytes), bytesBase64: bytes.toString('base64'), contentType: 'application/json'
      });
    };
    push('observation.started');
    response('deleted', `https://omnia.example/api/infrastructures/IsDeleted?infrastructureId=${elementId}`, false);
    response('rait-level', `https://omnia.example/api/infrastructures/${elementId}/raitConclusionLevel`, 'Higher');
    response('gra', `https://omnia.example/api/riskassessments/${graId}`, {
      id: graId, engagementId, workspaceId, workspaceName: 'Workspace', itElementId: elementId,
      name: 'Application GRA', graContentName: 'Application GRA', itElementRaitConclusionLevelName: 'Higher', type: 'Application'
    });
    response('risks', `https://omnia.example/api/plannedresponse/byriskassessmentid?riskassessmentid=${graId}`, [{
      id: riskId, riskNumber: 'R-1', description: 'Risk', numberOfControls: 1, riskRiskScopeId: scopeId,
      riskScopes: [{ riskScopeId: scopeId, riskRiskScopeId: scopeId, assertions: ['Existence'] }]
    }]);
    response('controls', `https://omnia.example/api/controls/byriskassessmentid/${graId}`, [{
      id: controlId, controlNumber: 'C-1', name: 'Control'
    }]);
    response('settings', `https://omnia.example/api/risk-factors/byriskassessmentid/${graId}`, {
      riskFactors: [{
        id: factorId, displayOrder: 1, description: 'Factor', applicable: true,
        riskFactorGrouping: { id: groupId, name: 'IT Risk Assessment', applicable: true }
      }]
    });
    response('element', `https://omnia.example/api/itelement/${elementId}`, {
      id: elementId, name: 'Application', elementType: 'Application'
    });
    response('risk-detail', `https://omnia.example/api/plannedresponse/getplanresponsedetailbyriskriskscopeid?riskriskscopeid=${scopeId}`, {
      planResponseRisk: [{
        id: riskId, riskNumber: 'R-1', description: 'Risk', numberOfControls: 1,
        riskScopes: [{ riskScopeId: scopeId, riskRiskScopeId: scopeId, assertions: ['Existence'] }]
      }],
      planResponseControl: [{
        id: controlId,
        currentRiskScopes: [{ riskId, riskScopeId: scopeId, assertions: ['Existence'] }]
      }]
    });
    response('control-detail', `https://omnia.example/api/controls/${controlId}`, {
      id: controlId, controlNumber: 'C-1', name: 'Control',
      currentRiskScopes: [{ riskId, riskScopeId: scopeId, assertions: ['Existence'] }]
    });
    push('observation.stopped');

    const ndjson = Buffer.from(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
    const inputHandleId = '12121212-1212-4121-8121-121212121212';
    const outputHandleId = '34343434-3434-4343-8343-343434343434';
    const inputRoot = path.join(tempRoot, runId, inputHandleId);
    const outputRoot = path.join(tempRoot, runId, outputHandleId);
    fs.mkdirSync(inputRoot, { recursive: true });
    fs.mkdirSync(outputRoot, { recursive: true });
    const inputPath = path.join(inputRoot, 'observation.ndjson');
    const outputPath = path.join(outputRoot, 'recording.json');
    fs.writeFileSync(inputPath, ndjson);
    fs.writeFileSync(outputPath, '');
    const inputHandle = {
      schemaVersion: 'omnia.python-artifact-handle/v1', handleId: inputHandleId, runId,
      path: inputPath, access: 'read', mediaType: 'application/x-ndjson', originalName: 'observation.ndjson',
      sizeBytes: ndjson.length, sha256: digest(ndjson)
    };
    const outputHandle = {
      schemaVersion: 'omnia.python-artifact-handle/v1', handleId: outputHandleId, runId,
      path: outputPath, access: 'write', mediaType: 'application/json', originalName: 'recording.json',
      sizeBytes: 0, sha256: ''
    };
    const observationStatus = {
      schemaVersion: 'omnia.page-observation-status/v1', observationId, streamId,
      state: 'stopped', complete: true, omissionCount: 0, eventCount: events.length,
      lastSequence: events.length, engagementId, startedAt, stoppedAt
    };
    const transformed = await bridge.invoke('ingest_and_export', {
      recordingId, runId, inputHandle, outputHandle, observationStatus,
      streamSizeBytes: ndjson.length, streamSha256: digest(ndjson)
    }, { runId, timeoutMs: 20_000 });

    assert.equal(transformed.eventCount, events.length);
    assert.equal(transformed.catalogCount, 1);
    assert.equal(transformed.metrics.riskCount, 1);
    assert.equal(transformed.metrics.controlCount, 1);
    assert.equal(transformed.metrics.incompleteCatalogCount, 0);
    assert.equal(transformed.sha256, digest(fs.readFileSync(outputPath)));
    const artifact = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.equal(artifact.totalEvents, events.length);
    assert.equal(artifact.catalogs[0].catalog.status, 'complete');
    assert.equal(artifact.catalogs[0].catalog.identity.capturedRait, 'Higher');
    assert.equal(artifact.catalogs[0].catalog.risks[0].riskNumber, 'R-1');
    assert.equal(artifact.catalogs[0].catalog.controls[0].controlNumber, 'C-1');
    assert.equal(artifact.catalogs[0].catalog.settings.riskFactorEvaluation.itRiskAssessment.enabled, true);

    const coreArtifact = {
      artifactId: 'abababab-abab-4bab-8bab-abababababab', sha256: transformed.sha256,
      sizeBytes: transformed.sizeBytes, available: true
    };
    await bridge.invoke('mark_finalized', {
      recordingId, runId, finalizedAt: '2026-08-05T01:00:01.000Z', artifact: coreArtifact
    }, { runId, timeoutMs: 10_000 });
    const retained = await bridge.invoke('maintenance', {
      now: '2026-08-06T00:59:59.999Z', limit: 20
    }, { runId, timeoutMs: 10_000 });
    assert.equal(retained.sessions.length, 1);
    assert.deepEqual(retained.purgedRecordingIds, []);
    const purged = await bridge.invoke('maintenance', {
      now: '2026-08-06T01:00:00.000Z', limit: 20
    }, { runId, timeoutMs: 10_000 });
    assert.deepEqual(purged.purgedRecordingIds, [recordingId]);
    assert.deepEqual(purged.sessions, []);
  } finally {
    await bridge.close();
    restoreEnvironment(previous);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('recording catalog treats DCNO content ID as stable identity and does not require APP-only scoring category', () => {
  assert.equal(fs.existsSync(releasePython) && fs.statSync(releasePython).isFile(), true, 'release-owned CPython 3.13.14 is required');
  const graId = '20202020-2020-4020-8020-202020202020';
  const elementId = '30303030-3030-4030-8030-303030303030';
  const workspaceId = '40404040-4040-4040-8040-404040404040';
  const riskId = '50505050-5050-4050-8050-505050505050';
  const controlId = '60606060-6060-4060-8060-606060606060';
  const scopeId = '70707070-7070-4070-8070-707070707070';
  const evidence = (key: string, url: string, response: unknown) => ({ key, method: 'GET', url, ok: true, responseCaptured: true, response });
  const catalogRecord = {
    stableId: graId,
    catalog: {
      capturedAt: '2026-08-07T03:00:00.000Z',
      identity: { engagement: { id: engagementId }, pack: { id: engagementId } },
      evidence: [
        evidence('gra-detail', `/riskassessments/${graId}`, {
          id: graId, engagementId, workspaceId, itElementId: elementId, name: 'GRA-TEST-DCNO',
          referenceNumber: 'GRA-679', inkContentId: 60241274, type: 'Infrastructure', itElementRaitConclusionLevelId: 'Higher'
        }),
        evidence('risk-list', `/plannedresponse/byriskassessmentid?riskassessmentid=${graId}`, [{
          id: riskId, riskNumber: 'RAITCOR008', description: 'Risk', numberOfControls: 1,
          riskRiskScopeId: scopeId, riskScopes: [{ riskScopeId: scopeId, riskRiskScopeId: scopeId }]
        }]),
        evidence('control-list', `/controls/byriskassessmentid/${graId}`, [{
          id: controlId, controlNumber: 'DCNO.05', name: 'Control', riskScopes: [{ riskId, riskScopeId: scopeId, enabled: true }]
        }]),
        evidence('risk-factor-settings', `/risk-factors/byriskassessmentid/${graId}`, { $id: '1' }),
        evidence('it-element-detail', `/itelement/${elementId}`, {
          id: elementId, number: 'TEST-DCNO', name: 'TEST-DCNO', itElementType: 'Infrastructure', typeId: 'Network'
        }),
        evidence(`risk-scope-detail:${riskId}`, `/plannedresponse/getplanresponsedetailbyriskriskscopeid?riskriskscopeid=${scopeId}`, {
          planResponseRisk: [{ id: riskId, riskNumber: 'RAITCOR008', numberOfControls: 1,
            riskScopes: [{ riskScopeId: scopeId, riskRiskScopeId: scopeId }] }],
          planResponseControl: [{ id: controlId, currentRiskScopes: [{ riskId, riskScopeId: scopeId, enabled: true }] }]
        }),
        evidence(`control-detail:${controlId}`, `/controls/${controlId}`, {
          id: controlId, controlNumber: 'DCNO.05', name: 'Control', currentRiskScopes: [{ riskId, riskScopeId: scopeId, enabled: true }]
        })
      ]
    }
  };
  const script = [
    'import json, sys',
    'sys.path.insert(0, sys.argv[1])',
    'from gra_catalog import rebuild_catalog',
    'metadata, catalog=rebuild_catalog(json.loads(sys.stdin.read()), "recording-dcno-regression")',
    'print(json.dumps({"catalog":catalog,"metadata":metadata},ensure_ascii=False))'
  ].join('\n');
  const result = spawnSync(releasePython, ['-I', '-S', '-E', '-B', '-c', script, path.join(packageRoot, 'python')], {
    cwd: repository, encoding: 'utf8', input: JSON.stringify(catalogRecord), env: { ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const rebuilt = JSON.parse(result.stdout).catalog;
  assert.equal(rebuilt.status, 'complete');
  assert.equal(rebuilt.identity.gra.content, '');
  assert.equal(rebuilt.identity.gra.contentId, '60241274');
  assert.equal(rebuilt.identity.itElement.elementType, 'Infrastructure');
  assert.equal(rebuilt.identity.itElement.subtype, 'Network');
  assert.equal(rebuilt.settings.riskFactorEvaluation.itRiskAssessment, null);
  assert.deepEqual(rebuilt.completeness.missingReasons, []);
});

test('future upgrade preserves a retryable frozen finalization plan even before its stream digest probe', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-recording-upgrade-recovery-'));
  const paths = resolveProductPaths(temporary);
  const database = new CoreDatabase(paths.database, cipher);
  const legacyRunId = '60664a82-102b-42e4-9163-78009fd8aa1f';
  const exactRecordingId = '53c4f730-4419-4a30-9da8-72dcafe0324c';
  const createdAt = '2026-08-09T14:00:00.000Z';
  const privateRoot = path.join(paths.data, 'features', 'omnia.recording');
  fs.mkdirSync(privateRoot, { recursive: true });
  const privateStore = new DatabaseSync(path.join(privateRoot, 'store.sqlite'));
  privateStore.exec('CREATE TABLE __runtime_plans(plan_id TEXT PRIMARY KEY,payload_json TEXT NOT NULL,updated_at TEXT NOT NULL)');
  privateStore.prepare('INSERT INTO __runtime_plans(plan_id,payload_json,updated_at) VALUES(?,?,?)').run(
    `recording-run:${exactRecordingId}`,
    JSON.stringify({
      planId: `recording-run:${exactRecordingId}`, recordingId: exactRecordingId, runId: legacyRunId,
      state: 'finalization_failed', observationId, streamId, eventCount: 1046,
      startedAt: createdAt, stoppedAt: '2026-08-09T14:23:30.595Z', engagementId
    }),
    '2026-08-10T00:00:00.000Z'
  );
  privateStore.close();
  database.db.prepare(`
    INSERT INTO feature_runs(
      run_id,trace_id,feature_id,feature_version,engagement_id,state,state_revision,
      source_artifact_id,template_version_id,output_artifact_id,plan_digest,last_error,created_at,updated_at
    ) VALUES(?,?,?,?,?,'processing',1,'','','',?,'',?,?)
  `).run(legacyRunId, crypto.randomUUID(), 'omnia.recording', '0.4.16', engagementId, 'a'.repeat(64), createdAt, createdAt);
  database.db.prepare(`
    INSERT INTO feature_run_events(event_id,run_id,revision,from_state,to_state,event_type,details_json,occurred_at)
    VALUES(?,?,1,'','processing','run.processing_started',?,?)
  `).run(crypto.randomUUID(), legacyRunId, JSON.stringify({
    surfaceId: 'recording.workbench', externalId: exactRecordingId,
    sourceRef: `connector-recording:${exactRecordingId}`
  }), createdAt);
  try {
    const manager = new FeaturePackageManager(database.db, paths);
    const installed = manager.install(candidatePath);
    assert.equal(installed.featureVersion, '0.4.18');
    assert.equal((database.db.prepare('SELECT state FROM feature_runs WHERE run_id=?').get(legacyRunId) as any).state, 'processing');
    assert.equal((database.db.prepare(`
      SELECT COUNT(*) AS count FROM feature_run_events
      WHERE run_id=? AND event_type='recording.terminal_projection_reconciled'
    `).get(legacyRunId) as any).count, 0);
  } finally {
    database.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('recording 0.4.18 candidate verifies, self-tests, and installs only in an isolated product root', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-recording-candidate-'));
  const unpacked = path.join(temporary, 'unpacked');
  const productRoot = path.join(temporary, 'isolated-product');
  fs.mkdirSync(unpacked, { recursive: true });
  const envelope = verifyOfficialPackage(JSON.parse(fs.readFileSync(candidatePath, 'utf8')), 'omnia-feature');
  assert.equal(envelope.packageId, 'omnia.recording');
  assert.equal(envelope.version, '0.4.18');
  assert.equal(envelope.sequence, 31);
  unpackEnvelope(envelope, unpacked);
  const manifest = JSON.parse(fs.readFileSync(path.join(unpacked, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.recoveryCompatibility, {
    schemaVersion: 'omnia.feature-recovery-compatibility/v1', mode: 'frozen_input_finalize',
    sourceFeatureVersions: ['0.4.16', '0.4.17'], actionId: 'retry-finalization'
  });
  const selfTest = spawnSync(process.execPath, [path.join(unpacked, 'tests', 'self-test.cjs')], {
    cwd: unpacked, encoding: 'utf8', windowsHide: true
  });
  assert.equal(selfTest.status, 0, selfTest.stderr || selfTest.stdout);
  assert.match(selfTest.stdout, /package contract self-test passed/);
  const runtimeContract = JSON.parse(fs.readFileSync(path.join(unpacked, 'contracts', 'feature-runtime.json'), 'utf8'));
  assert.equal(runtimeContract.storePorts.includes('compareAndSwapPlan'), true,
    'the signed Feature runtime contract must declare its atomic plan CAS dependency');
  assert.equal(runtimeContract.storePorts.includes('createSuccessorProcessingRun'), true,
    'the signed Feature runtime contract must declare its failed-Run successor dependency');
  const surface = JSON.parse(fs.readFileSync(path.join(unpacked, 'frontend', 'surface.json'), 'utf8'));
  const exportAction = surface.actions.find((action: any) => action.actionId === 'export-recording');
  assert.deepEqual(exportAction, {
    actionId: 'export-recording', label: '导出录制记录', presentation: 'export', effect: 'read_only',
    enabled: false, reason: '当前录制尚无已提交的 Core Artifact。', selectionMode: 'none', dependencies: []
  });
  const immutableWorker = fs.readFileSync(path.join(unpacked, 'middle', 'worker.cjs'), 'utf8');
  assert.match(immutableWorker, /const FEATURE_VERSION = '0\.4\.18'/);
  assert.match(immutableWorker, /createSuccessorProcessingRun/);
  assert.doesNotMatch(immutableWorker, /omnia\.operation-resource-recovery-claim\/v1/,
    'the immutable 0.4.18 candidate must not be rewritten with the 0.4.19 handoff claim');
  for (const member of ['engine.py', 'export.py', 'gra_catalog.py', 'protocol.py', 'recording_store.py']) {
    assert.deepEqual(
      fs.readFileSync(path.join(unpacked, 'python', member)),
      fs.readFileSync(path.join(packageRoot, 'python', member)),
      `candidate Python member ${member} must equal the smoke-tested source bytes`
    );
  }

  const paths = resolveProductPaths(productRoot);
  const database = new CoreDatabase(paths.database, { encrypt: (value) => value, decrypt: (value) => value });
  try {
    const manager = new FeaturePackageManager(database.db, paths);
    const installed = manager.install(candidatePath);
    assert.equal(installed.featureId, 'omnia.recording');
    assert.equal(installed.featureVersion, '0.4.18');
    assert.equal(installed.packageDigest, packageDigest(envelope));
    assert.equal(manager.list().find((item) => item.featureId === 'omnia.recording')?.featureVersion, '0.4.18');
  } finally {
    database.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('recording 0.4.19 immutable Feature and standalone Operation candidates are identical at the embedded boundary', {
  skip: !fs.existsSync(candidate019Path) || !fs.existsSync(operation019Path)
}, () => {
  const featureBytes = fs.readFileSync(candidate019Path);
  const operationBytes = fs.readFileSync(operation019Path);
  const feature = verifyOfficialPackage(JSON.parse(featureBytes.toString('utf8')), 'omnia-feature');
  const operation = verifyOfficialPackage(JSON.parse(operationBytes.toString('utf8')), 'omnia-connector-operation');
  assert.equal(feature.packageId, 'omnia.recording');
  assert.equal(feature.version, '0.4.19');
  assert.equal(feature.sequence, 32);
  assert.equal(operation.packageId, 'omnia.recording.operation');
  assert.equal(operation.version, '0.4.19');
  assert.equal(operation.sequence, 32);
  const embeddedOperation = feature.files.find((member) => member.path === 'connector-capability/operation.ofop');
  assert.ok(embeddedOperation);
  assert.deepEqual(Buffer.from(embeddedOperation.contentBase64, 'base64'), operationBytes,
    'the deployable standalone Operation must be byte-identical to the Feature member');

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-recording-0419-candidate-'));
  try {
    unpackEnvelope(feature, temporary);
    const manifest = JSON.parse(fs.readFileSync(path.join(temporary, 'manifest.json'), 'utf8'));
    assert.equal(manifest.minimumShellVersion, '0.4.15');
    assert.deepEqual(manifest.recoveryCompatibility, {
      schemaVersion: 'omnia.feature-recovery-compatibility/v1', mode: 'frozen_input_finalize',
      sourceFeatureVersions: ['0.4.16', '0.4.17', '0.4.18'], actionId: 'retry-finalization'
    });
    const operationManifest = JSON.parse(Buffer.from(
      operation.files.find((member) => member.path === 'manifest.json')!.contentBase64, 'base64'
    ).toString('utf8'));
    assert.deepEqual(operationManifest.resourceOwner, {
      schemaVersion: 'omnia.operation-resource-owner/v1', ownerId: 'omnia.page-observation.current-pack',
      compatibilityVersion: 1, capabilities: ['omnia.page-observation.current-pack.v1'],
      compatibleSourcePackageDigests: [
        'sha256:27218281da622b4bf3ec7ae64fa97e4f5cc3988a34abf659aff415bc71bb5d0f',
        'sha256:671ce107badb4d94600af7290c2b08c922088a2e8e2f56cd9d2d2f75869480db',
        'sha256:ec1ce1cfb3c33ce3b56257477fbb48866e790a158da570f4bbbe593e5abf01e9'
      ]
    });
    const packagedHandler = Buffer.from(
      operation.files.find((member) => member.path === 'operation/handler.cjs')!.contentBase64, 'base64'
    );
    assert.deepEqual(packagedHandler, fs.readFileSync(operationSourcePath));
    const runtime = JSON.parse(fs.readFileSync(path.join(temporary, 'contracts', 'feature-runtime.json'), 'utf8'));
    assert.equal(runtime.pythonSidecar.version, '3.13.14');
    assert.deepEqual(runtime.pythonSidecar.members,
      ['python/engine.py', 'python/export.py', 'python/gra_catalog.py', 'python/protocol.py', 'python/recording_store.py']);
    const selfTest = spawnSync(process.execPath, [path.join(temporary, 'tests', 'self-test.cjs')], {
      cwd: temporary, encoding: 'utf8', windowsHide: true
    });
    assert.equal(selfTest.status, 0, selfTest.stderr || selfTest.stdout);
    assert.match(selfTest.stdout, /package contract self-test passed/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
