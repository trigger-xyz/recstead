'use client';

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type DependencyList,
  type EffectCallback,
} from 'react';
import {
  createRecorder,
  type Recorder,
  type RecorderEvent,
  type RecorderFailure,
  type RecorderOptions,
  type RecorderSnapshot,
  type RecordingResult,
} from './core/index.js';

export interface RecorderCallbacks {
  onEvent?: (event: RecorderEvent) => void;
}

export type RecorderView = RecorderSnapshot & Pick<
  Recorder,
  'start' | 'stop' | 'pause' | 'resume' | 'cancel' | 'reset'
>;

type RecorderActions = Pick<RecorderView, 'start' | 'stop' | 'pause' | 'resume' | 'cancel' | 'reset'>;

const IDLE_SNAPSHOT: RecorderSnapshot = Object.freeze({
  status: 'idle',
  sessionId: null,
  result: null,
  error: null,
  permissionPending: false,
  trackMuted: false,
  timing: Object.freeze({ activeMs: 0, activeSince: null, startedAt: null }),
});

const getServerSnapshot = (): RecorderSnapshot => IDLE_SNAPSHOT;

// Select at hook call time so importing this module never reads browser globals.
function useCommittedEffect(effect: EffectCallback, dependencies?: DependencyList): void {
  const commitEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;
  commitEffect(effect, dependencies);
}

function notReady(): RecorderFailure {
  return Object.assign(new Error('The recorder hook is not mounted.'), {
    name: 'RecorderFailure' as const,
    code: 'NOT_READY' as const,
    phase: 'command' as const,
  });
}

function reportObserverFailure(): void {
  const error = new Error('Recstead observer callback failed');
  try {
    if (typeof globalThis.reportError === 'function') globalThis.reportError(error);
    else console.error(error);
  } catch {
    // Reporting must not interrupt cleanup or other observers.
  }
}

function mergeOptions(defaults: RecorderOptions | undefined, overrides: RecorderOptions | undefined): RecorderOptions {
  const merged = { ...defaults };
  if (overrides) {
    for (const key of Object.keys(overrides) as (keyof RecorderOptions)[]) {
      const value = overrides[key];
      if (value !== undefined) Object.assign(merged, { [key]: value });
    }
  }
  return merged;
}

function createHost() {
  let attached: Recorder | null = null;
  let options: RecorderOptions | undefined;
  let onEvent: RecorderCallbacks['onEvent'];
  let detach: (() => void) | undefined;
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of [...listeners]) {
      try { listener(); } catch { reportObserverFailure(); }
    }
  }

  const actions: RecorderActions = {
    start: overrides => {
      if (!attached) return Promise.reject(notReady());
      const status = attached.getSnapshot().status;
      if (overrides === undefined && status !== 'idle' && status !== 'ready' && status !== 'failed') {
        return attached.start();
      }
      return attached.start(mergeOptions(options, overrides));
    },
    stop: () => attached ? attached.stop() : Promise.reject(notReady()),
    pause: () => attached ? attached.pause() : Promise.reject(notReady()),
    resume: () => attached ? attached.resume() : Promise.reject(notReady()),
    cancel: () => attached ? attached.cancel() : Promise.reject(notReady()),
    reset: () => attached ? attached.reset() : Promise.reject(notReady()),
  };

  return {
    actions,
    getSnapshot: (): RecorderSnapshot => attached?.getSnapshot() ?? IDLE_SNAPSHOT,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    commit(nextOptions: RecorderOptions | undefined, callbacks: RecorderCallbacks | undefined): void {
      options = nextOptions;
      onEvent = callbacks?.onEvent;
    },
    attach(): void {
      if (attached) return;
      const recorder: Recorder = createRecorder();
      attached = recorder;
      const unsubscribe = recorder.subscribe(() => {
        if (attached === recorder) notify();
      });
      const unsubscribeEvents = recorder.onEvent(event => {
        if (attached === recorder) return onEvent?.(event);
      });
      notify();
      detach = () => {
        if (attached === recorder) attached = null;
        unsubscribe();
        unsubscribeEvents();
        // Terminal disposal releases resources synchronously. The next effect
        // setup binds a new controller, including during StrictMode replay.
        void recorder.dispose().catch(reportObserverFailure);
      };
    },
    detach(): void {
      detach?.();
      detach = undefined;
    },
  };
}

/** Own a microphone recorder for this mounted hook lifetime. Unmount discards it. */
export function useRecorder(options?: RecorderOptions, callbacks?: RecorderCallbacks): RecorderView {
  const hostRef = useRef<ReturnType<typeof createHost> | null>(null);
  if (hostRef.current === null) hostRef.current = createHost();
  const host = hostRef.current;
  useCommittedEffect(() => { host.commit(options, callbacks); });
  const snapshot = useSyncExternalStore(host.subscribe, host.getSnapshot, getServerSnapshot);
  useCommittedEffect(() => { host.attach(); }, [host]);
  // Suspense can clean up layout effects while retaining the mounted component.
  // Keep resource disposal in the passive lifetime effect so hiding a recorder
  // does not discard its session. StrictMode still detaches before replay setup.
  useEffect(() => () => host.detach(), [host]);
  return useMemo(() => ({ ...snapshot, ...host.actions }), [snapshot, host]);
}

/** Observe a caller-owned controller. Detaching never stops or disposes it. */
export function useRecorderSession(recorder: Recorder, callbacks?: RecorderCallbacks): RecorderView {
  const committedRef = useRef<{ recorder: Recorder; onEvent: RecorderCallbacks['onEvent'] } | null>(null);
  useCommittedEffect(() => { committedRef.current = { recorder, onEvent: callbacks?.onEvent }; });
  const binding = useMemo(() => {
    let unsubscribeEvents: (() => void) | undefined;
    return {
      subscribe: (listener: () => void) => recorder.subscribe(listener),
      getSnapshot: () => recorder.getSnapshot(),
      attachEvents(): void {
        unsubscribeEvents ??= recorder.onEvent(event => {
          if (committedRef.current?.recorder === recorder) return committedRef.current.onEvent?.(event);
        });
      },
      detachEvents(): void {
        unsubscribeEvents?.();
        unsubscribeEvents = undefined;
      },
      actions: {
        start: (options?: RecorderOptions) => recorder.start(options),
        stop: () => recorder.stop(),
        pause: () => recorder.pause(),
        resume: () => recorder.resume(),
        cancel: () => recorder.cancel(),
        reset: () => recorder.reset(),
      } satisfies RecorderActions,
    };
  }, [recorder]);
  const snapshot = useSyncExternalStore(binding.subscribe, binding.getSnapshot, getServerSnapshot);
  useCommittedEffect(() => { binding.attachEvents(); }, [binding]);
  useEffect(() => () => binding.detachEvents(), [binding]);
  return useMemo(() => ({ ...snapshot, ...binding.actions }), [snapshot, binding]);
}

/** Create an object URL for this result and revoke only that URL during cleanup. */
export function useRecordingUrl(result: RecordingResult | null): string | null {
  const [entry, setEntry] = useState<{ result: RecordingResult; url: string } | null>(null);
  useEffect(() => {
    if (result === null) {
      setEntry(null);
      return;
    }
    const owner = globalThis.URL;
    const url = owner.createObjectURL(result.blob);
    setEntry({ result, url });
    return () => { owner.revokeObjectURL(url); };
  }, [result]);
  return entry?.result === result ? entry.url : null;
}
