import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(import.meta.dirname, '..');
const productRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-agent-v5-portable-0.4.1-'));
const portableArtifact = path.join(root, 'artifacts', 'omnia-agent-v5-portable-0.4.1');
const releaseTarget = path.join(productRoot, 'releases', '0.4.1');
const evidenceRoot = path.join(root, 'acceptance', 'shell-0.4.1-portable');
if (!fs.existsSync(portableArtifact)) throw new Error('Packaged portable artifact directory is missing. Run npm run package:windows first.');
fs.cpSync(path.join(portableArtifact, 'releases'), path.join(productRoot, 'releases'), { recursive: true });
fs.cpSync(path.join(portableArtifact, 'data'), path.join(productRoot, 'data'), { recursive: true });
fs.copyFileSync(path.join(portableArtifact, 'portable-root.json'), path.join(productRoot, 'portable-root.json'));
fs.copyFileSync(path.join(portableArtifact, 'current'), path.join(productRoot, 'current'));
const app = await electron.launch({ executablePath: path.join(releaseTarget, 'Omnia Agent v5.exe'), env: { ...process.env, OMNIA_AGENT_PRODUCT_ROOT: productRoot } });
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.omnia), undefined, { timeout: 20_000 });
  const snapshot = await page.evaluate(() => window.omnia.getSnapshot());
  if (snapshot.productVersion !== '0.4.1') throw new Error('portable productVersion mismatch');
  if (!snapshot.features.navigation.some((leaf) => leaf.featureId === 'omnia.recording' && leaf.featureVersion === '0.1.1')) throw new Error('portable recording 0.1.1 builtin missing');
  if (snapshot.features.navigation.some((leaf) => leaf.featureId === 'omnia.delete-elements')) throw new Error('clean portable root unexpectedly bundled post-install delete-elements');
  if (snapshot.features.groups.filter((group) => group.id === 'other' && group.label === '其他').length !== 1) throw new Error('portable other group mismatch');
  fs.mkdirSync(evidenceRoot, { recursive: true });
  await page.screenshot({ path: path.join(evidenceRoot, 'clean-data-root.png') });
  const report = {
    ok: true,
    productVersion: snapshot.productVersion,
    cleanDataRoot: true,
    sourceArtifact: 'artifacts/omnia-agent-v5-portable-0.4.1',
    navigation: snapshot.features.navigation.map((leaf) => `${leaf.featureId}@${leaf.featureVersion}`),
    dataOutsideRelease: fs.existsSync(path.join(productRoot, 'data', 'stores', 'core.sqlite')),
    immutableRelease: fs.existsSync(path.join(root, 'releases', '0.4.0')) && fs.existsSync(path.join(root, 'releases', '0.4.1')),
    screenshot: 'acceptance/shell-0.4.1-portable/clean-data-root.png'
  };
  fs.writeFileSync(path.join(evidenceRoot, 'portable-smoke-report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await app.close();
  fs.rmSync(productRoot, { recursive: true, force: true });
}
