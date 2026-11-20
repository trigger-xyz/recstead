import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { isRecorderFailure } from '../dist/index.js';
import { environment, flush, stream, Track } from './helpers/media.mjs';

// Seeded random command and native-event sequences against one controller.
// After every step the controller must hold the invariants below, whatever
// order the commands, grants, native events and timers arrive in.
// RECSTEAD_MODEL_SEED and RECSTEAD_MODEL_RUNS select other sequences.
const DEFAULT_SEED = 20261118;
const BASE_SEED = Number(process.env.RECSTEAD_MODEL_SEED ?? DEFAULT_SEED);
const RUNS = Number(process.env.RECSTEAD_MODEL_RUNS ?? 400);
assert(Number.isSafeInteger(BASE_SEED) && BASE_SEED >= 0, 'RECSTEAD_MODEL_SEED must be a non-negative integer.');
assert(Number.isSafeInteger(RUNS) && RUNS > 0, 'RECSTEAD_MODEL_RUNS must be a positive integer.');
const STEPS = 60;
const ACTIVE = ['initializing', 'recording', 'paused', 'stopping', 'finalizing'];
const STATUSES = ['idle', 'acquiring', ...ACTIVE, 'ready', 'failed', 'disposed'];
const DEFAULTS = { maxBytes: 16 * 1024 * 1024, maxActiveMs: 300_000 };
const WEIGHTS = Object.entries({
  start: 10, startWithOptions: 3, stop: 8, pause: 5, resume: 5, cancel: 4, reset: 3, dispose: 0.3,
  grant: 12, deny: 3, nativeStart: 12, data: 12, nativeStop: 8, nativePause: 5, nativeResume: 5, nativeError: 2,
  nativeInactive: 1.5, trackEnded: 2, mute: 2, unmute: 2, hide: 1, show: 1, advance: 6, staleEvent: 4, reenter: 3,
});
const TOTAL_WEIGHT = WEIGHTS.reduce((sum, [, weight]) => sum + weight, 0);
const START_OPTIONS = [{}, { maxBytes: 32 }, { maxActiveMs: 2000 }, { mime: { candidates: ['audio/webm'], fallback: 'error' } },
  { mime: { candidates: ['audio/unknown'], fallback: 'error' } }, { maxBytes: -1 }, { finalizationTimeoutMs: 1000 }];
const BYTE_LIMIT_OPTION = START_OPTIONS.findIndex(options => options.maxBytes === 32);
const DENIALS = ['NotAllowedError', 'NotFoundError', 'NotReadableError', 'OverconstrainedError', 'UnexpectedError'];
const ADVANCES = [1, 50, 999, 1000, 2000, 10_000, 120_000, 300_000];
const REENTRANT = ['cancel', 'stop', 'start', 'reset', 'pause', 'resume'];

/** @param {number} seed */
function generator(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** @param {number} seed @returns {{ kind: string; a: number; b: number }[]} */
function sequence(seed) {
  const next = generator(seed);
  const random = Array.from({ length: STEPS }, () => {
    let pick = next() * TOTAL_WEIGHT;
    const kind = (WEIGHTS.find(([, weight]) => (pick -= weight) < 0) ?? WEIGHTS[0])[0];
    return { kind, a: next(), b: next() };
  });
  // Uniform sequences rarely get past acquisition, so half of them begin from a session:
  // recording, paused, or past a 32-byte limit with a 24-byte chunk kept and a 47-byte chunk refused.
  const depth = next();
  const recording = ['start', 'grant', 'nativeStart', 'data'].map(kind => ({ kind, a: 0.5, b: 0.5 }));
  const overLimit = [...recording.map(action => action.kind === 'start'
    ? { kind: 'startWithOptions', a: (BYTE_LIMIT_OPTION + 0.5) / START_OPTIONS.length, b: 0.5 } : action), { kind: 'data', a: 0.99, b: 0.5 }];
  const paused = [...recording, ...['pause', 'nativePause'].map(kind => ({ kind, a: 0.5, b: 0.5 }))];
  return [...(depth < 0.5 ? [] : depth < 0.6 ? overLimit : depth < 0.8 ? recording : paused), ...random];
}
/** @template T @param {readonly T[]} items @param {number} fraction @returns {T} */
const choose = (items, fraction) => items[Math.min(items.length - 1, Math.floor(fraction * items.length))];
/** Limits a start() call puts in force; an invalid value never creates a session. */
const limits = (/** @type {Record<string, unknown>} */ options = {}) => ({
  maxBytes: typeof options.maxBytes === 'number' ? options.maxBytes : DEFAULTS.maxBytes,
  maxActiveMs: typeof options.maxActiveMs === 'number' ? options.maxActiveMs : DEFAULTS.maxActiveMs,
});
const emptyCoverage = () => ({ statuses: {}, settled: {}, codes: {}, results: {}, verified: {} });

/**
 * Run one sequence. Returns the first violated invariant, or null.
 * @param {ReturnType<typeof environment>} env
 * @param {{ kind: string; a: number; b: number }[]} actions
 * @param {ReturnType<typeof emptyCoverage>} coverage
 * @returns {Promise<{ invariant: string; message: string } | null>}
 */
async function execute(env, actions, coverage) {
  // A failed earlier run is torn down before it returns; this baseline covers what the environment keeps.
  env.timers.clear();
  const base = { requests: env.requests.length, natives: env.natives.length, tracks: env.tracks.length,
    documentListeners: env.document.listenerCount };
  env.document.visibilityState = 'visible';
  const recorder = env.create();
  /** @type {string[]} */
  const violations = [];
  const count = (/** @type {string} */ name) => { coverage.verified[name] = (coverage.verified[name] ?? 0) + 1; };
  /** @type {{ name: string; settled: boolean }[]} */
  const commands = [];
  const settledRequests = new Set();
  /** Chunks each native recorder delivered while the controller listened. @type {Map<unknown, { text: string; type: string }[]>} */
  const chunks = new Map();
  /** @typedef {{ maxBytes: number; maxActiveMs: number; active: [number, number]; wall: [number, number]; expected: Set<string>; announced: Set<string> }} SessionModel */
  /** @type {Map<string, SessionModel>} */
  const sessions = new Map();
  const published = new Set();
  const finished = new Set();
  /** @type {Promise<void>[]} */
  const reading = [];
  /** @type {string | null} */
  let currentId = null;
  /** @type {string | null} */
  let latestId = null;
  let newest = 0;
  /** @type {ReturnType<typeof limits> | null} */
  let starting = null;
  /** @type {string | null} */
  let reenter = null;
  let disposed = false;
  let notificationsAfterDispose = 0;
  let chunkNumber = 0;

  const session = (/** @type {string} */ id) => {
    let entry = sessions.get(id);
    if (!entry) sessions.set(id, entry = { ...(starting ?? DEFAULTS), active: [0, 0], wall: [0, 0], expected: new Set(), announced: new Set() });
    return entry;
  };
  const within = (/** @type {number} */ value, /** @type {[number, number]} */ [low, high]) => value >= low && value <= high;

  /** Checks that need nothing but one snapshot; they also run on every published state. */
  const coherent = (/** @type {ReturnType<typeof recorder.getSnapshot>} */ snapshot) => {
    const say = (/** @type {boolean} */ holds, /** @type {string} */ message) => { if (!holds) violations.push(`${message} [${snapshot.status}]`); };
    const active = ACTIVE.includes(snapshot.status);
    say(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.timing), 'snapshot is not frozen');
    say(STATUSES.includes(snapshot.status), 'unknown status');
    if (snapshot.status === 'idle' || snapshot.status === 'disposed') say(snapshot.result === null && snapshot.error === null && snapshot.sessionId === null, 'idle state retains output');
    if (snapshot.status === 'acquiring' || active) say(snapshot.result === null && snapshot.error === null && snapshot.sessionId !== null, 'active state exposes terminal output');
    if (snapshot.status === 'ready') say(snapshot.result?.completion === 'complete' && snapshot.error === null && snapshot.result.sessionId === snapshot.sessionId, 'ready without a complete result');
    if (snapshot.status === 'failed') {
      say(isRecorderFailure(snapshot.error), 'failed without a recorder failure');
      say(snapshot.result === null || (snapshot.result.completion === 'partial' && snapshot.error?.partial === snapshot.result), 'failed output is not marked partial');
    }
    say(active || snapshot.trackMuted === false, 'mute state outside an active session');
    say(snapshot.timing.activeMs >= 0, 'negative active time');
    say(snapshot.status !== 'recording' || snapshot.timing.activeSince !== null, 'recording without a running clock');
    say(snapshot.status !== 'paused' || snapshot.timing.activeSince === null, 'paused with a running clock');
    // Every session takes a new, larger identifier, and a finished one never becomes active again.
    const id = snapshot.sessionId;
    if (id === null) { if (currentId !== null) finished.add(currentId); currentId = null; return; }
    if (id !== currentId) {
      say(!sessions.has(id) && Number(id) > newest, 'a session identifier was reused');
      if (currentId !== null) finished.add(currentId);
      currentId = latestId = id; newest = Math.max(newest, Number(id)); session(id);
    } else say(!(finished.has(id) && (active || snapshot.status === 'acquiring')), 'a finished session became active again');
    if (!active && snapshot.status !== 'acquiring') finished.add(id);
  };

  /** @param {string} name @param {Promise<unknown>} promise @param {ReturnType<typeof recorder.getSnapshot>} before */
  const track = (name, promise, before) => {
    const entry = { name, settled: false };
    commands.push(entry);
    promise.then(value => {
      entry.settled = true;
      if (name === 'stop' && value === null) {
        // null means no recording had started; it is never the outcome of a started one.
        if (['recording', 'paused', 'stopping', 'finalizing', 'ready'].includes(before.status)) violations.push(`stop resolved null from ${before.status}`);
      } else if (name === 'stop') {
        const result = /** @type {{ sessionId: string }} */ (value);
        count('stopResults');
        if (!published.has(result)) violations.push('stop resolved a value that was never published as a result');
        if (before.status === 'ready' ? result !== before.result : result.sessionId !== before.sessionId) violations.push('stop resolved the result of another session');
      } else if (name === 'start') {
        const info = /** @type {{ sessionId?: string } | undefined} */ (value);
        if (!info || !Object.isFrozen(info) || typeof info.sessionId !== 'string' || !sessions.has(info.sessionId)) violations.push('start resolved without its session');
      } else if (value !== undefined) violations.push(`${name} resolved a value`);
    }, error => {
      entry.settled = true;
      if (!isRecorderFailure(error)) violations.push(`${name} rejected with a non-recorder error: ${String(error)}`);
      else coverage.codes[error.code] = (coverage.codes[error.code] ?? 0) + 1;
    });
  };
  /** @param {string} name @param {Record<string, unknown>} [options] */
  const command = (name, options) => {
    const before = recorder.getSnapshot();
    if (name === 'dispose') disposed = true;
    // start() publishes its session before it returns; the model reads the limits it was given then.
    // A command issued from inside that notification must leave them in place.
    const outer = starting;
    if (name === 'start') starting = limits(options);
    const call = /** @type {Record<string, (options?: unknown) => Promise<unknown>>} */ (/** @type {unknown} */ (recorder))[name];
    try { track(name, options === undefined ? call() : call(options), before); }
    finally { starting = outer; }
  };
  recorder.subscribe(() => {
    if (disposed) notificationsAfterDispose++;
    const status = recorder.getSnapshot().status;
    coverage.statuses[status] = (coverage.statuses[status] ?? 0) + 1;
    if (reenter) { const name = reenter; reenter = null; command(name); }
  });
  recorder.onEvent(event => {
    if (disposed) notificationsAfterDispose++;
    if (event.type === 'state') { coherent(event.snapshot); return; }
    if (event.type === 'warning') {
      // A callback may already have ended the session this warning was queued for.
      const id = recorder.getSnapshot().sessionId ?? latestId;
      if (id === null) violations.push('warning before any session'); else session(id).announced.add(event.warning.code);
      return;
    }
    if (event.type === 'error' && !isRecorderFailure(event.error)) violations.push('error event without a recorder failure');
    // Complete output arrives as a result event, partial output on the failure.
    const result = event.type === 'result' ? event.result : event.type === 'error' ? event.error.partial : undefined;
    if (!result) return;
    if (event.type === 'result') published.add(result);
    if ((event.type === 'result') !== (result.completion === 'complete')) violations.push(`${result.completion} output on a ${event.type} event`);
    coverage.results[result.completion] = (coverage.results[result.completion] ?? 0) + 1;
    const model = session(result.sessionId);
    const delivered = chunks.get(env.natives.at(-1)) ?? [];
    const received = delivered.reduce((sum, chunk) => sum + chunk.text.length, 0);
    if (!Object.isFrozen(result)) violations.push('result is not frozen');
    if (result.bytes !== result.blob.size) violations.push('result bytes differ from its Blob');
    if (result.receivedBytes !== received) violations.push(`receivedBytes ${result.receivedBytes} differs from delivered ${received}`);
    // Output is the delivered chunks, in order, up to the first one refused for size or format.
    let mime = '';
    let kept = '';
    for (const chunk of delivered) {
      if (chunk.text.length > model.maxBytes - kept.length || (chunk.type && mime && chunk.type !== mime)) break;
      mime ||= chunk.type; kept += chunk.text;
    }
    if (result.completion === 'complete' && kept.length !== received) violations.push('complete result after a refused chunk');
    reading.push(result.blob.text().then(text => {
      count(result.completion === 'complete' ? 'completeContent' : 'partialContent');
      if (kept.length < received) count('refusedChunk');
      if (text !== kept) violations.push(`${result.completion} output holds ${JSON.stringify(text)}, expected ${JSON.stringify(kept)}`);
    }));
    // Time: only the fake clock advancing while the session recorded counts as active.
    if (model.active[0] > 0) count('timedResults');
    if (!within(result.activeMs, model.active)) violations.push(`result activeMs ${result.activeMs} outside ${model.active.join('..')}`);
    if (!within(result.wallMs, model.wall) || result.wallMs < result.activeMs) violations.push(`result wallMs ${result.wallMs} outside ${model.wall.join('..')}`);
    const codes = result.warnings.map(warning => warning.code);
    if (new Set(codes).size !== codes.length) violations.push('a warning is repeated in the result');
    for (const code of model.expected) {
      count('warnings');
      if (!codes.includes(code)) violations.push(`result lost its ${code} warning`);
    }
  });

  const currentNative = () => env.natives.length > base.natives ? env.natives.at(-1) : undefined;
  const currentTrack = () => env.tracks.length > base.tracks ? env.tracks.at(-1) : undefined;
  const unsettled = () => env.requests.slice(base.requests).filter(request => !settledRequests.has(request));
  /** The session a native or track event reaches, if the controller is still listening. */
  const listening = () => { const snapshot = recorder.getSnapshot(); return ACTIVE.includes(snapshot.status) && snapshot.sessionId ? session(snapshot.sessionId) : null; };

  /** @param {{ kind: string; a: number; b: number }} action */
  const apply = async action => {
    const native = currentNative();
    const audio = currentTrack();
    switch (action.kind) {
      case 'start': case 'stop': case 'pause': case 'resume': case 'cancel': case 'reset': case 'dispose':
        command(action.kind); break;
      case 'startWithOptions': command('start', choose(START_OPTIONS, action.a)); break;
      case 'grant': case 'deny': {
        const pending = unsettled();
        if (!pending.length) break;
        const request = choose(pending, action.a);
        settledRequests.add(request);
        // Only an acquiring controller is waiting for this answer. For any other, it is late.
        const before = recorder.getSnapshot();
        const late = before.status !== 'acquiring' && reenter === null;
        if (action.kind === 'deny') request.reject(Object.assign(new Error('denied'), { name: choose(DENIALS, action.b) }));
        else {
          const input = action.b < 0.08 ? stream(new Track(), new Track()) : stream();
          await env.grant(env.requests.indexOf(request), input);
        }
        await flush();
        if (late) {
          count('lateOutcomes');
          const after = recorder.getSnapshot();
          const same = after.status === before.status && after.sessionId === before.sessionId && after.result === before.result &&
            after.error === before.error && after.trackMuted === before.trackMuted && JSON.stringify(after.timing) === JSON.stringify(before.timing);
          if (!same) violations.push('a late permission outcome changed more than permissionPending');
        }
        break;
      }
      case 'nativeStart': if (native) await env.event(native, 'start'); break;
      case 'data': {
        if (!native) break;
        const size = Math.floor(action.a * 48);
        const type = action.b < 0.8 ? native.mimeType : action.b < 0.92 ? '' : 'audio/ogg';
        // Each chunk has its own letter, so lost, repeated or reordered audio shows in the output.
        const text = String.fromCharCode(97 + chunkNumber++ % 26).repeat(size);
        if (size > 0 && native.listenerCount > 0) chunks.set(native, [...(chunks.get(native) ?? []), { text, type }]);
        await env.event(native, 'dataavailable', { data: new Blob([text], { type }) });
        break;
      }
      case 'nativeStop': if (native) { native.state = 'inactive'; await env.event(native, 'stop'); } break;
      // A recorder that stops by itself is inactive before its final events arrive, or without them.
      case 'nativeInactive': if (native) native.state = 'inactive'; break;
      case 'nativePause': if (native) await env.event(native, 'pause'); break;
      case 'nativeResume': if (native) await env.event(native, 'resume'); break;
      case 'nativeError': if (native) await env.event(native, 'error', { error: new Error('encoder') }); break;
      case 'trackEnded': if (audio) { audio.readyState = 'ended'; await env.event(audio, 'ended'); } break;
      case 'mute': case 'unmute': {
        if (!audio) break;
        const code = action.kind === 'mute' ? 'track-muted' : 'track-unmuted';
        const model = listening();
        model?.expected.add(code); model?.announced.delete(code);
        audio.muted = action.kind === 'mute'; await env.event(audio, action.kind);
        if (model && !model.announced.has(code)) violations.push(`no ${code} warning`);
        break;
      }
      case 'hide': case 'show':
        env.document.visibilityState = action.kind === 'hide' ? 'hidden' : 'visible';
        await env.event(env.document, 'visibilitychange'); break;
      case 'advance': {
        const ms = choose(ADVANCES, action.a);
        const before = recorder.getSnapshot();
        const model = before.sessionId === null ? null : session(before.sessionId);
        const clocks = /** @type {[[number, number], string[]][]} */ (model ? [[model.active, ['recording']], [model.wall, ['recording', 'paused']]] : [])
          .filter(([, statuses]) => statuses.includes(before.status));
        // A timer may end the interval part of the way through, and publish its result before this returns.
        for (const [bounds] of clocks) bounds[1] += ms;
        env.advance(ms);
        const after = recorder.getSnapshot();
        // Otherwise the whole interval counted, and the time is known exactly.
        for (const [bounds, statuses] of clocks) if (after.sessionId === before.sessionId && statuses.includes(after.status)) bounds[0] += ms;
        break;
      }
      case 'staleEvent': {
        // Events from an earlier session's recorder or track must not reach the current one.
        const natives = env.natives.slice(base.natives, -1);
        const tracks = env.tracks.slice(base.tracks, -1);
        const before = recorder.getSnapshot();
        if (natives.length && action.b < 0.5) await env.event(choose(natives, action.a), choose(['start', 'stop', 'pause', 'resume', 'error', 'dataavailable'], action.b * 2), { data: new Blob(['stale']) });
        else if (tracks.length) await env.event(choose(tracks, action.a), choose(['ended', 'mute', 'unmute'], action.b));
        if (recorder.getSnapshot() !== before) violations.push('a stale event changed the snapshot');
        break;
      }
      case 'reenter': reenter = choose(REENTRANT, action.a); break;
    }
    await flush(); await flush();
    await Promise.all(reading.splice(0));
  };

  const check = () => {
    const snapshot = recorder.getSnapshot();
    const active = ACTIVE.includes(snapshot.status);
    const tracks = env.tracks.slice(base.tracks);
    const natives = env.natives.slice(base.natives);
    const pending = unsettled();
    const say = (/** @type {boolean} */ holds, /** @type {string} */ message) => { if (!holds) violations.push(`${message} [${snapshot.status}]`); };
    coverage.settled[snapshot.status] = (coverage.settled[snapshot.status] ?? 0) + 1;
    coherent(snapshot);
    say(disposed === (snapshot.status === 'disposed'), 'disposal and status disagree');
    // Acquisition: one request at most, and the snapshot reports it until the browser settles it.
    say(pending.length <= 1, 'overlapping microphone requests');
    say(snapshot.permissionPending === (pending.length === 1), 'permissionPending disagrees with the outstanding request');
    say(snapshot.status !== 'acquiring' || pending.length === 1, 'acquiring without an outstanding request');
    // Tracks: only the active session's single track is live; everything else was stopped exactly once.
    const live = tracks.filter(item => item.stops === 0);
    say(live.length === (active ? 1 : 0), `${live.length} live tracks`);
    say(!active || live[0] === tracks.at(-1), 'the live track is not the current session track');
    say(tracks.every(item => item.stops <= 1), 'a track was stopped twice');
    say(!active || snapshot.trackMuted === tracks.at(-1)?.muted, 'mute state differs from the track');
    // Listeners and timers belong to the active session only.
    const owner = active ? natives.at(-1) : undefined;
    say(natives.every(item => item === owner || item.listenerCount === 0), 'listeners remain on an earlier recorder');
    say(tracks.every(item => (active && item === tracks.at(-1)) || item.listenerCount === 0), 'listeners remain on a released track');
    say(!active || (owner !== undefined && owner.listenerCount > 0), 'the active recorder has no listeners');
    say(env.document.listenerCount - base.documentListeners === (active ? 1 : 0), 'document listener count');
    say(active ? env.timers.size <= 4 : env.timers.size === 0, `${env.timers.size} timers`);
    say(notificationsAfterDispose === 0, 'notification after disposal');
    if (snapshot.sessionId === null) return;
    const model = session(snapshot.sessionId);
    // Time: the recording stops itself at its limit, and active time is exactly what the clock gave it.
    const { activeMs, activeSince } = snapshot.timing;
    const elapsed = activeMs + (snapshot.status === 'recording' && activeSince !== null ? env.now() - activeSince : 0);
    say(within(elapsed, model.active), `active time ${elapsed} outside ${model.active.join('..')}`);
    say(snapshot.status !== 'recording' && snapshot.status !== 'paused' || elapsed < model.maxActiveMs, 'recording past its duration limit');
    // A page hidden during an active session is always announced.
    if (active && env.document.visibilityState === 'hidden') {
      model.expected.add('page-hidden');
      say(model.announced.has('page-hidden'), 'no page-hidden warning');
    }
  };

  /** A failed run must not leave a controller, timers or listeners behind for the next one. */
  const abandon = async () => {
    disposed = true;
    await recorder.dispose().catch(() => {});
    for (const request of unsettled()) { settledRequests.add(request); await env.grant(env.requests.indexOf(request), stream()); }
    await flush(); await Promise.allSettled(reading.splice(0));
  };
  const failure = async (/** @type {string} */ where) => {
    const message = violations[0];
    await abandon();
    // The invariant, without the status it was observed in, identifies the defect while shrinking.
    return { invariant: message.replace(/ \[[a-z]+\]$/, '').replace(/[0-9]+/g, 'N'), message: `${where}: ${message}` };
  };

  for (const [index, action] of actions.entries()) {
    await apply(action);
    check();
    if (violations.length) return failure(`step ${index} (${action.kind})`);
  }
  // Disposal settles every command at once, before any outstanding permission request is answered.
  command('dispose');
  await flush(); await flush();
  const waiting = commands.filter(entry => !entry.settled).map(entry => entry.name);
  if (waiting.length) violations.push(`commands not settled by disposal: ${waiting.join(', ')}`);
  // It also returns every resource, including a stream granted afterwards.
  for (const request of unsettled()) { settledRequests.add(request); await env.grant(env.requests.indexOf(request), stream()); }
  await flush(); await flush();
  check();
  return violations.length ? failure('after disposal') : null;
}

test(`${RUNS} seeded lifecycle sequences keep every ownership invariant`, async t => {
  const env = environment(t);
  const coverage = emptyCoverage();
  for (let run = 0; run < RUNS; run++) {
    const seed = BASE_SEED + run;
    const original = sequence(seed);
    const failure = await execute(env, original, coverage);
    if (!failure) continue;
    // Shrink: drop every step whose removal still breaks the same invariant.
    let actions = original;
    let message = failure.message;
    for (let index = actions.length - 1; index >= 0; index--) {
      const candidate = actions.filter((_, position) => position !== index);
      const repeated = await execute(env, candidate, emptyCoverage());
      if (repeated?.invariant === failure.invariant) { actions = candidate; message = repeated.message; }
    }
    assert.fail(`Seed ${seed}, ${original.length} steps, ${failure.message}\nShrunk to ${actions.length} steps, ${message}:\n${JSON.stringify(actions)}`);
  }
  await mkdir('.artifacts', { recursive: true });
  await writeFile('.artifacts/model-check.json', JSON.stringify({ checkedAt: new Date().toISOString(), baseSeed: BASE_SEED,
    runs: RUNS, stepsPerRun: STEPS, coverage }, null, 2) + '\n');
  // The sequences must actually reach every state, the main failure paths and each kind of check. This is
  // asserted where it cannot fail by chance: for the fixed default sequences, or for enough runs that the
  // rarest required outcome is certain to appear.
  if (RUNS >= 2000 || (BASE_SEED === DEFAULT_SEED && RUNS >= 400)) {
    // `statuses` counts notifications, `settled` the state left after each step.
    for (const status of STATUSES) assert(coverage.statuses[status] > 0 || coverage.settled[status] > 0, `No sequence reached ${status}`);
    for (const status of ['recording', 'paused', 'stopping', 'ready', 'failed']) assert(coverage.settled[status] >= 50, `Too few steps checked in ${status}`);
    for (const code of ['CANCELLED', 'BUSY', 'INVALID_STATE', 'ACQUISITION_PENDING', 'DISPOSED', 'PERMISSION_DENIED', 'EMPTY_OUTPUT',
      'RECORDING_FAILED', 'SOURCE_ENDED', 'BUFFER_LIMIT', 'INVALID_SOURCE', 'INVALID_OPTIONS', 'UNSUPPORTED_FORMAT', 'FINALIZATION_TIMEOUT']) {
      assert(coverage.codes[code] > 0, `No sequence produced ${code}`);
    }
    assert(coverage.results.complete > 0 && coverage.results.partial > 0, 'Sequences must produce complete and partial output');
    for (const kind of ['stopResults', 'lateOutcomes', 'completeContent', 'partialContent', 'refusedChunk', 'timedResults', 'warnings']) {
      assert(coverage.verified[kind] >= 5, `Too few sequences exercised the ${kind} check`);
    }
  }
});
