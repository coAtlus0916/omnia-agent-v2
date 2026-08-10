import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(import.meta.dirname, '..');
const version = '0.4.3';
const productRoot = fs.mkdtempSync(path.join(os.tmpdir(), `omnia-agent-v5-portable-${version}-`));
const artifact = path.join(root, 'artifacts', `omnia-agent-v5-portable-${version}`);
const release = path.join(productRoot, 'releases', version);
const evidenceRoot = path.join(root, 'acceptance', `shell-${version}-portable`);
const sha256 = (filename) => `sha256:${crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex')}`;
const assert = (condition, message) => { if (!condition) throw new Error(message); };

if (!fs.existsSync(artifact)) throw new Error('Run npm run package:windows first.');
fs.cpSync(path.join(artifact, 'releases'), path.join(productRoot, 'releases'), { recursive: true });
fs.cpSync(path.join(artifact, 'data'), path.join(productRoot, 'data'), { recursive: true });
for (const name of ['portable-root.json', 'current']) fs.copyFileSync(path.join(artifact, name), path.join(productRoot, name));

const app = await electron.launch({
  executablePath: path.join(release, 'Omnia Agent v5.exe'),
  env: { ...process.env, OMNIA_AGENT_PRODUCT_ROOT: productRoot }
});
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.omnia), undefined, { timeout: 20_000 });
  const snapshot = await page.evaluate(() => window.omnia.getSnapshot());
  assert(snapshot.productVersion === version, 'portable productVersion mismatch');
  assert(snapshot.connection.transport === 'remote' && snapshot.connection.adapter === 'v5_remote_connector', 'portable is not Remote-only');
  assert(snapshot.features.navigation.some((leaf) => leaf.featureId === 'omnia.recording' && leaf.featureVersion === '0.1.1'), 'recording builtin missing');
  const createLeaf = snapshot.features.navigation.find((leaf) => leaf.featureId === 'omnia.create-associate');
  assert(createLeaf?.featureVersion === '0.1.0', 'create-associate builtin missing');
  assert(createLeaf.availability === 'available', `offline create-associate is unavailable: ${createLeaf.reason || ''}`);
  assert(!snapshot.features.navigation.some((leaf) => leaf.featureId === 'omnia.delete-elements'), 'clean root bundled post-install delete-elements');
  assert(!fs.existsSync(path.join(release, 'resources', 'app', 'dist', 'main', 'connector.cjs')), 'Shell-local connector subprocess was packaged');

  const selected = await page.evaluate(() => window.omnia.selectFeature({ featureId: 'omnia.create-associate' }));
  assert(selected.features.selectedFeatureId === 'omnia.create-associate', 'create-associate Surface was not selected');
  assert(selected.features.surface?.surfaceId === 'create-associate.workbench', 'create-associate workbench Surface missing');
  assert(selected.features.surface.actions.some((action) => action.actionId === 'import-source-workbook' && action.enabled), 'offline workbook import action is not enabled');
  assert(selected.features.surface.actions.some((action) => action.actionId === 'prepare-return' && !action.enabled), 'return action must remain disabled before a validated plan');

  fs.mkdirSync(evidenceRoot, { recursive: true });
  await page.screenshot({ path: path.join(evidenceRoot, 'create-associate-clean-root.png'), fullPage: true });
  const builtinPath = path.join(release, 'resources', 'app', 'builtins', 'create-associate-0.1.0.ofp');
  const report = {
    ok: true,
    productVersion: snapshot.productVersion,
    transport: snapshot.connection.transport,
    localSubprocessAbsent: true,
    createAssociateOfflineAvailable: true,
    returnInitiallyDisabled: true,
    navigation: snapshot.features.navigation.map((leaf) => `${leaf.featureId}@${leaf.featureVersion}`),
    dataOutsideRelease: fs.existsSync(path.join(productRoot, 'data', 'stores', 'core.sqlite')),
    oldReleasePreserved: fs.existsSync(path.join(root, 'releases', '0.4.2')),
    bundledCreateAssociate: { path: 'resources/app/builtins/create-associate-0.1.0.ofp', sha256: sha256(builtinPath) }
  };
  fs.writeFileSync(path.join(evidenceRoot, 'portable-smoke-report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await app.close();
  fs.rmSync(productRoot, { recursive: true, force: true });
}
