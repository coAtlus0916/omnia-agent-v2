import { contextBridge, ipcRenderer } from 'electron';
import type {
  DeclarativeFeatureSurface,
  FeatureActionRequest,
  FeatureArtifactBytesInputRequest,
  FeatureArtifactDescriptor,
  FeatureArtifactInputRequest
} from '../shared/feature-contracts.js';
import type { ShellSnapshot } from '../shared/contracts.js';

async function invoke<T>(channel: string, input: unknown): Promise<T> {
  const result = await ipcRenderer.invoke(channel, input) as { ok: boolean; value?: T; error?: { message?: string; code?: string; interactionId?: string; traceId?: string; failurePoint?: string } };
  if (!result.ok) {
    const suffix = result.error?.interactionId ? `（交互 ID：${result.error.interactionId}）` : '';
    const error = Object.assign(new Error(`${result.error?.message || 'Feature 操作失败'}${suffix}`), {
      code: result.error?.code || 'FEATURE.ERROR', interactionId: result.error?.interactionId || '',
      traceId: result.error?.traceId || '', failurePoint: result.error?.failurePoint || ''
    });
    error.name = result.error?.code || 'FEATURE.ERROR'; throw error;
  }
  return result.value as T;
}

const api = Object.freeze({
  getHostContext: (): Promise<{ instanceId: string; placement: 'docked' | 'detached' | 'minimized' | 'closed' }> =>
    invoke('surface:get-self-context', undefined),
  dockToMain: (): Promise<{ instanceId: string; placement: 'docked' | 'detached' | 'minimized' | 'closed' }> =>
    invoke('surface:dock-self', undefined),
  featureAction: (input: FeatureActionRequest): Promise<ShellSnapshot> => invoke('surface:feature-action', input),
  chooseInput: (input: FeatureArtifactInputRequest): Promise<FeatureArtifactDescriptor | null> =>
    invoke('surface:choose-feature-input', input),
  importInputBytes: (input: FeatureArtifactBytesInputRequest): Promise<FeatureArtifactDescriptor> =>
    invoke('surface:import-feature-input-bytes', input),
  saveManagedAsset: (input: { featureId: string; featureVersion: string; actionId: string; memberPath: string }): Promise<{ saved: boolean }> =>
    invoke('surface:save-feature-managed-asset', input),
  saveArtifact: (input: { featureId: string; artifactId: string }): Promise<{ saved: boolean }> =>
    invoke('surface:save-feature-artifact', input),
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
