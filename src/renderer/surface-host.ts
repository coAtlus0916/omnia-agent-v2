/**
 * Shell-owned lifecycle for an isolated Feature surface.
 *
 * A placement change deliberately does not destroy the Feature instance. The
 * worker/Run is owned by Core and continues independently of whether the
 * surface is docked, detached, minimized or closed. Keeping this state in a
 * small, framework-free manager makes the invariant testable without a
 * browser and keeps Feature DOM/CSS/Store out of Shell code.
 */
export type SurfacePlacement = 'docked' | 'detached' | 'minimized' | 'closed';

export interface SurfaceInstance<T = unknown> {
  instanceId: string;
  featureId: string;
  contextKey: string;
  placement: SurfacePlacement;
  value?: T;
  openedAt: number;
  lastFocusedAt: number;
}

export interface SurfaceHostSnapshot<T = unknown> {
  instances: SurfaceInstance<T>[];
  activeInstanceId: string;
}

const now = () => Date.now();

export class SurfaceHost<T = unknown> {
  private readonly instances = new Map<string, SurfaceInstance<T>>();
  private activeInstanceId = '';

  private key(featureId: string, contextKey: string): string {
    return `${featureId}::${contextKey}`;
  }

  /** Open once per Feature + context. Existing windows are focused/restored. */
  open(featureId: string, contextKey: string, value?: T): SurfaceInstance<T> {
    const instanceId = this.key(featureId, contextKey);
    const timestamp = now();
    const existing = this.instances.get(instanceId);
    if (existing) {
      existing.placement = 'docked';
      existing.lastFocusedAt = timestamp;
      if (value !== undefined) existing.value = value;
      this.activeInstanceId = instanceId;
      return existing;
    }
    const instance: SurfaceInstance<T> = {
      instanceId,
      featureId,
      contextKey,
      placement: 'docked',
      openedAt: timestamp,
      lastFocusedAt: timestamp
    };
    if (value !== undefined) instance.value = value;
    this.instances.set(instanceId, instance);
    this.activeInstanceId = instanceId;
    return instance;
  }

  /** Update the latest declarative snapshot without changing placement. */
  update(featureId: string, contextKey: string, value: T): SurfaceInstance<T> | undefined {
    const instance = this.instances.get(this.key(featureId, contextKey));
    if (!instance) return undefined;
    instance.value = value;
    return instance;
  }

  focus(instanceId: string): SurfaceInstance<T> | undefined {
    const instance = this.instances.get(instanceId);
    if (!instance) return undefined;
    if (instance.placement === 'closed' || instance.placement === 'minimized') instance.placement = 'docked';
    instance.lastFocusedAt = now();
    this.activeInstanceId = instanceId;
    return instance;
  }

  focusFeature(featureId: string, contextKey: string): SurfaceInstance<T> | undefined {
    return this.focus(this.key(featureId, contextKey));
  }

  detach(instanceId: string): SurfaceInstance<T> | undefined {
    const instance = this.instances.get(instanceId);
    if (!instance || instance.placement === 'closed') return undefined;
    instance.placement = 'detached';
    instance.lastFocusedAt = now();
    this.activeInstanceId = instanceId;
    return instance;
  }

  minimize(instanceId: string): SurfaceInstance<T> | undefined {
    const instance = this.instances.get(instanceId);
    if (!instance || instance.placement === 'closed') return undefined;
    instance.placement = 'minimized';
    instance.lastFocusedAt = now();
    if (this.activeInstanceId === instanceId) this.activeInstanceId = '';
    return instance;
  }

  restore(instanceId: string): SurfaceInstance<T> | undefined {
    return this.focus(instanceId);
  }

  /** Close only the Shell surface; the instance and worker state remain. */
  close(instanceId: string): SurfaceInstance<T> | undefined {
    const instance = this.instances.get(instanceId);
    if (!instance) return undefined;
    instance.placement = 'closed';
    instance.lastFocusedAt = now();
    if (this.activeInstanceId === instanceId) this.activeInstanceId = '';
    return instance;
  }

  get(instanceId: string): SurfaceInstance<T> | undefined {
    return this.instances.get(instanceId);
  }

  getByFeature(featureId: string): SurfaceInstance<T>[] {
    return [...this.instances.values()].filter((instance) => instance.featureId === featureId);
  }

  get active(): SurfaceInstance<T> | undefined {
    return this.instances.get(this.activeInstanceId);
  }

  snapshot(): SurfaceHostSnapshot<T> {
    return {
      instances: [...this.instances.values()].map((instance) => ({ ...instance })),
      activeInstanceId: this.activeInstanceId
    };
  }
}
