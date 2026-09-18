import { acquireFailure, failure, isRecorderFailure, nativeName } from './errors.js';
import { resolveOptions } from './options.js';
import type { Options } from './options.js';
import { compatibleMime, informativeMime } from './output.js';
import { getCapabilities, notifyObserver } from './platform.js';
import type {
  Recorder, RecorderEvent, RecorderFailure, RecorderOptions, RecorderSnapshot,
  RecordingResult, RecordingWarning, SessionInfo, StopReason, WarningCode,
} from './types.js';

type Timer = ReturnType<typeof setTimeout>;
interface Deferred<T> {
  promise: Promise<T>;
  settled: boolean;
  resolve(value: T): void;
  reject(error: RecorderFailure): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: RecorderFailure) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // Internal automatic termination can settle before the application calls stop().
  void promise.catch(() => {});
  const result: Deferred<T> = {
    promise, settled: false,
    resolve(value) { if (!result.settled) { result.settled = true; resolve(value); } },
    reject(error) { if (!result.settled) { result.settled = true; reject(error); } },
  };
  return result;
}
interface Intent { kind: 'pause' | 'resume'; operation: Deferred<void> }
interface Session {
  id: string;
  options: Options;
  requestedMimeType: string | null;
  stream: MediaStream | null;
  recorder: MediaRecorder | null;
  detach: (() => void)[];
  start: Deferred<SessionInfo>;
  stop: Deferred<RecordingResult | null>;
  info: SessionInfo | null;
  startCalled: boolean;
  stopping: boolean;
  dropData: boolean;
  fatal: RecorderFailure | null;
  reason: StopReason;
  chunks: Blob[];
  bytes: number;
  receivedBytes: number;
  chunkMime: string;
  recorderMime: string;
  warnings: Map<WarningCode, RecordingWarning>;
  startedAt: number | null;
  activeSince: number | null;
  activeMs: number;
  endedAt: number | null;
  initializationTimer: Timer | null;
  finalizationTimer: Timer | null;
  durationTimer: Timer | null;
  controlTimer: Timer | null;
  intents: Intent[];
  controlling: boolean;
}
interface Acquisition { session: Session | null }

function idleSnapshot(status: 'idle' | 'disposed' = 'idle', permissionPending = false): RecorderSnapshot {
  return Object.freeze({
    status, sessionId: null, result: null, error: null, permissionPending, trackMuted: false,
    timing: Object.freeze({ activeMs: 0, activeSince: null, startedAt: null }),
  });
}
function releaseTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try { track.stop(); } catch { /* Best effort; one broken track must not skip the rest. */ }
  }
}
function now(): number { return performance.now(); }

/** Construct an inert controller. Browser APIs are first read by start(). */
export function createRecorder(defaults: RecorderOptions = {}): Recorder {
  let snapshot = idleSnapshot();
  let current: Session | null = null;
  let acquisition: Acquisition | null = null;
  let sequence = 0;
  let disposed = false;
  let disposal: Promise<void> | null = null;
  const subscribers = new Set<() => void>();
  const observers = new Set<(event: RecorderEvent) => void>();
  const notifications: RecorderEvent[] = [];
  let notifying = false;

  const live = (session: Session): boolean => !disposed && current === session;
  const eventState = (patch: Partial<RecorderSnapshot>): RecorderEvent => {
    snapshot = Object.freeze({ ...snapshot, ...patch,
      timing: Object.freeze({ ...(patch.timing ?? snapshot.timing) }),
    });
    return Object.freeze({ type: 'state', snapshot });
  };
  const emit = (...events: RecorderEvent[]): void => {
    if (disposed) return;
    notifications.push(...events);
    if (notifying) return;
    notifying = true;
    try {
      while (!disposed && notifications.length) {
        const event = notifications.shift();
        if (!event) continue;
        if (event.type === 'state') {
          for (const listener of [...subscribers]) {
            if (disposed) break;
            if (subscribers.has(listener)) notifyObserver(listener, undefined);
          }
        }
        for (const listener of [...observers]) {
          if (disposed) break;
          if (observers.has(listener)) notifyObserver(listener, event);
        }
      }
    } finally { notifying = false; }
  };
  const timing = (session: Session): RecorderSnapshot['timing'] => ({
    activeMs: session.activeMs, activeSince: session.activeSince, startedAt: session.startedAt,
  });
  const activeTime = (session: Session): number => session.activeMs +
    (session.activeSince === null ? 0 : Math.max(0, now() - session.activeSince));
  const clearTimer = (session: Session, key: 'initializationTimer' | 'finalizationTimer' | 'durationTimer' | 'controlTimer'): void => {
    const timer = session[key];
    if (timer !== null) clearTimeout(timer);
    session[key] = null;
  };
  const closeActive = (session: Session): void => {
    session.activeMs = activeTime(session);
    session.activeSince = null;
    clearTimer(session, 'durationTimer');
  };
  const endClock = (session: Session): void => {
    if (session.endedAt === null) {
      const time = now();
      session.activeMs += session.activeSince === null ? 0 : Math.max(0, time - session.activeSince);
      session.activeSince = null;
      session.endedAt = time;
      clearTimer(session, 'durationTimer');
    }
  };
  const addWarning = (session: Session, code: WarningCode, publish = true): RecordingWarning => {
    const warning = Object.freeze({ code, atActiveMs: activeTime(session) });
    session.warnings.set(code, warning);
    if (publish && live(session)) emit(Object.freeze({ type: 'warning', warning }));
    return warning;
  };
  const rejectControls = (session: Session): void => {
    clearTimer(session, 'controlTimer');
    const error = failure('CANCELLED', 'command', { sessionId: session.id });
    for (const intent of session.intents.splice(0)) intent.operation.reject(error);
    session.controlling = false;
  };
  const cleanup = (session: Session, stopNative: boolean): void => {
    clearTimer(session, 'initializationTimer');
    clearTimer(session, 'finalizationTimer');
    clearTimer(session, 'durationTimer');
    clearTimer(session, 'controlTimer');
    for (const detach of session.detach.splice(0)) { try { detach(); } catch { /* Complete remaining release steps. */ } }
    const recorder = session.recorder;
    session.recorder = null;
    if (stopNative && recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); } catch { /* Cancellation never waits for the encoder. */ }
    }
    if (session.stream) releaseTracks(session.stream);
    session.stream = null;
    session.chunks.length = 0;
  };
  const listen = (session: Session, target: EventTarget, type: string, listener: (event: Event) => void): void => {
    const guarded = (event: Event): void => { if (live(session)) listener(event); };
    target.addEventListener(type, guarded);
    session.detach.push(() => target.removeEventListener(type, guarded));
  };
  const rememberMime = (session: Session): void => {
    const value = session.recorder?.mimeType;
    if (value) session.recorderMime = value;
  };
  const observeTrack = (session: Session): void => {
    if (!live(session)) return;
    const track = session.stream?.getAudioTracks()[0];
    if (track && !track.enabled && !session.warnings.has('track-disabled')) addWarning(session, 'track-disabled');
  };
  const primary = (session: Session, error: RecorderFailure): void => {
    session.fatal ??= error;
  };
  const reasonFor = (session: Session): StopReason => {
    switch (session.fatal?.code) {
      case 'SOURCE_ENDED': case 'SOURCE_CHANGED': return 'source-ended';
      case 'BUFFER_LIMIT': return 'byte-limit';
      case 'FINALIZATION_TIMEOUT': return 'finalization-timeout';
      case undefined: return session.reason;
      default: return 'recorder-error';
    }
  };

  const finish = (session: Session): void => {
    if (!live(session)) return;
    session.stopping = true;
    rejectControls(session);
    endClock(session);
    emit(eventState({ status: 'finalizing', timing: timing(session) }));
    if (!live(session)) return;
    const extraWarnings: RecorderEvent[] = [];
    const mimeType = session.chunkMime || session.recorderMime;
    const mimeSource = session.chunkMime ? 'chunk' : session.recorderMime ? 'recorder' : 'unknown';
    if (!mimeType) extraWarnings.push(Object.freeze({ type: 'warning', warning: addWarning(session, 'mime-unknown', false) }));
    if (session.chunkMime && session.recorderMime && !compatibleMime(session.chunkMime, session.recorderMime)) {
      extraWarnings.push(Object.freeze({ type: 'warning', warning: addWarning(session, 'mime-disagreement', false) }));
    }
    if (session.bytes === 0) primary(session, failure('EMPTY_OUTPUT', 'finalize', { sessionId: session.id }));
    let result: RecordingResult | null = null;
    if (session.bytes > 0) {
      try {
        const blob = new Blob(session.chunks, { type: mimeType });
        result = Object.freeze({
          sessionId: session.id, blob, bytes: blob.size, receivedBytes: session.receivedBytes,
          mimeType, mimeSource, recorderMimeType: session.recorderMime,
          completion: session.fatal ? 'partial' : 'complete', reason: reasonFor(session),
          activeMs: session.activeMs,
          wallMs: session.startedAt === null ? 0 : Math.max(0, (session.endedAt ?? session.startedAt) - session.startedAt),
          warnings: Object.freeze([...session.warnings.values()]),
        });
      } catch (cause) { primary(session, failure('RECORDING_FAILED', 'finalize', { sessionId: session.id, cause })); }
    }
    const error = session.fatal && (result ? failure(session.fatal.code, session.fatal.phase, {
      sessionId: session.id, ...(session.fatal.cause === undefined ? {} : { cause: session.fatal.cause }), partial: result,
    }) : session.fatal);
    cleanup(session, true);
    current = null;
    const state = eventState({ status: error ? 'failed' : 'ready', result, error,
      trackMuted: false, timing: timing(session) });
    if (error) { session.start.reject(error); session.stop.reject(error); }
    else if (result) { session.stop.resolve(result); }
    if (!session.start.settled) session.start.reject(failure('CANCELLED', 'command', { sessionId: session.id }));
    const terminal: RecorderEvent[] = error ? [{ type: 'error', error }] : result ? [{ type: 'result', result }] : [];
    emit(state, ...extraWarnings, ...terminal.map(event => Object.freeze(event)));
  };

  const terminate = (session: Session, reason: StopReason = 'user'): void => {
    if (!live(session) || session.stopping) return;
    session.stopping = true;
    session.reason = reason;
    endClock(session);
    clearTimer(session, 'initializationTimer');
    rejectControls(session);
    session.start.reject(session.fatal ?? failure('CANCELLED', 'command', { sessionId: session.id }));
    session.finalizationTimer = setTimeout(() => {
      if (!live(session)) return;
      primary(session, failure('FINALIZATION_TIMEOUT', 'finalize', { sessionId: session.id }));
      finish(session);
    }, session.options.finalizationTimeoutMs);
    emit(eventState({ status: 'stopping', timing: timing(session) }));
    if (!live(session)) return;
    const recorder = session.recorder;
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); }
      catch (cause) { primary(session, failure('RECORDING_FAILED', 'finalize', { sessionId: session.id, cause })); }
    }
  };

  const failBeforeRecording = (session: Session, error: RecorderFailure): void => {
    if (!live(session)) return;
    primary(session, error);
    endClock(session);
    rejectControls(session);
    cleanup(session, true);
    current = null;
    const state = eventState({ status: 'failed', result: null, error, permissionPending: acquisition !== null,
      trackMuted: false, timing: timing(session) });
    session.start.reject(error);
    session.stop.reject(error);
    emit(state, Object.freeze({ type: 'error', error }));
  };

  const armDuration = (session: Session): void => {
    clearTimer(session, 'durationTimer');
    if (!live(session) || session.stopping || session.activeSince === null) return;
    const remaining = session.options.maxActiveMs - activeTime(session);
    session.durationTimer = setTimeout(() => {
      if (!live(session) || session.stopping || session.activeSince === null) return;
      if (activeTime(session) >= session.options.maxActiveMs) terminate(session, 'duration-limit');
      else armDuration(session);
    }, Math.max(0, Math.min(remaining, 2147483647)));
  };

  const processControl = (session: Session): void => {
    if (!live(session) || session.stopping || session.controlling) return;
    const intent = session.intents[0];
    if (!intent) return;
    const target = intent.kind === 'pause' ? 'paused' : 'recording';
    if (snapshot.status === target) {
      session.intents.shift();
      intent.operation.resolve(undefined);
      processControl(session);
      return;
    }
    session.controlling = true;
    session.controlTimer = setTimeout(() => {
      if (!live(session) || !session.controlling) return;
      primary(session, failure('RECORDING_FAILED', 'record', { sessionId: session.id }));
      terminate(session, 'recorder-error');
    }, session.options.initializationTimeoutMs);
    try { session.recorder?.[intent.kind](); }
    catch (cause) {
      primary(session, failure('RECORDING_FAILED', 'record', { sessionId: session.id, cause }));
      terminate(session, 'recorder-error');
    }
  };
  const controlEvent = (session: Session, kind: 'pause' | 'resume'): void => {
    if (session.stopping || !session.info) return;
    const intent = session.intents[0];
    if (!session.controlling || intent?.kind !== kind) return;
    clearTimer(session, 'controlTimer');
    if (kind === 'pause') closeActive(session);
    else { session.activeSince = now(); armDuration(session); }
    session.controlling = false;
    session.intents.shift();
    const state = eventState({ status: kind === 'pause' ? 'paused' : 'recording', timing: timing(session) });
    intent.operation.resolve(undefined);
    emit(state);
    if (live(session) && !session.stopping) observeTrack(session);
    processControl(session);
  };

  const initialize = (session: Session, stream: MediaStream): void => {
    if (!live(session)) { releaseTracks(stream); return; }
    session.stream = stream;
    const tracks = stream.getTracks();
    const audio = stream.getAudioTracks();
    if (tracks.length !== 1 || audio.length !== 1 || audio[0]?.readyState !== 'live') {
      failBeforeRecording(session, failure('INVALID_SOURCE', 'initialize', { sessionId: session.id }));
      return;
    }
    const track = audio[0];
    if (!track) return;
    emit(eventState({ status: 'initializing', permissionPending: false, trackMuted: track.muted }));
    if (!live(session)) return;
    listen(session, track, 'ended', () => {
      primary(session, failure('SOURCE_ENDED', 'record', { sessionId: session.id }));
      if (!session.startCalled) failBeforeRecording(session, session.fatal!);
      else terminate(session, 'source-ended');
    });
    for (const [event, code] of [['mute', 'track-muted'], ['unmute', 'track-unmuted']] as const) {
      listen(session, track, event, () => {
        const state = eventState({ trackMuted: event === 'mute' });
        const warning = addWarning(session, code, false);
        emit(state, Object.freeze({ type: 'warning', warning }));
      });
    }
    if (typeof document !== 'undefined') {
      listen(session, document, 'visibilitychange', () => {
        if (document.visibilityState === 'hidden') addWarning(session, 'page-hidden');
      });
      if (document.visibilityState === 'hidden') addWarning(session, 'page-hidden');
    }
    if (track.muted) addWarning(session, 'track-muted');
    observeTrack(session);
    if (!live(session)) return;
    try {
      const options: MediaRecorderOptions = {};
      if (session.requestedMimeType !== null) options.mimeType = session.requestedMimeType;
      if (session.options.audioBitsPerSecond !== undefined) options.audioBitsPerSecond = session.options.audioBitsPerSecond;
      const recorder = new MediaRecorder(stream, options);
      session.recorder = recorder;
      listen(session, recorder, 'start', () => {
        rememberMime(session);
        if (session.stopping) return;
        clearTimer(session, 'initializationTimer');
        const time = now();
        session.startedAt = time;
        session.activeSince = time;
        session.info = Object.freeze({ sessionId: session.id, startedAt: time,
          requestedMimeType: session.requestedMimeType, recorderMimeType: session.recorderMime });
        const state = eventState({ status: 'recording', timing: timing(session) });
        session.start.resolve(session.info);
        armDuration(session);
        emit(state);
        if (live(session) && !session.stopping) observeTrack(session);
      });
      listen(session, recorder, 'dataavailable', event => {
        const data = (event as BlobEvent).data;
        if (!data || data.size === 0) return;
        session.receivedBytes = Math.min(Number.MAX_SAFE_INTEGER, session.receivedBytes + data.size);
        rememberMime(session);
        observeTrack(session);
        if (!live(session) || session.dropData) return;
        if (data.size > session.options.maxBytes - session.bytes) {
          session.dropData = true;
          primary(session, failure('BUFFER_LIMIT', 'record', { sessionId: session.id }));
          terminate(session, 'byte-limit');
          return;
        }
        if (data.type && !compatibleMime(session.chunkMime, data.type)) {
          session.dropData = true;
          primary(session, failure('MIME_MISMATCH', 'record', { sessionId: session.id }));
          terminate(session, 'recorder-error');
          return;
        }
        if (data.type) session.chunkMime = informativeMime(session.chunkMime, data.type);
        session.chunks.push(data);
        session.bytes += data.size;
      });
      listen(session, recorder, 'error', event => {
        const cause = (event as Event & { error?: unknown }).error;
        primary(session, failure('RECORDING_FAILED', 'record', { sessionId: session.id, cause }));
        terminate(session, 'recorder-error');
      });
      listen(session, recorder, 'stop', () => { rejectControls(session); finish(session); });
      listen(session, recorder, 'pause', () => controlEvent(session, 'pause'));
      listen(session, recorder, 'resume', () => controlEvent(session, 'resume'));
      session.initializationTimer = setTimeout(() => {
        if (!live(session)) return;
        failBeforeRecording(session, failure('INITIALIZATION_TIMEOUT', 'initialize', { sessionId: session.id }));
      }, session.options.initializationTimeoutMs);
      if (!live(session)) return;
      session.startCalled = true;
      recorder.start(1000);
    } catch (cause) {
      failBeforeRecording(session, failure(nativeName(cause) === 'NotSupportedError' ? 'UNSUPPORTED_FORMAT' : 'RECORDING_FAILED',
        'initialize', { sessionId: session.id, cause }));
    }
  };

  const clearAcquisition = (token: Acquisition): Session | null => {
    const session = token.session;
    token.session = null;
    if (acquisition === token) acquisition = null;
    return session;
  };
  const updatePermission = (): void => {
    if (snapshot.permissionPending !== (acquisition !== null)) {
      const state = eventState({ permissionPending: acquisition !== null });
      emit(state);
    }
  };
  const invalidate = (terminal: boolean): void => {
    if (!terminal && !current && snapshot.status === 'idle') return;
    const session = current;
    current = null;
    if (acquisition) acquisition.session = null;
    if (session) {
      endClock(session);
      rejectControls(session);
      const error = failure('CANCELLED', 'command', { sessionId: session.id });
      session.start.reject(error);
      session.stop.reject(error);
      cleanup(session, true);
    }
    snapshot = idleSnapshot(terminal ? 'disposed' : 'idle', acquisition !== null);
    if (!terminal) emit(Object.freeze({ type: 'state', snapshot }));
  };
  const commandError = (code: 'BUSY' | 'DISPOSED' | 'INVALID_STATE' | 'ACQUISITION_PENDING'): RecorderFailure =>
    failure(code, 'command', snapshot.sessionId === null ? {} : { sessionId: snapshot.sessionId });

  const start = (overrides?: RecorderOptions): Promise<SessionInfo> => {
    if (disposed) return Promise.reject(commandError('DISPOSED'));
    if (current) {
      if (current.stopping || overrides !== undefined) return Promise.reject(commandError('BUSY'));
      return current.start.promise;
    }
    if (acquisition) return Promise.reject(commandError('ACQUISITION_PENDING'));
    let options: Options;
    try { options = resolveOptions(defaults, overrides); }
    catch (cause) { return Promise.reject(isRecorderFailure(cause) ? cause : failure('INVALID_OPTIONS', 'command', { cause })); }
    const session: Session = {
      id: String(++sequence), options, requestedMimeType: null,
      stream: null, recorder: null, detach: [], start: deferred(), stop: deferred(), info: null,
      startCalled: false, stopping: false, dropData: false, fatal: null, reason: 'user', chunks: [],
      bytes: 0, receivedBytes: 0, chunkMime: '', recorderMime: '', warnings: new Map(),
      startedAt: null, activeSince: null, activeMs: 0, endedAt: null,
      initializationTimer: null, finalizationTimer: null, durationTimer: null, controlTimer: null,
      intents: [], controlling: false,
    };
    current = session;
    const initial = { sessionId: session.id, result: null, error: null, trackMuted: false, timing: timing(session) };
    // Commit the new generation before any callback can inspect it.
    eventState(initial);
    let capabilities;
    try { capabilities = getCapabilities(options.mime?.candidates); }
    catch (cause) { failBeforeRecording(session, failure('UNSUPPORTED_ENVIRONMENT', 'capability', { sessionId: session.id, cause })); return session.start.promise; }
    if (capabilities.secureContext === false) {
      failBeforeRecording(session, failure('INSECURE_CONTEXT', 'capability', { sessionId: session.id }));
      return session.start.promise;
    }
    if (!capabilities.mediaRecorder || !capabilities.microphone) {
      failBeforeRecording(session, failure('UNSUPPORTED_ENVIRONMENT', 'capability', { sessionId: session.id }));
      return session.start.promise;
    }
    if (options.mime) {
      session.requestedMimeType = options.mime.candidates.find(type => capabilities.mimeSupport[type] === true) ?? null;
      if (session.requestedMimeType === null && options.mime.fallback === 'error') {
        failBeforeRecording(session, failure('UNSUPPORTED_FORMAT', 'capability', { sessionId: session.id }));
        return session.start.promise;
      }
    }
    const token: Acquisition = { session };
    acquisition = token;
    try {
      const request = navigator.mediaDevices.getUserMedia({ audio: options.constraints, video: false });
      Promise.resolve(request).then(stream => {
        const pending = clearAcquisition(token);
        if (!pending || !live(pending)) { releaseTracks(stream); updatePermission(); return; }
        try { initialize(pending, stream); }
        catch (cause) { failBeforeRecording(pending, failure('RECORDING_FAILED', 'initialize', { sessionId: pending.id, cause })); }
      }, cause => {
        const pending = clearAcquisition(token);
        if (pending && live(pending)) failBeforeRecording(pending, acquireFailure(cause, pending.id));
        else updatePermission();
      });
      emit(eventState({ ...initial, status: 'acquiring', permissionPending: true }));
    } catch (cause) {
      clearAcquisition(token);
      failBeforeRecording(session, acquireFailure(cause, session.id));
    }
    return session.start.promise;
  };
  const stop = (): Promise<RecordingResult | null> => {
    if (disposed) return Promise.reject(commandError('DISPOSED'));
    const session = current;
    if (session) {
      if (!session.startCalled) { invalidate(false); return Promise.resolve(null); }
      observeTrack(session);
      if (!live(session)) return session.stop.promise;
      terminate(session);
      return session.stop.promise;
    }
    if (snapshot.error) return Promise.reject(snapshot.error);
    return Promise.resolve(snapshot.result);
  };
  const control = (kind: Intent['kind']): Promise<void> => {
    if (disposed) return Promise.reject(commandError('DISPOSED'));
    const session = current;
    if (session?.stopping) return Promise.reject(commandError('BUSY'));
    if (!session?.info) return Promise.reject(commandError('INVALID_STATE'));
    observeTrack(session);
    if (!live(session) || session.stopping) return Promise.reject(failure('CANCELLED', 'command', { sessionId: session.id }));
    const previous = session.intents[session.intents.length - 1];
    if (previous?.kind === kind) return previous.operation.promise;
    const intent: Intent = { kind, operation: deferred() };
    session.intents.push(intent);
    processControl(session);
    return intent.operation.promise;
  };
  return Object.freeze({
    start, stop,
    pause: () => control('pause'), resume: () => control('resume'),
    cancel: () => {
      if (disposed) return Promise.reject(commandError('DISPOSED'));
      invalidate(false);
      return Promise.resolve();
    },
    reset: () => {
      if (disposed) return Promise.reject(commandError('DISPOSED'));
      if (current) return Promise.reject(commandError('BUSY'));
      invalidate(false);
      return Promise.resolve();
    },
    dispose: () => {
      if (disposal) return disposal;
      disposed = true;
      invalidate(true);
      subscribers.clear(); observers.clear(); notifications.length = 0;
      disposal = Promise.resolve();
      return disposal;
    },
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      if (!disposed) subscribers.add(listener);
      return () => { subscribers.delete(listener); };
    },
    onEvent: (listener: (event: RecorderEvent) => void) => {
      if (!disposed) observers.add(listener);
      return () => { observers.delete(listener); };
    },
  });
}
