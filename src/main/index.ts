import { app, BrowserWindow, dialog, ipcMain, shell as electronShell } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { RemoteConnectorTransport } from './connector/remote-connector-transport.js';
import { CoreDatabase } from './database.js';
import { createWindowsProtectedContentCipher } from './windows-content-cipher.js';
import { findPortableProductRoot, resolveProductPaths } from './paths.js';
import { ChatService } from './services/chat-service.js';
import { AttachmentService } from './services/attachment-service.js';
import { ShellService } from './services/shell-service.js';
import { publicError } from '../shared/errors.js';
import { FeaturePackageManager } from './features/package-manager.js';
import { installBuiltinFeaturePackages } from './features/builtin-features.js';
import type { FeatureActionRequest } from '../shared/feature-contracts.js';
import { SurfaceWindowManager } from './services/surface-window-manager.js';

let mainWindow: BrowserWindow | null = null;
let database: CoreDatabase | null = null;
let shell: ShellService | null = null;
let connector: RemoteConnectorTransport | null = null;
let surfaceWindows: SurfaceWindowManager | null = null;

function rendererPath(filename: string): string {
  return path.resolve(__dirname, '..', 'renderer', filename);
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
  await mainWindow.loadFile(rendererPath('index.html'));
  // Chromium can restore a previously persisted origin zoom during load.
  // Re-assert the Core-owned preference before the first frame is shown.
  mainWindow.webContents.setZoomFactor(initialZoomFactor);
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    surfaceWindows?.dispose();
    surfaceWindows = null;
    mainWindow = null;
  });
}

function registerIpc(service: ShellService): void {
  const handle = <T extends unknown[]>(channel: string, action: (...args: T) => unknown | Promise<unknown>): void => {
    ipcMain.handle(channel, async (_event, ...args: T) => {
      try {
        return { ok: true, value: await action(...args) };
      } catch (error) {
        return { ok: false, error: publicError(error) };
      }
    });
  };
  handle('shell:get-snapshot', () => service.snapshot());
  handle('shell:connect', () => service.connect());
  handle('shell:cancel-connect', () => service.cancelConnect());
  handle('shell:refresh', () => service.refresh());
  handle('shell:set-keepalive', (enabled: boolean) => service.setKeepalive(enabled));
  handle('shell:refresh-workspaces', () => service.refreshWorkspaceDirectory());
  handle('shell:save-safety', (input: { enabled: boolean; workspaceIds: string[]; expectedStateVersion: number }) =>
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
  ipcMain.handle('surface:feature-action', async (event, input: FeatureActionRequest) => {
    try {
      if (!surfaceWindows) throw new Error('Feature Surface host is not ready.');
      return { ok: true, value: await surfaceWindows.featureAction(event.sender.id, input) };
    } catch (error) {
      return { ok: false, error: publicError(error) };
    }
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
  const productRoot = process.env.OMNIA_AGENT_PRODUCT_ROOT
    || (app.isPackaged ? findPortableProductRoot(path.dirname(process.execPath)) : app.getAppPath());
  const paths = resolveProductPaths(productRoot);
  const contentCipher = createWindowsProtectedContentCipher(paths.stores);
  database = new CoreDatabase(paths.database, contentCipher);
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
  const chat = new ChatService(database);
  const attachments = new AttachmentService(database, path.join(paths.data, 'artifacts'));
  const featurePackages = new FeaturePackageManager(database.db, paths, undefined, {
    connector,
    workerHostEntrypoint: path.resolve(__dirname, 'feature-worker-host.cjs')
  });
  installBuiltinFeaturePackages(featurePackages, app.getAppPath(), app.isPackaged);
  await featurePackages.initializeRuntime();
  shell = new ShellService(database, connector, chat, attachments, featurePackages);
  registerIpc(shell);
  await shell.initialize();
  await createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
}).catch((error) => {
  console.error('Omnia Agent v5 startup failed:', error instanceof Error ? error.message : 'unknown error');
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
  database = null;
});
