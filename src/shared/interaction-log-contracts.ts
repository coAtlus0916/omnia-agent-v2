export type InteractionPlane = 'surface' | 'middle' | 'core' | 'connector';
export type InteractionPhase = 'start' | 'success' | 'failure';
export type InteractionSeverity = 'info' | 'error';

export interface InteractionContext {
  interactionId: string;
  traceId: string;
  parentId: string;
}

export interface InteractionLogEntry extends InteractionContext {
  eventId: string;
  timestamp: string;
  durationMs: number;
  plane: InteractionPlane;
  component: string;
  surface: string;
  action: string;
  phase: InteractionPhase;
  severity: InteractionSeverity;
  errorCode: string;
  failurePoint: string;
  message: string;
  details: Record<string, string | number | boolean | string[]>;
  runId: string;
  commandId: string;
  requestId: string;
  operationId: string;
}

export interface InteractionLogQuery {
  severity?: '' | InteractionSeverity;
  plane?: '' | InteractionPlane;
  component?: string;
  since?: string;
  interactionId?: string;
  limit?: number;
}

export interface InteractionLogPage {
  entries: InteractionLogEntry[];
  hasMore: boolean;
}

export interface InteractionLogTrace {
  traceId: string;
  entries: InteractionLogEntry[];
}
