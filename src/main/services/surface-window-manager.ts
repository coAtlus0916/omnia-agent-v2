import { BrowserWindow, WebContentsView } from 'electron';
import path from 'node:path';
import type { DeclarativeFeatureSurface, FeatureActionRequest, FeatureArtifactInputRequest } from '../../shared/feature-contracts.js';
import type { ShellSnapshot } from '../../shared/contracts.js';
import type { DockedSurfaceManagerSnapshot, DockedSurfaceVisibilityInput } from '../../shared/contracts.js';

export type SurfacePlacement = 'docked' | 'detached' | 'minimized' | 'closed';
export interface SurfaceOpenInput {
  instanceId: string;
  featureId: string;
  featureVersion: string;
  surfaceId: string;
  placement: 'docked' | 'detached' | 'minimized';
  bounds?: { x: number; y: number; width: number; height: number };
}
export interface SurfaceSelfContext {
  instanceId: string;
  placement: SurfacePlacement;
}
interface SurfaceWindowState extends Omit<SurfaceOpenInput, 'placement'> {
  placement: SurfacePlacement;
  view: WebContentsView | null;
  window: BrowserWindow | null;
  attached: boolean;
  bounds: { x: number; y: number; width: number; height: number };
}

/** Main-process owner of isolated Feature WebContents and native windows. */
export class SurfaceWindowManager {
  private readonly states = new Map<string, SurfaceWindowState>();
  private readonly senderInstances = new Map<number, string>();
  private readonly featureHtml: string;
  private activeDockedInstanceId: string | null = null;
  private overlayActive = false;
  private zoomFactor = 1;

  constructor(
    private readonly shellWindow: BrowserWindow,
    private readonly preloadPath: string,
    rendererDirectory: string,
    private readonly getSnapshot: () => ShellSnapshot,
    private readonly invokeFeatureAction: (request: FeatureActionRequest) => Promise<ShellSnapshot>
  ) {
    this.featureHtml = path.join(rendererDirectory, 'feature-window.html');
  }

  dispose(): void {
    this.activeDockedInstanceId = null;
    this.overlayActive = true;
    for (const state of this.states.values()) this.close(state.instanceId);
    this.states.clear();
    this.senderInstances.clear();
  }

  private currentSurface(input: Pick<SurfaceOpenInput, 'featureId' | 'featureVersion' | 'surfaceId'>): DeclarativeFeatureSurface | null {
    const surface = this.getSnapshot().features.surface;
    if (!surface || surface.featureId !== input.featureId || surface.featureVersion !== input.featureVersion || surface.surfaceId !== input.surfaceId) return null;
    return surface;
  }

  private webPreferences(partition: string): Electron.WebPreferences {
    return {
      preload: this.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      partition
    };
  }

  private bootstrap(state: SurfaceWindowState, surface: DeclarativeFeatureSurface): void {
    const target = state.view?.webContents || state.window?.webContents;
    if (!target || target.isDestroyed()) return;
    target.send('feature:bootstrap', surface);
  }

  private bootstrapMatching(surface: DeclarativeFeatureSurface): void {
    for (const state of this.states.values()) {
      if (
        state.placement !== 'closed'
        && state.featureId === surface.featureId
        && state.featureVersion === surface.featureVersion
        && state.surfaceId === surface.surfaceId
      ) this.bootstrap(state, surface);
    }
  }

  private async load(state: SurfaceWindowState, surface: DeclarativeFeatureSurface): Promise<void> {
    const contents = state.view?.webContents || state.window?.webContents;
    if (!contents) return;
    this.senderInstances.set(contents.id, state.instanceId);
    contents.once('destroyed', () => {
      if (this.senderInstances.get(contents.id) === state.instanceId) this.senderInstances.delete(contents.id);
    });
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.setZoomFactor(this.zoomFactor);
    contents.on('will-navigate', (event, url) => {
      if (!url.startsWith('file://')) event.preventDefault();
    });
    contents.on('render-process-gone', () => {
      if (this.senderInstances.get(contents.id) === state.instanceId) this.senderInstances.delete(contents.id);
      if (state.view?.webContents === contents) {
        this.detachDocked(state);
        state.view = null;
      }
    });
    await contents.loadFile(this.featureHtml);
    // A persisted partition may restore its previous origin zoom while loading.
    // The Core preference always wins for both reused and newly created surfaces.
    contents.setZoomFactor(this.zoomFactor);
    this.bootstrap(state, surface);
  }

  private destroyDocked(state: SurfaceWindowState): void {
    if (!state.view) return;
    this.detachDocked(state);
    this.senderInstances.delete(state.view.webContents.id);
    state.view.webContents.close();
    state.view = null;
  }

  private detachDocked(state: SurfaceWindowState): void {
    if (!state.view || !state.attached) return;
    try { this.shellWindow.contentView.removeChildView(state.view); } catch { /* idempotent during teardown */ }
    state.attached = false;
  }

  private attachDocked(state: SurfaceWindowState): void {
    if (!state.view || state.view.webContents.isDestroyed() || state.attached || this.shellWindow.isDestroyed()) return;
    for (const other of this.states.values()) {
      if (other !== state) this.detachDocked(other);
    }
    this.shellWindow.contentView.addChildView(state.view);
    state.attached = true;
    state.view.setBounds(this.toHostBounds(state.bounds));
  }

  private toHostBounds(bounds: { x: number; y: number; width: number; height: number }): { x: number; y: number; width: number; height: number } {
    // Renderer measurements are CSS pixels. contentView uses BrowserWindow DIP;
    // Electron page zoom scales CSS pixels into DIP, so convert exactly once.
    return {
      x: Math.round(bounds.x * this.zoomFactor),
      y: Math.round(bounds.y * this.zoomFactor),
      width: Math.max(1, Math.round(bounds.width * this.zoomFactor)),
      height: Math.max(1, Math.round(bounds.height * this.zoomFactor))
    };
  }

  private destroyDetached(state: SurfaceWindowState): void {
    if (!state.window || state.window.isDestroyed()) { state.window = null; return; }
    this.senderInstances.delete(state.window.webContents.id);
    state.window.destroy();
    state.window = null;
  }

  private async createDocked(state: SurfaceWindowState, surface: DeclarativeFeatureSurface, bounds?: { x: number; y: number; width: number; height: number }): Promise<void> {
    state.view = new WebContentsView({ webPreferences: this.webPreferences(`persist:omnia-feature-${state.instanceId}`) });
    state.attached = false;
    state.bounds = bounds || { x: 0, y: 0, width: 1, height: 1 };
    state.view.setBounds(this.toHostBounds(state.bounds));
    state.placement = 'docked';
    await this.load(state, surface);
    this.reconcileDockedViews();
  }

  private async createDetached(state: SurfaceWindowState, surface: DeclarativeFeatureSurface, minimized = false): Promise<void> {
    const featureWindow = new BrowserWindow({ width: 760, height: 620, minWidth: 480, minHeight: 320, show: false, autoHideMenuBar: true,
      webPreferences: this.webPreferences(`persist:omnia-feature-${state.instanceId}`) });
    state.window = featureWindow;
    const contents = featureWindow.webContents;
    const cleanup = (): void => {
      if (this.senderInstances.get(contents.id) === state.instanceId) this.senderInstances.delete(contents.id);
      if (state.window === featureWindow) {
        state.placement = 'closed';
        state.window = null;
      }
    };
    featureWindow.once('closed', cleanup);
    contents.once('destroyed', cleanup);
    contents.once('render-process-gone', () => {
      if (!featureWindow.isDestroyed()) featureWindow.destroy();
      cleanup();
    });
    state.placement = minimized ? 'minimized' : 'detached';
    contents.setZoomFactor(this.zoomFactor);
    await this.load(state, surface);
    if (state.window !== featureWindow || featureWindow.isDestroyed()) return;
    featureWindow.show();
    if (minimized) featureWindow.minimize();
  }

  async featureAction(senderId: number, request: FeatureActionRequest): Promise<ShellSnapshot> {
    const instanceId = this.senderInstances.get(senderId);
    const state = instanceId ? this.states.get(instanceId) : undefined;
    if (!state || state.placement === 'closed' || state.featureId !== request.featureId ||
      state.featureVersion !== request.featureVersion || state.surfaceId !== request.surfaceId) {
      throw new Error('Feature Surface context is not authorized or has drifted.');
    }
    try {
      const snapshot = await this.invokeFeatureAction(request);
      const next = snapshot.features.surface;
      if (next && next.featureId === request.featureId && next.featureVersion === request.featureVersion
        && next.surfaceId === request.surfaceId) this.bootstrapMatching(next);
      return snapshot;
    } catch (error) {
      const latest = this.currentSurface(state);
      if (latest) this.bootstrapMatching(latest);
      throw error;
    }
  }

  selfContext(senderId: number): SurfaceSelfContext {
    const instanceId = this.senderInstances.get(senderId);
    const state = instanceId ? this.states.get(instanceId) : undefined;
    if (!state || state.placement === 'closed') throw new Error('Feature Surface sender is not authorized.');
    return { instanceId: state.instanceId, placement: state.placement };
  }

  dockFromSender(senderId: number): SurfaceSelfContext {
    const context = this.selfContext(senderId);
    const state = this.states.get(context.instanceId)!;
    if (state.placement !== 'detached' && state.placement !== 'minimized') {
      throw new Error('Only a detached Feature Surface can be docked to the Shell.');
    }
    setTimeout(() => { void this.performDock(state); }, 0);
    return context;
  }

  private async performDock(state: SurfaceWindowState): Promise<void> {
    const surface = this.currentSurface(state);
    if (!surface || state.placement === 'closed') return;
    this.destroyDetached(state);
    if (!state.view) await this.createDocked(state, surface, state.bounds);
    else state.placement = 'docked';
    this.activeDockedInstanceId = state.instanceId;
    this.overlayActive = false;
    this.reconcileDockedViews();
    if (!this.shellWindow.isDestroyed()) this.shellWindow.webContents.send('surface:docked', state.instanceId);
  }

  authorizeArtifactInput(senderId: number, request: FeatureArtifactInputRequest): void {
    const instanceId = this.senderInstances.get(senderId);
    const state = instanceId ? this.states.get(instanceId) : undefined;
    if (!state || state.placement === 'closed' || state.featureId !== request.featureId
      || state.featureVersion !== request.featureVersion || state.surfaceId !== request.surfaceId) {
      throw new Error('Feature artifact input context is not authorized or has drifted.');
    }
    const current = this.currentSurface(state);
    const action = current?.actions.find((candidate) => candidate.actionId === request.actionId);
    if (!current || !action || action.input?.kind !== 'open_file' || !action.enabled
      || (current.workflow && current.workflow.currentStepId !== 'upload')) {
      if (current) this.bootstrapMatching(current);
      throw new Error('当前 Feature 已进入校验或回传步骤；请先点击“返回上传”再选择文件。');
    }
  }

  authorizeArtifactExport(senderId: number, featureId: string): void {
    const instanceId = this.senderInstances.get(senderId);
    const state = instanceId ? this.states.get(instanceId) : undefined;
    if (!state || state.placement === 'closed' || state.featureId !== featureId) {
      throw new Error('Feature artifact export context is not authorized or has drifted.');
    }
  }

  async open(input: SurfaceOpenInput): Promise<{ instanceId: string; placement: SurfacePlacement; attached: boolean; reason: string }> {
    const surface = this.currentSurface(input);
    if (!surface) return { instanceId: input.instanceId, placement: 'closed', attached: false, reason: 'FeatureContext 已漂移，请从 Registry 重新打开。' };
    const existing = this.states.get(input.instanceId);
    if (existing) {
      existing.featureId = input.featureId;
      existing.featureVersion = input.featureVersion;
      existing.surfaceId = input.surfaceId;
      if (input.placement === 'docked') {
        if (existing.window) this.destroyDetached(existing);
        if (!existing.view) await this.createDocked(existing, surface, input.bounds);
        else {
          existing.bounds = input.bounds || existing.bounds;
          existing.view.setBounds(this.toHostBounds(existing.bounds));
          existing.placement = 'docked';
          this.bootstrap(existing, surface);
          this.reconcileDockedViews();
        }
      } else if (input.placement === 'detached') {
        if (existing.view) this.destroyDocked(existing);
        if (!existing.window) await this.createDetached(existing, surface);
        else { existing.window.show(); existing.window.focus(); existing.placement = 'detached'; this.bootstrap(existing, surface); }
      } else {
        if (existing.view) this.destroyDocked(existing);
        if (!existing.window) await this.createDetached(existing, surface, true);
        else { existing.window.show(); existing.window.minimize(); existing.placement = 'minimized'; this.bootstrap(existing, surface); }
      }
      return { instanceId: existing.instanceId, placement: existing.placement, attached: existing.placement !== 'docked' || existing.attached, reason: '' };
    }
    const state: SurfaceWindowState = {
      ...input,
      placement: input.placement,
      view: null,
      window: null,
      attached: false,
      bounds: input.bounds || { x: 0, y: 0, width: 1, height: 1 }
    };
    this.states.set(input.instanceId, state);
    if (input.placement === 'docked') await this.createDocked(state, surface, input.bounds);
    else await this.createDetached(state, surface, input.placement === 'minimized');
    return { instanceId: state.instanceId, placement: state.placement, attached: state.placement !== 'docked' || state.attached, reason: '' };
  }

  resize(instanceId: string, bounds: { x: number; y: number; width: number; height: number }): void {
    const state = this.states.get(instanceId);
    if (!state || state.placement !== 'docked') return;
    state.bounds = bounds;
    if (state.view && state.attached && this.activeDockedInstanceId === instanceId && !this.overlayActive) {
      state.view.setBounds(this.toHostBounds(bounds));
    }
  }

  setDockedVisibility(input: DockedSurfaceVisibilityInput): DockedSurfaceManagerSnapshot {
    this.activeDockedInstanceId = input.activeInstanceId;
    this.overlayActive = Boolean(input.overlayActive);
    this.reconcileDockedViews();
    return this.snapshot();
  }

  setZoomFactor(factor: number): DockedSurfaceManagerSnapshot {
    if (!Number.isFinite(factor) || factor < 0.8 || factor > 1.3) return this.snapshot();
    this.zoomFactor = factor;
    for (const state of this.states.values()) {
      const contents = state.view?.webContents || state.window?.webContents;
      if (contents && !contents.isDestroyed()) contents.setZoomFactor(factor);
    }
    this.reconcileDockedViews();
    return this.snapshot();
  }

  snapshot(): DockedSurfaceManagerSnapshot {
    return {
      activeInstanceId: this.activeDockedInstanceId,
      overlayActive: this.overlayActive,
      attachedInstanceIds: [...this.states.values()].filter((state) => state.attached).map((state) => state.instanceId),
      dockedInstanceIds: [...this.states.values()].filter((state) => state.placement === 'docked').map((state) => state.instanceId),
      detachedInstanceIds: [...this.states.values()].filter((state) => state.placement === 'detached' || state.placement === 'minimized').map((state) => state.instanceId),
      authorizedSenderInstanceIds: [...new Set(this.senderInstances.values())],
      hostBoundsByInstance: Object.fromEntries([...this.states.values()]
        .filter((state) => state.placement === 'docked')
        .map((state) => [state.instanceId, this.toHostBounds(state.bounds)])),
      zoomFactor: this.zoomFactor
    };
  }

  private reconcileDockedViews(): void {
    const allowed = this.overlayActive ? null : this.activeDockedInstanceId;
    for (const state of this.states.values()) {
      if (allowed && state.instanceId === allowed && state.placement === 'docked') this.attachDocked(state);
      else this.detachDocked(state);
    }
  }

  close(instanceId: string): void {
    const state = this.states.get(instanceId);
    if (!state) return;
    this.destroyDocked(state);
    this.destroyDetached(state);
    state.placement = 'closed';
    if (this.activeDockedInstanceId === instanceId) this.activeDockedInstanceId = null;
  }

  async minimize(instanceId: string): Promise<void> {
    const state = this.states.get(instanceId);
    if (!state) return;
    if (state.window && !state.window.isDestroyed()) { state.window.minimize(); state.placement = 'minimized'; return; }
    const surface = this.currentSurface(state);
    if (!surface) { state.placement = 'closed'; return; }
    this.destroyDocked(state);
    await this.createDetached(state, surface, true);
  }

  restore(instanceId: string): void {
    const state = this.states.get(instanceId);
    if (!state) return;
    if (state.window && !state.window.isDestroyed()) { state.window.restore(); state.window.show(); state.window.focus(); state.placement = 'detached'; return; }
    state.placement = 'docked';
    this.reconcileDockedViews();
  }
}
