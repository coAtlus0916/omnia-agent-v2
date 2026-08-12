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
  parentId: string | null;
  label: string;
  parentLabel: string;
  selected: boolean;
  /** Present for hierarchical authority catalogs such as Section → Workspace → element type. */
  kind?: 'section' | 'workspace' | 'element_type';
  level?: 1 | 2 | 3;
  initialExpanded?: boolean;
  disabledReason?: string;
}

export interface DeclarativeSelectionBrowser {
  schemaVersion: 'omnia.declarative-selection-browser/v1';
  /**
   * A declarative workbench arrangement for real authority catalogs.  The
   * Renderer owns only geometry; status and actions remain Feature-projected
   * state/actions.
   */
  layout?: {
    schemaVersion: 'omnia.selection-browser-layout/v1';
    mode: 'standard' | 'fixed_footer_split';
  };
  hierarchyLabel: string;
  resultsLabel: string;
  searchPlaceholder: string;
  emptyMessage: string;
  allScopesLabel: string;
  selectVisibleLabel: string;
  clearSelectionLabel: string;
  /** Ordered, real Feature actions rendered in the sticky workbench footer. */
  footerActionIds: string[];
  primaryActionId: string;
}

export interface DeclarativeFeatureAction {
  actionId: string;
  label: string;
  effect: 'read_only' | 'local_state_write' | 'omnia_mutation';
  /** False removes the action and any associated input from the rendered Surface. */
  visible?: boolean;
  enabled: boolean;
  reason: string;
  presentation?: 'default' | 'record' | 'pause' | 'stop' | 'export' | 'refresh' | 'recover' | 'restart' | 'upload' | 'return' | 'file_input' | 'background';
  /** Signed copy and workflow target shown only while this exact action is executing. */
  pendingPresentation?: DeclarativeFeatureActionPendingPresentation;
  selectionMode?: 'none' | 'single' | 'multiple';
  dependencies?: Array<'remote_connector' | 'safety_lock' | 'verified_canary'>;
  canaryCapability?: {
    scenarioId: string;
    capabilityId: string;
  };
  input?: DeclarativeFeatureActionInput;
  output?: {
    kind: 'save_managed_asset';
    memberPath: string;
    suggestedName: string;
  };
}

export interface DeclarativeFeatureActionPendingPresentation {
  schemaVersion: 'omnia.declarative-action-pending-presentation/v1';
  title: string;
  message: string;
  /** Must identify one step in the same signed Surface workflow. */
  workflowStepId: string;
}

/**
 * Signed, Shell-owned lifecycle dispatch. The referenced action remains a
 * normal Feature Worker action; Shell only decides when to invoke it.
 */
export interface DeclarativeFeatureSurfaceLifecycle {
  schemaVersion: 'omnia.declarative-feature-surface-lifecycle/v1';
  /** Runs only when an existing instance transitions from closed to open. */
  onReopenActionId: string;
}

export type DeclarativeFeatureActionInput =
  | {
    kind: 'open_file';
    accept: string[];
    label: string;
  }
  | {
    /** A backend-owned boolean setting submitted with this action's payload. */
    kind: 'toggle';
    fieldKey: string;
    label: string;
    defaultValue: boolean;
    /** Optional authoritative value returned by the backend for this projection. */
    value?: boolean;
  };

export interface LegacyReturnRecoveryInspectionRequest {
  schemaVersion: 'omnia.feature-return-recovery-inspection/v1';
  /** Empty discovers the sole eligible legacy Run for the calling Feature. */
  runId: string;
  /** Empty discovers the immutable source Feature version from that Run. */
  sourceFeatureVersion: string;
}

export interface LegacyReturnRecoveryAuthorizationRequest {
  schemaVersion: 'omnia.feature-return-recovery-authorization-request/v1';
  runId: string;
  sourceFeatureVersion: string;
  expectedStateRevision: number;
  connectorBinding: Record<string, unknown>;
  safetyLock: Record<string, unknown>;
}

export interface LegacyReturnRecoveryReceiptContext {
  schemaVersion: 'omnia.feature-return-recovery-receipt-context/v1';
  authorizationId: string;
  runId: string;
  commandId: string;
}

export interface LegacyReturnRecoveryOutcomeRequest {
  schemaVersion: 'omnia.feature-return-recovery-outcome/v1';
  authorizationId: string;
  runId: string;
  commandId: string;
  outcome: 'applied' | 'not_applied';
  recoveryReceiptId: string;
  payload: unknown;
}

export interface LegacyReturnPartialCloseRequest {
  schemaVersion: 'omnia.feature-return-partial-close/v1';
  authorizationId: string;
  runId: string;
  sourceFeatureVersion: string;
  expectedStateRevision: number;
}

export interface DeclarativeRecorder {
  state: 'idle' | 'recording' | 'paused' | 'stopped' | 'exported' | 'cancelled' | 'error';
  recordingId: string;
  startedAt: string;
  updatedAt: string;
  elapsedMs: number;
  eventCount: number;
  interactionCount: number;
  networkRequestCount: number;
  riskCount: number;
  controlCount: number;
  captureState: 'idle' | 'pending' | 'complete' | 'incomplete';
  captureMessage: string;
  exportAvailable: boolean;
}

export type DeclarativeWorkflowStepState = 'pending' | 'current' | 'completed' | 'warning' | 'failed';

export interface DeclarativeWorkflowStep {
  stepId: string;
  label: string;
  state: DeclarativeWorkflowStepState;
  detail: string;
}

export interface DeclarativeWorkflow {
  /** Monotonic durable Run/Event revision used to produce this projection. */
  revision: number;
  currentStepId: string;
  steps: DeclarativeWorkflowStep[];
}

export type DeclarativeProgressState = 'pending' | 'running' | 'passed' | 'warning' | 'failed' | 'skipped' | 'uncertain';

export interface DeclarativeProgressItem {
  itemId: string;
  label: string;
  state: DeclarativeProgressState;
  detail: string;
  /** Optional authoritative counters for capsule progress rendering. */
  completed?: number;
  total?: number;
  percent?: number;
}

export interface DeclarativeProgress {
  label: string;
  completed: number;
  total: number;
  percent: number;
  state: DeclarativeProgressState;
  message: string;
  items: DeclarativeProgressItem[];
}

export interface DeclarativeIssue {
  issueId: string;
  scope: 'global' | 'element' | 'field';
  severity: 'warning' | 'error';
  elementId: string;
  fieldKey: string;
  message: string;
}

export type DeclarativeReviewElementKind = 'APP' | 'DB' | 'OS' | 'TOOL' | 'DCNO';

export interface DeclarativeReviewField {
  rowKey: string;
  kind: DeclarativeReviewElementKind;
  fieldKey: string;
  rawFieldKey: string;
  label: string;
  expectedRevision: number;
  inputKind: 'text' | 'enum' | 'textarea' | 'readonly';
  currentValue: string;
  allowedValues: string[];
  required: boolean;
  maxLength: number;
  editable: boolean;
  message: string;
  sourceSheet: string;
  sourceRow: number;
  derivation: string;
}

export interface DeclarativeFeatureReview {
  selectedKind: DeclarativeReviewElementKind;
  selectedRowKey: string;
  elementTypes: Array<{ kind: DeclarativeReviewElementKind; label: string; count: number; issueCount: number; warningCount: number; disabled: boolean; reason: string }>;
  elements: Array<{ rowKey: string; kind: DeclarativeReviewElementKind; elementId: string; label: string; sourceSheet: string; sourceRow: number; issueCount: number; warningCount: number; derivedDisplay: string; inheritanceDecision: null | { schemaVersion: 'omnia.create-associate.infrastructure-rait-decision/v1'; policy: 'any_higher_else_all_lower'; sourceModes: Array<{ rowKey: string; elementId: string; rait: 'Higher' | 'Lower' }>; mixedSources: boolean; result: 'Higher' | 'Lower'; message: string }; blocking: boolean; excluded: boolean }>;
  fields: DeclarativeReviewField[];
  issueOrder: Array<{ issueId: string; rowKey: string; fieldKey: string; severity: 'warning' | 'error'; message: string }>;
}

export interface FeatureReviewFieldRevision {
  rowKey: string;
  fieldKey: string;
  expectedRevision: number;
  value: string;
}

export interface FeatureReviewDerivedRevision {
  fieldKey: string;
  expectedRevision: number;
  value: string;
  dependencyFieldKey: string;
  /** Revision of the dependency after the user revision in this same atomic commit. */
  dependencyRevision: number;
}

export interface FeatureReviewValidationCommit {
  runId: string;
  expectedRunRevision: number;
  revisions: FeatureReviewFieldRevision[];
  derivedRevisions: FeatureReviewDerivedRevision[];
  issues: Array<Record<string, unknown>>;
  nextState: 'needs_input' | 'ready_for_review';
  eventType: 'review.row_excluded' | 'review.revalidated' | 'review.saved_and_revalidated';
  excludedRowKey: string;
  templateInstanceId: string;
}

export interface FeatureArtifactDescriptor {
  schemaVersion: 'omnia.feature-artifact/v1';
  artifactId: string;
  runId: string;
  traceId: string;
  featureId: string;
  featureVersion: string;
  surfaceId: string;
  kind: 'source' | 'template_candidate' | 'template_instance' | 'result' | 'evidence';
  originalName: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  importedAt: string;
}

export interface FeatureArtifactInputRequest {
  featureId: string;
  featureVersion: string;
  surfaceId: string;
  actionId: string;
  accept: string[];
  /** Main-process authority scope; Renderer input is ignored and overwritten at the IPC boundary. */
  engagementId?: string;
}

export interface FeatureArtifactBytesInputRequest extends FeatureArtifactInputRequest {
  name: string;
  bytes: Uint8Array;
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
  lifecycle?: DeclarativeFeatureSurfaceLifecycle;
  selectionBrowser?: DeclarativeSelectionBrowser;
  recorder?: DeclarativeRecorder;
  workflow?: DeclarativeWorkflow;
  progress?: DeclarativeProgress;
  issues?: DeclarativeIssue[];
  review?: DeclarativeFeatureReview;
  artifacts?: Array<{
    artifactId: string;
    kind: FeatureArtifactDescriptor['kind'];
    name: string;
    sha256: string;
    sizeBytes: number;
    available: boolean;
    reason: string;
  }>;
  editors?: Array<{
    issueId: string;
    fieldKey: string;
    expectedRevision: number;
    inputKind: 'text' | 'enum';
    label: string;
    currentValue: string;
    allowedValues: string[];
    required: boolean;
    maxLength: number;
  }>;
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
