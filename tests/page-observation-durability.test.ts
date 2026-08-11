import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Frame, Page } from 'playwright-core';
import { OperationHost } from '../src/connector/operation-host.js';
import {
  ManagedStreamHost,
  quarantineLegacyManagedStreamOrphans,
  type ManagedStreamOwner
} from '../src/connector/managed-stream-host.js';
import { PageObservationHost, type PageObservationContext } from '../src/connector/page-observation-host.js';
import {
  canonicalJson,
  packageDigest,
  packageFile,
  verifyOfficialPackage,
  type OfficialPackageEnvelope
} from '../src/main/features/official-package.js';

const engagementId = '11111111-1111-4111-8111-111111111111';
const binding = {
  connectorId: 'connector-durable-test',
  sessionGeneration: 7,
  engagementId,
  authorityInstanceId: 'authority-test',
  tenantOrOrgId: 'tenant-test',
  packId: 'pack-test'
};
const digestA = `sha256:${'a'.repeat(64)}`;
const digestB = `sha256:${'b'.repeat(64)}`;
const digestC = `sha256:${'d'.repeat(64)}`;
const digestD = `sha256:${'e'.repeat(64)}`;
const fingerprint = 'c'.repeat(64);

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-page-observation-durable-'));
}

function owner(overrides: Partial<ManagedStreamOwner> = {}): ManagedStreamOwner {
  return {
    ownerKey: '1'.repeat(64),
    packageDigest: digestA,
    packageSequence: 10,
    capabilityFingerprint: fingerprint,
    binding: { ...binding },
    ...overrides
  };
}

class FakeFrame {
  constructor(private readonly pageUrl: string) {}
  url(): string { return this.pageUrl; }
  isDetached(): boolean { return false; }
  async evaluate(): Promise<Record<string, unknown>> { return { title: 'TEST', headings: [], controls: [] }; }
}

class FakePage extends EventEmitter {
  private readonly frame: FakeFrame;
  private closed = false;
  constructor(private readonly pageUrl: string) {
    super();
    this.frame = new FakeFrame(pageUrl);
  }
  url(): string { return this.pageUrl; }
  isClosed(): boolean { return this.closed; }
  mainFrame(): Frame { return this.frame as unknown as Frame; }
  async exposeBinding(): Promise<void> {}
  async addInitScript(): Promise<void> {}
  async evaluate(): Promise<boolean> { return true; }
}

function observationContext(page: FakePage, generation = 7, packId = 'pack-test'): PageObservationContext {
  const targetUrl = new URL(page.url());
  return {
    page: page as unknown as Page,
    binding: { ...binding, sessionGeneration: generation, packId },
    targetUrl,
    apiOrigin: targetUrl.origin
  };
}

function updatePackageMember(envelope: OfficialPackageEnvelope, memberPath: string, bytes: Buffer): void {
  const member = envelope.files.find((item) => item.path === memberPath);
  if (!member) throw new Error(`Missing test package member: ${memberPath}`);
  member.contentBase64 = bytes.toString('base64');
  member.size = bytes.length;
  member.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
}

function signedOperationUpgrade(
  source: OfficialPackageEnvelope,
  version: string,
  sequence: number,
  compatibleSourcePackageDigests: string[],
  handlerSuffix = '',
  ownerId = 'omnia.page-observation.current-pack'
): OfficialPackageEnvelope {
  const upgraded = structuredClone(source);
  upgraded.version = version;
  upgraded.sequence = sequence;
  const manifest = JSON.parse(packageFile(upgraded, 'manifest.json').toString('utf8'));
  manifest.version = version;
  manifest.sequence = sequence;
  manifest.resourceOwner = {
    schemaVersion: 'omnia.operation-resource-owner/v1',
    ownerId,
    compatibilityVersion: 1,
    capabilities: ['omnia.page-observation.current-pack.v1'],
    compatibleSourcePackageDigests
  };
  updatePackageMember(upgraded, 'manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
  if (handlerSuffix) {
    updatePackageMember(upgraded, 'operation/handler.cjs', Buffer.concat([
      packageFile(upgraded, 'operation/handler.cjs'), Buffer.from(handlerSuffix)
    ]));
  }
  const signingRoot = path.join(process.env.USERPROFILE || '', '.omnia-agent-v5', 'signing');
  const privateKey = fs.readFileSync(path.join(signingRoot, 'operation-ed25519-private.pem'), 'utf8');
  const unsigned = { ...upgraded } as Record<string, unknown>;
  delete unsigned.signature;
  upgraded.signature = crypto.sign(null, Buffer.from(canonicalJson(unsigned)), privateKey).toString('base64');
  return upgraded;
}

function signedOperationWithoutOwnerUpgrade(
  source: OfficialPackageEnvelope,
  version: string,
  sequence: number
): OfficialPackageEnvelope {
  const upgraded = structuredClone(source);
  upgraded.version = version;
  upgraded.sequence = sequence;
  const manifest = JSON.parse(packageFile(upgraded, 'manifest.json').toString('utf8'));
  manifest.version = version;
  manifest.sequence = sequence;
  delete manifest.resourceOwner;
  updatePackageMember(upgraded, 'manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
  const signingRoot = path.join(process.env.USERPROFILE || '', '.omnia-agent-v5', 'signing');
  const privateKey = fs.readFileSync(path.join(signingRoot, 'operation-ed25519-private.pem'), 'utf8');
  const unsigned = { ...upgraded } as Record<string, unknown>;
  delete unsigned.signature;
  upgraded.signature = crypto.sign(null, Buffer.from(canonicalJson(unsigned)), privateKey).toString('base64');
  return upgraded;
}

test('frozen managed stream survives process reopen and only a monotonic ABI-compatible owner can read it', async () => {
  const root = tempRoot();
  const first = new ManagedStreamHost(root);
  const original = owner();
  const streamId = first.create(original, 'application/x-ndjson');
  first.append(original, streamId, Buffer.from('{"sequence":1}\n'));
  first.finalize(original, streamId, true);
  const largeStreamId = first.create(original, 'application/octet-stream');
  const largeEvidence = Buffer.alloc(300 * 1024, 0x5a);
  first.append(original, largeStreamId, largeEvidence);
  first.finalize(original, largeStreamId, true);
  first.close();

  const reopened = new ManagedStreamHost(root);
  const samePackageAfterRestart = owner({ binding: { ...binding, sessionGeneration: 98 } });
  const samePackageChunk = await reopened.read(samePackageAfterRestart, {
    schemaVersion: 'omnia.managed-stream-read/v1', streamId, offset: 0, maxBytes: 128 * 1024
  });
  assert.equal(Buffer.from(samePackageChunk.bytesBase64, 'base64').toString('utf8'), '{"sequence":1}\n');
  const recoveredChunks: Buffer[] = [];
  let largeOffset = 0;
  for (;;) {
    const recoveredChunk = await reopened.read(samePackageAfterRestart, {
      schemaVersion: 'omnia.managed-stream-read/v1', streamId: largeStreamId,
      offset: largeOffset, maxBytes: 128 * 1024
    });
    recoveredChunks.push(Buffer.from(recoveredChunk.bytesBase64, 'base64'));
    largeOffset = recoveredChunk.nextOffset;
    if (recoveredChunk.eof) break;
  }
  assert.deepEqual(Buffer.concat(recoveredChunks), largeEvidence);
  const next = owner({
    packageDigest: digestB,
    packageSequence: 11,
    binding: { ...binding, sessionGeneration: 99 }
  });
  const chunk = await reopened.read(next, {
    schemaVersion: 'omnia.managed-stream-read/v1', streamId, offset: 0, maxBytes: 128 * 1024
  });
  assert.equal(Buffer.from(chunk.bytesBase64, 'base64').toString('utf8'), '{"sequence":1}\n');
  assert.equal(chunk.eof, true);
  assert.match(chunk.streamDigest || '', /^[0-9a-f]{64}$/u);

  await assert.rejects(reopened.read(owner({
    packageDigest: digestB,
    packageSequence: 11,
    capabilityFingerprint: 'd'.repeat(64)
  }), { schemaVersion: 'omnia.managed-stream-read/v1', streamId, offset: 0 }), /unavailable/);
  await assert.rejects(reopened.read(owner({
    packageDigest: digestB,
    packageSequence: 10
  }), { schemaVersion: 'omnia.managed-stream-read/v1', streamId, offset: 0 }), /unavailable/);
  await assert.rejects(reopened.read(next, {
    schemaVersion: 'omnia.managed-stream-read/v1', streamId, offset: 1
  }), /align/);
  await assert.rejects(reopened.read({ ...next, binding: { ...next.binding, packId: 'other-pack' } }, {
    schemaVersion: 'omnia.managed-stream-read/v1', streamId, offset: 0
  }), /unavailable/);
});

test('legacy digest handoff requires an exact signed source owner and complete stopped observation', async () => {
  const root = tempRoot();
  const streams = new ManagedStreamHost(root);
  const observations = new PageObservationHost(streams);
  const page = new FakePage(`https://client.deloitteomnia.deloitte.com.cn/engagement/${engagementId}/home`);
  const legacy = owner({ ownerKey: '2'.repeat(64) });
  const opened = await observations.open(legacy, {
    schemaVersion: 'omnia.page-observation-open/v1',
    policyId: 'omnia.page-observation.current-pack.v1',
    idempotencyKey: 'durable:test:complete:0001'
  }, observationContext(page));
  const stopped = await observations.stop(legacy, {
    schemaVersion: 'omnia.page-observation-control/v1', observationId: opened.observationId
  });
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.complete, true);
  await observations.close();
  streams.close();

  const reopenedStreams = new ManagedStreamHost(root);
  const reopened = new PageObservationHost(reopenedStreams);
  const successor = owner({
    ownerKey: '3'.repeat(64),
    packageDigest: digestB,
    packageSequence: 11,
    binding: { ...binding, sessionGeneration: 8 },
    compatibleSourceOwners: [{ ownerKey: legacy.ownerKey, packageDigest: legacy.packageDigest }]
  });
  const status = reopened.status(successor, {
    schemaVersion: 'omnia.page-observation-control/v1', observationId: opened.observationId
  });
  assert.equal(status.streamId, opened.streamId);
  const bytes = await reopened.readChunk(successor, {
    schemaVersion: 'omnia.managed-stream-read/v1', streamId: opened.streamId, offset: 0, maxBytes: 128 * 1024
  });
  assert.equal(bytes.eof, true);
  assert.match(Buffer.from(bytes.bytesBase64, 'base64').toString('utf8'), /"kind":"observation\.stopped"/u);

  assert.throws(() => reopened.status({
    ...successor,
    compatibleSourceOwners: [{ ownerKey: legacy.ownerKey, packageDigest: `sha256:${'e'.repeat(64)}` }]
  }, { schemaVersion: 'omnia.page-observation-control/v1', observationId: opened.observationId }), /unavailable/);
  assert.throws(() => reopened.status({
    ...successor,
    binding: { ...successor.binding, authorityInstanceId: 'other-authority' }
  }, { schemaVersion: 'omnia.page-observation-control/v1', observationId: opened.observationId }), /unavailable/);

  reopened.commitOwnerReplacement(legacy.packageDigest, binding, () => successor);
  assert.equal(reopened.status(legacy, {
    schemaVersion: 'omnia.page-observation-control/v1', observationId: opened.observationId
  }).state, 'stopped', 'the source owner remains usable until explicit finalization');
  assert.equal((await reopened.readChunk(legacy, {
    schemaVersion: 'omnia.managed-stream-read/v1', streamId: opened.streamId, offset: 0
  })).eof, true);
  assert.equal((await reopened.readChunk(successor, {
    schemaVersion: 'omnia.managed-stream-read/v1', streamId: opened.streamId, offset: 0
  })).eof, true);
  reopened.finalizeOwnerReplacement(legacy.packageDigest, binding, () => successor);
  await assert.rejects(reopened.readChunk(legacy, {
    schemaVersion: 'omnia.managed-stream-read/v1', streamId: opened.streamId, offset: 0
  }), /unavailable/);
  reopenedStreams.close();
  const stableRestartStreams = new ManagedStreamHost(root);
  const stableRestart = new PageObservationHost(stableRestartStreams);
  const laterStableOwner = owner({
    ownerKey: successor.ownerKey,
    packageDigest: digestC,
    packageSequence: 12,
    binding: { ...binding, sessionGeneration: 9 }
  });
  assert.equal(stableRestart.status(laterStableOwner, {
    schemaVersion: 'omnia.page-observation-control/v1', observationId: opened.observationId
  }).state, 'stopped');
  await assert.rejects(stableRestart.readChunk(laterStableOwner, {
    schemaVersion: 'omnia.managed-stream-read/v1', streamId: opened.streamId, offset: 0
  }), /unavailable/);
  stableRestart.preflightOwnerReplacement(successor.packageDigest, binding, () => laterStableOwner);
  stableRestart.commitOwnerReplacement(successor.packageDigest, binding, () => laterStableOwner);
  assert.equal((await stableRestart.readChunk(successor, {
    schemaVersion: 'omnia.managed-stream-read/v1', streamId: opened.streamId, offset: 0
  })).eof, true);
  assert.equal((await stableRestart.readChunk(laterStableOwner, {
    schemaVersion: 'omnia.managed-stream-read/v1', streamId: opened.streamId, offset: 0
  })).eof, true);
  stableRestart.finalizeOwnerReplacement(successor.packageDigest, binding, () => laterStableOwner);
  await assert.rejects(stableRestart.readChunk(successor, {
    schemaVersion: 'omnia.managed-stream-read/v1', streamId: opened.streamId, offset: 0
  }), /unavailable/);
  stableRestartStreams.close();
  const thirdRestartStreams = new ManagedStreamHost(root);
  const thirdRestart = new PageObservationHost(thirdRestartStreams);
  const thirdStableOwner = owner({
    ownerKey: successor.ownerKey,
    packageDigest: digestD,
    packageSequence: 13,
    binding: { ...binding, sessionGeneration: 10 }
  });
  assert.equal(thirdRestart.status(thirdStableOwner, {
    schemaVersion: 'omnia.page-observation-control/v1', observationId: opened.observationId
  }).state, 'stopped');
  await assert.rejects(thirdRestart.readChunk(thirdStableOwner, {
    schemaVersion: 'omnia.managed-stream-read/v1', streamId: opened.streamId, offset: 0
  }), /unavailable/, 'a future digest is not readable until its own commit records it as pending');
  thirdRestart.preflightOwnerReplacement(laterStableOwner.packageDigest, binding, () => thirdStableOwner);
  thirdRestart.commitOwnerReplacement(laterStableOwner.packageDigest, binding, () => thirdStableOwner);
  assert.equal((await thirdRestart.readChunk(laterStableOwner, {
    schemaVersion: 'omnia.managed-stream-read/v1', streamId: opened.streamId, offset: 0
  })).eof, true);
  assert.equal((await thirdRestart.readChunk(thirdStableOwner, {
    schemaVersion: 'omnia.managed-stream-read/v1', streamId: opened.streamId, offset: 0
  })).eof, true);
  thirdRestart.finalizeOwnerReplacement(laterStableOwner.packageDigest, binding, () => thirdStableOwner);
  await assert.rejects(thirdRestart.readChunk(laterStableOwner, {
    schemaVersion: 'omnia.managed-stream-read/v1', streamId: opened.streamId, offset: 0
  }), /unavailable/);
  assert.equal((await thirdRestart.readChunk(thirdStableOwner, {
    schemaVersion: 'omnia.managed-stream-read/v1', streamId: opened.streamId, offset: 0
  })).eof, true);
  await assert.rejects(thirdRestart.readChunk(legacy, {
    schemaVersion: 'omnia.managed-stream-read/v1', streamId: opened.streamId, offset: 0
  }), /unavailable/);
  const adoptionFilename = path.join(root, 'owner-adoptions', `${opened.streamId}.json`);
  fs.writeFileSync(adoptionFilename, '{"tampered":true}');
  const tamperedAdoptionStreams = new ManagedStreamHost(root);
  const tamperedAdoptionObservations = new PageObservationHost(tamperedAdoptionStreams);
  await assert.rejects(tamperedAdoptionObservations.readChunk(thirdStableOwner, {
    schemaVersion: 'omnia.managed-stream-read/v1', streamId: opened.streamId, offset: 0
  }), /unavailable/);
  assert.equal(fs.existsSync(adoptionFilename), true, 'invalid adoption evidence is preserved for audit');
});

test('active observation is failed closed on package retirement and is never handed to the next digest', async () => {
  const root = tempRoot();
  const streams = new ManagedStreamHost(root);
  const observations = new PageObservationHost(streams);
  const page = new FakePage(`https://client.deloitteomnia.deloitte.com.cn/engagement/${engagementId}/home`);
  const activeOwner = owner({ ownerKey: '4'.repeat(64) });
  const opened = await observations.open(activeOwner, {
    schemaVersion: 'omnia.page-observation-open/v1',
    policyId: 'omnia.page-observation.current-pack.v1',
    idempotencyKey: 'durable:test:active:000001'
  }, observationContext(page));
  assert.throws(() => observations.status(owner({
    ownerKey: activeOwner.ownerKey,
    binding: { ...binding, sessionGeneration: 8 }
  }), {
    schemaVersion: 'omnia.page-observation-control/v1', observationId: opened.observationId
  }), /unavailable/);
  observations.retireOwner(activeOwner.packageDigest);
  const successor = owner({
    ownerKey: activeOwner.ownerKey,
    packageDigest: digestB,
    packageSequence: 11,
    binding: { ...binding, sessionGeneration: 8 }
  });
  assert.throws(() => observations.status(successor, {
    schemaVersion: 'omnia.page-observation-control/v1', observationId: opened.observationId
  }), /unavailable/);
  assert.equal(observations.status(activeOwner, {
    schemaVersion: 'omnia.page-observation-control/v1', observationId: opened.observationId
  }).state, 'failed');
});

test('multi-stream owner adoption and observation finalization replay after a second-resource failure', async () => {
  const root = tempRoot();
  const streams = new ManagedStreamHost(root);
  const observations = new PageObservationHost(streams);
  const page = new FakePage(`https://client.deloitteomnia.deloitte.com.cn/engagement/${engagementId}/home`);
  const legacy = owner({ ownerKey: '5'.repeat(64) });
  const ids: string[] = [];
  for (const suffix of ['0001', '0002']) {
    const opened = await observations.open(legacy, {
      schemaVersion: 'omnia.page-observation-open/v1',
      policyId: 'omnia.page-observation.current-pack.v1',
      idempotencyKey: `durable:multi-adoption:${suffix}`
    }, observationContext(page));
    await observations.stop(legacy, {
      schemaVersion: 'omnia.page-observation-control/v1', observationId: opened.observationId
    });
    ids.push(opened.observationId);
  }
  const successor = owner({
    ownerKey: '6'.repeat(64), packageDigest: digestB, packageSequence: 11,
    compatibleSourceOwners: [{ ownerKey: legacy.ownerKey, packageDigest: legacy.packageDigest }]
  });
  const originalAdopt = streams.adoptOwner.bind(streams);
  let adoptionCalls = 0;
  streams.adoptOwner = ((source, target, streamId) => {
    adoptionCalls += 1;
    if (adoptionCalls === 2) throw new Error('injected second adoption failure');
    return originalAdopt(source, target, streamId);
  }) as typeof streams.adoptOwner;
  assert.throws(() => observations.commitOwnerReplacement(legacy.packageDigest, binding, () => successor), /second adoption/);
  streams.adoptOwner = originalAdopt;
  assert.doesNotThrow(() => observations.commitOwnerReplacement(legacy.packageDigest, binding, () => successor));

  const originalRename = fs.renameSync;
  let observationMetadataRenames = 0;
  fs.renameSync = ((source: fs.PathLike, destination: fs.PathLike) => {
    if (path.dirname(path.resolve(String(destination))) === path.join(root, 'observations')) {
      observationMetadataRenames += 1;
      if (observationMetadataRenames === 2) throw new Error('injected second observation metadata failure');
    }
    return originalRename(source, destination);
  }) as typeof fs.renameSync;
  try {
    assert.throws(() => observations.finalizeOwnerReplacement(legacy.packageDigest, binding, () => successor), /second observation/);
  } finally {
    fs.renameSync = originalRename;
  }
  assert.doesNotThrow(() => observations.finalizeOwnerReplacement(legacy.packageDigest, binding, () => successor));
  for (const observationId of ids) {
    assert.equal(observations.status(successor, {
      schemaVersion: 'omnia.page-observation-control/v1', observationId
    }).state, 'stopped');
  }
});

test('tamper fails closed without deleting evidence and TTL cleanup is audited', async () => {
  const root = tempRoot();
  let clock = Date.parse('2026-08-10T00:00:00.000Z');
  const first = new ManagedStreamHost(root, { now: () => clock, frozenTtlMs: 60_000 });
  const current = owner();
  const streamId = first.create(current, 'application/x-ndjson');
  first.append(current, streamId, Buffer.from('evidence\n'));
  first.finalize(current, streamId, true);
  fs.appendFileSync(path.join(root, `${streamId}.bin`), 'tamper');
  const tampered = new ManagedStreamHost(root, { now: () => clock, frozenTtlMs: 60_000 });
  await assert.rejects(tampered.read(current, {
    schemaVersion: 'omnia.managed-stream-read/v1', streamId, offset: 0
  }), /unavailable/);
  assert.equal(fs.existsSync(path.join(root, `${streamId}.bin`)), true);
  assert.match(fs.readFileSync(path.join(root, 'cleanup-audit.ndjson'), 'utf8'), /integrity_fail_closed/u);

  const ttlRoot = tempRoot();
  const ttl = new ManagedStreamHost(ttlRoot, { now: () => clock, frozenTtlMs: 60_000 });
  const ttlStreamId = ttl.create(current, 'application/x-ndjson');
  ttl.append(current, ttlStreamId, Buffer.from('expires\n'));
  ttl.finalize(current, ttlStreamId, true);
  clock += 60_001;
  new ManagedStreamHost(ttlRoot, { now: () => clock, frozenTtlMs: 60_000 });
  assert.equal(fs.existsSync(path.join(ttlRoot, `${ttlStreamId}.bin`)), false);
  assert.match(fs.readFileSync(path.join(ttlRoot, 'cleanup-audit.ndjson'), 'utf8'), /ttl_expired/u);
});

test('legacy orphan stream is quarantined with immutable size and digest evidence instead of deleted', () => {
  const root = tempRoot();
  const streamId = 'stream_36a65e360751c80e0161d12f70c06b80';
  const bytes = Buffer.from('{"legacy":true}\n');
  fs.writeFileSync(path.join(root, `${streamId}.bin`), bytes);
  const offline = quarantineLegacyManagedStreamOrphans(root);
  assert.equal(offline.quarantined, 1);
  assert.equal(offline.failed, 0);
  assert.deepEqual(offline.remainingOrphans, []);
  const quarantined = path.join(root, 'legacy-orphans', `${streamId}.bin`);
  const evidence = JSON.parse(fs.readFileSync(path.join(root, 'legacy-orphans', `${streamId}.json`), 'utf8'));
  assert.equal(fs.existsSync(path.join(root, `${streamId}.bin`)), false);
  assert.deepEqual(fs.readFileSync(quarantined), bytes);
  assert.equal(evidence.streamId, streamId);
  assert.equal(evidence.size, bytes.length);
  assert.equal(evidence.digest, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.match(fs.readFileSync(path.join(root, 'cleanup-audit.ndjson'), 'utf8'), /orphan_quarantined/u);
  const repeat = quarantineLegacyManagedStreamOrphans(root);
  assert.equal(repeat.quarantined, 0);
  assert.equal(repeat.failed, 0);

  const interruptedStreamId = `stream_${'7'.repeat(32)}`;
  fs.writeFileSync(path.join(root, 'legacy-orphans', `${interruptedStreamId}.bin`), Buffer.from('preserved'));
  const normalStreamId = `stream_${'8'.repeat(32)}`;
  fs.writeFileSync(path.join(root, `${normalStreamId}.bin`), Buffer.from('normal'));
  fs.writeFileSync(path.join(root, `${normalStreamId}.json`), '{"left":"unparsed"}');
  const repaired = quarantineLegacyManagedStreamOrphans(root);
  assert.equal(repaired.repaired, 1);
  assert.equal(repaired.failed, 0);
  assert.equal(fs.existsSync(path.join(root, 'legacy-orphans', `${interruptedStreamId}.json`)), true);
  assert.equal(fs.existsSync(path.join(root, `${normalStreamId}.bin`)), true,
    'offline quarantine never opens or freezes streams that have metadata');

  const blockedRoot = tempRoot();
  const blockedIds = [`stream_${'9'.repeat(32)}`, `stream_${'a'.repeat(32)}`];
  for (const blockedId of blockedIds) {
    fs.writeFileSync(path.join(blockedRoot, `${blockedId}.bin`), Buffer.from(blockedId));
  }
  assert.throws(
    () => new ManagedStreamHost(blockedRoot, { maxQuarantineCount: 1 }),
    /preservation failed closed/u,
    'a Worker-local host construction must not bypass an incomplete offline quarantine'
  );
  const preservedBlockedBytes = blockedIds.reduce((count, blockedId) => (
    count
    + Number(fs.existsSync(path.join(blockedRoot, `${blockedId}.bin`)))
    + Number(fs.existsSync(path.join(blockedRoot, 'legacy-orphans', `${blockedId}.bin`)))
  ), 0);
  assert.equal(preservedBlockedBytes, blockedIds.length, 'fail-close keeps every orphan byte on disk');
});

test('managed stream quota rejects new bytes without evicting retained evidence and TTL restores capacity', () => {
  const root = tempRoot();
  let clock = Date.parse('2026-08-10T00:00:00.000Z');
  const options = { now: () => clock, frozenTtlMs: 60_000, maxStreamCount: 1, maxTotalBytes: 8 };
  const streams = new ManagedStreamHost(root, options);
  const streamId = streams.create(owner(), 'application/x-ndjson');
  streams.append(owner(), streamId, Buffer.from('12345678'));
  streams.finalize(owner(), streamId, true);
  const retained = fs.readFileSync(path.join(root, `${streamId}.bin`));
  assert.throws(() => streams.create(owner(), 'application/x-ndjson'), /quota is full/);
  assert.deepEqual(fs.readFileSync(path.join(root, `${streamId}.bin`)), retained);
  clock += 60_001;
  const reopened = new ManagedStreamHost(root, options);
  assert.doesNotThrow(() => reopened.create(owner(), 'application/x-ndjson'));
  assert.match(fs.readFileSync(path.join(root, 'cleanup-audit.ndjson'), 'utf8'), /quota_rejected_create/u);
});

test('Operation registration hands off only exact legacy digest with stable signed claim, ABI fingerprint, and monotonic sequence', async () => {
  const repository = path.resolve(import.meta.dirname, '..');
  const outer = verifyOfficialPackage(JSON.parse(fs.readFileSync(
    path.join(repository, 'feature-packages', 'recording', 'candidates', 'recording-0.4.18.ofp'), 'utf8'
  )), 'omnia-feature');
  const legacyPackage = verifyOfficialPackage(
    JSON.parse(packageFile(outer, 'connector-capability/operation.ofop').toString('utf8')),
    'omnia-connector-operation'
  );
  const legacyDigest = packageDigest(legacyPackage);
  const root = tempRoot();
  let host = new OperationHost(root);
  let liveBinding = { ...binding };
  const page = new FakePage(`https://client.deloitteomnia.deloitte.com.cn/engagement/${engagementId}/home`);
  const legacyRegistration = host.register({
    schemaVersion: 'omnia.operation-registration/v1',
    featureId: 'omnia.recording',
    featureVersion: '0.4.18',
    operationPackage: legacyPackage
  }, liveBinding);
  const invoke = (registration: typeof legacyRegistration, featureVersion: string, operationId: string, request: Record<string, unknown>) => host.invoke({
    schemaVersion: 'omnia.operation-invocation/v1',
    featureId: 'omnia.recording',
    featureVersion,
    operationId,
    request: { connectorBinding: liveBinding, ...request },
    operationPackageDigest: registration.packageDigest,
    mutationAuthorized: false
  }, liveBinding, async () => { throw new Error('Page observation test must not invoke an HTTP route.'); }, observationContext(page));

  const opened = await invoke(legacyRegistration, '0.4.18', 'omnia.recording.observation.open.v1', {
    recordingId: '22222222-2222-4222-8222-222222222222'
  }) as any;
  const compatiblePackage = signedOperationUpgrade(legacyPackage, '0.4.19', 32, [legacyDigest]);
  assert.throws(() => host.register({
    schemaVersion: 'omnia.operation-registration/v1',
    featureId: 'omnia.recording',
    featureVersion: '0.4.19',
    operationPackage: compatiblePackage
  }, binding), /active page observation/);
  assert.equal((await invoke(legacyRegistration, '0.4.18', 'omnia.recording.observation.status.v1', {
    observationId: opened.observationId
  }) as any).state, 'observing');
  await invoke(legacyRegistration, '0.4.18', 'omnia.recording.observation.stop.v1', {
    observationId: opened.observationId
  });

  const compatible = host.register({
    schemaVersion: 'omnia.operation-registration/v1',
    featureId: 'omnia.recording',
    featureVersion: '0.4.19',
    operationPackage: compatiblePackage
  }, binding);
  const compatibleRepeat = host.register({
    schemaVersion: 'omnia.operation-registration/v1',
    featureId: 'omnia.recording',
    featureVersion: '0.4.19',
    operationPackage: compatiblePackage
  }, binding);
  assert.equal(compatibleRepeat.registrationToken, compatible.registrationToken);
  assert.deepEqual(compatibleRepeat.replacedPackageDigests, compatible.replacedPackageDigests);
  await assert.rejects(invoke(compatible, '0.4.19', 'omnia.recording.observation.status.v1', {
    observationId: opened.observationId
  }), /not the active registered package/);
  assert.equal((await invoke(legacyRegistration, '0.4.18', 'omnia.recording.observation.status.v1', {
    observationId: opened.observationId
  }) as any).state, 'stopped');
  (host as any).preparedRegistrations.get(compatible.registrationToken).expiresAt = 0;
  const compatibleAfterExpiry = host.register({
    schemaVersion: 'omnia.operation-registration/v1',
    featureId: 'omnia.recording',
    featureVersion: '0.4.19',
    operationPackage: compatiblePackage
  }, binding);
  assert.equal(compatibleAfterExpiry.registrationToken, compatible.registrationToken,
    'a durable prepared registration must retain its exact token after an in-memory TTL/prune attempt');
  const preparedRestart = new OperationHost(root);
  const recoveredPrepared = preparedRestart.register({
    schemaVersion: 'omnia.operation-registration/v1',
    featureId: 'omnia.recording',
    featureVersion: '0.4.19',
    operationPackage: compatiblePackage
  }, { ...binding, sessionGeneration: binding.sessionGeneration + 1 });
  assert.equal(recoveredPrepared.registrationState, 'prepared');
  assert.equal(recoveredPrepared.registrationToken, compatible.registrationToken,
    'Connector restart must restore the exact durable prepared token from the same signed package');
  assert.equal((await invoke(legacyRegistration, '0.4.18', 'omnia.recording.observation.status.v1', {
    observationId: opened.observationId
  }) as any).state, 'stopped');
  const registeredMap = (host as any).registered as Map<string, unknown>;
  const originalSet = registeredMap.set;
  let injectedRegistrationSetFailure = false;
  registeredMap.set = function (key: string, value: unknown) {
    if (!injectedRegistrationSetFailure && key === compatible.packageDigest) {
      injectedRegistrationSetFailure = true;
      throw new Error('injected registration map crash');
    }
    return originalSet.call(this, key, value);
  };
  assert.throws(() => host.register({
    schemaVersion: 'omnia.operation-registration-commit/v1',
    featureId: 'omnia.recording',
    featureVersion: '0.4.19',
    operationPackageDigest: compatible.packageDigest,
    registrationToken: compatibleAfterExpiry.registrationToken
  }, binding), /injected registration map crash/);
  registeredMap.set = originalSet;
  assert.equal((await invoke(legacyRegistration, '0.4.18', 'omnia.recording.observation.status.v1', {
    observationId: opened.observationId
  }) as any).state, 'stopped');
  const committed = host.register({
    schemaVersion: 'omnia.operation-registration-commit/v1',
    featureId: 'omnia.recording',
    featureVersion: '0.4.19',
    operationPackageDigest: compatible.packageDigest,
    registrationToken: compatibleAfterExpiry.registrationToken
  }, binding);
  assert.equal(committed.registrationState, 'committed');
  assert.equal(host.register({
    schemaVersion: 'omnia.operation-registration-commit/v1',
    featureId: 'omnia.recording',
    featureVersion: '0.4.19',
    operationPackageDigest: compatible.packageDigest,
    registrationToken: compatibleAfterExpiry.registrationToken
  }, binding).registrationState, 'committed');
  const recoveredCommittedRegistration = host.register({
    schemaVersion: 'omnia.operation-registration/v1',
    featureId: 'omnia.recording',
    featureVersion: '0.4.19',
    operationPackage: compatiblePackage
  }, binding);
  assert.equal(recoveredCommittedRegistration.registrationToken, compatibleAfterExpiry.registrationToken);
  assert.deepEqual(recoveredCommittedRegistration.replacedPackageDigests, [legacyRegistration.packageDigest]);
  const recovered = await invoke(compatible, '0.4.19', 'omnia.recording.observation.status.v1', {
    observationId: opened.observationId
  }) as any;
  assert.equal(recovered.state, 'stopped');
  assert.equal(recovered.streamId, opened.streamId);
  assert.equal((await invoke(legacyRegistration, '0.4.18', 'omnia.recording.observation.status.v1', {
    observationId: opened.observationId
  }) as any).state, 'stopped');
  host = new OperationHost(root);
  liveBinding = { ...binding, sessionGeneration: 8 };
  const recoveredAfterConnectorRestart = host.register({
    schemaVersion: 'omnia.operation-registration/v1',
    featureId: 'omnia.recording',
    featureVersion: '0.4.19',
    operationPackage: compatiblePackage
  }, liveBinding);
  assert.equal(recoveredAfterConnectorRestart.registrationToken, compatibleAfterExpiry.registrationToken);
  assert.deepEqual(recoveredAfterConnectorRestart.replacedPackageDigests, [legacyRegistration.packageDigest]);
  host.register({
    schemaVersion: 'omnia.operation-registration/v1',
    featureId: 'omnia.recording',
    featureVersion: '0.4.18',
    operationPackage: legacyPackage
  }, liveBinding);
  assert.equal((await invoke(compatible, '0.4.19', 'omnia.recording.observation.status.v1', {
    observationId: opened.observationId
  }) as any).state, 'stopped');
  assert.equal((await invoke(legacyRegistration, '0.4.18', 'omnia.recording.observation.status.v1', {
    observationId: opened.observationId
  }) as any).state, 'stopped');
  assert.equal((await invoke(compatible, '0.4.19', 'omnia.recording.observation.read-chunk.v1', {
    streamId: opened.streamId, offset: 0
  }) as any).eof, true);
  assert.equal((await invoke(legacyRegistration, '0.4.18', 'omnia.recording.observation.read-chunk.v1', {
    streamId: opened.streamId, offset: 0
  }) as any).eof, true);
  assert.throws(() => host.register({
    schemaVersion: 'omnia.operation-registration-abort/v1',
    featureId: 'omnia.recording',
    featureVersion: '0.4.19',
    operationPackageDigest: compatible.packageDigest,
    registrationToken: compatibleAfterExpiry.registrationToken
  }, { ...liveBinding, packId: 'other-pack' }), /scope or package identity/);
  const aborted = host.register({
    schemaVersion: 'omnia.operation-registration-abort/v1',
    featureId: 'omnia.recording',
    featureVersion: '0.4.19',
    operationPackageDigest: compatible.packageDigest,
    registrationToken: compatibleAfterExpiry.registrationToken
  }, liveBinding);
  assert.equal(aborted.registrationState, 'aborted');
  assert.deepEqual(aborted.replacedPackageDigests, [legacyRegistration.packageDigest]);
  assert.equal(host.register({
    schemaVersion: 'omnia.operation-registration-abort/v1',
    featureId: 'omnia.recording',
    featureVersion: '0.4.19',
    operationPackageDigest: compatible.packageDigest,
    registrationToken: compatibleAfterExpiry.registrationToken
  }, liveBinding).registrationState, 'aborted');
  host = new OperationHost(root);
  liveBinding = { ...binding, sessionGeneration: 9 };
  assert.equal(host.register({
    schemaVersion: 'omnia.operation-registration-abort/v1',
    featureId: 'omnia.recording',
    featureVersion: '0.4.19',
    operationPackageDigest: compatible.packageDigest,
    registrationToken: compatibleAfterExpiry.registrationToken
  }, liveBinding).registrationState, 'aborted');
  assert.throws(() => host.register({
    schemaVersion: 'omnia.operation-registration/v1',
    featureId: 'omnia.recording',
    featureVersion: '0.4.19',
    operationPackage: compatiblePackage
  }, liveBinding), /requires the exact source package/);
  host.register({
    schemaVersion: 'omnia.operation-registration/v1',
    featureId: 'omnia.recording',
    featureVersion: '0.4.18',
    operationPackage: legacyPackage
  }, liveBinding);
  await assert.rejects(invoke(compatible, '0.4.19', 'omnia.recording.observation.status.v1', {
    observationId: opened.observationId
  }), /not the active registered package/);
  assert.equal((await invoke(legacyRegistration, '0.4.18', 'omnia.recording.observation.status.v1', {
    observationId: opened.observationId
  }) as any).state, 'stopped');
  const replacementAfterAbort = host.register({
    schemaVersion: 'omnia.operation-registration/v1',
    featureId: 'omnia.recording',
    featureVersion: '0.4.19',
    operationPackage: compatiblePackage
  }, liveBinding);
  assert.equal(replacementAfterAbort.registrationState, 'prepared');
  const recommitted = host.register({
    schemaVersion: 'omnia.operation-registration-commit/v1',
    featureId: 'omnia.recording',
    featureVersion: '0.4.19',
    operationPackageDigest: compatible.packageDigest,
    registrationToken: replacementAfterAbort.registrationToken
  }, liveBinding);
  assert.equal(recommitted.registrationState, 'committed');
  const finalized = host.register({
    schemaVersion: 'omnia.operation-registration-finalize/v1',
    featureId: 'omnia.recording',
    featureVersion: '0.4.19',
    operationPackageDigest: compatible.packageDigest,
    registrationToken: replacementAfterAbort.registrationToken
  }, liveBinding);
  assert.equal(finalized.registrationState, 'committed');
  assert.equal(host.register({
    schemaVersion: 'omnia.operation-registration-finalize/v1',
    featureId: 'omnia.recording',
    featureVersion: '0.4.19',
    operationPackageDigest: compatible.packageDigest,
    registrationToken: replacementAfterAbort.registrationToken
  }, liveBinding).registrationToken, replacementAfterAbort.registrationToken);
  assert.throws(() => host.register({
    schemaVersion: 'omnia.operation-registration-abort/v1',
    featureId: 'omnia.recording',
    featureVersion: '0.4.19',
    operationPackageDigest: compatible.packageDigest,
    registrationToken: replacementAfterAbort.registrationToken
  }, liveBinding), /cannot be aborted/);
  await assert.rejects(invoke(legacyRegistration, '0.4.18', 'omnia.recording.observation.status.v1', {
    observationId: opened.observationId
  }), /not the active registered package/);

  const finalizedRestart = new OperationHost(root);
  assert.throws(() => finalizedRestart.register({
    schemaVersion: 'omnia.operation-registration/v1',
    featureId: 'omnia.recording',
    featureVersion: '0.4.18',
    operationPackage: legacyPackage
  }, { ...binding, sessionGeneration: 10 }), /high-water mark/);

  const changedAbiPackage = signedOperationUpgrade(compatiblePackage, '0.4.20', 33, [], '\n// ABI fingerprint drift\n');
  assert.throws(() => host.register({
    schemaVersion: 'omnia.operation-registration/v1',
    featureId: 'omnia.recording',
    featureVersion: '0.4.20',
    operationPackage: changedAbiPackage
  }, binding), /unavailable/);
  assert.equal((await invoke(compatible, '0.4.19', 'omnia.recording.observation.status.v1', {
    observationId: opened.observationId
  }) as any).state, 'stopped');

  const lowerSequencePackage = signedOperationUpgrade(compatiblePackage, '0.4.21', 31, []);
  assert.throws(() => host.register({
    schemaVersion: 'omnia.operation-registration/v1', featureId: 'omnia.recording',
    featureVersion: '0.4.21', operationPackage: lowerSequencePackage
  }, binding), /increase monotonically|high-water mark/);
  const equalSequencePackage = signedOperationUpgrade(compatiblePackage, '0.4.22', 32, []);
  assert.throws(() => host.register({
    schemaVersion: 'omnia.operation-registration/v1', featureId: 'omnia.recording',
    featureVersion: '0.4.22', operationPackage: equalSequencePackage
  }, binding), /increase monotonically|high-water mark/);
  const wrongSourcePackage = signedOperationUpgrade(
    legacyPackage, '0.4.23', 34, [`sha256:${'9'.repeat(64)}`], '', 'omnia.page-observation.other-family'
  );
  assert.throws(() => host.register({
    schemaVersion: 'omnia.operation-registration/v1',
    featureId: 'omnia.recording',
    featureVersion: '0.4.23',
    operationPackage: wrongSourcePackage
  }, binding), /unavailable/);
  await host.close();
  const finalizedLedgerFilename = path.join(
    root, 'operation-registration-ledger', `${replacementAfterAbort.registrationToken}.json`
  );
  fs.writeFileSync(finalizedLedgerFilename, '{"tampered":true}');
  const ledgerFailClosed = new OperationHost(root);
  assert.throws(() => ledgerFailClosed.register({
    schemaVersion: 'omnia.operation-registration/v1',
    featureId: 'omnia.recording',
    featureVersion: '0.4.19',
    operationPackage: compatiblePackage
  }, { ...binding, sessionGeneration: 11 }), /ledger failed integrity validation/);
  assert.equal(fs.existsSync(finalizedLedgerFilename), true, 'tampered registration ledger is not deleted');
});

test('Operation registration durably hands off no-owner packages only with exact known-zero resources', async () => {
  const repository = path.resolve(import.meta.dirname, '..');
  const outer = verifyOfficialPackage(JSON.parse(fs.readFileSync(
    path.join(repository, 'feature-packages', 'recording', 'candidates', 'recording-0.4.18.ofp'), 'utf8'
  )), 'omnia-feature');
  const sourcePackage = verifyOfficialPackage(
    JSON.parse(packageFile(outer, 'connector-capability/operation.ofop').toString('utf8')),
    'omnia-connector-operation'
  );
  const replacementPackage = signedOperationWithoutOwnerUpgrade(sourcePackage, '0.4.19', 32);

  const zeroRoot = tempRoot();
  let host = new OperationHost(zeroRoot);
  const source = host.register({
    schemaVersion: 'omnia.operation-registration/v1', featureId: 'omnia.recording',
    featureVersion: '0.4.18', operationPackage: sourcePackage
  }, binding);
  const prepared = host.register({
    schemaVersion: 'omnia.operation-registration/v1', featureId: 'omnia.recording',
    featureVersion: '0.4.19', operationPackage: replacementPackage
  }, binding);
  assert.equal(prepared.registrationState, 'prepared');
  assert.deepEqual(prepared.replacedPackageDigests, [source.packageDigest]);

  host = new OperationHost(zeroRoot);
  const restartedBinding = { ...binding, sessionGeneration: binding.sessionGeneration + 1 };
  const recovered = host.register({
    schemaVersion: 'omnia.operation-registration/v1', featureId: 'omnia.recording',
    featureVersion: '0.4.19', operationPackage: replacementPackage
  }, restartedBinding);
  assert.equal(recovered.registrationState, 'prepared');
  assert.equal(recovered.registrationToken, prepared.registrationToken);
  const committed = host.register({
    schemaVersion: 'omnia.operation-registration-commit/v1', featureId: 'omnia.recording',
    featureVersion: '0.4.19', operationPackageDigest: recovered.packageDigest,
    registrationToken: recovered.registrationToken
  }, restartedBinding);
  assert.equal(committed.registrationState, 'committed');
  const finalized = host.register({
    schemaVersion: 'omnia.operation-registration-finalize/v1', featureId: 'omnia.recording',
    featureVersion: '0.4.19', operationPackageDigest: recovered.packageDigest,
    registrationToken: recovered.registrationToken
  }, restartedBinding);
  assert.equal(finalized.registrationState, 'committed');

  const blockedRoot = tempRoot();
  const blockedHost = new OperationHost(blockedRoot);
  const blockedSource = blockedHost.register({
    schemaVersion: 'omnia.operation-registration/v1', featureId: 'omnia.recording',
    featureVersion: '0.4.18', operationPackage: sourcePackage
  }, binding);
  const page = new FakePage(`https://client.deloitteomnia.deloitte.com.cn/engagement/${engagementId}/home`);
  await blockedHost.invoke({
    schemaVersion: 'omnia.operation-invocation/v1', featureId: 'omnia.recording', featureVersion: '0.4.18',
    operationId: 'omnia.recording.observation.open.v1',
    request: { connectorBinding: binding, recordingId: '22222222-2222-4222-8222-222222222222' },
    operationPackageDigest: blockedSource.packageDigest, mutationAuthorized: false
  }, binding, async () => { throw new Error('unexpected HTTP invocation'); }, observationContext(page));
  assert.throws(() => blockedHost.register({
    schemaVersion: 'omnia.operation-registration/v1', featureId: 'omnia.recording',
    featureVersion: '0.4.19', operationPackage: replacementPackage
  }, binding), /blocked by durable resources/u);
});
