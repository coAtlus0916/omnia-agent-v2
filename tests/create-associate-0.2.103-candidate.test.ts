import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { packageDigest, packageFile, verifyOfficialPackage } from '../src/main/features/official-package.ts';

const repository = path.resolve(import.meta.dirname, '..');
const featurePath = path.join(repository, 'feature-packages', 'create-associate', 'candidates', 'create-associate-0.2.103.ofp');
const operationPath = path.join(repository, 'feature-packages', 'create-associate', 'candidates', 'create-associate-operation-0.2.103.ofop');
const releasePython = path.join(repository, 'releases', 'runtime', 'python', 'cpython-3.13.14-embed-amd64', 'python.exe');

function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

test('0.2.103 is an immutable signed candidate with an identical standalone Operation and runnable self-test', (t) => {
  const featureBytes = fs.readFileSync(featurePath);
  const operationBytes = fs.readFileSync(operationPath);
  assert.equal(sha256(featureBytes), '93cadeabb44736b5aa053d32e78464b4d22691c8adc65fa1debb6dbaa6bfd65a');
  assert.equal(sha256(operationBytes), 'b69bf33e15a5c908ad848578d5259abbd24cdaf45d0821a0b68440ad2d1226bd');

  const feature = verifyOfficialPackage(JSON.parse(featureBytes.toString('utf8')), 'omnia-feature');
  assert.equal(feature.version, '0.2.103');
  assert.equal(feature.sequence, 105);
  assert.equal(packageDigest(feature), 'sha256:d5a63632bfd07716fa3480f134e614866b3c4c5c9105414bbffaa4cab5daa9a3');

  const embeddedOperationBytes = packageFile(feature, 'connector-capability/operation.ofop');
  assert.deepEqual(embeddedOperationBytes, operationBytes);
  const embeddedOperation = verifyOfficialPackage(JSON.parse(embeddedOperationBytes.toString('utf8')), 'omnia-connector-operation');
  const standaloneOperation = verifyOfficialPackage(JSON.parse(operationBytes.toString('utf8')), 'omnia-connector-operation');
  assert.equal(packageDigest(embeddedOperation), packageDigest(standaloneOperation));
  assert.equal(standaloneOperation.version, '0.2.103');

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-create-associate-0.2.103-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  for (const member of feature.files) {
    const target = path.resolve(temporary, ...member.path.split('/'));
    assert.equal(target.startsWith(`${temporary}${path.sep}`), true, `unsafe member path: ${member.path}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(member.contentBase64, 'base64'));
  }
  const selfTest = spawnSync(process.execPath, [path.join(temporary, 'tests', 'self-test.cjs')], {
    cwd: temporary,
    encoding: 'utf8',
    env: {
      ...process.env,
      OMNIA_PYTHON_EXECUTABLE: releasePython,
      OMNIA_MANAGED_PYTHON_EXECUTABLE: releasePython,
      PYTHONUTF8: '1',
      PYTHONDONTWRITEBYTECODE: '1'
    }
  });
  assert.equal(selfTest.status, 0, selfTest.stderr || selfTest.stdout);
  assert.match(selfTest.stdout, /package self-test passed \(5 declared checks; CPython 3\.13\.14\)/u);
});
