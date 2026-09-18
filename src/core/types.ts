export type RecorderStatus =
  | 'idle' | 'acquiring' | 'initializing' | 'recording' | 'paused'
  | 'stopping' | 'finalizing' | 'ready' | 'failed' | 'disposed';

export type RecorderSource = { kind: 'microphone'; constraints?: MediaTrackConstraints };

export interface RecorderOptions {
  source?: RecorderSource;
  mime?: { candidates: readonly string[]; fallback: 'browser' | 'error' };
  audioBitsPerSecond?: number;
  maxBytes?: number;
  maxActiveMs?: number;
  initializationTimeoutMs?: number;
  finalizationTimeoutMs?: number;
}

export interface SessionInfo {
  readonly sessionId: string;
  readonly startedAt: number;
  readonly requestedMimeType: string | null;
  readonly recorderMimeType: string;
}
export type StopReason = 'user' | 'duration-limit' | 'source-ended' |
  'byte-limit' | 'recorder-error' | 'finalization-timeout';
export type WarningCode = 'track-muted' | 'track-unmuted' | 'track-disabled' |
  'page-hidden' | 'mime-unknown' | 'mime-disagreement';
export interface RecordingWarning {
  readonly code: WarningCode;
  readonly atActiveMs: number;
}
export interface RecordingResult {
  readonly sessionId: string;
  readonly blob: Blob;
  readonly bytes: number;
  readonly receivedBytes: number;
  readonly mimeType: string;
  readonly mimeSource: 'chunk' | 'recorder' | 'unknown';
  readonly recorderMimeType: string;
  readonly completion: 'complete' | 'partial';
  readonly reason: StopReason;
  readonly activeMs: number;
  readonly wallMs: number;
  readonly warnings: readonly RecordingWarning[];
}
export type RecorderErrorCode =
  | 'UNSUPPORTED_ENVIRONMENT' | 'INSECURE_CONTEXT' | 'PERMISSION_DENIED'
  | 'DEVICE_NOT_FOUND' | 'DEVICE_UNAVAILABLE' | 'CONSTRAINTS_UNSATISFIED'
  | 'UNSUPPORTED_FORMAT' | 'INVALID_SOURCE' | 'SOURCE_ENDED' | 'SOURCE_CHANGED'
  | 'RECORDING_FAILED' | 'INITIALIZATION_TIMEOUT' | 'FINALIZATION_TIMEOUT'
  | 'BUFFER_LIMIT' | 'EMPTY_OUTPUT' | 'MIME_MISMATCH'
  | 'BUSY' | 'INVALID_STATE' | 'INVALID_OPTIONS' | 'NOT_READY'
  | 'CANCELLED' | 'ACQUISITION_PENDING' | 'DISPOSED';
export interface RecorderFailure extends Error {
  readonly name: 'RecorderFailure';
  readonly code: RecorderErrorCode;
  readonly phase: 'capability' | 'acquire' | 'initialize' | 'record' | 'finalize' | 'command';
  readonly sessionId?: string;
  readonly nativeName?: string;
  readonly cause?: unknown;
  readonly partial?: RecordingResult;
}
export interface RecorderSnapshot {
  readonly status: RecorderStatus;
  readonly sessionId: string | null;
  readonly result: RecordingResult | null;
  readonly error: RecorderFailure | null;
  readonly permissionPending: boolean;
  readonly trackMuted: boolean;
  readonly timing: {
    readonly activeMs: number;
    readonly activeSince: number | null;
    readonly startedAt: number | null;
  };
}
export type RecorderEvent =
  | { readonly type: 'state'; readonly snapshot: RecorderSnapshot }
  | { readonly type: 'result'; readonly result: RecordingResult }
  | { readonly type: 'error'; readonly error: RecorderFailure }
  | { readonly type: 'warning'; readonly warning: RecordingWarning };
export interface Recorder {
  start(options?: RecorderOptions): Promise<SessionInfo>;
  stop(): Promise<RecordingResult | null>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  cancel(): Promise<void>;
  reset(): Promise<void>;
  dispose(): Promise<void>;
  getSnapshot(): RecorderSnapshot;
  subscribe(listener: () => void): () => void;
  onEvent(listener: (event: RecorderEvent) => void): () => void;
}
export interface Capabilities {
  readonly environment: 'browser' | 'server';
  readonly secureContext: boolean | null;
  readonly mediaRecorder: boolean;
  readonly microphone: boolean;
  readonly mimeSupport: Readonly<Record<string, boolean | null>>;
}
