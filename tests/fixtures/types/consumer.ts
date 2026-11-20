// Type-only consumer: compiled against the installed package by each TypeScript version.
import {
  createRecorder, getCapabilities, isRecorderFailure,
  type Capabilities, type Recorder, type RecorderErrorCode, type RecorderEvent, type RecorderFailure,
  type RecorderOptions, type RecorderSnapshot, type RecorderSource, type RecorderStatus, type RecordingResult,
  type RecordingWarning, type SessionInfo, type StopReason, type WarningCode,
} from 'recstead';
import { createRecorder as createFromCore, getCapabilities as capabilitiesFromCore, isRecorderFailure as isFailureFromCore } from 'recstead/core';
import {
  useRecorder, useRecorderSession, useRecordingUrl, type RecorderCallbacks, type RecorderView,
} from 'recstead/react';

const options: RecorderOptions = {
  source: { kind: 'microphone', constraints: { echoCancellation: true } },
  mime: { candidates: ['audio/webm;codecs=opus', 'audio/mp4'], fallback: 'browser' },
  maxBytes: 1024, maxActiveMs: 1000, initializationTimeoutMs: 1000, finalizationTimeoutMs: 1000,
};
// The reference promises that an explicit undefined keeps the default. The fixture is compiled with
// exactOptionalPropertyTypes, where that only type-checks if the declarations say so.
const maybe = (value: number): number | undefined => (value > 0 ? value : undefined);
const defaulted: RecorderOptions = {
  source: undefined, mime: undefined, audioBitsPerSecond: maybe(0), maxBytes: maybe(0), maxActiveMs: maybe(0),
  initializationTimeoutMs: maybe(0), finalizationTimeoutMs: maybe(0),
};
const unconstrained: RecorderOptions = { source: { kind: 'microphone', constraints: undefined } };
const silent: RecorderCallbacks = { onEvent: undefined };
const recorder: Recorder = createRecorder(options);
const same: typeof createRecorder = createFromCore;
const capabilities: Capabilities = getCapabilities(['audio/webm']);
const supported: boolean | null | undefined = capabilities.mimeSupport['audio/webm'];

export async function record(): Promise<Blob | null> {
  const info: SessionInfo = await recorder.start({ maxBytes: 2048 });
  const snapshot: RecorderSnapshot = recorder.getSnapshot();
  const status: RecorderStatus = snapshot.status;
  try {
    const result: RecordingResult | null = await recorder.stop();
    return result && result.completion === 'complete' && status !== 'failed' && info.sessionId === result.sessionId ? result.blob : null;
  } catch (error) {
    if (!isRecorderFailure(error)) throw error;
    const failure: RecorderFailure = error;
    const code: RecorderErrorCode = failure.code;
    return code === 'BUFFER_LIMIT' ? failure.partial?.blob ?? null : null;
  }
}

export function describe(event: RecorderEvent): string {
  // The event union must narrow by its discriminant.
  switch (event.type) {
    case 'state': return event.snapshot.status;
    case 'result': return event.result.mimeType;
    case 'error': return event.error.code;
    case 'warning': return event.warning.code;
  }
}

export function useEverything(shared: Recorder): (string | null)[] {
  const callbacks: RecorderCallbacks = { onEvent: event => { void describe(event); } };
  const owned: RecorderView = useRecorder(options, callbacks);
  const observed: RecorderView = useRecorderSession(shared, callbacks);
  const start: (overrides?: RecorderOptions) => Promise<SessionInfo> = owned.start;
  void start;
  return [useRecordingUrl(owned.result), useRecordingUrl(observed.result)];
}

// Exact unions: the build fails if a member is added, removed or renamed without this file changing too.
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const exactly = <_Check extends true>(): void => undefined;
exactly<Same<RecorderStatus, 'idle' | 'acquiring' | 'initializing' | 'recording' | 'paused' | 'stopping' | 'finalizing' | 'ready' | 'failed' | 'disposed'>>();
exactly<Same<RecorderErrorCode, 'UNSUPPORTED_ENVIRONMENT' | 'INSECURE_CONTEXT' | 'PERMISSION_DENIED' | 'DEVICE_NOT_FOUND' | 'DEVICE_UNAVAILABLE' |
  'CONSTRAINTS_UNSATISFIED' | 'UNSUPPORTED_FORMAT' | 'INVALID_SOURCE' | 'SOURCE_ENDED' | 'SOURCE_CHANGED' | 'RECORDING_FAILED' | 'INITIALIZATION_TIMEOUT' |
  'FINALIZATION_TIMEOUT' | 'BUFFER_LIMIT' | 'EMPTY_OUTPUT' | 'MIME_MISMATCH' | 'BUSY' | 'INVALID_STATE' | 'INVALID_OPTIONS' | 'NOT_READY' | 'CANCELLED' |
  'ACQUISITION_PENDING' | 'DISPOSED'>>();
exactly<Same<StopReason, 'user' | 'duration-limit' | 'source-ended' | 'byte-limit' | 'recorder-error' | 'finalization-timeout'>>();
exactly<Same<WarningCode, 'track-muted' | 'track-unmuted' | 'track-disabled' | 'page-hidden' | 'mime-unknown' | 'mime-disagreement'>>();
exactly<Same<RecordingResult['completion'], 'complete' | 'partial'>>();
exactly<Same<RecordingResult['mimeSource'], 'chunk' | 'recorder' | 'unknown'>>();
exactly<Same<RecorderFailure['phase'], 'capability' | 'acquire' | 'initialize' | 'record' | 'finalize' | 'command'>>();
exactly<Same<Capabilities['environment'], 'browser' | 'server'>>();
exactly<Same<RecorderSource['kind'], 'microphone'>>();
exactly<Same<keyof RecorderOptions, 'source' | 'mime' | 'audioBitsPerSecond' | 'maxBytes' | 'maxActiveMs' | 'initializationTimeoutMs' | 'finalizationTimeoutMs'>>();
exactly<Same<keyof Recorder, 'start' | 'stop' | 'pause' | 'resume' | 'cancel' | 'reset' | 'dispose' | 'getSnapshot' | 'subscribe' | 'onEvent'>>();

export function inspect(result: RecordingResult, snapshot: RecorderSnapshot): number {
  // Required fields are present without a check, and results and snapshots are read-only.
  const warning: RecordingWarning | undefined = result.warnings[0];
  const total: number = result.bytes + result.receivedBytes + result.activeMs + result.wallMs + (warning?.atActiveMs ?? 0) + snapshot.timing.activeMs;
  // @ts-expect-error A result cannot be modified.
  result.bytes = 0;
  // @ts-expect-error Its warnings cannot be modified.
  result.warnings.push({ code: 'page-hidden', atActiveMs: 0 });
  // @ts-expect-error A snapshot cannot be modified.
  snapshot.status = 'idle';
  // @ts-expect-error Nor can its timing.
  snapshot.timing.activeMs = 0;
  return total;
}

// The explicit core entry has the same functions, callable with their optional arguments omitted.
const fromCore: [Recorder, Capabilities, boolean] = [createFromCore(), capabilitiesFromCore(), isFailureFromCore(null)];
const bitrate: RecorderOptions = { audioBitsPerSecond: 64_000 };

void [same, supported, defaulted, unconstrained, silent, fromCore, bitrate];
