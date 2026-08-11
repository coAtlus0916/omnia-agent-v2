import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { WebSocket } from 'ws';
import { DatabaseSync } from 'node:sqlite';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(import.meta.dirname, '..');
const evidenceRoot = path.join(root, 'acceptance', 'shell-0.4.2-ui-regression');
const productRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-agent-v5-ui-regression-'));
const executablePath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'Electron');
const deletePackage = path.join(root, 'feature-packages', 'delete-elements', 'candidates', 'delete-elements-0.1.2.ofp');
fs.mkdirSync(evidenceRoot, { recursive: true });
fs.writeFileSync(path.join(productRoot, 'portable-root.json'), JSON.stringify({
  schemaVersion: 'omnia.portable-product-root/v1', product: 'omnia-agent-v5', formatVersion: 1
}));
const install = spawnSync(process.execPath, [path.join(root, 'dist', 'tools', 'feature-installer.cjs'), '--root', productRoot, 'install', deletePackage], { encoding: 'utf8' });
if (install.status !== 0) throw new Error(`delete-elements install failed: ${install.stderr || install.stdout}`);

const bridgePort = await new Promise((resolve, reject) => {
  const server = net.createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const address = server.address(); const port = typeof address === 'object' && address ? address.port : 0; server.close((error) => error ? reject(error) : resolve(port)); });
});
const bridgeUrl = `http://127.0.0.1:${bridgePort}/`;
const bridgeProcess = spawn(process.execPath, [path.join(root, 'dist', 'bridge', 'server.cjs')], { cwd: productRoot, windowsHide: true, stdio: 'ignore', env: {
  ...process.env, NODE_ENV: 'test', OMNIA_V5_BRIDGE_HOST: '127.0.0.1', OMNIA_V5_BRIDGE_PORT: String(bridgePort),
  OMNIA_V5_BRIDGE_TOKEN_SECRET: 'ui-acceptance-bridge-secret-at-least-32-bytes', OMNIA_V5_BRIDGE_STATE_PATH: path.join(productRoot, 'bridge-bindings.json')
} });
for (const deadline = Date.now() + 15_000;;) {
  try { if ((await fetch(`${bridgeUrl}v1/health`)).ok) break; } catch { /* wait */ }
  if (Date.now() >= deadline) throw new Error('UI acceptance Bridge did not start.');
  await new Promise((resolve) => setTimeout(resolve, 100));
}
const acceptanceDatabase = new DatabaseSync(path.join(productRoot, 'data', 'stores', 'core.sqlite'));
acceptanceDatabase.prepare(`UPDATE remote_binding_settings SET bridge_url=? WHERE singleton=1`).run(bridgeUrl);
acceptanceDatabase.close();
const launch = () => electron.launch({ executablePath, args: [root], env: {
  ...process.env, NODE_ENV: 'test', OMNIA_AGENT_PRODUCT_ROOT: productRoot, OMNIA_V5_REMOTE_BRIDGE_URL: bridgeUrl
} });
const within = (child, parent) => child.x >= parent.x - 1 && child.y >= parent.y - 1
  && child.x + child.width <= parent.x + parent.width + 1
  && child.y + child.height <= parent.y + parent.height + 1;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const boxes = async (page) => page.evaluate(() => {
  const rect = (selector) => {
    const value = document.querySelector(selector)?.getBoundingClientRect();
    return value ? { x: value.x, y: value.y, width: value.width, height: value.height } : null;
  };
  return {
    host: rect('.host-content'), textarea: rect('[data-testid=comments-textarea]'),
    attachment: rect('[data-testid=comments-attachment]'), send: rect('[data-testid=comments-send]')
  };
});
const assertComposer = async (page, label) => {
  const value = await boxes(page);
  assert(value.host && value.textarea && value.attachment && value.send, `${label}: composer controls missing`);
  assert(value.textarea.width > 120 && value.textarea.height >= 88, `${label}: textarea is clipped`);
  assert(within(value.textarea, value.host) && within(value.attachment, value.host) && within(value.send, value.host), `${label}: composer is outside host`);
  return value;
};
const waitSurfaceManager = async (page, count) => {
  await page.waitForFunction(async (expected) => (await window.omnia.getSurfaceManagerSnapshot?.())?.attachedInstanceIds.length === expected, count);
  return page.evaluate(() => window.omnia.getSurfaceManagerSnapshot?.());
};
const captureCompositedShellWindow = async (app, outputPath) => {
  const capture = await app.evaluate(async ({ BrowserWindow, desktopCapturer }) => {
    const shellWindow = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/index.html'));
    if (!shellWindow || shellWindow.isDestroyed()) throw new Error('Shell BrowserWindow is unavailable for native capture.');
    const targetSourceId = shellWindow.getMediaSourceId();
    const [width, height] = shellWindow.getSize();
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: Math.max(1, width), height: Math.max(1, height) },
      fetchWindowIcons: false
    });
    const source = sources.find((candidate) => candidate.id === targetSourceId);
    if (!source) throw new Error(`desktopCapturer did not return Shell source ${targetSourceId}.`);
    return {
      sourceId: source.id,
      targetSourceId,
      sourceName: source.name,
      shellTitle: shellWindow.getTitle(),
      pngDataUrl: source.thumbnail.toDataURL(),
      thumbnailSize: source.thumbnail.getSize()
    };
  });
  assert(capture.sourceId === capture.targetSourceId, 'native capture source is not the Shell BrowserWindow');
  assert(capture.sourceName === capture.shellTitle, `native capture title drifted: ${capture.sourceName} != ${capture.shellTitle}`);
  const prefix = 'data:image/png;base64,';
  assert(capture.pngDataUrl.startsWith(prefix), 'desktopCapturer did not return PNG data');
  const bytes = Buffer.from(capture.pngDataUrl.slice(prefix.length), 'base64');
  assert(bytes.length > 10_000 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'native Shell screenshot is empty or not a PNG');
  assert(capture.thumbnailSize.width > 0 && capture.thumbnailSize.height > 0, 'native Shell screenshot has empty geometry');
  fs.writeFileSync(outputPath, bytes);
  return { sourceId: capture.sourceId, sourceName: capture.sourceName, bytes: bytes.length, ...capture.thumbnailSize };
};

let app = await launch();
let connectorSocket = null;
try {
  let page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.omnia), undefined, { timeout: 20_000 });
  const navigation = page.getByLabel('FeatureNavigation', { exact: true });
  await navigation.getByRole('button', { name: '录制' }).waitFor();
  await navigation.getByRole('button', { name: '删除元素' }).waitFor();

  const registry = await page.evaluate(async () => {
    const snapshot = await window.omnia.getSnapshot();
    return {
      productVersion: snapshot.productVersion,
      otherGroups: snapshot.features.groups.filter((group) => group.id === 'other'),
      otherLeaves: snapshot.features.navigation.filter((leaf) => leaf.parentId === 'other').map((leaf) => `${leaf.featureId}@${leaf.featureVersion}`)
    };
  });
  assert(registry.productVersion === '0.4.2', 'Shell product version is not 0.4.2');
  assert(registry.otherGroups.length === 1 && registry.otherGroups[0].label === '其他', 'other group was not merged exactly once');
  assert(registry.otherLeaves.includes('omnia.recording@0.1.1') && registry.otherLeaves.includes('omnia.delete-elements@0.1.2'), 'expected Feature leaves are missing');
  await page.screenshot({ path: path.join(evidenceRoot, 'other-group-recording-delete.png') });

  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  const pairingCode = await page.locator('[data-testid=remote-pairing-code]').textContent();
  assert(Boolean(pairingCode), 'top Connect did not produce a link code');
  const connectorId = 'v5-connector-ui-acceptance';
  const pairResponse = await fetch(`${bridgeUrl}v1/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    schemaVersion: 'omnia.v5.bridge/v1', role: 'connector', pairingCode, name: 'UI acceptance workstation', connectorId,
    connectorVersion: '0.3.5', platform: 'win32-x64', product: 'omnia-agent-v5', protocol: 'omnia.v5.remote-connector/v2'
  }) });
  const paired = await pairResponse.json();
  assert(pairResponse.ok && paired.token, 'Connector could not consume link code');
  connectorSocket = new WebSocket(`${bridgeUrl.replace(/^http/, 'ws')}v1/connect`, { headers: { Authorization: `Bearer ${paired.token}`,
    'X-Omnia-Protocol': 'omnia.v5.remote-connector/v2', 'X-Omnia-Connector-Id': connectorId, 'X-Omnia-Connector-Version': '0.3.5' } });
  await new Promise((resolve, reject) => { connectorSocket.once('open', resolve); connectorSocket.once('error', reject); });
  connectorSocket.on('message', (data) => {
    const envelope = JSON.parse(data.toString()); if (envelope.kind !== 'command') return;
    const connected = { status: 'connected', connected: true, connecting: false, connectorId, connectorName: 'UI acceptance workstation', connectorVersion: '0.3.5', sessionGeneration: 1,
      engagementId: '11111111-1111-4111-8111-111111111111', engagementName: 'UI Acceptance Pack', clientName: 'Acceptance', checkedAt: new Date().toISOString(), message: 'Remote Pack connected' };
    const value = envelope.request.operation === 'operation_register' ? {
      schemaVersion: 'omnia.operation-registration-result/v1', featureId: envelope.request.payload.featureId,
      featureVersion: envelope.request.payload.featureVersion, packageId: envelope.request.payload.operationPackage?.packageId || 'ui.acceptance.operation',
      packageDigest: 'sha256:ui-acceptance', operationIds: (envelope.request.payload.operationPackage?.operations || []).map((item) => item.operationId)
    } : envelope.request.operation === 'workspace_light_read' ? { schemaVersion: 'omnia.workspace-light-read/v1', profile: 'workspace_light_read', authorityId: 'ui-acceptance',
      engagementId: connected.engagementId, source: 'ui_acceptance_remote_connector', sections: [{ id: '22222222-2222-4222-8222-222222222222', name: 'Acceptance Section', order: 0 }],
      workspaces: [{ id: '33333333-3333-4333-8333-333333333333', parentSectionId: '22222222-2222-4222-8222-222222222222', name: 'Acceptance Workspace', status: 'active' }] } : connected;
    connectorSocket.send(JSON.stringify({ schemaVersion: 'omnia.v5.bridge/v1', kind: 'result', response: { schemaVersion: 'omnia.connector-ipc/v1', id: envelope.request.id, ok: true, value } }));
  });
  for (const deadline = Date.now() + 30_000;;) {
    const current = await page.evaluate(() => window.omnia.pollRemotePairing());
    if (current.settings.connection.remotePaired && current.connection.connected) break;
    if (Date.now() >= deadline) throw new Error(`automatic pairing/connect did not settle: ${JSON.stringify(current)}`);
    await page.waitForTimeout(250);
  }
  await page.locator('[data-testid=remote-connection-dialog]').getByRole('button', { name: '关闭', exact: true }).click();
  const runtimeAfterConnect = await page.evaluate(async () => { const value = await window.omnia.getSnapshot(); return { binding: value.settings.connection, connection: value.connection, leaves: value.features.navigation.map((leaf) => ({ id: leaf.featureId, availability: leaf.availability, reason: leaf.reason })) }; });
  assert(runtimeAfterConnect.leaves.every((leaf) => leaf.availability === 'available'), `Feature runtimes did not recover after Remote pairing: ${JSON.stringify(runtimeAfterConnect)}`);

  const geometry100 = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    devicePixelRatio: window.devicePixelRatio,
    railWidth: document.querySelector('.rail')?.getBoundingClientRect().width || 0,
    brandFont: getComputedStyle(document.querySelector('.brand-mark')).fontSize,
    uiScaleToken: getComputedStyle(document.querySelector('.app-frame')).getPropertyValue('--ui-scale').trim()
  }));
  await page.screenshot({ path: path.join(evidenceRoot, 'shell-100-percent.png') });
  await page.getByRole('button', { name: '放大' }).click();
  await page.waitForFunction(async () => (await window.omnia.getSnapshot()).preference.uiScalePercent === 105);
  await page.waitForFunction(() => window.devicePixelRatio > 1.01);
  const geometry105 = await page.evaluate(() => ({ innerWidth: window.innerWidth, devicePixelRatio: window.devicePixelRatio, railWidth: document.querySelector('.rail')?.getBoundingClientRect().width || 0 }));
  assert(geometry105.devicePixelRatio > geometry100.devicePixelRatio, '105% did not change the real Electron rendering scale');
  await page.screenshot({ path: path.join(evidenceRoot, 'shell-105-percent.png') });
  await page.getByRole('button', { name: '重置缩放' }).click();
  await page.waitForFunction(async () => (await window.omnia.getSnapshot()).preference.uiScalePercent === 100);

  await navigation.getByRole('button', { name: '录制' }).click();
  await page.locator('.feature-surface-frame').waitFor();
  const recordingInstance = await page.locator('.feature-surface-frame').getAttribute('data-surface-instance-id');
  let manager = await waitSurfaceManager(page, 1);
  assert(manager.attachedInstanceIds[0] === recordingInstance, 'recording native view is not the sole attached view');

  await page.getByRole('button', { name: 'Comments' }).click();
  await assertComposer(page, 'comments-expanded');
  manager = await waitSurfaceManager(page, 0);
  assert(manager.activeInstanceId === null, 'Comments did not clear active native view');
  const sentText = `native-click-proof-${Date.now()}`;
  await page.locator('[data-testid=comments-textarea]').fill(sentText);
  await page.locator('[data-testid=comments-send]').click();
  await page.getByText(sentText, { exact: true }).waitFor();
  assert((await page.evaluate(async (expected) => (await window.omnia.getSnapshot()).chat.messages.some((message) => message.content === expected), sentText)) === true, 'Comments send did not reach the real chat store');
  await page.screenshot({ path: path.join(evidenceRoot, 'comments-menu-expanded.png') });

  await page.locator('.collapse-button').click();
  await page.waitForFunction(() => document.querySelector('.feature-navigation')?.classList.contains('collapsed'));
  await assertComposer(page, 'comments-collapsed');
  await waitSurfaceManager(page, 0);
  await page.screenshot({ path: path.join(evidenceRoot, 'comments-menu-collapsed.png') });
  await page.locator('.collapse-button').click();

  await navigation.getByRole('button', { name: '录制' }).click();
  await page.locator('.feature-surface-frame').waitFor();
  manager = await waitSurfaceManager(page, 1);
  const expandedBounds = manager.hostBoundsByInstance[recordingInstance];
  await page.locator('.collapse-button').click();
  await page.waitForTimeout(150);
  manager = await waitSurfaceManager(page, 1);
  const collapsedBounds = manager.hostBoundsByInstance[recordingInstance];
  assert(collapsedBounds.x < expandedBounds.x && collapsedBounds.width > expandedBounds.width, 'active native bounds did not follow menu collapse');
  await page.locator('.collapse-button').click();

  let settingsKeyboardPersisted = 0;
  const verifySettings = async (origin) => {
    await page.locator('.rail-settings').click();
    const dialog = page.locator('[data-testid=settings-dialog]');
    await dialog.waitFor();
    await waitSurfaceManager(page, 0);
    const sizes = [];
    for (const name of ['AI 设置', '安全锁']) {
      await page.getByRole('button', { name, exact: true }).click();
      const box = await dialog.boundingBox();
      sizes.push({ name, width: box.width, height: box.height });
      await page.screenshot({ path: path.join(evidenceRoot, `settings-${origin}-${name === 'AI 设置' ? 'ai' : 'safety'}.png`) });
    }
    assert(sizes.every((value) => Math.abs(value.width - sizes[0].width) <= 1 && Math.abs(value.height - sizes[0].height) <= 1), `${origin}: settings frame changed between sections`);
    const scroll = await page.evaluate(() => ({
      navOverflow: getComputedStyle(document.querySelector('[data-testid=settings-nav-scroll]')).overflowY,
      mainOverflow: getComputedStyle(document.querySelector('[data-testid=settings-main-scroll]')).overflowY,
      separate: document.querySelector('[data-testid=settings-nav-scroll]') !== document.querySelector('[data-testid=settings-main-scroll]')
    }));
    assert(scroll.separate && scroll.navOverflow === 'auto' && scroll.mainOverflow === 'auto', `${origin}: settings scroll containers are not independent`);
    if (origin === 'recording-direct') {
      const splitter = page.getByRole('separator', { name: '调整设置导航宽度' });
      await splitter.focus();
      await splitter.press('ArrowRight');
      await page.waitForFunction(async () => (await window.omnia.getSnapshot()).settingsLayout.settingsNavigationBasisPoints === 2300);
      settingsKeyboardPersisted = await splitter.getAttribute('aria-valuenow').then(Number);
      assert(settingsKeyboardPersisted === 2300, 'settings splitter keyboard action did not update the real preference');
    }
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    return sizes[0];
  };
  const settings100 = await verifySettings('recording-direct');
  await waitSurfaceManager(page, 1);
  await page.getByRole('button', { name: 'Comments' }).click();
  await verifySettings('comments');
  await assertComposer(page, 'comments-after-settings');

  await navigation.getByRole('button', { name: '删除元素' }).click();
  await page.locator('.feature-surface-frame').waitFor();
  await waitSurfaceManager(page, 1);
  await verifySettings('delete-elements');
  await waitSurfaceManager(page, 1);
  assert(await page.locator('.feature-tab').count() === 2, 'recording/delete multi-tab host was not preserved');
  for (const label of ['录制', '删除元素']) {
    await page.locator('.feature-tab', { hasText: label }).click();
    manager = await waitSurfaceManager(page, 1);
    assert(manager.attachedInstanceIds.length === 1, `${label}: more than one docked view attached`);
  }

  for (let index = 0; index < 3; index += 1) await page.getByRole('button', { name: '放大' }).click();
  await page.waitForFunction(async () => (await window.omnia.getSnapshot()).preference.uiScalePercent === 115);
  const geometry115 = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    devicePixelRatio: window.devicePixelRatio,
    railWidth: document.querySelector('.rail')?.getBoundingClientRect().width || 0,
    brandFont: getComputedStyle(document.querySelector('.brand-mark')).fontSize,
    uiScaleToken: getComputedStyle(document.querySelector('.app-frame')).getPropertyValue('--ui-scale').trim(),
    frame: (() => { const r = document.querySelector('.feature-surface-frame')?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null; })()
  }));
  manager = await waitSurfaceManager(page, 1);
  assert(manager.zoomFactor === 1.15, 'native surfaces did not receive 115% zoom');
  assert(geometry115.innerWidth < geometry100.innerWidth, 'Shell layout viewport did not geometrically scale');
  assert(geometry115.devicePixelRatio > geometry100.devicePixelRatio, 'Shell device scale did not increase');
  assert((geometry115.uiScaleToken || '1') === '1', 'CSS ui scale token would double-apply Electron zoom');
  const activeId = manager.attachedInstanceIds[0];
  const hostBounds = manager.hostBoundsByInstance[activeId];
  const frame = geometry115.frame;
  assert(frame && Math.abs(hostBounds.x - Math.round(frame.x * 1.15)) <= 2 && Math.abs(hostBounds.width - Math.round(frame.width * 1.15)) <= 2, '115% docked bounds are not aligned after CSS-to-DIP conversion');
  await page.screenshot({ path: path.join(evidenceRoot, 'shell-115-percent.png') });
  const nativeDockedCapture = await captureCompositedShellWindow(app, path.join(evidenceRoot, 'feature-docked-115-percent.png'));
  await page.locator('.rail-settings').click();
  const settings115Box = await page.locator('[data-testid=settings-dialog]').boundingBox();
  assert(settings115Box.width * geometry115.devicePixelRatio > settings100.width * geometry100.devicePixelRatio, 'Settings physical geometry did not grow at 115%');
  await page.screenshot({ path: path.join(evidenceRoot, 'settings-115-percent.png') });
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await waitSurfaceManager(page, 1);

  await page.setViewportSize({ width: 920, height: 600 });
  for (let index = 0; index < 3; index += 1) await page.getByRole('button', { name: '放大' }).click();
  await page.waitForFunction(async () => (await window.omnia.getSnapshot()).preference.uiScalePercent === 130);
  await page.locator('.rail-settings').click();
  await page.getByRole('button', { name: 'AI 设置', exact: true }).click();
  const scrollExercise = await page.evaluate(() => {
    const nav = document.querySelector('[data-testid=settings-nav-scroll]');
    const main = document.querySelector('[data-testid=settings-main-scroll]');
    const navBefore = nav.scrollTop;
    main.scrollTop = main.scrollHeight;
    return {
      mainScrollHeight: main.scrollHeight,
      mainClientHeight: main.clientHeight,
      mainScrollTop: main.scrollTop,
      navBefore,
      navAfter: nav.scrollTop
    };
  });
  assert(scrollExercise.mainScrollHeight > scrollExercise.mainClientHeight && scrollExercise.mainScrollTop > 0
    && scrollExercise.navBefore === scrollExercise.navAfter, `real Settings content did not independently scroll at minimum window/high zoom: ${JSON.stringify(scrollExercise)}`);
  await page.screenshot({ path: path.join(evidenceRoot, 'settings-independent-scroll-130-percent.png') });
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 800 });
  for (let index = 0; index < 3; index += 1) await page.getByRole('button', { name: '缩小' }).click();
  await page.waitForFunction(async () => (await window.omnia.getSnapshot()).preference.uiScalePercent === 115);

  await page.keyboard.press('Control+-');
  await page.waitForFunction(async () => (await window.omnia.getSnapshot()).preference.uiScalePercent === 110);
  await page.waitForFunction(async () => Math.abs(window.devicePixelRatio - 1.1) < 0.01
    && Math.abs((await window.omnia.getSurfaceManagerSnapshot()).zoomFactor - 1.1) < 0.001);
  const keyboard110 = await page.evaluate(async () => ({
    scale: (await window.omnia.getSnapshot()).preference.uiScalePercent,
    dpr: window.devicePixelRatio,
    managerZoom: (await window.omnia.getSurfaceManagerSnapshot()).zoomFactor
  }));
  await page.keyboard.press('Control++');
  await page.waitForFunction(async () => (await window.omnia.getSnapshot()).preference.uiScalePercent === 115);
  await page.waitForFunction(async () => Math.abs(window.devicePixelRatio - 1.15) < 0.01
    && Math.abs((await window.omnia.getSurfaceManagerSnapshot()).zoomFactor - 1.15) < 0.001);
  const keyboard115 = await page.evaluate(async () => ({
    scale: (await window.omnia.getSnapshot()).preference.uiScalePercent,
    dpr: window.devicePixelRatio,
    managerZoom: (await window.omnia.getSurfaceManagerSnapshot()).zoomFactor
  }));
  await page.keyboard.press('Control+0');
  await page.waitForFunction(async () => (await window.omnia.getSnapshot()).preference.uiScalePercent === 100
    && Math.abs(window.devicePixelRatio - 1) < 0.01
    && Math.abs((await window.omnia.getSurfaceManagerSnapshot()).zoomFactor - 1) < 0.001);
  const keyboard100 = await page.evaluate(async () => ({
    scale: (await window.omnia.getSnapshot()).preference.uiScalePercent,
    dpr: window.devicePixelRatio,
    managerZoom: (await window.omnia.getSurfaceManagerSnapshot()).zoomFactor
  }));
  for (let index = 0; index < 3; index += 1) await page.getByRole('button', { name: '放大' }).click();
  await page.waitForFunction(async () => (await window.omnia.getSnapshot()).preference.uiScalePercent === 115
    && Math.abs(window.devicePixelRatio - 1.15) < 0.01
    && Math.abs((await window.omnia.getSurfaceManagerSnapshot()).zoomFactor - 1.15) < 0.001);

  const expectedDetachedTitle = (await page.locator('.feature-tab.active').innerText()).trim();
  const detachedWindowPromise = app.waitForEvent('window', { timeout: 20_000 });
  await page.locator('button[title="弹出"]').click();
  await page.waitForFunction(() => document.querySelectorAll('.feature-tab.active').length === 0 || document.querySelector('.comments-tab.active'));
  const detached = await detachedWindowPromise;
  await detached.waitForLoadState('domcontentloaded');
  await detached.locator('#feature-root h1').waitFor({ state: 'visible', timeout: 20_000 });
  const detachedGeometry = await detached.evaluate(() => ({
    devicePixelRatio: window.devicePixelRatio,
    innerWidth: window.innerWidth,
    title: document.querySelector('#feature-root h1')?.textContent || ''
  }));
  assert(detachedGeometry.devicePixelRatio >= geometry115.devicePixelRatio - 0.01, 'detached Feature did not inherit global zoom');
  assert(detachedGeometry.title.includes(expectedDetachedTitle), `detached Feature did not bootstrap the active ${expectedDetachedTitle} surface: ${detachedGeometry.title}`);
  const detachedManager = await page.evaluate(() => window.omnia.getSurfaceManagerSnapshot());
  assert(detachedManager.detachedInstanceIds.length === 1, 'detached Feature lifecycle was not registered');
  const detachedInstanceId = detachedManager.detachedInstanceIds[0];
  assert(detachedManager.authorizedSenderInstanceIds.includes(detachedInstanceId), 'detached Feature sender was not authorized after bootstrap');
  const detachedScreenshot = path.join(evidenceRoot, 'feature-detached-115-percent.png');
  if (!fs.existsSync(detachedScreenshot)) await detached.screenshot({ path: detachedScreenshot, timeout: 15_000 });
  await detached.close();
  await page.waitForFunction((instanceId) => {
    return window.omnia.getSurfaceManagerSnapshot().then((manager) => !manager.detachedInstanceIds.includes(instanceId)
      && !manager.authorizedSenderInstanceIds.includes(instanceId));
  }, detachedInstanceId);
  assert(detached.isClosed(), 'detached Feature window did not close cleanly');

  await app.close();
  app = await launch();
  page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.omnia), undefined, { timeout: 20_000 });
  await page.waitForFunction(async () => (await window.omnia.getSnapshot()).preference.uiScalePercent === 115);
  const restart = await page.evaluate(async () => ({
    scale: (await window.omnia.getSnapshot()).preference.uiScalePercent,
    settingsBasis: (await window.omnia.getSnapshot()).settingsLayout.settingsNavigationBasisPoints,
    dpr: window.devicePixelRatio,
    leaves: (await window.omnia.getSnapshot()).features.navigation.map((leaf) => `${leaf.featureId}@${leaf.featureVersion}`)
  }));
  assert(restart.scale === 115 && restart.dpr > geometry100.devicePixelRatio, 'global zoom did not persist across restart');
  assert(restart.settingsBasis === 2300, 'settings splitter did not persist across restart');
  assert(restart.leaves.includes('omnia.recording@0.1.1') && restart.leaves.includes('omnia.delete-elements@0.1.2'), 'Feature activation did not survive restart');
  await page.getByLabel('FeatureNavigation', { exact: true }).getByRole('button', { name: '录制' }).click();
  await page.locator('.feature-surface-frame').waitFor();
  const newFrame = await page.evaluate(() => { const r = document.querySelector('.feature-surface-frame').getBoundingClientRect(); return { x: r.x, width: r.width }; });
  const newManager = await waitSurfaceManager(page, 1);
  const newId = newManager.attachedInstanceIds[0];
  assert(newManager.zoomFactor === 1.15, 'new docked Feature did not inherit persisted zoom');
  assert(Math.abs(newManager.hostBoundsByInstance[newId].x - Math.round(newFrame.x * 1.15)) <= 2
    && Math.abs(newManager.hostBoundsByInstance[newId].width - Math.round(newFrame.width * 1.15)) <= 2, 'new docked Feature bounds are not aligned at persisted zoom');

  const report = {
    ok: true,
    productRoot,
    registry,
    geometry100,
    geometry105,
    geometry115,
    settingsPhysical: { at100: settings100, at115: settings115Box },
    settingsKeyboardPersisted,
    nativeDockedCapture,
    scrollExercise,
    keyboardZoom: { at110: keyboard110, at115: keyboard115, reset100: keyboard100 },
    detachedGeometry,
    detachedCleanup: { instanceId: detachedInstanceId, senderMappingRemoved: true },
    restart,
    nativeLifecycle: { commentsAttached: 0, featureAttachedMaximum: 1, menuBoundsChanged: true, settingsAttached: 0 },
    screenshots: fs.readdirSync(evidenceRoot).filter((name) => name.endsWith('.png')).sort()
  };
  fs.writeFileSync(path.join(evidenceRoot, 'automation-report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await app.close().catch(() => undefined);
  if (connectorSocket && connectorSocket.readyState < WebSocket.CLOSING) connectorSocket.close();
  bridgeProcess.kill();
  await new Promise((resolve) => {
    if (bridgeProcess.exitCode !== null) return resolve();
    bridgeProcess.once('exit', resolve);
    setTimeout(resolve, 3_000);
  });
  fs.rmSync(productRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
