import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const [portableRootArgument, expectation, screenshotArgument] = process.argv.slice(2);
if (!portableRootArgument || !['empty', 'feature-disabled', 'feature-installed'].includes(expectation) || !screenshotArgument) {
  throw new Error('Usage: portable-ui-acceptance ROOT empty|feature-disabled|feature-installed SCREENSHOT');
}
const portableRoot = path.resolve(portableRootArgument);
const marker = JSON.parse(fs.readFileSync(path.join(portableRoot, 'portable-root.json'), 'utf8'));
if (marker.product !== 'omnia-agent-v5') throw new Error('Portable root identity mismatch.');
const current = JSON.parse(fs.readFileSync(path.join(portableRoot, 'current'), 'utf8'));
const executable = path.join(portableRoot, ...String(current.relativePath).split('/'), 'Omnia Agent v5.exe');
const screenshot = path.resolve(screenshotArgument);
fs.mkdirSync(path.dirname(screenshot), { recursive: true });

const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen({ host: '127.0.0.1', port: 0 }, () => {
    const address = server.address();
    const selected = typeof address === 'object' && address ? address.port : 0;
    server.close((error) => error ? reject(error) : resolve(selected));
  });
});
const childEnvironment = { ...process.env };
delete childEnvironment.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, [`--remote-debugging-port=${port}`], {
  cwd: portableRoot,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: childEnvironment
});
let childError = '';
child.stderr?.on('data', (chunk) => { childError += chunk.toString(); });
let browser;
try {
  const deadline = Date.now() + 30_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch { /* startup in progress */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error(`Packaged Electron DevTools endpoint did not become ready. ${childError}`);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  let page;
  const pageDeadline = Date.now() + 20_000;
  while (!page && Date.now() < pageDeadline) {
    page = browser.contexts().flatMap((context) => context.pages())
      .find((candidate) => candidate.url().startsWith('file:'));
    if (!page) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!page) throw new Error('Packaged Shell page was not found.');
  await page.waitForFunction(() => Boolean(window.omnia), undefined, { timeout: 20_000 });
  const before = await page.evaluate(() => window.omnia.getSnapshot());
  if (expectation === 'empty') {
    if (before.features.navigation.length !== 0 || before.featureCount !== 0) {
      throw new Error('Fresh baseline exposed a Feature before controlled install.');
    }
  } else if (expectation === 'feature-disabled') {
    if (
      before.features.navigation.length !== 1
      || before.features.navigation[0]?.availability !== 'disabled'
      || before.featureCount !== 0
    ) throw new Error('Installed candidate was not represented as one disabled navigation entry.');
    await page.getByRole('button', { name: '删除元素' }).click();
    await page.waitForFunction(() => window.omnia.getSnapshot().then((value) => value.features.surface?.status === 'blocked'));
  } else {
    if (
      before.features.navigation.length !== 1
      || before.features.navigation[0]?.availability !== 'available'
      || before.featureCount !== 1
    ) throw new Error('Installed Feature did not activate as one available navigation entry.');
    await page.getByRole('button', { name: '删除元素' }).click();
    await page.waitForFunction(() => window.omnia.getSnapshot().then((value) =>
      value.features.surface?.status === 'blocked'
      && /连接 Omnia Pack/.test(value.features.surface?.statusMessage || '')
    ));
    const installed = await page.evaluate(() => window.omnia.getSnapshot());
    if (/隔离|canary/i.test(installed.features.surface?.statusMessage || '')) {
      throw new Error('Installed Feature exposed a stale isolation/canary block reason.');
    }
  }
  await page.screenshot({ path: screenshot, fullPage: true });
  const after = await page.evaluate(() => window.omnia.getSnapshot());
  process.stdout.write(`${JSON.stringify({
    expectation,
    productVersion: after.productVersion,
    activeFeatureCount: after.featureCount,
    navigation: after.features.navigation.map((entry) => ({
      featureId: entry.featureId,
      featureVersion: entry.featureVersion,
      availability: entry.availability
    })),
    surfaceStatus: after.features.surface?.status || null,
    surfaceStatusMessage: after.features.surface?.statusMessage || '',
    screenshot
  }, null, 2)}\n`);
  await page.close();
} finally {
  await browser?.close().catch(() => undefined);
  if (child.exitCode === null) child.kill();
}
