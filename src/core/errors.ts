import type { RecorderErrorCode, RecorderFailure, RecordingResult } from './types.js';

const messages: Record<RecorderErrorCode, string> = {
  UNSUPPORTED_ENVIRONMENT: 'This environment does not provide browser microphone recording.',
  INSECURE_CONTEXT: 'Microphone recording requires a secure context.',
  PERMISSION_DENIED: 'Microphone access was denied or blocked by browser policy.',
  DEVICE_NOT_FOUND: 'No matching microphone was found.',
  DEVICE_UNAVAILABLE: 'The microphone could not be opened.',
  CONSTRAINTS_UNSATISFIED: 'The microphone constraints could not be satisfied.',
  UNSUPPORTED_FORMAT: 'The requested recording format is unavailable.',
  INVALID_SOURCE: 'Recording requires exactly one live audio track and no other tracks.',
  SOURCE_ENDED: 'The microphone track ended before recording finished.',
  SOURCE_CHANGED: 'The recording source changed.',
  RECORDING_FAILED: 'The browser could not complete recording.',
  INITIALIZATION_TIMEOUT: 'The browser did not acknowledge recording startup.',
  FINALIZATION_TIMEOUT: 'The browser did not finish recording before the finalization deadline.',
  BUFFER_LIMIT: 'The recording exceeded its retained byte limit.',
  EMPTY_OUTPUT: 'The browser finished recording without audio data.',
  MIME_MISMATCH: 'The browser returned incompatible recording formats in one session.',
  BUSY: 'The recorder is busy with another operation.',
  INVALID_STATE: 'This command is unavailable in the current recorder state.',
  INVALID_OPTIONS: 'Recorder options are invalid.',
  NOT_READY: 'The recorder is not mounted.',
  CANCELLED: 'The recording operation was cancelled.',
  ACQUISITION_PENDING: 'Resolve the outstanding browser permission request before recording again.',
  DISPOSED: 'This recorder has been disposed.',
};

export function failure(
  code: RecorderErrorCode,
  phase: RecorderFailure['phase'] = 'command',
  details: { sessionId?: string; cause?: unknown; partial?: RecordingResult } = {},
): RecorderFailure {
  const error = new Error(messages[code]) as RecorderFailure;
  Object.defineProperties(error, {
    name: { value: 'RecorderFailure', enumerable: true },
    code: { value: code, enumerable: true },
    phase: { value: phase, enumerable: true },
  });
  if (details.sessionId !== undefined) Object.defineProperty(error, 'sessionId', { value: details.sessionId, enumerable: true });
  if ('cause' in details) {
    Object.defineProperty(error, 'cause', { value: details.cause });
    const name = nativeName(details.cause);
    if (name) Object.defineProperty(error, 'nativeName', { value: name, enumerable: true });
  }
  if (details.partial) Object.defineProperty(error, 'partial', { value: details.partial, enumerable: true });
  return Object.freeze(error);
}

export function nativeName(cause: unknown): string | undefined {
  if (typeof cause !== 'object' || cause === null) return undefined;
  try {
    const name = (cause as { name?: unknown }).name;
    return typeof name === 'string' ? name : undefined;
  } catch { return undefined; }
}

export function isRecorderFailure(value: unknown): value is RecorderFailure {
  if (typeof value !== 'object' || value === null) return false;
  try {
    const candidate = value as Partial<RecorderFailure>;
    return candidate.name === 'RecorderFailure' && typeof candidate.code === 'string' &&
      Object.prototype.hasOwnProperty.call(messages, candidate.code) && typeof candidate.message === 'string';
  } catch { return false; }
}

export function acquireFailure(cause: unknown, sessionId: string): RecorderFailure {
  const codes: Record<string, RecorderErrorCode> = {
    NotAllowedError: 'PERMISSION_DENIED', SecurityError: 'PERMISSION_DENIED',
    NotFoundError: 'DEVICE_NOT_FOUND', NotReadableError: 'DEVICE_UNAVAILABLE',
    AbortError: 'DEVICE_UNAVAILABLE', OverconstrainedError: 'CONSTRAINTS_UNSATISFIED',
  };
  const name = nativeName(cause) ?? '';
  const code = Object.prototype.hasOwnProperty.call(codes, name) ? codes[name] : 'RECORDING_FAILED';
  return failure(code, 'acquire', { sessionId, cause });
}
