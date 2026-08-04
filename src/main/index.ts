import { app, BrowserWindow, dialog, ipcMain, shell as electronShell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { RemoteConnectorTransport } from './connector/remote-connector-transport.js';
import { CoreDatabase } from './database.js';
import { createWindowsProtectedContentCipher } from './windows-content-cipher.js';
import type { ContentCipher } from './content-cipher.js';
import {
  findPortableProductRoot,
  quarantineUnreadableDataRoot,
  resolveProductPaths,
  type ProtectedDataRecovery
} from './paths.js';
import { ChatService } from './services/chat-service.js';
import { AttachmentService } from './services/attachment-service.js';
import { ShellService } from './services/shell-service.js';
import { AppError, publicError } from '../shared/errors.js';
import { FeaturePackageManager } from './features/package-manager.js';
import { installBuiltinFeaturePackages } from './features/builtin-features.js';
import type { FeatureActionRequest, FeatureArtifactBytesInputRequest, FeatureArtifactInputRequest } from '../shared/feature-contracts.js';
import { SurfaceWindowManager } from './services/surface-window-manager.js';
import { InteractionLogService, type InteractionDescriptor } from './services/interaction-log-service.js';
import type { InteractionLogQuery } from '../shared/interaction-log-contracts.js';

let mainWindow: BrowserWindow | null = null;
let database: CoreDatabase | null = null;
let shell: ShellService | null = null;
let connector: RemoteConnectorTransport | null = null;
let surfaceWindows: SurfaceWindowManager | null = null;
let featurePackages: FeaturePackageManager | null = null;
let interactionLogs: InteractionLogService | null = null;
let startupRecovery: ProtectedDataRecovery | null = null;

const ownsSingleInstance = app.requestSingleInstanceLock();
if (!ownsSingleInstance) app.quit();
app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

function rendererPath(filename: string): string {
  return path.resolve(__dirname, '..', 'renderer', filename);
}

function resolveHotApplicationRoot(): string | null {
  const configuredRoot = String(process.env.OMNIA_AGENT_HOT_ROOT || '').trim();
  if (!configuredRoot) return null;
  const root = path.resolve(configuredRoot);
  const packagePath = path.join(root, 'package.json');
  const featurePackagesPath = path.join(root, 'feature-packages');
  if (!fs.existsSync(packagePath) || !fs.existsSync(featurePackagesPath)) {
    throw new Error(`Omnia hot workspace is incomplete: ${root}`);
  }
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { name?: unknown };
  if (packageJson.name !== 'omnia-agent-v5-shell') {
    throw new Error(`Omnia hot workspace identity is invalid: ${root}`);
  }
  return root;
}

async function createWindow(): Promise<void> {
  const initialZoomFactor = shell!.snapshot().preference.uiScalePercent / 100;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 920,
    minHeight: 600,
    backgroundColor: '#f4f6f8',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.resolve(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  surfaceWindows = new SurfaceWindowManager(
    mainWindow,
    path.resolve(__dirname, 'feature-preload.cjs'),
    rendererPath(''),
    () => shell!.snapshot(),
    (request) => shell!.featureAction(request)
  );
  mainWindow.webContents.setZoomFactor(initialZoomFactor);
  surfaceWindows.setZoomFactor(initialZoomFactor);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== pathToFileURL(rendererPath('index.html')).href) event.preventDefault();
  });
  mainWindow.webContents.on('render-process-gone', () => {
    surfaceWindows?.setDockedVisibility({ activeInstanceId: null, overlayActive: true });
  });
  const windowToShow = mainWindow;
  windowToShow.once('ready-to-show', () => {
    if (!windowToShow.isDestroyed()) windowToShow.show();
  });
  await mainWindow.loadFile(rendererPath('index.html'));
  // Chromium can restore a previously persisted origin zoom during load.
  // Re-assert the Core-owned preference before the first frame is shown.
  mainWindow.webContents.setZoomFactor(initialZoomFactor);
  // Keep a post-load fallback for platforms where ready-to-show is suppressed.
  if (!windowToShow.isDestroyed() && !windowToShow.isVisible()) windowToShow.show();
  mainWindow.on('closed', () => {
    surfaceWindows?.dispose();
    surfaceWindows = null;
    mainWindow = null;
  });
}

function registerIpc(service: ShellService, packages: FeaturePackageManager, logs: InteractionLogService): void {
  const descriptor = (channel: string, args: unknown[]): InteractionDescriptor => {
    const input = args[0] as Record<string, unknown> | undefined;
    const feature = channel.includes('feature') && input && typeof input === 'object' ? input : undefined;
    return {
      plane: 'surface',
      component: channel.startsWith('surface:') ? 'feature-surface-ipc' : 'shell-ipc',
      surface: channel.startsWith('surface:') ? String(feature?.surfaceId || 'feature.surface') : 'shell.main',
      action: channel,
      failurePoint: `main.ipc.${channel}`,
      details: feature ? {
        featureId: feature.featureId,
        featureVersion: feature.featureVersion,
        surfaceId: feature.surfaceId,
        actionId: feature.actionId,
        expectedStateVersion: feature.expectedStateVersion,
        runId: (feature.payload as Record<string, unknown> | undefined)?.runId,
        commandId: (feature.payload as Record<string, unknown> | undefined)?.commandId,
        artifactId: feature.artifactId,
        basename: feature.name,
        sizeBytes: feature.bytes instanceof Uint8Array ? feature.bytes.byteLength : undefined
      } : channel === 'shell:send-message' ? { count: Array.isArray(input?.attachmentIds) ? input!.attachmentIds.length : 0 }
        : channel === 'shell:save-ai-settings' ? { hasApiKeyChange: Boolean(input?.apiKey || input?.clearApiKey) }
          : channel.includes('remote-pairing') ? { repair: Boolean(input?.repair), expectedStateVersion: input?.expectedStateVersion }
            : {}
    };
  };
  const register = <T extends unknown[]>(
    channel: string,
    action: (event: Electron.IpcMainInvokeEvent, ...args: T) => unknown | Promise<unknown>
  ): void => {
    ipcMain.handle(channel, async (event, ...args: T) => {
      try {
        if (channel === 'shell:poll-remote-pairing') {
          try { return { ok: true, value: await action(event, ...args) }; }
          catch (pollError) {
            await logs.run(descriptor(channel, args), () => { throw pollError; });
          }
        }
        return { ok: true, value: await logs.run(descriptor(channel, args), () => action(event, ...args)) };
      } catch (error) {
        return { ok: false, error: publicError(error) };
      }
    });
  };
  const handle = <T extends unknown[]>(channel: string, action: (...args: T) => unknown | Promise<unknown>): void =>
    register<T>(channel, (_event, ...args: T) => action(...args));
  handle('shell:get-snapshot', () => service.snapshot());
  handle('shell:connect', () => service.connect());
  handle('shell:cancel-connect', () => service.cancelConnect());
  handle('shell:refresh', () => service.refresh());
  handle('shell:set-keepalive', (enabled: boolean) => service.setKeepalive(enabled));
  handle('shell:refresh-workspaces', () => service.refreshWorkspaceDirectory());
  handle('shell:save-safety', (input: { enabled: boolean; globalEnabled?: boolean; globalSectionIds?: string[]; workspaceIds: string[]; expectedStateVersion: number }) =>
    service.saveSafety(input));
  handle('shell:send-message', (input: { content: string; attachmentIds: string[] }) => service.sendMessage(input));
  handle('shell:choose-attachments', async () => {
    const selected = await dialog.showOpenDialog(mainWindow!, {
      title: '选择要添加到对话的附件',
      properties: ['openFile', 'multiSelections']
    });
    if (!selected.canceled) await service.importAttachments(selected.filePaths);
    return service.snapshot();
  });
  handle('shell:remove-attachment', (id: string) => service.removeAttachment(id));
  handle('shell:preview-attachment', async (id: string) => {
    const result = await electronShell.openPath(service.previewAttachmentPath(id));
    if (result) throw new Error(result);
  });
  handle('shell:save-composer-height', (input: { heightPx: number }) =>
    service.saveComposerHeight(input.heightPx));
  handle('shell:save-ai-settings', (input: Parameters<ShellService['saveAiSettings']>[0]) =>
    service.saveAiSettings(input));
  handle('shell:test-ai-provider', () => service.testAiProvider());
  handle('shell:diagnose-remote', () => service.diagnoseRemoteConnection());
  handle('shell:begin-remote-pairing', (input: Parameters<ShellService['beginRemotePairing']>[0]) =>
    service.beginRemotePairing(input));
  handle('shell:poll-remote-pairing', () => service.pollRemotePairing());
  handle('shell:cancel-remote-pairing', () => service.cancelRemotePairing());
  handle('shell:revoke-remote-binding', (input: Parameters<ShellService['revokeRemoteBinding']>[0]) =>
    service.revokeRemoteBinding(input));
  handle('shell:save-scale', (input: { percent: number; expectedStateVersion: number }) =>
    service.saveScale(input.percent, input.expectedStateVersion));
  handle('shell:save-layout', (input: {
    featureNavigationBasisPoints: number;
    featureNavigationCollapsed: boolean;
    expectedStateVersion: number;
  }) => service.saveLayout(
    input.featureNavigationBasisPoints,
    input.featureNavigationCollapsed,
    input.expectedStateVersion
  ));
  handle('shell:save-settings-layout', (input: {
    settingsNavigationBasisPoints: number;
    expectedStateVersion: number;
  }) => service.saveSettingsLayout(input.settingsNavigationBasisPoints, input.expectedStateVersion));
  handle('shell:select-feature', (input: { featureId: string }) => service.selectFeature(input.featureId));
  handle('shell:feature-action', (input: FeatureActionRequest) => service.featureAction(input));
  handle('shell:query-interaction-logs', (input: InteractionLogQuery) => logs.query(input));
  handle('shell:get-interaction-trace', (traceId: string) => logs.trace(traceId));
  handle('surface:open', (input: Parameters<SurfaceWindowManager['open']>[0]) => {
    if (!surfaceWindows) throw new Error('Feature Surface host is not ready.');
    return surfaceWindows.open(input);
  });
  handle('surface:resize', (input: { instanceId: string; bounds: { x: number; y: number; width: number; height: number } }) => {
    if (!surfaceWindows) throw new Error('Feature Surface host is not ready.');
    surfaceWindows.resize(input.instanceId, input.bounds);
  });
  handle('surface:close', (instanceId: string) => surfaceWindows?.close(instanceId));
  handle('surface:minimize', (instanceId: string) => surfaceWindows?.minimize(instanceId));
  handle('surface:restore', (instanceId: string) => surfaceWindows?.restore(instanceId));
  handle('surface:set-docked-visibility', (input: Parameters<SurfaceWindowManager['setDockedVisibility']>[0]) => {
    if (!surfaceWindows) throw new Error('Feature Surface host is not ready.');
    return surfaceWindows.setDockedVisibility(input);
  });
  handle('surface:get-manager-snapshot', () => {
    if (!surfaceWindows) throw new Error('Feature Surface host is not ready.');
    return surfaceWindows.snapshot();
  });
  register('surface:get-self-context', (event) => {
    if (!surfaceWindows) throw new Error('Feature Surface host is not ready.');
    return surfaceWindows.selfContext(event.sender.id);
  });
  register('surface:dock-self', (event) => {
    if (!surfaceWindows) throw new Error('Feature Surface host is not ready.');
    return surfaceWindows.dockFromSender(event.sender.id);
  });
  register('surface:feature-action', async (event, input: FeatureActionRequest) => {
      if (!surfaceWindows) throw new Error('Feature Surface host is not ready.');
      return surfaceWindows.featureAction(event.sender.id, input);
  });
  register('surface:choose-feature-input', async (event, input: FeatureArtifactInputRequest) => {
      if (!surfaceWindows) throw new Error('Feature Surface host is not ready.');
      surfaceWindows.authorizeArtifactInput(event.sender.id, input);
      const selected = await dialog.showOpenDialog({
        title: '选择 Feature 输入文件',
        properties: ['openFile'],
        filters: [{ name: 'Feature input', extensions: input.accept.map((value) => value.slice(1)) }]
      });
      if (selected.canceled || selected.filePaths.length !== 1) return null;
      return packages.importArtifact(input, selected.filePaths[0]!);
  });
  register('surface:import-feature-input-bytes', async (event, input: FeatureArtifactBytesInputRequest) => {
      if (!surfaceWindows) throw new Error('Feature Surface host is not ready.');
      surfaceWindows.authorizeArtifactInput(event.sender.id, input);
      const bytes = input.bytes instanceof Uint8Array ? input.bytes : new Uint8Array(input.bytes as ArrayBuffer);
      return packages.importArtifactBytes(input, input.name, bytes);
  });
  register('surface:save-feature-managed-asset', async (event, input: { featureId: string; featureVersion: string; actionId: string; memberPath: string }) => {
      if (!surfaceWindows) throw new Error('Feature Surface host is not ready.');
      surfaceWindows.authorizeArtifactExport(event.sender.id, input.featureId);
      const asset = packages.exportManagedAsset(input.featureId, input.featureVersion, input.actionId, input.memberPath);
      const selected = await dialog.showSaveDialog({ title: '保存 Feature 模板', defaultPath: asset.suggestedName });
      if (selected.canceled || !selected.filePath) return { saved: false };
      fs.copyFileSync(asset.source, selected.filePath);
      return { saved: true };
  });
  register('surface:save-feature-artifact', async (event, input: { featureId: string; artifactId: string }) => {
      if (!surfaceWindows) throw new Error('Feature Surface host is not ready.');
      surfaceWindows.authorizeArtifactExport(event.sender.id, input.featureId);
      const artifact = packages.exportArtifact(input.featureId, input.artifactId);
      const selected = await dialog.showSaveDialog({ title: '保存 Feature 产物', defaultPath: artifact.suggestedName });
      if (selected.canceled || !selected.filePath) return { saved: false };
      fs.copyFileSync(artifact.source, selected.filePath);
      return { saved: true };
  });
  service.onChanged((snapshot) => {
    const factor = snapshot.preference.uiScalePercent / 100;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.setZoomFactor(factor);
      mainWindow.webContents.send('shell:changed', snapshot);
    }
    surfaceWindows?.setZoomFactor(factor);
  });
}

app.whenReady().then(async () => {
  if (!ownsSingleInstance) return;
  const productRoot = process.env.OMNIA_AGENT_PRODUCT_ROOT
    || (app.isPackaged ? findPortableProductRoot(path.dirname(process.execPath)) : app.getAppPath());
  let paths = resolveProductPaths(productRoot);
  let contentCipher: ContentCipher;
  try {
    contentCipher = createWindowsProtectedContentCipher(paths.stores);
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'SECRET.INSTANCE_KEY_UNREADABLE' || !app.isPackaged) throw error;
    startupRecovery = quarantineUnreadableDataRoot(paths);
    paths = resolveProductPaths(productRoot);
    contentCipher = createWindowsProtectedContentCipher(paths.stores);
  }
  database = new CoreDatabase(paths.database, contentCipher);
  interactionLogs = new InteractionLogService(database.db);
  connector = new RemoteConnectorTransport(() => {
    const binding = database!.getRemoteBinding();
    const lifecycleRecoveryPending = database!.hasPendingRemoteLifecycleWork();
    const usable = binding.bindingState === 'bound' && binding.remotePaired && !lifecycleRecoveryPending;
    return {
      bridgeUrl: binding.bridgeUrl,
      pairId: usable ? binding.pairId : '',
      token: usable ? binding.remoteToken : '',
      generation: binding.generation
    };
  });
  await connector.start();
  const chat = new ChatService(database, undefined, interactionLogs);
  const attachments = new AttachmentService(database, path.join(paths.data, 'artifacts'), interactionLogs);
  featurePackages = new FeaturePackageManager(database.db, paths, undefined, {
    connector,
    workerHostEntrypoint: path.resolve(__dirname, 'feature-worker-host.cjs')
  }, interactionLogs);
  const hotApplicationRoot = resolveHotApplicationRoot();
  installBuiltinFeaturePackages(
    featurePackages,
    hotApplicationRoot || app.getAppPath(),
    hotApplicationRoot ? false : app.isPackaged
  );
  await featurePackages.initializeRuntime();
  shell = new ShellService(database, connector, chat, attachments, featurePackages, {}, {}, interactionLogs);
  registerIpc(shell, featurePackages, interactionLogs);
  await shell.initialize();
  await createWindow();
  if (startupRecovery && mainWindow && !mainWindow.isDestroyed()) {
    void dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: '本地数据保护已恢复',
      message: '旧实例的数据保护密钥已无法读取。应用已创建新的数据根，并完整保留旧数据。',
      detail: `旧数据保留在产品根内：${startupRecovery.previousDataRelativePath}`,
      buttons: ['知道了'],
      defaultId: 0,
      noLink: true
    });
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
}).catch((error) => {
  const message = error instanceof Error ? error.message : '发生未知启动错误。';
  console.error('Omnia Agent v5 startup failed:', message);
  if (app.isReady()) dialog.showErrorBox('Omnia Agent v5 启动失败', message);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  shell?.dispose();
  surfaceWindows?.dispose();
  void shell?.disposeFeatureRuntime();
  void connector?.stop();
  database?.close();
  shell = null;
  surfaceWindows = null;
  connector = null;
  featurePackages = null;
  interactionLogs = null;
  database = null;
});
