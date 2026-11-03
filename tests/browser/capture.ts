import { expect, type Page } from '@playwright/test';

declare global {
  interface Window {
    captureTest: {
      mode: 'normal' | 'defer' | 'deny';
      requests: number;
      streams: MediaStream[];
      urls: Set<string>;
      grant: () => Promise<void>;
      fail: () => void;
    };
  }
}

/** Only the tests install this instrumentation; app code has no test globals. */
export async function observeCapture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const nativeAcquire = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const nativeCreate = URL.createObjectURL.bind(URL);
    const nativeRevoke = URL.revokeObjectURL.bind(URL);
    const NativeRecorder = window.MediaRecorder;
    const recorders: MediaRecorder[] = [];
    let grantPending: (() => Promise<void>) | undefined;
    const state: Window['captureTest'] = {
      mode: 'normal', requests: 0, streams: [], urls: new Set(),
      async grant() { if (!grantPending) throw new Error('No pending acquisition'); await grantPending(); },
      fail() { recorders.at(-1)?.dispatchEvent(new Event('error')); },
    };
    window.captureTest = state;
    navigator.mediaDevices.getUserMedia = async constraints => {
      state.requests++;
      if (state.mode === 'deny') throw new DOMException('Simulated permission denial', 'NotAllowedError');
      const acquire = async (): Promise<MediaStream> => {
        const stream = await nativeAcquire(constraints); state.streams.push(stream); return stream;
      };
      if (state.mode === 'defer') return new Promise<MediaStream>((resolve, reject) => {
        grantPending = async () => {
          grantPending = undefined;
          try { resolve(await acquire()); } catch (error) { reject(error); }
        };
      });
      return acquire();
    };
    window.MediaRecorder = class extends NativeRecorder {
      constructor(stream: MediaStream, options?: MediaRecorderOptions) { super(stream, options); recorders.push(this); }
    };
    URL.createObjectURL = object => { const url = nativeCreate(object); state.urls.add(url); return url; };
    URL.revokeObjectURL = url => { state.urls.delete(url); nativeRevoke(url); };
  });
}

export async function record(page: Page, pause = false): Promise<void> {
  await page.getByRole('button', { name: 'Record', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await page.waitForTimeout(350); // Produce actual native audio, not a fabricated data event.
  if (pause) {
    await page.getByRole('button', { name: 'Pause', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeFocused();
    await page.waitForTimeout(150);
  }
  await page.getByRole('button', { name: 'Stop', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Ready to review' })).toBeVisible();
}

export async function assertReleased(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => window.captureTest.streams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true);
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
