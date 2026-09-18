import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createRecorder, getCapabilities, isRecorderFailure } from '../dist/index.js';
import { environment, flush, stream, Track } from './helpers/media.mjs';
const rejects = (promise, code) => assert.rejects(promise, error => isRecorderFailure(error) && error.code === code);

async function complete(env, recorder, native, text = 'final') {
  const stopping = recorder.stop();
  await env.data(native, text);
  await env.event(native, 'stop');
  return stopping;
}

test('import and construction read no browser APIs and snapshots are stable and frozen', () => {
  const entry = new URL('../dist/index.js', import.meta.url).href;
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    for (const key of ['window', 'navigator', 'MediaRecorder', 'URL', 'performance', 'document'])
      Object.defineProperty(globalThis, key, { configurable: true, get() { throw new Error(key); } });
    const { createRecorder } = await import(${JSON.stringify(entry)});
    const r = createRecorder();
    if (r.getSnapshot() !== r.getSnapshot() || r.getSnapshot().status !== 'idle') throw new Error('snapshot');
  `]);
  const recorder = createRecorder();
  assert.ok(Object.isFrozen(recorder.getSnapshot()));
  assert.ok(Object.isFrozen(recorder.getSnapshot().timing));
  assert.equal(getCapabilities().environment, 'server');
});

test('capabilities, insecure context and unsupported formats never request media', async t => {
  const env = environment(t, { secure: false });
  assert.deepEqual({ ...getCapabilities(['audio/webm', 'audio/mp3']).mimeSupport }, { 'audio/webm': true, 'audio/mp3': false });
  const recorder = env.create();
  await rejects(recorder.start(), 'INSECURE_CONTEXT');
  globalThis.isSecureContext = true;
  await rejects(recorder.start({ mime: { candidates: ['audio/mp3'], fallback: 'error' } }), 'UNSUPPORTED_FORMAT');
  assert.equal(env.requests.length, 0);
  delete globalThis.MediaRecorder.isTypeSupported;
  assert.equal(getCapabilities(['audio/webm']).mimeSupport['audio/webm'], null);
  await rejects(recorder.start({ mime: { candidates: ['audio/webm'], fallback: 'error' } }), 'UNSUPPORTED_FORMAT');
});

test('start resolves on its event and stop awaits all final bytes and terminal stop', async t => {
  const env = environment(t, { resetMimeOnStop: true });
  const recorder = env.create();
  const states = [];
  recorder.subscribe(() => states.push(recorder.getSnapshot().status));
  const starting = recorder.start();
  assert.equal(env.requests.length, 1);
  assert.equal(recorder.getSnapshot().status, 'acquiring');
  await env.grant();
  const native = env.natives[0];
  assert.equal(recorder.getSnapshot().status, 'initializing');
  assert.deepEqual(native.commands, [['start', 1000]]);
  await env.event(native, 'start');
  const info = await starting;
  assert.ok(Object.isFrozen(info));
  assert.equal(await recorder.start(), info);
  await rejects(recorder.start({}), 'BUSY');
  await env.data(native, 'first', 'audio/webm;codecs=opus');
  const stable = recorder.getSnapshot();
  await env.data(native, '', 'audio/webm');
  assert.equal(recorder.getSnapshot(), stable);
  const stopping = recorder.stop();
  const repeated = recorder.stop();
  let settled = false;
  void stopping.then(() => { settled = true; });
  await env.data(native, 'last', 'audio/webm;codecs=opus');
  assert.equal(settled, false);
  assert.equal(env.tracks[0].stops, 0);
  await env.event(native, 'stop');
  const result = await stopping;
  assert.equal(await repeated, result);
  assert.equal(await recorder.stop(), result);
  assert.equal(await result.blob.text(), 'firstlast');
  assert.equal(result.mimeType, 'audio/webm;codecs=opus');
  assert.equal(result.recorderMimeType, 'audio/webm;codecs=opus');
  assert.equal(result.bytes, 9);
  assert.equal(result.completion, 'complete');
  assert.equal(env.tracks[0].stops, 1);
  assert.equal(native.listenerCount, 0);
  assert.equal(env.tracks[0].listenerCount, 0);
  assert.equal(env.document.listenerCount, 0);
  assert.equal(env.timers.size, 0);
  assert.deepEqual(states, ['acquiring', 'initializing', 'recording', 'stopping', 'finalizing', 'ready']);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.warnings));
});

test('cancelled permission returns promptly, blocks overlapping acquisition and releases every late track', async t => {
  const env = environment(t);
  const recorder = env.create();
  const starting = recorder.start();
  assert.equal(recorder.start(), starting);
  env.advance(1000000);
  assert.equal(recorder.getSnapshot().status, 'acquiring');
  assert.equal(await recorder.stop(), null);
  await rejects(starting, 'CANCELLED');
  assert.equal(recorder.getSnapshot().permissionPending, true);
  await rejects(recorder.start(), 'ACQUISITION_PENDING');
  assert.equal(env.requests.length, 1);
  const audio = new Track(), other = new Track(); other.kind = 'video';
  await env.grant(0, stream(audio, other));
  assert.equal(audio.stops, 1); assert.equal(other.stops, 1);
  assert.equal(env.natives.length, 0);
  assert.equal(recorder.getSnapshot().permissionPending, false);
  const { native } = await env.begin(recorder);
  await complete(env, recorder, native);
});

test('late acquisition rejection is consumed after cancel and dispose', async t => {
  const env = environment(t);
  for (const operation of ['cancel', 'dispose']) {
    const recorder = env.create();
    const start = recorder.start();
    await recorder[operation]();
    await rejects(start, 'CANCELLED');
    env.requests.at(-1).reject(new DOMException('private device label', 'NotAllowedError'));
    await flush();
    assert.equal(recorder.getSnapshot().error, null);
    assert.equal(recorder.getSnapshot().permissionPending, false);
    assert.equal(recorder.getSnapshot().status, operation === 'dispose' ? 'disposed' : 'idle');
  }
});

test('disposed controllers release late grants without constructing a recorder', async t => {
  const env = environment(t);
  const recorder = env.create();
  const start = recorder.start();
  const disposal = recorder.dispose();
  assert.equal(recorder.dispose(), disposal);
  await rejects(start, 'CANCELLED');
  await disposal;
  const source = await env.grant();
  assert.equal(source.getTracks()[0].stops, 1);
  assert.equal(env.natives.length, 0);
  for (const method of ['start', 'stop', 'pause', 'resume', 'cancel', 'reset']) await rejects(recorder[method](), 'DISPOSED');
});

test('stop from initializing notification cancels before recorder construction', async t => {
  const env = environment(t);
  const recorder = env.create();
  let stopping;
  recorder.subscribe(() => {
    if (recorder.getSnapshot().status === 'initializing') stopping = recorder.stop();
  });
  const starting = recorder.start();
  await env.grant();
  await rejects(starting, 'CANCELLED');
  assert.equal(await stopping, null);
  assert.equal(env.natives.length, 0);
  assert.equal(env.tracks[0].stops, 1);
});

test('stop after native start invocation rejects start without a late event restoring recording', async t => {
  const env = environment(t);
  const recorder = env.create();
  const starting = recorder.start();
  await env.grant();
  const native = env.natives[0];
  const stopping = recorder.stop();
  await rejects(starting, 'CANCELLED');
  await rejects(recorder.start(), 'BUSY');
  await env.event(native, 'start');
  assert.equal(recorder.getSnapshot().status, 'stopping');
  await env.data(native, 'tail');
  await env.event(native, 'stop');
  assert.equal((await stopping).completion, 'complete');
});

test('native acquisition errors map safely and failed stop returns the same failure', async t => {
  const env = environment(t);
  const mapping = {
    NotAllowedError: 'PERMISSION_DENIED', SecurityError: 'PERMISSION_DENIED',
    NotFoundError: 'DEVICE_NOT_FOUND', NotReadableError: 'DEVICE_UNAVAILABLE',
    AbortError: 'DEVICE_UNAVAILABLE', OverconstrainedError: 'CONSTRAINTS_UNSATISFIED', Error: 'RECORDING_FAILED',
  };
  for (const [name, code] of Object.entries(mapping)) {
    const recorder = env.create();
    const starting = recorder.start();
    const cause = new DOMException('sensitive source', name);
    env.requests.at(-1).reject(cause);
    await rejects(starting, code);
    const error = recorder.getSnapshot().error;
    assert.equal(error.cause, cause);
    assert.equal(error.nativeName, name);
    assert.ok(!error.message.includes('sensitive'));
    await assert.rejects(recorder.stop(), candidate => candidate === error);
    await recorder.reset();
    assert.equal(recorder.getSnapshot().status, 'idle');
  }
});

test('constructor and native start failures release owned tracks and listeners', async t => {
  for (const point of ['constructorError', 'startError']) {
    await t.test(point, async t => {
      const env = environment(t, { [point]: new DOMException('cannot encode', 'NotSupportedError') });
      const recorder = env.create();
      const starting = recorder.start();
      await env.grant();
      await rejects(starting, 'UNSUPPORTED_FORMAT');
      assert.equal(env.tracks[0].stops, 1);
      assert.equal(env.tracks[0].listenerCount, 0);
      assert.equal(env.natives[0]?.listenerCount ?? 0, 0);
      assert.equal(env.timers.size, 0);
    });
  }
});

test('initialization timeout releases resources without timing out pending permission', async t => {
  const env = environment(t);
  const recorder = env.create({ initializationTimeoutMs: 1000 });
  const starting = recorder.start();
  env.advance(50000);
  assert.equal(recorder.getSnapshot().status, 'acquiring');
  await env.grant();
  env.advance(1000);
  await rejects(starting, 'INITIALIZATION_TIMEOUT');
  assert.equal(env.tracks[0].stops, 1);
  assert.equal(env.natives[0].listenerCount, 0);
  await env.event(env.natives[0], 'start');
  assert.equal(recorder.getSnapshot().status, 'failed');
});

test('native error preserves trailing output as partial and keeps the first cause', async t => {
  const env = environment(t);
  const recorder = env.create({ finalizationTimeoutMs: 1000 });
  const errors = [], results = [];
  recorder.onEvent(event => { if (event.type === 'error') errors.push(event.error); if (event.type === 'result') results.push(event.result); });
  const { native } = await env.begin(recorder);
  await env.data(native, 'prefix');
  const cause = new DOMException('encoder failed', 'UnknownError');
  await env.event(native, 'error', { error: cause });
  await env.data(native, 'tail');
  await env.event(native, 'error', { error: new Error('secondary') });
  const stopping = recorder.stop();
  await env.event(native, 'stop');
  await rejects(stopping, 'RECORDING_FAILED');
  assert.equal(errors.length, 1); assert.equal(results.length, 0);
  assert.equal(errors[0].cause, cause);
  assert.equal(await errors[0].partial.blob.text(), 'prefixtail');
  assert.equal(errors[0].partial.completion, 'partial');
  assert.equal(recorder.getSnapshot().result, errors[0].partial);
});

test('missing final event fails with partial output and ignores all stale events', async t => {
  const env = environment(t);
  const recorder = env.create({ finalizationTimeoutMs: 1000 });
  const { native } = await env.begin(recorder);
  await env.data(native, 'prefix');
  const stopping = recorder.stop();
  env.advance(1000);
  await rejects(stopping, 'FINALIZATION_TIMEOUT');
  const partial = recorder.getSnapshot().result;
  assert.equal(partial.reason, 'finalization-timeout');
  assert.equal(env.tracks[0].stops, 1);
  const next = await env.begin(recorder);
  await env.data(native, 'late contamination');
  await env.event(native, 'stop');
  const result = await complete(env, recorder, next.native, 'new');
  assert.equal(await result.blob.text(), 'new');
  assert.equal(await partial.blob.text(), 'prefix');
});

test('prior recorder failure survives a later finalization deadline', async t => {
  const env = environment(t);
  const recorder = env.create({ finalizationTimeoutMs: 1000 });
  const { native } = await env.begin(recorder);
  await env.data(native, 'prefix');
  await env.event(native, 'error', { error: new Error('original') });
  env.advance(1000);
  await rejects(recorder.stop(), 'RECORDING_FAILED');
  assert.equal(recorder.getSnapshot().result.reason, 'recorder-error');
});

test('zero-byte output fails only at the terminal stop barrier', async t => {
  const env = environment(t);
  const recorder = env.create();
  const { native } = await env.begin(recorder);
  const stopping = recorder.stop();
  await env.data(native, '');
  assert.equal(recorder.getSnapshot().status, 'stopping');
  await env.event(native, 'stop');
  await rejects(stopping, 'EMPTY_OUTPUT');
  assert.equal(recorder.getSnapshot().result, null);
});

test('byte overflow rejects the whole chunk and retains a contiguous bounded prefix', async t => {
  const env = environment(t);
  const recorder = env.create({ maxBytes: 5 });
  const { native } = await env.begin(recorder);
  await env.data(native, '12345');
  assert.equal(recorder.getSnapshot().status, 'recording');
  await env.data(native, 'overflow');
  await env.data(native, 'tail');
  const stopping = recorder.stop();
  await env.event(native, 'stop');
  await rejects(stopping, 'BUFFER_LIMIT');
  const result = recorder.getSnapshot().result;
  assert.equal(await result.blob.text(), '12345');
  assert.equal(result.bytes, 5);
  assert.equal(result.receivedBytes, 17);
  assert.equal(result.reason, 'byte-limit');
});

test('single oversized first event produces no partial and final chunks have no byte exemption', async t => {
  const env = environment(t);
  const recorder = env.create({ maxBytes: 3 });
  let { native } = await env.begin(recorder);
  await env.data(native, 'oversized');
  await env.event(native, 'stop');
  await rejects(recorder.stop(), 'BUFFER_LIMIT');
  assert.equal(recorder.getSnapshot().result, null);
  ({ native } = await env.begin(recorder));
  await env.data(native, 'fit');
  const stopping = recorder.stop();
  await env.data(native, 'tail');
  await env.event(native, 'stop');
  await rejects(stopping, 'BUFFER_LIMIT');
  assert.equal(recorder.getSnapshot().result.bytes, 3);
});

test('pause and resume coalesce adjacent requests, preserve opposite ordering and exclude pauses', async t => {
  const env = environment(t);
  const recorder = env.create({ maxActiveMs: 1000 });
  const { native } = await env.begin(recorder);
  env.advance(100);
  const pause = recorder.pause();
  assert.equal(recorder.pause(), pause);
  const resume = recorder.resume();
  const pauseAgain = recorder.pause();
  assert.deepEqual(native.commands.map(command => command[0]), ['start', 'pause']);
  await env.event(native, 'pause'); await pause;
  assert.deepEqual(native.commands.map(command => command[0]), ['start', 'pause', 'resume']);
  env.advance(5000);
  assert.equal(recorder.getSnapshot().status, 'paused');
  await env.event(native, 'resume'); await resume;
  env.advance(100);
  await env.event(native, 'pause'); await pauseAgain;
  assert.equal(recorder.getSnapshot().timing.activeMs, 200);
  const result = await complete(env, recorder, native);
  assert.equal(result.activeMs, 200);
  assert.equal(result.wallMs, 5200);
});

test('active duration ends automatically and waits for final output', async t => {
  const env = environment(t);
  const recorder = env.create({ maxActiveMs: 250 });
  const { native } = await env.begin(recorder);
  env.advance(250);
  assert.equal(recorder.getSnapshot().status, 'stopping');
  await env.data(native, 'bounded');
  await env.event(native, 'stop');
  const result = await recorder.stop();
  assert.equal(result.reason, 'duration-limit');
  assert.equal(result.activeMs, 250);
});

test('control timeout fails recording and stop preempts pending controls', async t => {
  const env = environment(t);
  const recorder = env.create({ initializationTimeoutMs: 1000 });
  let { native } = await env.begin(recorder);
  const pause = recorder.pause();
  env.advance(1000);
  await rejects(pause, 'CANCELLED');
  await env.data(native, 'partial');
  await env.event(native, 'stop');
  await rejects(recorder.stop(), 'RECORDING_FAILED');
  ({ native } = await env.begin(recorder));
  const pause2 = recorder.pause(), resume = recorder.resume();
  const stopping = recorder.stop();
  await rejects(pause2, 'CANCELLED'); await rejects(resume, 'CANCELLED');
  await env.event(native, 'pause');
  assert.equal(recorder.getSnapshot().status, 'stopping');
  await env.data(native, 'last'); await env.event(native, 'stop'); await stopping;
});

test('mute/unmute/disabled/hidden warnings are bounded and source end preserves partial bytes', async t => {
  const env = environment(t);
  const recorder = env.create();
  const { native, input } = await env.begin(recorder);
  const track = input.getTracks()[0];
  for (let i = 0; i < 5; i++) { await env.event(track, 'mute'); await env.event(track, 'unmute'); }
  assert.equal(recorder.getSnapshot().trackMuted, false);
  track.enabled = false;
  env.document.visibilityState = 'hidden';
  await env.event(env.document, 'visibilitychange');
  await env.data(native, 'audio');
  track.readyState = 'ended';
  await env.event(track, 'ended');
  await env.event(native, 'stop');
  await rejects(recorder.stop(), 'SOURCE_ENDED');
  const result = recorder.getSnapshot().result;
  assert.equal(result.reason, 'source-ended');
  assert.equal(result.warnings.length, 4);
  assert.equal(new Set(result.warnings.map(warning => warning.code)).size, 4);
});

test('MIME negotiation uses reported supported candidates without constructor retries', async t => {
  const env = environment(t);
  const recorder = env.create({ mime: { candidates: ['audio/mp3', 'audio/webm'], fallback: 'error' } });
  const { native, info } = await env.begin(recorder);
  assert.equal(native.options.mimeType, 'audio/webm');
  assert.equal(info.requestedMimeType, 'audio/webm');
  await complete(env, recorder, native);
  const second = await env.begin(recorder, { mime: { candidates: ['audio/mp3'], fallback: 'browser' } });
  assert.equal('mimeType' in second.native.options, false);
});

test('MIME evidence prefers chunks, falls back to recorder, and reports unknown honestly', async t => {
  for (const [reported, chunk, expectedSource, expectedType, warning] of [
    ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'chunk', 'audio/ogg;codecs=opus', 'mime-disagreement'],
    ['audio/webm;codecs=opus', '', 'recorder', 'audio/webm;codecs=opus', null],
    ['', '', 'unknown', '', 'mime-unknown'],
  ]) await t.test(`${expectedSource} ${expectedType}`, async t => {
    const env = environment(t, { recorderMime: reported });
    const recorder = env.create();
    const { native } = await env.begin(recorder);
    const stopping = recorder.stop();
    await env.data(native, 'data', chunk); await env.event(native, 'stop');
    const result = await stopping;
    assert.equal(result.mimeType, expectedType); assert.equal(result.mimeSource, expectedSource);
    if (warning) assert.ok(result.warnings.some(item => item.code === warning));
  });
});

test('MIME parameter order and unknown codec details are compatible but explicit conflicts discard the suffix', async t => {
  const env = environment(t);
  const recorder = env.create();
  const { native } = await env.begin(recorder);
  await env.data(native, 'a', 'audio/webm');
  await env.data(native, 'b', 'audio/webm; codecs="opus,other"; foo=bar');
  await env.data(native, 'c', 'audio/webm;foo=bar;codecs="other, opus"');
  await env.data(native, 'bad', 'audio/webm;codecs=vorbis');
  await env.data(native, 'later', 'audio/webm;codecs=opus');
  await env.event(native, 'stop');
  await rejects(recorder.stop(), 'MIME_MISMATCH');
  assert.equal(await recorder.getSnapshot().result.blob.text(), 'abc');
  assert.equal(recorder.getSnapshot().result.receivedBytes, 11);
});

test('session option copies cannot be reconfigured by caller mutation', async t => {
  const env = environment(t);
  const options = { maxBytes: 5, source: { kind: 'microphone', constraints: { deviceId: { exact: 'test-only' } } }, mime: { candidates: ['audio/webm'], fallback: 'error' } };
  const recorder = env.create(options);
  const starting = recorder.start();
  options.maxBytes = 100;
  options.source.constraints.deviceId.exact = 'changed';
  options.mime.candidates[0] = 'audio/mp3';
  assert.equal(env.requests[0].constraints.audio.deviceId.exact, 'test-only');
  await env.grant(); const native = env.natives[0];
  await env.event(native, 'start'); await starting;
  assert.equal(native.options.mimeType, 'audio/webm');
  await env.data(native, '123456'); await env.event(native, 'stop');
  await rejects(recorder.stop(), 'BUFFER_LIMIT');
});

test('invalid options and command misuse do not poison a healthy session', async t => {
  const env = environment(t);
  const recorder = env.create();
  for (const options of [
    { maxBytes: Infinity }, { maxBytes: 0 }, { maxBytes: null }, { maxActiveMs: NaN },
    { initializationTimeoutMs: null }, { initializationTimeoutMs: 999 },
    { finalizationTimeoutMs: 120001 }, { source: { kind: 'stream' } },
    { mime: { candidates: [''], fallback: 'browser' } }, { audioBitsPerSecond: -1 },
  ]) await rejects(recorder.start(options), 'INVALID_OPTIONS');
  assert.equal(env.requests.length, 0);
  for (const command of ['pause', 'resume']) await rejects(recorder[command](), 'INVALID_STATE');
  assert.equal(await recorder.stop(), null);
  const { native } = await env.begin(recorder);
  await rejects(recorder.reset(), 'BUSY'); await rejects(recorder.start({}), 'BUSY');
  assert.equal(recorder.getSnapshot().error, null);
  assert.equal((await complete(env, recorder, native)).completion, 'complete');
});

test('cancel preempts stop synchronously, clears resources and keeps caller-held Blobs valid', async t => {
  const env = environment(t);
  const recorder = env.create();
  let { native } = await env.begin(recorder);
  const result = await complete(env, recorder, native, 'owned by caller');
  ({ native } = await env.begin(recorder));
  assert.equal(recorder.getSnapshot().result, null);
  const stopping = recorder.stop();
  const cancelling = recorder.cancel();
  assert.equal(recorder.getSnapshot().status, 'idle');
  assert.equal(env.tracks.at(-1).readyState, 'ended');
  assert.equal(native.listenerCount, 0);
  await cancelling; await rejects(stopping, 'CANCELLED');
  await env.data(native, 'late'); await env.event(native, 'stop');
  assert.equal(recorder.getSnapshot().result, null);
  assert.equal(await result.blob.text(), 'owned by caller');
});

test('observer exceptions and rejected async callbacks cannot alter settlement or cleanup', async t => {
  const env = environment(t);
  const recorder = env.create();
  const events = [];
  recorder.subscribe(() => { throw new Error('sensitive'); });
  recorder.onEvent(async () => { throw new Error('sensitive async'); });
  recorder.onEvent(event => { events.push(event); });
  const { native } = await env.begin(recorder);
  const result = await complete(env, recorder, native);
  await flush();
  assert.equal(result.completion, 'complete');
  assert.equal(env.tracks[0].stops, 1);
  assert.ok(events.some(event => event.type === 'result'));
  assert.ok(env.reports.length > 1);
  assert.ok(env.reports.every(error => error.message === 'Recstead observer callback failed' && error.cause === undefined));
});

test('terminal subscribers may restart without old result events republishing old state', async t => {
  const env = environment(t);
  const recorder = env.create();
  let nextStart;
  const observations = [];
  recorder.subscribe(() => { if (recorder.getSnapshot().status === 'ready') nextStart = recorder.start(); });
  recorder.onEvent(event => {
    if (event.type === 'result') observations.push({ oldId: event.result.sessionId, currentId: recorder.getSnapshot().sessionId });
  });
  const { native } = await env.begin(recorder);
  const first = await complete(env, recorder, native);
  assert.equal(recorder.getSnapshot().status, 'acquiring');
  assert.equal(env.requests.length, 2);
  assert.deepEqual(observations, [{ oldId: first.sessionId, currentId: '2' }]);
  await recorder.cancel(); await rejects(nextStart, 'CANCELLED'); await env.grant();
});

test('reentrant disposal suppresses queued notifications while settled stop stays successful', async t => {
  const env = environment(t);
  const recorder = env.create();
  let results = 0;
  recorder.subscribe(() => { if (recorder.getSnapshot().status === 'ready') void recorder.dispose(); });
  recorder.onEvent(event => { if (event.type === 'result') results++; });
  const { native } = await env.begin(recorder);
  const result = await complete(env, recorder, native);
  assert.equal(result.completion, 'complete');
  assert.equal(results, 0);
  assert.equal(recorder.getSnapshot().status, 'disposed');
});

test('100 sessions return owned listeners and timers to baseline', async t => {
  const env = environment(t);
  const recorder = env.create();
  for (let index = 0; index < 100; index++) {
    const { native, input } = await env.begin(recorder);
    const result = await complete(env, recorder, native, 'synthetic');
    assert.equal(result.sessionId, String(index + 1));
    assert.equal(native.listenerCount, 0);
    assert.equal(input.getTracks()[0].listenerCount, 0);
    assert.equal(input.getTracks()[0].stops, 1);
    assert.equal(env.document.listenerCount, 0);
    assert.equal(env.timers.size, 0);
    await recorder.reset();
    assert.equal(recorder.getSnapshot().result, null);
  }
});

test('warning observer stop preempts the control which discovered a disabled track', async t => {
  const env = environment(t);
  const recorder = env.create({ finalizationTimeoutMs: 1000 });
  const { input } = await env.begin(recorder);
  let stopping;
  recorder.onEvent(event => { if (event.type === 'warning' && event.warning.code === 'track-disabled') stopping = recorder.stop(); });
  input.getTracks()[0].enabled = false;
  const pausing = recorder.pause();
  await rejects(pausing, 'CANCELLED');
  env.advance(1000);
  await rejects(stopping, 'FINALIZATION_TIMEOUT');
  assert.equal(recorder.getSnapshot().status, 'failed');
  assert.equal(env.timers.size, 0);
});

test('unsolicited native stop makes reentrant start during finalizing reject BUSY', async t => {
  const env = environment(t);
  const recorder = env.create();
  let attempted;
  recorder.subscribe(() => { if (recorder.getSnapshot().status === 'finalizing') attempted = recorder.start(); });
  const { native } = await env.begin(recorder);
  await env.data(native, 'ended');
  native.state = 'inactive';
  await env.event(native, 'stop');
  await rejects(attempted, 'BUSY');
  assert.equal((await recorder.stop()).completion, 'complete');
});

test('warning callbacks cannot emit an earlier recording or paused state after stopping', async t => {
  for (const phase of ['start', 'pause']) await t.test(phase, async t => {
    const env = environment(t);
    const recorder = env.create();
    const states = [];
    let stopping;
    recorder.onEvent(event => {
      if (event.type === 'state') states.push(event.snapshot.status);
      if (event.type === 'warning' && event.warning.code === 'track-disabled') stopping = recorder.stop();
    });
    const starting = recorder.start();
    const input = await env.grant();
    const native = env.natives[0];
    if (phase === 'start') input.getTracks()[0].enabled = false;
    await env.event(native, 'start'); await starting;
    if (phase === 'pause') {
      const pause = recorder.pause();
      input.getTracks()[0].enabled = false;
      await env.event(native, 'pause'); await pause;
    }
    assert.equal(states.at(-1), 'stopping');
    assert.equal(recorder.getSnapshot().status, 'stopping');
    await env.data(native, 'data'); await env.event(native, 'stop'); await stopping;
  });
});

test('idle cancel and reset preserve snapshot identity and cannot recurse through observers', async t => {
  const env = environment(t);
  const recorder = env.create();
  const idle = recorder.getSnapshot();
  let notifications = 0;
  recorder.subscribe(() => {
    notifications++;
    assert.ok(notifications < 5, 'repeated idle notifications');
    void recorder.cancel(); void recorder.reset();
  });
  await recorder.cancel(); await recorder.reset();
  assert.equal(recorder.getSnapshot(), idle);
  assert.equal(notifications, 0);
  const starting = recorder.start();
  await rejects(starting, 'CANCELLED');
  assert.equal(notifications, 2);
  await env.grant();
  assert.equal(notifications, 3);
  assert.equal(recorder.getSnapshot().permissionPending, false);
});

test('bitrates outside the native unsigned-long range reject before microphone acquisition', async t => {
  const env = environment(t);
  const recorder = env.create();
  for (const audioBitsPerSecond of [2 ** 32, Number.MAX_SAFE_INTEGER]) {
    const starting = recorder.start({ audioBitsPerSecond });
    assert.equal(env.requests.length, 0);
    await rejects(starting, 'INVALID_OPTIONS');
  }
});

test('unexpected acquisition error names cannot resolve to inherited object properties', async t => {
  const env = environment(t);
  const recorder = env.create();
  for (const name of ['constructor', 'toString', '__proto__']) {
    const starting = recorder.start();
    const cause = new DOMException('unknown acquisition failure', name);
    env.requests.at(-1).reject(cause);
    await rejects(starting, 'RECORDING_FAILED');
    const error = recorder.getSnapshot().error;
    assert.equal(error.cause, cause);
    assert.equal(error.nativeName, name);
    await assert.rejects(recorder.stop(), candidate => candidate === error);
  }
});
