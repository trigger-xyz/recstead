import { expect, type Page } from '@playwright/test';

declare global {
  interface Window {
    captureTest: {
      mode: 'normal' | 'defer' | 'deny';
      requests: number;
      streams: MediaStream[];
      /** Every track handed to the application, kept apart from its stream. */
      tracks: MediaStreamTrack[];
      recorders: MediaRecorder[];
      urls: Set<string>;
      /** Seconds of audio the generated tone has rendered; null when the engine's own device is recorded. */
      audioSeconds: () => number | null;
      grant: () => Promise<void>;
      fail: () => void;
    };
  }
}

/** Engines whose automation build has no capture device record a generated tone instead. */
export function usesGeneratedSource(browserName: string): boolean {
  return browserName === 'webkit';
}

/** Playwright's WebKit builds for Linux and Windows ship without MediaRecorder. */
export function lacksNativeRecorder(browserName: string): boolean {
  return browserName === 'webkit' && process.platform !== 'darwin';
}

/** Headless Firefox cannot start Web Audio on a host without an audio output device. */
export async function webAudioStarts(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const context = new AudioContext();
    try {
      return await Promise.race([context.resume().then(() => true),
        new Promise<boolean>(resolve => { setTimeout(() => resolve(false), 3_000); })]);
    } finally { void context.close(); }
  });
}

/**
 * Only the tests install this instrumentation; app code has no test globals.
 * With `generated`, acquisition returns a Web Audio tone. The engine's own
 * MediaRecorder still encodes it; only the capture device is replaced.
 */
export async function observeCapture(page: Page, generated = false): Promise<void> {
  await page.addInitScript(generated => {
    // Patch the prototype: WebKit can collect the navigator.mediaDevices wrapper,
    // and an override stored on that instance would silently disappear with it.
    const devices = navigator.mediaDevices;
    const deviceAcquire = MediaDevices.prototype.getUserMedia.bind(devices);
    let tone: AudioContext | undefined;
    const toneAcquire = async (): Promise<MediaStream> => {
      const context = new AudioContext();
      tone = context;
      const destination = context.createMediaStreamDestination();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      gain.gain.value = 0.2;
      oscillator.connect(gain).connect(destination);
      oscillator.start();
      if (context.state === 'suspended') await context.resume();
      const track = destination.stream.getAudioTracks()[0];
      if (!track) throw new DOMException('No generated track', 'NotFoundError');
      const stopTrack = track.stop.bind(track);
      track.stop = () => { stopTrack(); if (context.state !== 'closed') void context.close(); };
      return destination.stream;
    };
    const nativeAcquire = generated ? toneAcquire : deviceAcquire;
    const nativeCreate = URL.createObjectURL.bind(URL);
    const nativeRevoke = URL.revokeObjectURL.bind(URL);
    const NativeRecorder = window.MediaRecorder;
    const recorders: MediaRecorder[] = [];
    let grantPending: (() => Promise<void>) | undefined;
    const state: Window['captureTest'] = {
      mode: 'normal', requests: 0, streams: [], tracks: [], recorders, urls: new Set(),
      audioSeconds: () => tone?.currentTime ?? null,
      async grant() { if (!grantPending) throw new Error('No pending acquisition'); await grantPending(); },
      fail() { recorders.at(-1)?.dispatchEvent(new Event('error')); },
    };
    window.captureTest = state;
    MediaDevices.prototype.getUserMedia = async constraints => {
      state.requests++;
      if (state.mode === 'deny') throw new DOMException('Simulated permission denial', 'NotAllowedError');
      const acquire = async (): Promise<MediaStream> => {
        const stream = await nativeAcquire(constraints);
        // Remember the tracks themselves: a track removed from its stream without being stopped is still live.
        state.streams.push(stream); state.tracks.push(...stream.getTracks());
        return stream;
      };
      if (state.mode === 'defer') return new Promise<MediaStream>((resolve, reject) => {
        grantPending = async () => {
          grantPending = undefined;
          // The test must learn of a failed acquisition too, or it would check the release of nothing.
          try { resolve(await acquire()); } catch (error) { reject(error); throw error; }
        };
      });
      return acquire();
    };
    if (typeof NativeRecorder === 'function') window.MediaRecorder = class extends NativeRecorder {
      constructor(stream: MediaStream, options?: MediaRecorderOptions) { super(stream, options); recorders.push(this); }
    };
    URL.createObjectURL = object => { const url = nativeCreate(object); state.urls.add(url); return url; };
    URL.revokeObjectURL = url => { state.urls.delete(url); nativeRevoke(url); };
  }, generated);
}

/**
 * Let the active recorder receive `ms` of audio. Waiting is not enough for the generated tone:
 * on a slow host its audio clock starts late, and a recorder stopped before any audio arrived
 * reports EMPTY_OUTPUT. So the tone must also have rendered that much audio.
 */
export async function captureFor(page: Page, ms: number): Promise<void> {
  const before = await page.evaluate(() => window.captureTest.audioSeconds());
  await page.waitForTimeout(ms);
  if (before === null) return;
  await expect.poll(() => page.evaluate(() => window.captureTest.audioSeconds()),
    { message: `The generated tone must render ${ms} ms of audio into the recording.`, timeout: 15_000, intervals: [25, 50, 100, 250] }).toBeGreaterThanOrEqual(before + ms / 1000);
}

export async function record(page: Page, pause = false): Promise<void> {
  // The notes app disables Record until its storage has loaded; focus() does not wait for that.
  await expect(page.getByRole('button', { name: 'Record', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Record', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await captureFor(page, 350); // Produce actual native audio, not a fabricated data event.
  if (pause) {
    await page.getByRole('button', { name: 'Pause', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeFocused();
    await captureFor(page, 150);
  }
  await page.getByRole('button', { name: 'Stop', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Ready to review' })).toBeVisible();
}

export async function assertReleased(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => window.captureTest.tracks.every(track => track.readyState === 'ended'))).toBe(true);
}

/** A grant that arrives after the session ended: one stream was delivered, its track was stopped, and nothing recorded it. */
export async function assertLateGrantReleased(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => ({ streams: window.captureTest.streams.length, recorders: window.captureTest.recorders.length,
    tracks: window.captureTest.tracks.map(track => `${track.kind} ${track.readyState}`) }))).toEqual({ streams: 1, recorders: 0, tracks: ['audio ended'] });
}

export interface AudioDigest { bytes: number; sha256: string; type: string }

/** Size, hash and media type of what an audio player would play. */
export async function audioDigest(page: Page, label: string): Promise<AudioDigest> {
  return page.getByLabel(label, { exact: true }).evaluate(async element => {
    if (!(element instanceof HTMLAudioElement)) throw new Error('Expected an audio player');
    const response = await fetch(element.src);
    const data = await response.arrayBuffer();
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    return { bytes: data.byteLength, sha256: [...digest].map(byte => byte.toString(16).padStart(2, '0')).join(''),
      type: (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() };
  });
}

export async function decodedSeconds(page: Page, label: string): Promise<number> {
  return page.getByLabel(label, { exact: true }).evaluate(async element => {
    if (!(element instanceof HTMLAudioElement)) throw new Error('Expected an audio player');
    const bytes = await (await fetch(element.src)).arrayBuffer();
    const context = new AudioContext();
    try { return (await context.decodeAudioData(bytes)).duration; }
    finally { await context.close(); }
  });
}

/** Counts of everything a session can leave behind in the page. */
export async function resourceCounts(page: Page): Promise<{ requests: number; streams: number; liveTracks: number; recorders: number; activeRecorders: number; urls: number }> {
  return page.evaluate(() => ({
    requests: window.captureTest.requests, streams: window.captureTest.streams.length,
    liveTracks: window.captureTest.tracks.filter(track => track.readyState !== 'ended').length,
    recorders: window.captureTest.recorders.length,
    activeRecorders: window.captureTest.recorders.filter(recorder => recorder.state !== 'inactive').length,
    urls: window.captureTest.urls.size,
  }));
}
