import type { BridgePairingCapabilityInspection, RemoteConnectorDiagnostics } from './bridge-contracts.js';

export type ConnectionStatus =
  | 'not_configured'
  | 'not_connected'
  | 'bridge_connecting'
  | 'connected'
  | 'connector_offline'
  | 'connector_incompatible'
  | 'browser_starting'
  | 'waiting_login'
  | 'waiting_pack'
  | 'waiting_authorization'
  | 'identifying_pack'
  | 'target_closed'
  | 'multiple_targets'
  | 'identity_changed'
  | 'timed_out'
  | 'cancelled'
  | 'repair_required'
  | 'error';

export interface ConnectionSnapshot {
  transport: 'remote';
  adapter: 'v5_remote_connector' | 'connector_next_v3';
  adapterAvailable: boolean;
  adapterReason: string;
  remoteAvailable: boolean;
  remoteReason: string;
  bridgeOnline: boolean;
  connectorOnline: boolean;
  protocolCompatible: boolean;
  bindingState: 'unpaired' | 'pairing' | 'bound' | 'repair_required' | 'revoked';
  status: ConnectionStatus;
  connected: boolean;
  connecting: boolean;
  connectorId: string;
  connectorName: string;
  connectorVersion: string;
  remoteDiagnostics?: RemoteConnectorDiagnostics | null;
  sessionGeneration?: number;
  authorityInstanceId?: string;
  tenantOrOrgId?: string;
  packId?: string;
  engagementId: string;
  engagementName: string;
  clientName: string;
  checkedAt: string;
  message: string;
}

export interface KeepaliveSnapshot {
  enabled: boolean;
  running: boolean;
  intervalSeconds: number;
  enabledAt: string;
  lastAttemptAt: string;
  lastSuccessAt: string;
  lastError: string;
  nextAttemptAt: string;
}

export interface WorkspaceSection {
  id: string;
  name: string;
  order: number;
}

export interface WorkspaceItem {
  id: string;
  parentSectionId: string;
  name: string;
  status: string;
}

export interface WorkspaceObservation {
  observationId: string;
  profile: 'workspace_light_read';
  authorityId: string;
  connectorId: string;
  sessionGeneration: number;
  authorityInstanceId: string;
  tenantOrOrgId: string;
  packId: string;
  engagementId: string;
  capturedAt: string;
  source: string;
  coverage: 'full';
  sections: WorkspaceSection[];
  workspaces: WorkspaceItem[];
}

export interface WorkspaceDirectorySnapshot {
  available: boolean;
  reasonCode: '' | 'not_connected' | 'authority_hierarchy_unavailable' | 'dependency_unavailable' | 'read_failed';
  reason: string;
  observation: WorkspaceObservation | null;
}

export interface WorkspaceSafetySnapshot {
  enabled: boolean;
  globalEnabled: boolean;
  globalSectionIds: string[];
  /** Live Core projection from the latest authority observation; never persisted as authority. */
  globalWorkspaceIds: string[];
  connectorId: string;
  sessionGeneration: number;
  authorityInstanceId: string;
  tenantOrOrgId: string;
  packId: string;
  engagementId: string;
  workspaceIds: string[];
  authorityObservationId: string;
  stateVersion: number;
  updatedAt: string;
  validForCurrentConnection: boolean;
  invalidReason: string;
  /**
   * The single recovery action the Surface should offer for a safety lock that
   * is no longer valid for the current connection. Projected by the Shell from
   * the same state machine that computes `validForCurrentConnection`; the
   * Renderer never re-derives this from raw identity fields. Optional at the
   * persistence boundary (defaults to `none`); the Shell projection always sets it.
   */
  recovery?: 'none' | 'rebind' | 'reconfigure';
}

export type MessageRole = 'user' | 'assistant';
export type MessageStatus = 'sending' | 'stored' | 'provider_unavailable' | 'failed' | 'delivered';

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  error: string;
  createdAt: string;
  attachments: ChatAttachment[];
}

export type AttachmentStatus = 'staged' | 'attached' | 'removed' | 'failed';
export interface ChatAttachment {
  id: string;
  messageId: string;
  name: string;
  mediaType: string;
  size: number;
  sha256: string;
  status: AttachmentStatus;
  modelDelivery: 'not_attempted' | 'sent' | 'blocked' | 'unconfirmed';
  error: string;
  previewable: boolean;
  createdAt: string;
}

export interface ChatSnapshot {
  sessionId: string;
  providerStatus: 'ready' | 'unconfigured' | 'invalid';
  providerReason: string;
  messages: ChatMessage[];
  stagedAttachments: ChatAttachment[];
  composerHeightPx: number;
}

export type AiProviderKind = 'deepseek' | 'custom';
export type AiAttachmentCapability = 'text_only' | 'images' | 'images_and_text';
export interface AiSettingsSnapshot {
  provider: AiProviderKind;
  baseUrl: string;
  model: string;
  attachmentCapability: AiAttachmentCapability;
  hasApiKey: boolean;
  stateVersion: number;
  updatedAt: string;
  testStatus: 'untested' | 'testing' | 'success' | 'failed';
  testMessage: string;
  testedAt: string;
}

export interface ConnectionSettingsSnapshot {
  bindingState: 'unpaired' | 'bound' | 'repair_required' | 'revoked';
  remotePaired: boolean;
  connectorId: string;
  connectorName: string;
  connectorVersion: string;
  protocolVersion: string;
  generation: number;
  stateVersion: number;
  updatedAt: string;
}

export interface SettingsSnapshot {
  ai: AiSettingsSnapshot;
  connection: ConnectionSettingsSnapshot;
}

export interface RemotePairingSnapshot {
  state: 'idle' | 'waiting' | 'candidate' | 'matched' | 'expired' | 'failed';
  pairingCode: string;
  expiresAt: string;
  message: string;
}

export interface UserViewPreference {
  uiScalePercent: number;
  stateVersion: number;
  updatedAt: string;
}

export interface LayoutPreference {
  schemaVersion: 'omnia.layout-preference/v1';
  surfaceId: 'shell.main';
  /** v3 is the fixed-Rail shell contract. Rail width is intentionally absent. */
  layoutVersion: 3;
  splitters: { 'feature-menu-host': number };
  collapsedPanels: { 'feature-menu': boolean };
  featureNavigationBasisPoints: number;
  /** Read-only aliases for v1 callers during migration; never accepted by v3 actions. */
  readonly railBasisPoints?: number;
  readonly middleBasisPoints?: number;
  readonly featureNavigationCollapsed?: boolean;
  stateVersion: number;
  updatedAt: string;
}

export interface SettingsLayoutPreference {
  schemaVersion: 'omnia.layout-preference/v1';
  surfaceId: 'settings.main';
  layoutVersion: 1;
  splitters: { 'settings-navigation-content': number };
  settingsNavigationBasisPoints: number;
  stateVersion: number;
  updatedAt: string;
}

export interface DockedSurfaceVisibilityInput {
  activeInstanceId: string | null;
  overlayActive: boolean;
}

export interface DockedSurfaceManagerSnapshot {
  activeInstanceId: string | null;
  overlayActive: boolean;
  attachedInstanceIds: string[];
  dockedInstanceIds: string[];
  detachedInstanceIds: string[];
  authorizedSenderInstanceIds: string[];
  hostBoundsByInstance: Record<string, { x: number; y: number; width: number; height: number }>;
  zoomFactor: number;
}

export interface FeatureSurfaceFocusResult {
  instanceId: string;
  placement: 'docked' | 'detached';
  attached: boolean;
  manager: DockedSurfaceManagerSnapshot;
}

export interface ShellSnapshot {
  schemaVersion: 'omnia.shell-home/v1';
  generatedAt: string;
  productVersion: string;
  featureCount: number;
  features: import('./feature-contracts.js').FeatureRuntimeSnapshot;
  connection: ConnectionSnapshot;
  keepalive: KeepaliveSnapshot;
  workspaceDirectory: WorkspaceDirectorySnapshot;
  safety: WorkspaceSafetySnapshot;
  chat: ChatSnapshot;
  preference: UserViewPreference;
  layout: LayoutPreference;
  settingsLayout: SettingsLayoutPreference;
  settings: SettingsSnapshot;
  bridgePairing: BridgePairingCapabilityInspection;
  remotePairing: RemotePairingSnapshot;
}

export interface ShellApi {
  getSnapshot(): Promise<ShellSnapshot>;
  connect(): Promise<ShellSnapshot>;
  cancelConnect(): Promise<ShellSnapshot>;
  refresh(): Promise<ShellSnapshot>;
  setKeepalive(enabled: boolean): Promise<ShellSnapshot>;
  refreshWorkspaceDirectory(): Promise<ShellSnapshot>;
  saveSafety(input: {
    enabled: boolean;
    globalEnabled?: boolean;
    globalSectionIds?: string[];
    workspaceIds: string[];
    expectedStateVersion: number;
  }): Promise<ShellSnapshot>;
  sendMessage(input: { content: string; attachmentIds: string[] }): Promise<ShellSnapshot>;
  chooseAttachments(): Promise<ShellSnapshot>;
  removeAttachment(id: string): Promise<ShellSnapshot>;
  previewAttachment(id: string): Promise<void>;
  saveComposerHeight(input: { heightPx: number }): Promise<ShellSnapshot>;
  saveAiSettings(input: {
    provider: AiProviderKind;
    baseUrl: string;
    model: string;
    attachmentCapability: AiAttachmentCapability;
    apiKey?: string;
    clearApiKey?: boolean;
    expectedStateVersion: number;
  }): Promise<ShellSnapshot>;
  testAiProvider(): Promise<ShellSnapshot>;
  diagnoseRemoteConnection(): Promise<ShellSnapshot>;
  beginRemotePairing(input: { repair: boolean; confirmed?: boolean; expectedStateVersion: number }): Promise<ShellSnapshot>;
  pollRemotePairing(): Promise<ShellSnapshot>;
  cancelRemotePairing(): Promise<ShellSnapshot>;
  revokeRemoteBinding(input: { confirmed: boolean; expectedStateVersion: number }): Promise<ShellSnapshot>;
  saveScale(input: { percent: number; expectedStateVersion: number }): Promise<ShellSnapshot>;
  saveLayout(input: {
    featureNavigationBasisPoints: number;
    featureNavigationCollapsed: boolean;
    expectedStateVersion: number;
  }): Promise<ShellSnapshot>;
  saveSettingsLayout(input: {
    settingsNavigationBasisPoints: number;
    expectedStateVersion: number;
  }): Promise<ShellSnapshot>;
  selectFeature(input: { featureId: string }): Promise<ShellSnapshot>;
  featureAction(input: import('./feature-contracts.js').FeatureActionRequest): Promise<ShellSnapshot>;
  queryInteractionLogs(input: import('./interaction-log-contracts.js').InteractionLogQuery): Promise<import('./interaction-log-contracts.js').InteractionLogPage>;
  getInteractionTrace(traceId: string): Promise<import('./interaction-log-contracts.js').InteractionLogTrace>;
  openFeatureSurface?(input: {
    instanceId: string;
    featureId: string;
    featureVersion: string;
    surfaceId: string;
    placement: 'docked' | 'detached' | 'minimized';
    bounds?: { x: number; y: number; width: number; height: number };
  }): Promise<{ instanceId: string; placement: 'docked' | 'detached' | 'minimized' | 'closed'; attached: boolean; reason: string; surfaceStateVersion: number }>;
  focusFeatureSurface?(instanceId: string): Promise<FeatureSurfaceFocusResult>;
  resizeFeatureSurface?(input: { instanceId: string; bounds: { x: number; y: number; width: number; height: number } }): Promise<void>;
  closeFeatureSurface?(instanceId: string): Promise<void>;
  minimizeFeatureSurface?(instanceId: string): Promise<void>;
  restoreFeatureSurface?(instanceId: string): Promise<void>;
  setDockedSurfaceVisibility?(input: DockedSurfaceVisibilityInput): Promise<DockedSurfaceManagerSnapshot>;
  getSurfaceManagerSnapshot?(): Promise<DockedSurfaceManagerSnapshot>;
  onFeatureDocked?(listener: (instanceId: string) => void): () => void;
  onFeatureBootstrap?(listener: (surface: import('./feature-contracts.js').DeclarativeFeatureSurface) => void): () => void;
  onChanged(listener: (snapshot: ShellSnapshot) => void): () => void;
}
