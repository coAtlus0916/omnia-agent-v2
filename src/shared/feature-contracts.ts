export type FeatureAvailability =
  | 'available'
  | 'disabled'
  | 'unhealthy'
  | 'incompatible'
  | 'unauthorized'
  | 'unknown';

export interface FeatureNavigationLeaf {
  id: string;
  parentId: string;
  level: 2 | 3;
  label: string;
  order: number;
  featureId: string;
  featureVersion: string;
  route: string;
  availability: FeatureAvailability;
  reason: string;
}

export interface FeatureNavigationGroup {
  id: string;
  parentId: string | null;
  level: 1 | 2;
  label: string;
  order: number;
}

export interface DeclarativeFeatureItem {
  id: string;
  scopeId: string;
  type: string;
  title: string;
  subtitle: string;
  selectable: boolean;
  disabledReason: string;
  concurrencyToken: string;
}

export interface DeclarativeFeatureScope {
  id: string;
  parentId: string;
  label: string;
  parentLabel: string;
  selected: boolean;
}

export interface DeclarativeFeatureAction {
  actionId: string;
  label: string;
  effect: 'read_only' | 'local_state_write' | 'omnia_mutation';
  enabled: boolean;
  reason: string;
  selectionMode?: 'none' | 'single' | 'multiple';
}

export interface FeatureMessageCard {
  messageId: string;
  featureId: string;
  featureVersion: string;
  surfaceId: string;
  runId: string;
  confirmationId: string;
  stateVersion: number;
  state: 'pending_confirmation' | 'executing' | 'completed' | 'failed' | 'cancelled' | 'uncertain';
  title: string;
  summary: string;
  details: Array<{ label: string; value: string }>;
  actions: DeclarativeFeatureAction[];
}

export interface DeclarativeFeatureSurface {
  schemaVersion: 'omnia.declarative-feature-surface/v1';
  featureId: string;
  featureVersion: string;
  surfaceId: string;
  stateVersion: number;
  title: string;
  description: string;
  density: 'compact';
  status: 'idle' | 'loading' | 'ready' | 'empty' | 'blocked' | 'error' | 'stale';
  statusMessage: string;
  scopes: DeclarativeFeatureScope[];
  items: DeclarativeFeatureItem[];
  selectedItemIds: string[];
  search: string;
  actions: DeclarativeFeatureAction[];
}

export interface FeatureRuntimeSnapshot {
  schemaVersion: 'omnia.feature-runtime-snapshot/v1';
  snapshotId: string;
  stateVersion: number;
  groups: FeatureNavigationGroup[];
  navigation: FeatureNavigationLeaf[];
  selectedFeatureId: string;
  surface: DeclarativeFeatureSurface | null;
  messageCards: FeatureMessageCard[];
}

export interface FeatureActionRequest {
  featureId: string;
  featureVersion: string;
  surfaceId: string;
  actionId: string;
  expectedStateVersion: number;
  payload: Record<string, unknown>;
}
