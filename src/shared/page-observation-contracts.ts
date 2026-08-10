export const CURRENT_PACK_PAGE_OBSERVATION_POLICY = 'omnia.page-observation.current-pack.v1' as const;

export type PageObservationPolicyId = typeof CURRENT_PACK_PAGE_OBSERVATION_POLICY;
export type PageObservationState = 'observing' | 'paused' | 'stopped' | 'failed';

export interface PageObservationOpenRequest {
  schemaVersion: 'omnia.page-observation-open/v1';
  policyId: PageObservationPolicyId;
  idempotencyKey: string;
}

export interface PageObservationControlRequest {
  schemaVersion: 'omnia.page-observation-control/v1';
  observationId: string;
}

export interface PageObservationStatus {
  schemaVersion: 'omnia.page-observation-status/v1';
  observationId: string;
  streamId: string;
  policyId: PageObservationPolicyId;
  state: PageObservationState;
  engagementId: string;
  startedAt: string;
  updatedAt: string;
  stoppedAt: string | null;
  lastSequence: number;
  eventCount: number;
  omissionCount: number;
  complete: boolean;
  terminalReason: string | null;
}

export interface PageObservationEventEnvelope {
  schemaVersion: 'omnia.page-observation-event/v1';
  observationId: string;
  sequence: number;
  occurredAt: string;
  target: {
    engagementId: string;
    frameId: string;
    mainFrame: boolean;
  };
  kind:
    | 'observation.started'
    | 'observation.paused'
    | 'observation.resumed'
    | 'observation.stopped'
    | 'observation.omission'
    | 'page.navigation'
    | 'page.snapshot'
    | 'page.interaction'
    | 'network.request'
    | 'network.response'
    | 'network.response-body.segment';
  payload: Record<string, unknown>;
}

export interface ManagedStreamReadRequest {
  schemaVersion: 'omnia.managed-stream-read/v1';
  streamId: string;
  offset: number;
  maxBytes?: number;
}

export interface ManagedStreamChunk {
  schemaVersion: 'omnia.managed-stream-chunk/v1';
  streamId: string;
  mediaType: string;
  offset: number;
  nextOffset: number;
  availableBytes: number;
  ready: boolean;
  bytesBase64: string;
  chunkDigest: string | null;
  streamDigest: string | null;
  eof: boolean;
}

export interface OperationPageObservationSdk {
  open(input: PageObservationOpenRequest): Promise<PageObservationStatus>;
  status(input: PageObservationControlRequest): PageObservationStatus;
  pause(input: PageObservationControlRequest): Promise<PageObservationStatus>;
  resume(input: PageObservationControlRequest): Promise<PageObservationStatus>;
  stop(input: PageObservationControlRequest): Promise<PageObservationStatus>;
  readChunk(input: ManagedStreamReadRequest): Promise<ManagedStreamChunk>;
}
