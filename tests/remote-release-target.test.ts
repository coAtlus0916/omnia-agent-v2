import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import {
  verifyRemoteConnectorArchiveTarget
} from '../scripts/verify-remote-release-target.ts';

const root = path.resolve(import.meta.dirname, '..');

async function archiveFixture(t: test.TestContext, bytes: Buffer) {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests += 1;
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': bytes.length
    });
    res.end(bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('archive fixture did not bind');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const fixtureUrl = `http://127.0.0.1:${address.port}/connector.zip`;
  const fetchImpl = ((_: string | URL | Request, init?: RequestInit) => fetch(fixtureUrl, init)) as typeof fetch;
  return { fetchImpl, requests: () => requests };
}

test('signed Remote Connector target ZIP is fetched and verified before manifest activation', async (t) => {
  const stable = JSON.parse(fs.readFileSync(path.join(root, 'remote-connector', 'public', 'stable.json'), 'utf8'));
  const archive = fs.readFileSync(path.join(
    root,
    'remote-connector',
    'public',
    'releases',
    stable.version,
    `Omnia-Agent-v5-Remote-Connector-v${stable.version}-Portable.zip`
  ));
  const fixture = await archiveFixture(t, archive);
  const verified = await verifyRemoteConnectorArchiveTarget(stable, fixture.fetchImpl);
  assert.equal(verified.version, stable.version);
  assert.equal(fixture.requests(), 1);

  const deploy = fs.readFileSync(path.join(root, 'scripts', 'deploy-remote-connector-release.mjs'), 'utf8');
  const stage = deploy.indexOf("install-release.py' stage");
  const targetPreflight = deploy.indexOf('verifyPublishedArchiveBeforeStable();');
  const activate = deploy.indexOf("install-release.py' activate");
  assert.ok(stage >= 0 && targetPreflight > stage && activate > targetPreflight);

  const installer = fs.readFileSync(path.join(root, 'ops', 'install_v5_remote_connector_release.py'), 'utf8');
  assert.ok(installer.indexOf('if mode == "stage"') < installer.indexOf('atomic_text(manifest_bytes, public_stable)'));
});

test('target ZIP verification fails closed for signature or archive mismatch', async (t) => {
  const stable = JSON.parse(fs.readFileSync(path.join(root, 'remote-connector', 'public', 'stable.json'), 'utf8'));
  const wrongArchive = Buffer.from('not-the-signed-archive');
  const fixture = await archiveFixture(t, wrongArchive);
  await assert.rejects(
    () => verifyRemoteConnectorArchiveTarget(stable, fixture.fetchImpl),
    /size or digest/
  );
  const invalidSignature = { ...stable, signature: Buffer.alloc(64).toString('base64') };
  const before = fixture.requests();
  await assert.rejects(
    () => verifyRemoteConnectorArchiveTarget(invalidSignature, fixture.fetchImpl),
    /signature is invalid/
  );
  assert.equal(fixture.requests(), before, 'invalid signed manifest must fail before any target download');
});
