import { contextBridge, ipcRenderer } from 'electron';
import type { ShellApi, ShellSnapshot } from '../shared/contracts.js';

interface IpcResult<T> {
  ok: boolean;
  value?: T;
  error?: { code: string; message: string; interactionId?: string; traceId?: string; failurePoint?: string };
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = await ipcRenderer.invoke(channel, ...args) as IpcResult<T>;
  if (!result.ok) {
    const suffix = result.error?.interactionId ? `（交互 ID：${result.error.interactionId}）` : '';
    const error = Object.assign(new Error(`${result.error?.message || '后台操作失败。'}${suffix}`), {
      code: result.error?.code || 'APP.ERROR', interactionId: result.error?.interactionId || '',
      traceId: result.error?.traceId || '', failurePoint: result.error?.failurePoint || ''
    });
    error.name = result.error?.code || 'APP.ERROR';
    throw error;
  }
  return result.value as T;
}

const api: ShellApi = {
  getSnapshot: () => invoke('shell:get-snapshot'),
  connect: () => invoke('shell:connect'),
  cancelConnect: () => invoke('shell:cancel-connect'),
  refresh: () => invoke('shell:refresh'),
  setKeepalive: (enabled) => invoke('shell:set-keepalive', enabled),
  refreshWorkspaceDirectory: () => invoke('shell:refresh-workspaces'),
  saveSafety: (input) => invoke('shell:save-safety', input),
  sendMessage: (input) => invoke('shell:send-message', input),
  chooseAttachments: () => invoke('shell:choose-attachments'),
  removeAttachment: (id) => invoke('shell:remove-attachment', id),
  previewAttachment: (id) => invoke('shell:preview-attachment', id),
  saveComposerHeight: (input) => invoke('shell:save-composer-height', input),
  saveAiSettings: (input) => invoke('shell:save-ai-settings', input),
  testAiProvider: () => invoke('shell:test-ai-provider'),
  diagnoseRemoteConnection: () => invoke('shell:diagnose-remote'),
  beginRemotePairing: (input) => invoke('shell:begin-remote-pairing', input),
  pollRemotePairing: () => invoke('shell:poll-remote-pairing'),
  cancelRemotePairing: () => invoke('shell:cancel-remote-pairing'),
  revokeRemoteBinding: (input) => invoke('shell:revoke-remote-binding', input),
  saveScale: (input) => invoke('shell:save-scale', input),
  saveLayout: (input) => invoke('shell:save-layout', input),
  saveSettingsLayout: (input) => invoke('shell:save-settings-layout', input),
  selectFeature: (input) => invoke('shell:select-feature', input),
  featureAction: (input) => invoke('shell:feature-action', input),
  queryInteractionLogs: (input) => invoke('shell:query-interaction-logs', input),
  getInteractionTrace: (traceId) => invoke('shell:get-interaction-trace', traceId),
  openFeatureSurface: (input) => invoke('surface:open', input),
  focusFeatureSurface: (instanceId) => invoke('surface:focus', instanceId),
  resizeFeatureSurface: (input) => invoke('surface:resize', input),
  closeFeatureSurface: (instanceId) => invoke('surface:close', instanceId),
  minimizeFeatureSurface: (instanceId) => invoke('surface:minimize', instanceId),
  restoreFeatureSurface: (instanceId) => invoke('surface:restore', instanceId),
  setDockedSurfaceVisibility: (input) => invoke('surface:set-docked-visibility', input),
  getSurfaceManagerSnapshot: () => invoke('surface:get-manager-snapshot'),
  onFeatureDocked: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, instanceId: string) => listener(instanceId);
    ipcRenderer.on('surface:docked', handler);
    return () => ipcRenderer.removeListener('surface:docked', handler);
  },
  onFeatureBootstrap: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, surface: import('../shared/feature-contracts.js').DeclarativeFeatureSurface) => listener(surface);
    ipcRenderer.on('feature:bootstrap', handler);
    return () => ipcRenderer.removeListener('feature:bootstrap', handler);
  },
  onChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: ShellSnapshot) => listener(snapshot);
    ipcRenderer.on('shell:changed', handler);
    return () => ipcRenderer.removeListener('shell:changed', handler);
  }
};

contextBridge.exposeInMainWorld('omnia', Object.freeze(api));

declare global {
  interface Window {
    omnia: ShellApi;
  }
}
