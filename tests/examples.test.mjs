import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { build } from 'esbuild';
import { IDBFactory } from 'fake-indexeddb';
import { createMessageApi } from '../examples/server/messages.mjs';

const compiled = await mkdtemp(join(tmpdir(), 'recstead-example-tests-'));
await build({ entryPoints: ['examples/react/outbox.ts', 'examples/vanilla/storage.ts'], outdir: compiled,
  bundle: true, platform: 'node', format: 'esm', outExtension: { '.js': '.mjs' } });
/** @type {typeof import('../examples/react/outbox.js')} */
const { Outbox } = await import(pathToFileURL(join(compiled, 'react/outbox.mjs')).href);
/** @type {typeof import('../examples/vanilla/storage.js')} */
const { NoteStorage } = await import(pathToFileURL(join(compiled, 'vanilla/storage.mjs')).href);
test.after(() => rm(compiled, { recursive: true, force: true }));
const tick = () => new Promise(setImmediate);
/** @returns {import('../src/core/types.js').RecordingResult} */
const complete = () => ({ sessionId: 'session-1', completion: 'complete', blob: new Blob(['audio'], { type: 'audio/webm' }), mimeType: 'audio/webm',
  bytes: 5, receivedBytes: 5, mimeSource: 'chunk', recorderMimeType: 'audio/webm', reason: 'user', activeMs: 1000, wallMs: 1000, warnings: [] });
const message = (id = 'message-001') => ({ id, conversation: 'team', bytes: 5, mimeType: 'audio/webm', createdAt: 1 });
const note = (id = 'note-1', text = 'audio') => ({ id, title: 'A note', blob: new Blob([text], { type: 'audio/webm' }), mimeType: 'audio/webm', activeMs: 1000, createdAt: 1 });
function deferred() {
  /** @type {(value: Response) => void} */
  let resolve = () => {};
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

/** @param {import('node:test').TestContext} t @param {Parameters<typeof createMessageApi>[0]} [options] */
async function api(t, options) {
  const handler = createMessageApi(options);
  const server = createServer((req, res) => handler(req, res, () => { res.writeHead(404); res.end(); }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const address = server.address();
  assert(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  return { get: () => fetch(`${base}/api/messages`), clear: () => fetch(`${base}/api/messages`, { method: 'DELETE' }),
    put: (id = 'message-001', body = 'audio', headers = {}) => fetch(`${base}/api/messages/${id}`, {
      method: 'PUT', body, headers: { 'Content-Type': 'audio/webm', 'X-Conversation': 'team', ...headers },
    }), base };
}

/**
 * A PUT whose body the test delivers piece by piece, so the test decides when the upload can finish.
 * @param {string} base @param {string} id
 */
function streamedPut(base, id) {
  /** @type {import('node:http').ClientRequest | undefined} */
  let upload;
  /** @type {Promise<number | undefined>} */
  const status = new Promise((resolve, reject) => {
    upload = request(`${base}/api/messages/${id}`, { method: 'PUT', headers: { 'Content-Type': 'audio/webm', 'X-Conversation': 'team' } },
      response => { response.resume(); response.once('end', () => resolve(response.statusCode)); });
    upload.on('error', reject);
  });
  return {
    write: (/** @type {string} */ text) => new Promise(done => { upload?.write(text, () => done(undefined)); }),
    end: (/** @type {string} */ text) => { upload?.end(text); return status; },
  };
}
/** Wait until the server has started handling this many uploads. @param {{ get(): Promise<Response> }} a @param {number} count */
async function started(a, count) {
  while ((await (await a.get()).json()).requests < count) await tick();
}

test('local API accepts actual bytes, replays retries and rejects identifier reuse with other content', async t => {
  const a = await api(t);
  assert.equal((await a.put()).status, 201);
  assert.equal((await a.put()).status, 200);
  // The same identifier with anything else is refused: other bytes of any length, another type, another conversation.
  assert.equal((await a.put('message-001', 'different')).status, 409);
  assert.equal((await a.put('message-001', 'AUDIO')).status, 409);
  assert.equal((await a.put('message-001', 'audio', { 'Content-Type': 'audio/ogg' })).status, 409);
  assert.equal((await a.put('message-001', 'audio', { 'X-Conversation': 'friends' })).status, 409);
  const state = await (await a.get()).json();
  assert.equal(state.messages.length, 1); assert.equal(state.requests, 6); assert.equal(state.bytes, 5);
  assert.deepEqual([state.messages[0].mimeType, state.messages[0].conversation], ['audio/webm', 'team']);
  assert.equal(await (await fetch(`${a.base}/api/messages/message-001/audio`)).text(), 'audio');
});

test('audio byte ranges return exact slices for bounded, open-ended and suffix requests', async t => {
  const a = await api(t);
  await a.put('message-001', '0123456789');
  const url = `${a.base}/api/messages/message-001/audio`;
  const full = await fetch(url);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.equal(full.headers.get('content-range'), null);
  assert.equal(await full.text(), '0123456789');
  const cases = [
    { range: 'bytes=0-0', start: 0, end: 0 },
    { range: 'bytes=3-6', start: 3, end: 6 },
    { range: 'bytes=7-', start: 7, end: 9 },
    { range: 'bytes=-3', start: 7, end: 9 },
    { range: 'bytes=8-100', start: 8, end: 9 },
    { range: 'bytes=-100', start: 0, end: 9 },
    { range: 'BYTES=001-003', start: 1, end: 3 },
    { range: `bytes=0-${'9'.repeat(400)}`, start: 0, end: 9 },
    { range: `bytes=-${'9'.repeat(400)}`, start: 0, end: 9 },
  ];
  for (const { range, start, end } of cases) {
    const response = await fetch(url, { headers: { Range: range } });
    assert.equal(response.status, 206, range);
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/10`, range);
    assert.equal(response.headers.get('content-length'), String(end - start + 1), range);
    assert.equal(response.headers.get('content-type'), 'audio/webm');
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    assert.equal(await response.text(), '0123456789'.slice(start, end + 1), range);
  }
});

test('audio byte ranges handle unsatisfiable requests, ignored syntax and stale validators', async t => {
  const a = await api(t);
  await a.put('message-001', '0123456789');
  const url = `${a.base}/api/messages/message-001/audio`;
  for (const range of ['bytes=10-', 'bytes=20-30', 'bytes=-0', `bytes=${'9'.repeat(400)}-`]) {
    const response = await fetch(url, { headers: { Range: range } });
    assert.equal(response.status, 416, range);
    assert.equal(response.headers.get('content-range'), 'bytes */10');
    assert.equal(response.headers.get('content-length'), '0');
    assert.equal(await response.text(), '');
  }
  for (const range of ['items=0-1', 'bytes=-', 'bytes=5-3', 'bytes=abc-def', 'bytes=0-1,4-5']) {
    const response = await fetch(url, { headers: { Range: range } });
    assert.equal(response.status, 200, range);
    assert.equal(response.headers.get('content-range'), null);
    assert.equal(await response.text(), '0123456789', range);
  }
  const full = await fetch(url);
  const etag = full.headers.get('etag'); assert(etag);
  await full.arrayBuffer();
  const matching = await fetch(url, { headers: { Range: 'bytes=3-6', 'If-Range': etag } });
  assert.equal(matching.status, 206); assert.equal(await matching.text(), '3456');
  for (const validator of ['"stale"', `W/${etag}`, 'Wed, 21 Oct 2015 07:28:00 GMT']) {
    const response = await fetch(url, { headers: { Range: 'bytes=3-6', 'If-Range': validator } });
    assert.equal(response.status, 200); assert.equal(await response.text(), '0123456789');
  }
});

test('accept then lose response retries to one message; concurrent retries also commit once', async t => {
  const a = await api(t, { delayMs: 30 });
  await assert.rejects(a.put('message-001', 'audio', { 'X-Example-Scenario': 'drop-response' }));
  await assert.rejects(a.put('message-001', 'audio', { 'X-Example-Scenario': 'drop-response' }));
  assert.equal((await a.put()).status, 200);
  const responses = await Promise.all([a.put('message-002', 'audio', { 'X-Example-Scenario': 'delay' }), a.put('message-002')]);
  assert.deepEqual(responses.map(x => x.status).sort(), [200, 201]);
  assert.equal((await (await a.get()).json()).messages.length, 2);
});

test('API validates type, empty and oversized requests and collection limits without partial admission', async t => {
  const a = await api(t, { maxRecordingBytes: 6, maxItems: 1, maxBytes: 6 });
  assert.equal((await a.put('message-001', 'audio', { 'Content-Type': 'text/html' })).status, 400);
  assert.equal((await a.put('message-001', '')).status, 400);
  assert.equal((await a.put('message-001', 'too large')).status, 413);
  assert.equal((await a.put()).status, 201);
  assert.equal((await a.put('message-002')).status, 507);
  assert.equal((await a.put()).status, 200, 'A full collection must still permit idempotent retries');
  assert.equal((await (await a.get()).json()).bytes, 5);
});

test('the item limit and the byte limit each refuse a message on their own', async t => {
  const counted = await api(t, { maxItems: 1, maxBytes: 1000 });
  assert.equal((await counted.put()).status, 201);
  assert.equal((await counted.put('message-002')).status, 507);
  const sized = await api(t, { maxItems: 10, maxBytes: 8 });
  assert.equal((await sized.put()).status, 201);
  assert.equal((await sized.put('message-002')).status, 507);
  assert.equal((await sized.put('message-003', 'aud')).status, 201, 'a message that still fits is accepted');
  const state = await (await sized.get()).json();
  assert.deepEqual([state.messages.length, state.bytes], [2, 8]);
});

test('API rejects cross-site writes and clear invalidates an upload already in progress', async t => {
  const a = await api(t);
  assert.equal((await a.put('message-001', 'audio', { Origin: 'https://example.com' })).status, 403);
  // The test holds the body open, so the upload cannot commit before the clear on any machine.
  const upload = streamedPut(a.base, 'message-002');
  await upload.write('aud');
  await started(a, 1);
  assert.equal((await a.clear()).status, 200);
  assert.equal(await upload.end('io'), 409);
  assert.equal((await (await a.get()).json()).messages.length, 0);
});

test('API buffers two uploads at most and frees a place when one finishes', async t => {
  const a = await api(t);
  const first = streamedPut(a.base, 'message-001');
  const second = streamedPut(a.base, 'message-002');
  await first.write('aud'); await second.write('aud');
  await started(a, 2);
  assert.equal((await a.put('message-003')).status, 429);
  assert.equal(await first.end('io'), 201);
  assert.equal((await a.put('message-003')).status, 201);
  assert.equal(await second.end('io'), 201);
  assert.equal((await (await a.get()).json()).messages.length, 3);
});

test('API bounds chunked uploads without trusting Content-Length and accepts a later valid request', async t => {
  const a = await api(t, { maxRecordingBytes: 6 });
  // Each piece fits the limit; only their sum exceeds it.
  const upload = streamedPut(a.base, 'message-001');
  await upload.write('aud');
  await started(a, 1);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(await upload.end('io12'), 413);
  assert.equal((await (await a.get()).json()).bytes, 0);
  assert.equal((await a.put()).status, 201);
});

test('outbox preserves the Blob and identifier after unknown acceptance and retries without capture', async () => {
  /** @type {{ url: RequestInfo | URL; options: RequestInit | undefined }[]} */
  const calls = [];
  const outbox = new Outbox(async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) throw new TypeError('connection lost');
    return Response.json(message());
  }, () => 'message-001');
  const result = complete(); outbox.enqueue(result, 'team', 'normal'); await tick();
  assert.equal(outbox.getSnapshot().entries[0].state, 'unknown');
  await outbox.send('message-001');
  assert.equal(calls[0].url, calls[1].url);
  assert.equal(calls[1].options?.body, result.blob);
  assert.equal(outbox.getSnapshot().entries[0].state, 'accepted');
  assert.equal(outbox.getSnapshot().entries[0].blob, null);
  outbox.dispose();
});

test('an acknowledgment for another recording never releases the local one', async () => {
  for (const [field, value] of Object.entries({ id: 'message-999', conversation: 'friends', bytes: 4, mimeType: 'audio/ogg' })) {
    let calls = 0;
    const outbox = new Outbox(async () => Response.json(++calls === 1 ? { ...message(), [field]: value } : message()), () => 'message-001');
    const result = complete(); outbox.enqueue(result, 'team', 'normal'); await tick();
    const [entry] = outbox.getSnapshot().entries;
    assert.deepEqual([entry.state, entry.blob], ['unknown', result.blob], field);
    await outbox.send('message-001');
    assert.deepEqual([calls, outbox.getSnapshot().entries[0].state], [2, 'accepted'], field);
    outbox.dispose();
  }
});

test('an upload that never answers stops at its deadline, keeps the recording and can be retried', async t => {
  /** @type {AbortSignal[]} */
  const signals = [];
  const outbox = new Outbox((_url, options) => {
    if (options?.signal) signals.push(options.signal);
    if (signals.length > 1) return Promise.resolve(Response.json(message()));
    return new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  }, () => 'message-001');
  t.after(() => outbox.dispose());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const recording = complete(); outbox.enqueue(recording, 'team', 'normal');
  t.mock.timers.tick(9_999); await tick();
  assert.deepEqual([signals[0].aborted, outbox.getSnapshot().entries[0].state], [false, 'pending']);
  t.mock.timers.tick(1); await tick();
  assert.deepEqual([signals[0].aborted, outbox.getSnapshot().entries[0].state], [true, 'unknown']);
  assert.equal(outbox.getSnapshot().entries[0].blob, recording.blob);
  await outbox.send('message-001');
  assert.deepEqual([signals.length, outbox.getSnapshot().entries[0].state], [2, 'accepted']);
});

test('outbox rejects partial recordings and coalesces sends while keeping draft on rejection', async () => {
  const request = deferred(); let count = 0;
  const outbox = new Outbox(() => { count++; return request.promise; }, () => 'message-001');
  assert.throws(() => outbox.enqueue({ ...complete(), completion: 'partial' }, 'team', 'normal'), /complete/);
  assert.equal(count, 0);
  outbox.enqueue(complete(), 'team', 'normal');
  await outbox.send('message-001'); assert.equal(count, 1);
  request.resolve(Response.json({ error: 'Try again' }, { status: 503 })); await tick();
  assert.equal(outbox.getSnapshot().entries[0].state, 'rejected');
  assert.equal(outbox.getSnapshot().entries[0].blob?.size, 5);
  outbox.dispose();
});

test('stale history response cannot erase a message accepted during loading', async () => {
  const history = deferred();
  const outbox = new Outbox(async (_url, options) => options?.method === 'PUT' ? Response.json(message()) : history.promise, () => 'message-001');
  const loading = outbox.load(); outbox.enqueue(complete(), 'team', 'normal'); await tick();
  history.resolve(Response.json({ messages: [] })); await loading;
  assert.equal(outbox.getSnapshot().entries[0].state, 'accepted');
  outbox.dispose();
});

test('failed collection clear leaves cancelled requests unknown and retryable, with no stuck pending state', async () => {
  /** @type {AbortSignal[]} */
  const uploads = [];
  const outbox = new Outbox((_url, options) => {
    if (options?.method === 'DELETE') return Promise.resolve(new Response('', { status: 503 }));
    if (options?.signal) uploads.push(options.signal);
    if (uploads.length > 1) return Promise.resolve(Response.json(message()));
    return new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
  }, () => 'message-001');
  const recording = complete(); outbox.enqueue(recording, 'team', 'normal');
  await assert.rejects(outbox.clear(), /clear/); await tick();
  // The upload itself has to stop. Marking it unknown while it still ran would block every retry.
  assert.equal(uploads[0].aborted, true);
  assert.deepEqual([outbox.getSnapshot().entries[0].state, outbox.getSnapshot().entries[0].blob], ['unknown', recording.blob]);
  await outbox.send('message-001');
  assert.deepEqual([uploads.length, outbox.getSnapshot().entries[0].state], [2, 'accepted']);
  outbox.dispose(); assert.equal(outbox.getSnapshot().entries.length, 0);
});

test('history cannot start during collection clear or after disposal', async () => {
  const deletion = deferred(); let reads = 0;
  const outbox = new Outbox((_url, options) => {
    if (options?.method === 'DELETE') return deletion.promise;
    reads++; return Promise.resolve(Response.json({ messages: [message()] }));
  });
  const clearing = outbox.clear();
  await outbox.load();
  deletion.resolve(Response.json({ cleared: true })); await clearing;
  assert.equal(outbox.getSnapshot().entries.length, 0);
  outbox.dispose(); await outbox.load();
  assert.equal(reads, 0);
});

test('clear times out without losing local recordings and permits a successful retry', async t => {
  /** @type {AbortSignal[]} */
  const signals = [];
  let attempts = 0;
  const outbox = new Outbox((_url, options) => {
    if (options?.method !== 'DELETE') return Promise.resolve(Response.json({ error: 'Rejected' }, { status: 503 }));
    if (options.signal) signals.push(options.signal);
    if (++attempts > 1) return Promise.resolve(Response.json({ cleared: true }));
    return new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  }, () => 'message-001');
  t.after(() => outbox.dispose());
  const recording = complete();
  outbox.enqueue(recording, 'team', 'normal'); await tick();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clearing = outbox.clear();
  assert(signals[0], 'Clear must own an abortable request');
  const rejected = assert.rejects(clearing, /Could not confirm clearing/);
  t.mock.timers.tick(10_000); await rejected;
  assert.equal(signals[0].aborted, true);
  assert.equal(outbox.getSnapshot().entries[0].blob, recording.blob);
  await outbox.clear();
  assert.equal(attempts, 2); assert.equal(outbox.getSnapshot().entries.length, 0);
  t.mock.timers.tick(10_000);
  assert.equal(signals[1].aborted, false, 'Successful clear must remove its timeout');
});

test('disposal aborts clear and a late success cannot restore disposed state', async t => {
  const response = deferred();
  /** @type {AbortSignal[]} */
  const signals = [];
  const outbox = new Outbox((_url, options) => {
    if (options?.signal) signals.push(options.signal);
    return response.promise;
  });
  t.after(() => { outbox.dispose(); response.resolve(Response.json({ cleared: true })); });
  let notifications = 0;
  outbox.subscribe(() => { notifications++; });
  const clearing = outbox.clear();
  assert(signals[0], 'Clear must own an abortable request');
  outbox.dispose();
  const before = notifications;
  assert.equal(signals[0].aborted, true);
  response.resolve(Response.json({ cleared: true })); await clearing;
  assert.equal(notifications, before);
  assert.equal(outbox.getSnapshot().entries.length, 0);
});

test('note storage persists completed Blobs across reopen and failed transactions retain prior data', async () => {
  const factory = new IDBFactory();
  const first = new NoteStorage(factory, 'notes'); await first.save(note()); first.close();
  const second = new NoteStorage(factory, 'notes');
  assert.equal(await (await second.list())[0].blob.text(), 'audio');
  await assert.rejects(second.save(note('note-2'), true), /Simulated/);
  assert.equal((await second.list()).length, 1);
  await second.save(note('note-2')); await second.save(note('note-2'));
  assert.equal((await second.list()).length, 2);
  await second.delete('note-1'); assert.equal((await second.list()).length, 1);
  await second.clear(); assert.equal((await second.list()).length, 0); second.close();
});

test('notes are stored as bytes, restore their MIME type and still read Blob records from the alphas', async () => {
  const factory = new IDBFactory();
  const storage = new NoteStorage(factory, 'bytes'); await storage.save(note());
  /** @type {IDBDatabase} */
  const db = await new Promise((resolve, reject) => {
    const request = factory.open('bytes', 1);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  /** @param {IDBRequest} request */
  const settle = request => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  // WebKit rejects Blob values in ephemeral sessions, so no stored field may be a Blob.
  const stored = await settle(db.transaction('notes').objectStore('notes').get('note-1'));
  assert(stored.bytes instanceof ArrayBuffer);
  assert.equal(Object.values(stored).some(value => value instanceof Blob), false);
  await settle(db.transaction('notes', 'readwrite').objectStore('notes').put(
    { id: 'legacy', title: 'Older note', createdAt: 0, blob: new Blob(['older'], { type: 'audio/ogg' }), mimeType: 'audio/ogg', activeMs: 5 }));
  db.close();
  const [current, legacy] = await storage.list();
  assert.equal(current.blob.type, 'audio/webm'); assert.equal(await current.blob.text(), 'audio');
  assert.equal(legacy.blob.type, 'audio/ogg'); assert.equal(await legacy.blob.text(), 'older');
  storage.close();
});

test('note count and byte limits remain atomic across concurrent tabs', async () => {
  const factory = new IDBFactory();
  const a = new NoteStorage(factory, 'bounded', { count: 1, bytes: 5 });
  const b = new NoteStorage(factory, 'bounded', { count: 1, bytes: 5 });
  const outcomes = await Promise.allSettled([a.save(note('a')), b.save(note('b'))]);
  assert.deepEqual(outcomes.map(result => result.status).sort(), ['fulfilled', 'rejected']);
  const lost = outcomes.find(result => result.status === 'rejected');
  assert.match(String(lost?.status === 'rejected' && lost.reason), /full/, 'the other save is refused for capacity, not by accident');
  const notes = await a.list();
  assert.deepEqual(notes.map(saved => saved.id), [outcomes[0].status === 'fulfilled' ? 'a' : 'b'], 'exactly the winning note is stored');
  const kept = notes[0];
  await assert.rejects(a.save({ ...kept, blob: new Blob(['too large']) }), /full/);
  assert.equal(await (await a.list())[0].blob.text(), 'audio');
  a.close(); b.close();
});

test('the note count limit and the note byte limit each refuse a save on their own', async () => {
  const factory = new IDBFactory();
  const counted = new NoteStorage(factory, 'count-only', { count: 1, bytes: 1000 });
  await counted.save(note('a'));
  await assert.rejects(counted.save(note('b')), /full/);
  await counted.save(note('a', 'again'));
  assert.deepEqual(await Promise.all((await counted.list()).map(async saved => [saved.id, await saved.blob.text()])), [['a', 'again']]);
  counted.close();
  const sized = new NoteStorage(factory, 'bytes-only', { count: 10, bytes: 8 });
  await sized.save(note('a'));
  await assert.rejects(sized.save(note('b')), /full/);
  await sized.save(note('c', 'aud'));
  assert.deepEqual((await sized.list()).map(saved => saved.id).sort(), ['a', 'c']);
  sized.close();
});
