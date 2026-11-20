import { createRecorder } from '../../dist/index.js';

export const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
export function pending() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class ObservableTarget extends EventTarget {
  listeners = new Map();
  addEventListener(type, listener, options) {
    super.addEventListener(type, listener, options);
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener); this.listeners.set(type, set);
  }
  removeEventListener(type, listener, options) {
    super.removeEventListener(type, listener, options);
    this.listeners.get(type)?.delete(listener);
  }
  get listenerCount() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
}
export class Track extends ObservableTarget {
  kind = 'audio';
  readyState = 'live';
  muted = false;
  enabled = true;
  stops = 0;
  stop() { this.stops++; this.readyState = 'ended'; }
}
export function stream(...tracks) {
  if (!tracks.length) tracks.push(new Track());
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter(track => track.kind === 'audio'),
    getVideoTracks: () => tracks.filter(track => track.kind === 'video'),
  };
}
export function environment(t, config = {}) {
  const requests = [], natives = [], owned = [], tracks = [], reports = [], constructions = [];
  const timers = new Map();
  let time = 0, timerId = 0;
  const document = new ObservableTarget();
  document.visibilityState = 'visible';
  class NativeRecorder extends ObservableTarget {
    static isTypeSupported(type) { return config.supported ? config.supported.includes(type) : type.startsWith('audio/webm'); }
    state = 'inactive';
    mimeType = config.recorderMime ?? 'audio/webm;codecs=opus';
    commands = [];
    constructor(input, options) {
      super();
      // Every attempt counts, including one that throws.
      constructions.push(options);
      if (config.constructorError) throw config.constructorError;
      this.input = input; this.options = options; natives.push(this);
    }
    // Like the browsers' recorder, every command but start() throws while inactive,
    // and start() throws unless inactive. A controller must never rely on leniency.
    require(active) {
      if ((this.state !== 'inactive') !== active) throw new DOMException(`The recorder is ${this.state}.`, 'InvalidStateError');
    }
    start(slice) {
      this.commands.push(['start', slice]);
      if (config.startError) throw config.startError;
      this.require(false);
      this.state = 'recording';
    }
    stop() {
      this.commands.push(['stop']);
      if (config.stopError) throw config.stopError;
      this.require(true);
      this.state = 'inactive';
      if (config.resetMimeOnStop) this.mimeType = '';
    }
    pause() { this.commands.push(['pause']); this.require(true); this.state = 'paused'; }
    resume() { this.commands.push(['resume']); this.require(true); this.state = 'recording'; }
  }
  const globals = {
    window: {}, document,
    navigator: { mediaDevices: { getUserMedia(constraints) {
      const request = { ...pending(), constraints }; requests.push(request); return request.promise;
    } } },
    MediaRecorder: NativeRecorder, isSecureContext: config.secure !== false,
    performance: { now: () => time },
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, at: time + delay }); return id; },
    clearTimeout: id => { timers.delete(id); },
    reportError: error => { reports.push(error); },
  };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  t.after(async () => {
    for (const recorder of owned) await recorder.dispose();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  async function event(target, name, props = {}) {
    // Events arrive in a later task, independently from native command return.
    await new Promise(setImmediate);
    const event = new Event(name);
    for (const [key, value] of Object.entries(props)) Object.defineProperty(event, key, { value });
    target.dispatchEvent(event);
    await flush();
  }
  async function grant(index = requests.length - 1, input = stream()) {
    tracks.push(...input.getTracks()); requests[index].resolve(input); await flush(); return input;
  }
  return {
    requests, natives, tracks, reports, timers, constructions, document, NativeRecorder, event, grant,
    now: () => time,
    create(options) { const recorder = createRecorder(options); owned.push(recorder); return recorder; },
    async begin(recorder, options) {
      const promise = recorder.start(options);
      const input = await grant();
      const native = natives.at(-1);
      await event(native, 'start');
      const info = await promise;
      return { native, input, info };
    },
    async data(native, text, type = native.mimeType) { await event(native, 'dataavailable', { data: new Blob([text], { type }) }); },
    advance(ms) {
      const target = time + ms;
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]); time = next[1].at; next[1].fn();
      }
      time = target;
    },
  };
}
