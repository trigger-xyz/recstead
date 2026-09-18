import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act, StrictMode, Suspense, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { useRecorder, useRecorderSession, useRecordingUrl } from '../dist/react.js';

function installBrowser(t, { deferredPermission = false } = {}) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://recstead.test/' });
  const requests = [];
  const tracks = [];
  const nativeRecorders = [];
  const pendingPermissions = [];
  class Track extends EventTarget {
    kind = 'audio';
    readyState = 'live';
    enabled = true;
    muted = false;
    stops = 0;
    stop() { this.stops += 1; this.readyState = 'ended'; }
  }
  function stream() {
    const track = new Track();
    tracks.push(track);
    return { getTracks: () => [track], getAudioTracks: () => [track], getVideoTracks: () => [] };
  }
  class MediaRecorder extends EventTarget {
    static isTypeSupported() { return true; }
    state = 'inactive';
    mimeType = 'audio/webm;codecs=opus';
    constructor(input, options) {
      super();
      this.stream = input;
      this.options = options;
      nativeRecorders.push(this);
    }
    start() { this.state = 'recording'; queueMicrotask(() => this.dispatchEvent(new Event('start'))); }
    pause() { this.state = 'paused'; queueMicrotask(() => this.dispatchEvent(new Event('pause'))); }
    resume() { this.state = 'recording'; queueMicrotask(() => this.dispatchEvent(new Event('resume'))); }
    stop() {
      this.state = 'inactive';
      queueMicrotask(() => {
        const event = new Event('dataavailable');
        Object.defineProperty(event, 'data', { value: new Blob(['test recording'], { type: this.mimeType }) });
        this.dispatchEvent(event);
        this.dispatchEvent(new Event('stop'));
      });
    }
  }
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: {
      mediaDevices: {
        getUserMedia(constraints) {
          requests.push(constraints);
          if (deferredPermission) return new Promise(resolve => { pendingPermissions.push(() => resolve(stream())); });
          return Promise.resolve(stream());
        },
      },
    },
    MediaRecorder,
    isSecureContext: true,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  // Browser adapters may read these APIs through window as well as globalThis.
  Object.defineProperty(dom.window.navigator, 'mediaDevices', { value: globals.navigator.mediaDevices });
  dom.window.MediaRecorder = MediaRecorder;
  dom.window.isSecureContext = true;
  const root = createRoot(dom.window.document.getElementById('root'));
  let mounted = true;
  async function unmount() {
    if (mounted) {
      await act(async () => root.unmount());
      mounted = false;
    }
  }
  t.after(async () => {
    await unmount();
    dom.window.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return { root, unmount, requests, tracks, nativeRecorders, pendingPermissions };
}

const idle = Object.freeze({
  status: 'idle', sessionId: null, result: null, error: null,
  permissionPending: false, trackMuted: false,
  timing: Object.freeze({ activeMs: 0, activeSince: null, startedAt: null }),
});

function borrowedRecorder() {
  let snapshot = idle;
  const listeners = new Set();
  const events = new Set();
  const calls = { stop: 0, cancel: 0, dispose: 0, subscriptions: 0 };
  return {
    calls, listeners, events,
    getSnapshot() { return snapshot; },
    subscribe(listener) { calls.subscriptions += 1; listeners.add(listener); return () => listeners.delete(listener); },
    onEvent(listener) { events.add(listener); return () => events.delete(listener); },
    start: async () => ({ sessionId: 'borrowed' }),
    stop: async () => { calls.stop += 1; return null; },
    pause: async () => {}, resume: async () => {}, reset: async () => {},
    cancel: async () => { calls.cancel += 1; },
    dispose: async () => { calls.dispose += 1; },
    setStatus(status) {
      snapshot = Object.freeze({ ...snapshot, status });
      for (const listener of listeners) listener();
      for (const listener of events) listener({ type: 'state', snapshot });
    },
  };
}

test('server rendering is idle and does not acquire a microphone or make object URLs', () => {
  const borrowed = borrowedRecorder();
  borrowed.setStatus('recording');
  function View() {
    const owned = useRecorder();
    const observed = useRecorderSession(borrowed);
    const url = useRecordingUrl({ blob: new Blob(['server']) });
    return React.createElement('p', null, `${owned.status}/${observed.status}/${url}`);
  }
  assert.equal(renderToString(React.createElement(View)), '<p>idle/idle/null</p>');
  assert.equal(borrowed.listeners.size, 0);
  assert.equal(borrowed.events.size, 0);
});

test('StrictMode replays effects with a usable fresh controller and unmount releases capture', async t => {
  const browser = installBrowser(t);
  let view;
  let setups = 0;
  let cleanups = 0;
  function View() {
    view = useRecorder();
    useEffect(() => { setups += 1; return () => { cleanups += 1; }; }, []);
    return React.createElement('p', null, view.status);
  }
  await act(async () => browser.root.render(React.createElement(StrictMode, null, React.createElement(View))));
  assert.equal(setups, 2, 'this test must exercise actual strict effect replay');
  assert.equal(cleanups, 1);
  assert.equal(browser.requests.length, 0, 'rendering and effect setup never prompt');
  const start = view.start;
  await act(async () => { await view.start(); });
  assert.equal(view.status, 'recording');
  assert.equal(view.start, start);
  assert.equal(browser.requests.length, 1);
  let repeated;
  await act(async () => { repeated = await view.start(); });
  assert.equal(repeated.sessionId, view.sessionId);
  assert.equal(browser.requests.length, 1, 'no-argument repeated start reuses the active session');
  await assert.rejects(view.start({ maxBytes: 100 }), { code: 'BUSY' });
  await browser.unmount();
  assert.equal(browser.tracks[0].stops, 1);
  assert.equal(cleanups, 2);
  await assert.rejects(start(), { name: 'RecorderFailure', code: 'NOT_READY' });
  await assert.rejects(view.stop(), { code: 'NOT_READY' });
});

test('owned actions are ready in the component layout effect', async t => {
  const browser = installBrowser(t);
  let view;
  let started;
  function View() {
    view = useRecorder();
    React.useLayoutEffect(() => { started = view.start().catch(error => error); }, []);
    return null;
  }
  await act(async () => browser.root.render(React.createElement(View)));
  const result = await started;
  assert.equal(result.sessionId, view.sessionId);
  assert.equal(view.status, 'recording');
  assert.equal(browser.requests.length, 1);
});

test('unmount rejects an outstanding start and releases a stream granted later', async t => {
  const browser = installBrowser(t, { deferredPermission: true });
  let view;
  const events = [];
  function View() { view = useRecorder(undefined, { onEvent: event => events.push(event) }); return null; }
  await act(async () => browser.root.render(React.createElement(View)));
  let outcome;
  await act(async () => { outcome = view.start().catch(error => error); });
  assert.equal(view.status, 'acquiring');
  await browser.unmount();
  const eventCountAtUnmount = events.length;
  assert.equal((await outcome).code, 'CANCELLED');
  await act(async () => { browser.pendingPermissions[0](); });
  assert.equal(browser.tracks[0].stops, 1);
  assert.equal(browser.nativeRecorders.length, 0);
  assert.equal(events.length, eventCountAtUnmount, 'late cleanup never notifies detached callbacks');
});

test('new committed options affect the next start and callback changes do not restart capture', async t => {
  const browser = installBrowser(t);
  let view;
  const firstEvents = [];
  const secondEvents = [];
  function View({ device, onEvent }) {
    view = useRecorder({ source: { kind: 'microphone', constraints: { deviceId: { exact: device } } } }, { onEvent });
    return null;
  }
  await act(async () => browser.root.render(React.createElement(View, { device: 'first', onEvent: event => firstEvents.push(event) })));
  await act(async () => { await view.start(); });
  const start = view.start;
  await act(async () => browser.root.render(React.createElement(View, { device: 'second', onEvent: event => secondEvents.push(event) })));
  assert.equal(view.start, start);
  assert.equal(browser.requests.length, 1);
  const firstCount = firstEvents.length;
  await act(async () => { await view.pause(); });
  assert.equal(firstEvents.length, firstCount);
  assert.ok(secondEvents.length > 0);
  await act(async () => { await view.cancel(); });
  await act(async () => { await view.start({ source: undefined }); });
  assert.equal(browser.requests.length, 2);
  assert.deepEqual(browser.requests.map(request => request.audio.deviceId.exact), ['first', 'second']);
});

test('a suspended uncommitted render cannot install new options or callbacks', async t => {
  const browser = installBrowser(t);
  let view;
  const committedEvents = [];
  const abandonedEvents = [];
  const pending = new Promise(() => {});
  function View({ suspend }) {
    view = useRecorder({ source: { kind: 'microphone', constraints: { deviceId: { exact: suspend ? 'abandoned' : 'committed' } } } }, {
      onEvent: event => (suspend ? abandonedEvents : committedEvents).push(event),
    });
    if (suspend) throw pending;
    return React.createElement('p', null, view.status);
  }
  const render = suspend => React.createElement(Suspense, { fallback: React.createElement('p', null, 'loading') }, React.createElement(View, { suspend }));
  await act(async () => browser.root.render(render(false)));
  const start = view.start;
  await act(async () => browser.root.render(render(true)));
  await act(async () => { await start(); });
  assert.equal(browser.requests[0].audio.deviceId.exact, 'committed');
  assert.ok(committedEvents.length > 0);
  assert.equal(abandonedEvents.length, 0);
});

test('borrowed controller subscriptions and actions follow replacement without disposal', async t => {
  const browser = installBrowser(t);
  const first = borrowedRecorder();
  const second = borrowedRecorder();
  let view;
  const oldEvents = [];
  const newEvents = [];
  function View({ recorder, onEvent, emitDuringCommit }) {
    view = useRecorderSession(recorder, { onEvent });
    React.useLayoutEffect(() => { emitDuringCommit?.(); }, [emitDuringCommit]);
    return null;
  }
  await act(async () => browser.root.render(React.createElement(View, { recorder: first, onEvent: event => oldEvents.push(event) })));
  const firstStop = view.stop;
  await act(async () => { first.setStatus('recording'); });
  assert.equal(view.status, 'recording');
  await act(async () => browser.root.render(React.createElement(View, { recorder: first, onEvent: event => newEvents.push(event) })));
  assert.equal(view.stop, firstStop);
  assert.equal(first.calls.subscriptions, 1);
  const oldCount = oldEvents.length;
  await act(async () => { first.setStatus('paused'); });
  assert.equal(oldEvents.length, oldCount);
  assert.equal(newEvents.length, 1);
  await act(async () => browser.root.render(React.createElement(View, {
    recorder: second,
    onEvent: event => newEvents.push(event),
    emitDuringCommit: () => first.setStatus('ready'),
  })));
  assert.equal(newEvents.length, 1, 'old controller events are ignored as soon as the new controller commits');
  assert.notEqual(view.stop, firstStop);
  assert.equal(first.listeners.size, 0);
  assert.equal(first.events.size, 0);
  assert.equal(view.status, 'idle');
  await browser.unmount();
  assert.equal(second.listeners.size, 0);
  assert.equal(second.events.size, 0);
  for (const recorder of [first, second]) {
    assert.equal(recorder.calls.dispose, 0);
    assert.equal(recorder.calls.cancel, 0);
    assert.equal(recorder.calls.stop, 0);
  }
  await firstStop();
  assert.equal(first.calls.stop, 1, 'retained borrowed actions still belong to their caller-owned controller');
});

test('borrowed callbacks receive events from the component layout effect on mount and replacement', async t => {
  const browser = installBrowser(t);
  const first = borrowedRecorder();
  const second = borrowedRecorder();
  const received = [];
  function View({ recorder }) {
    useRecorderSession(recorder, { onEvent: event => received.push({ recorder, event }) });
    React.useLayoutEffect(() => { recorder.setStatus('recording'); }, [recorder]);
    return null;
  }
  await act(async () => browser.root.render(React.createElement(View, { recorder: first })));
  assert.equal(received.length, 1);
  assert.equal(received[0].recorder, first);
  await act(async () => browser.root.render(React.createElement(View, { recorder: second })));
  assert.equal(received.length, 2);
  assert.equal(received[1].recorder, second);
  assert.equal(first.events.size, 0);
  await browser.unmount();
  assert.equal(second.events.size, 0);
});

test('Suspense hiding keeps a borrowed subscription and its committed callback', async t => {
  const browser = installBrowser(t);
  const recorder = borrowedRecorder();
  const committed = [];
  const abandoned = [];
  const pending = new Promise(() => {});
  function View({ suspend }) {
    useRecorderSession(recorder, { onEvent: event => (suspend ? abandoned : committed).push(event) });
    if (suspend) throw pending;
    return React.createElement('p', null, 'Recorder');
  }
  const render = suspend => React.createElement(Suspense, { fallback: 'Loading' }, React.createElement(View, { suspend }));
  await act(async () => browser.root.render(render(false)));
  await act(async () => browser.root.render(render(true)));
  await act(async () => { recorder.setStatus('paused'); });
  assert.equal(committed.length, 1);
  assert.equal(abandoned.length, 0);
  assert.equal(recorder.events.size, 1);
  await act(async () => browser.root.render(render(false)));
  assert.equal(recorder.events.size, 1, 'revealing content does not duplicate its subscription');
  await browser.unmount();
  assert.equal(recorder.events.size, 0);
});

function mockObjectUrls(t) {
  const create = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
  const revoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
  const created = [];
  const revoked = [];
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: blob => {
    const url = `blob:owned-${created.length + 1}`;
    created.push({ blob, url });
    return url;
  } });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: url => revoked.push(url) });
  t.after(() => {
    if (create) Object.defineProperty(URL, 'createObjectURL', create); else delete URL.createObjectURL;
    if (revoke) Object.defineProperty(URL, 'revokeObjectURL', revoke); else delete URL.revokeObjectURL;
  });
  return { created, revoked };
}

test('each URL hook revokes its own URL on result replacement and unmount', async t => {
  const browser = installBrowser(t);
  const urls = mockObjectUrls(t);
  const first = { blob: new Blob(['first']) };
  const second = { blob: new Blob(['second']) };
  let values;
  function View({ result }) { values = [useRecordingUrl(result), useRecordingUrl(first)]; return null; }
  await act(async () => browser.root.render(React.createElement(View, { result: first })));
  assert.deepEqual(values, ['blob:owned-1', 'blob:owned-2']);
  await act(async () => browser.root.render(React.createElement(View, { result: second })));
  assert.deepEqual(values, ['blob:owned-3', 'blob:owned-2']);
  assert.deepEqual(urls.revoked, ['blob:owned-1']);
  await act(async () => browser.root.render(React.createElement(View, { result: null })));
  assert.deepEqual(values, [null, 'blob:owned-2']);
  assert.deepEqual(urls.revoked, ['blob:owned-1', 'blob:owned-3']);
  await browser.unmount();
  assert.deepEqual(urls.revoked, ['blob:owned-1', 'blob:owned-3', 'blob:owned-2']);
});

test('StrictMode URL replay revokes the first effect URL and retains only the live one', async t => {
  const browser = installBrowser(t);
  const urls = mockObjectUrls(t);
  const result = { blob: new Blob(['strict']) };
  let value;
  function View() { value = useRecordingUrl(result); return null; }
  await act(async () => browser.root.render(React.createElement(StrictMode, null, React.createElement(View))));
  assert.equal(urls.created.length, 2);
  assert.deepEqual(urls.revoked, ['blob:owned-1']);
  assert.equal(value, 'blob:owned-2');
  await browser.unmount();
  assert.deepEqual(urls.revoked, ['blob:owned-1', 'blob:owned-2']);
});
