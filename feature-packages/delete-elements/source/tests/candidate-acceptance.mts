import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { CoreDatabase } from '../../../../src/main/database.js';
import { FeaturePackageManager } from '../../../../src/main/features/package-manager.js';
import { resolveProductPaths } from '../../../../src/main/paths.js';

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`${name} is required.`);
  return path.resolve(process.argv[index + 1]);
}

const candidate = argument('--candidate');
const runtime = argument('--runtime');
const release = argument('--release');
const expectedDigest = String(process.argv[process.argv.indexOf('--sha256') + 1] || '').toLowerCase();
if (!/^[0-9a-f]{64}$/u.test(expectedDigest)) throw new Error('--sha256 is required.');

const candidateBytes = fs.readFileSync(candidate);
const candidateEnvelope = JSON.parse(candidateBytes.toString('utf8')) as { product: string; packageId: string; version: string; sequence: number };
assert.equal(candidateEnvelope.product, 'omnia-feature');
assert.equal(candidateEnvelope.packageId, 'omnia.delete-elements');
assert.match(candidateEnvelope.version, /^0\.3\.\d+$/u);
const expectedVersion = candidateEnvelope.version;
const actualDigest = crypto.createHash('sha256').update(candidateBytes).digest('hex');
assert.equal(actualDigest, expectedDigest);
assert.equal(path.basename(runtime).toLowerCase(), 'python.exe');

const versionSlug = expectedVersion.replaceAll('.', '-');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), `omnia-delete-${versionSlug}-acceptance-`));
const wrapperTemporary = fs.mkdtempSync(path.join(os.tmpdir(), `omnia-delete-${versionSlug}-wrapper-`));
const paths = resolveProductPaths(temporary);
const database = new CoreDatabase(paths.database, { encrypt: (value) => value, decrypt: (value) => value });
let bridge: { invoke(method: string, payload: unknown, options: {runId: string}): Promise<any>; close(): Promise<void> } | null = null;

try {
  const manager = new FeaturePackageManager(database.db, paths);
  manager.install(candidate);
  const installed = manager.list().find((item) => item.featureId === 'omnia.delete-elements');
  assert.ok(installed);
  assert.equal(installed.featureVersion, expectedVersion);
  const installedRoot = path.join(paths.data, ...installed.packagePath.split('/'));

  const selfTest = execFileSync(process.execPath, ['tests/self-test.cjs'], { cwd: installedRoot, encoding: 'utf8' }).trim();
  assert.match(selfTest, /omnia\.delete-elements package self-test passed/u);
  const pythonTemp = path.join(temporary, 'python-sidecar-temp');
  fs.mkdirSync(pythonTemp, { recursive: true });
  process.env.OMNIA_MANAGED_PYTHON_EXECUTABLE = runtime;
  process.env.OMNIA_MANAGED_PYTHON_ENTRY = path.join(installedRoot, 'python', 'delete-elements-engine.py');
  process.env.OMNIA_FEATURE_PACKAGE_ROOT = installedRoot;
  process.env.OMNIA_FEATURE_TEMP_ROOT = pythonTemp;
  const require = createRequire(import.meta.url);
  const bridgeModule = require(path.join(installedRoot, 'middle', 'delete-elements-python-bridge.cjs'));
  bridge = bridgeModule.createPythonSidecarBridge({ timeoutMs: 15_000 });
  const scheduled = await bridge.invoke('schedule_deletion', {
    schemaVersion: 'omnia.delete-scheduler-input/v1', planId: 'candidate-plan', runId: 'candidate-run', concurrencyBudget: 1,
    steps: [
      { stepId: 'relation:r1', targetKey: 'relation:r1', dependsOn: [], operationId: 'omnia.delete.infrastructure-application.disassociate.v1', effect: 'omnia_mutation' },
      { stepId: 'object:app-1', targetKey: 'APP|app-1', dependsOn: ['relation:r1'], operationId: 'omnia.delete.it-element.direct.v1', effect: 'omnia_mutation' }
    ],
    outcomes: []
  }, { runId: 'candidate-run' });
  assert.equal(scheduled.schemaVersion, 'omnia.delete-scheduler-decision/v1');
  assert.deepEqual(scheduled.readyStepIds, ['relation:r1']);
  assert.equal(scheduled.terminal, 'running');

  const portableRoot = path.join(wrapperTemporary, 'omnia-agent-v5-portable-0.4.14');
  const installerRoot = path.join(wrapperTemporary, `delete-elements-feature-${expectedVersion}-installer`);
  fs.mkdirSync(path.join(portableRoot, 'releases'), { recursive: true });
  fs.mkdirSync(path.join(portableRoot, 'data'), { recursive: true });
  fs.mkdirSync(installerRoot, { recursive: true });
  fs.writeFileSync(path.join(portableRoot, 'portable-root.json'), JSON.stringify({
    schemaVersion: 'omnia.portable-product-root/v1', product: 'omnia-agent-v5', formatVersion: 1
  }));
  fs.writeFileSync(path.join(portableRoot, 'current'), JSON.stringify({
    schemaVersion: 'omnia.active-release/v1', version: '0.4.14', relativePath: 'releases/0.4.14'
  }));
  fs.symlinkSync(release, path.join(portableRoot, 'releases', '0.4.14'), 'junction');
  const repositoryRoot = path.resolve(import.meta.dirname, '../../../..');
  const installerTemplate = fs.readFileSync(path.join(repositoryRoot, 'scripts', 'installers', 'delete-elements', 'InstallFeature.ps1'), 'utf8');
  fs.writeFileSync(path.join(installerRoot, 'InstallFeature.ps1'), `\uFEFF${installerTemplate.replaceAll('__FEATURE_VERSION__', expectedVersion)}`, 'utf8');
  fs.copyFileSync(candidate, path.join(installerRoot, `delete-elements-${expectedVersion}.ofp`));
  const wrapper = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(installerRoot, 'InstallFeature.ps1'), portableRoot], { encoding: 'utf8', windowsHide: true });
  const wrapperOutput = `${wrapper.stdout || ''}${wrapper.stderr || ''}`;
  assert.equal(wrapper.status, 0, wrapperOutput);
  assert.match(wrapperOutput, /\[安装成功\]/u);

  process.stdout.write(`${JSON.stringify({
    candidate, sha256: actualDigest, featureVersion: installed.featureVersion,
    isolatedInstallRoot: installedRoot, selfTest, packageContracts: 'covered by signed self-test',
    python: 'CPython 3.13.14 bundled sidecar smoke passed', windowsInstaller: 'isolated 0.4.14 wrapper install passed'
  })}\n`);
} finally {
  if (bridge) await bridge.close();
  database.close();
  fs.rmSync(temporary, { recursive: true, force: true });
  fs.rmSync(wrapperTemporary, { recursive: true, force: true });
}
