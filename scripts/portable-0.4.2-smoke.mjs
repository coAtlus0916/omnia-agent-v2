import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(import.meta.dirname, '..');
const productRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-agent-v5-portable-0.4.2-'));
const artifact = path.join(root, 'artifacts', 'omnia-agent-v5-portable-0.4.2');
const release = path.join(productRoot, 'releases', '0.4.2');
const evidenceRoot = path.join(root, 'acceptance', 'shell-0.4.2-portable');
if (!fs.existsSync(artifact)) throw new Error('Run npm run package:windows first.');
fs.cpSync(path.join(artifact, 'releases'), path.join(productRoot, 'releases'), { recursive: true });
fs.cpSync(path.join(artifact, 'data'), path.join(productRoot, 'data'), { recursive: true });
for (const name of ['portable-root.json', 'current']) fs.copyFileSync(path.join(artifact, name), path.join(productRoot, name));
const app = await electron.launch({ executablePath: path.join(release, 'Omnia Agent v5.exe'), env: { ...process.env, OMNIA_AGENT_PRODUCT_ROOT: productRoot } });
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.omnia), undefined, { timeout: 20_000 });
  const snapshot = await page.evaluate(() => window.omnia.getSnapshot());
  if (snapshot.productVersion !== '0.4.2') throw new Error('portable productVersion mismatch');
  if (snapshot.connection.transport !== 'remote' || snapshot.connection.adapter !== 'v5_remote_connector') throw new Error('portable is not Remote-only');
  if (!snapshot.features.navigation.some((leaf) => leaf.featureId === 'omnia.recording' && leaf.featureVersion === '0.1.1')) throw new Error('recording builtin missing');
  if (snapshot.features.navigation.some((leaf) => leaf.featureId === 'omnia.delete-elements')) throw new Error('clean root bundled post-install delete-elements');
  if (fs.existsSync(path.join(release, 'resources', 'app', 'dist', 'main', 'connector.cjs'))) throw new Error('Shell-local connector subprocess was packaged');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const settingsLabels = await page.locator('[aria-label="设置导航"] button').allTextContents();
  if (settingsLabels.join('|') !== 'AI 设置|安全锁') throw new Error(`unexpected Settings navigation: ${settingsLabels.join('|')}`);
  fs.mkdirSync(evidenceRoot, { recursive: true });
  await page.screenshot({ path: path.join(evidenceRoot, 'clean-data-root.png') });
  const report = {
    ok: true,
    productVersion: snapshot.productVersion,
    transport: snapshot.connection.transport,
    localSubprocessAbsent: true,
    navigation: snapshot.features.navigation.map((leaf) => `${leaf.featureId}@${leaf.featureVersion}`),
    dataOutsideRelease: fs.existsSync(path.join(productRoot, 'data', 'stores', 'core.sqlite')),
    oldReleasePreserved: fs.existsSync(path.join(root, 'releases', '0.4.1')),
    settingsLabels
  };
  fs.writeFileSync(path.join(evidenceRoot, 'portable-smoke-report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await app.close();
  fs.rmSync(productRoot, { recursive: true, force: true });
}
