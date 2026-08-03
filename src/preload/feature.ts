import { contextBridge, ipcRenderer } from 'electron';
import type { DeclarativeFeatureSurface, FeatureActionRequest } from '../shared/feature-contracts.js';
import type { ShellSnapshot } from '../shared/contracts.js';

async function invoke<T>(channel: string, input: unknown): Promise<T> {
  const result = await ipcRenderer.invoke(channel, input) as { ok: boolean; value?: T; error?: { message?: string; code?: string } };
  if (!result.ok) { const error = new Error(result.error?.message || 'Feature 操作失败'); error.name = result.error?.code || 'FEATURE.ERROR'; throw error; }
  return result.value as T;
}

const api = Object.freeze({
  featureAction: (input: FeatureActionRequest): Promise<ShellSnapshot> => invoke('surface:feature-action', input),
  onBootstrap: (listener: (surface: DeclarativeFeatureSurface) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, surface: DeclarativeFeatureSurface) => listener(surface);
    ipcRenderer.on('feature:bootstrap', handler);
    return () => ipcRenderer.removeListener('feature:bootstrap', handler);
  }
});

contextBridge.exposeInMainWorld('featureSurface', api);

declare global {
  interface Window {
    featureSurface: typeof api;
  }
}

