import type { Capabilities } from './types.js';

export function getCapabilities(mimeTypes: readonly string[] = []): Capabilities {
  const browser = typeof window !== 'undefined';
  const mediaRecorder = browser && typeof MediaRecorder === 'function';
  const microphone = browser && typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function';
  const mimeSupport: Record<string, boolean | null> = Object.create(null) as Record<string, boolean | null>;
  for (const type of mimeTypes) {
    let supported: boolean | null = null;
    if (mediaRecorder && typeof MediaRecorder.isTypeSupported === 'function') {
      try { supported = MediaRecorder.isTypeSupported(type); } catch { supported = null; }
    }
    mimeSupport[type] = supported;
  }
  return Object.freeze({
    environment: browser ? 'browser' : 'server',
    secureContext: browser && typeof isSecureContext === 'boolean' ? isSecureContext : null,
    mediaRecorder, microphone, mimeSupport: Object.freeze(mimeSupport),
  });
}

export function reportObserverError(): void {
  const error = new Error('Recstead observer callback failed');
  try {
    if (typeof globalThis.reportError === 'function') globalThis.reportError(error);
    else console.error(error);
  } catch { /* Observer diagnostics must not affect recorder cleanup. */ }
}

export function notifyObserver<T>(listener: (value: T) => unknown, value: T): void {
  try {
    const returned = listener(value);
    if (returned !== null && (typeof returned === 'object' || typeof returned === 'function')) {
      Promise.resolve(returned).catch(reportObserverError);
    }
  } catch { reportObserverError(); }
}
