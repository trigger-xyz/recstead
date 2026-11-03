import { createHash } from 'node:crypto';
import { MAX_ITEMS, MAX_COLLECTION_BYTES, MAX_RECORDING_BYTES, CONVERSATIONS } from '../shared/limits.mjs';

/** @typedef {{ id: string; conversation: string; bytes: number; mimeType: string; createdAt: number }} Message */
/** @typedef {{ meta: Message; body: Buffer; digest: string }} StoredMessage */
/** @typedef {import('node:http').IncomingMessage} Request */
/** @typedef {import('node:http').ServerResponse} Response */

/**
 * Serve one byte range; ignore unsupported units, malformed and multipart ranges.
 * See https://www.rfc-editor.org/rfc/rfc9110.html#section-14.2.
 * @param {string | undefined} value
 * @param {number} size
 * @returns {{ start: number; end: number } | 'unsatisfiable' | null}
 */
function byteRange(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value?.trim() ?? '');
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    return suffix === 0 ? 'unsatisfiable' : { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (match[2] && end < start) return null;
  if (start >= size) return 'unsatisfiable';
  // Huge end/suffix numerals clamp to the bounded Buffer, never to a slice offset outside it.
  return { start, end: Math.min(end, size - 1) };
}

/**
 * A loopback-only example API. Media is bounded and retained in memory until reset.
 * @param {{ maxItems?: number; maxBytes?: number; maxRecordingBytes?: number; delayMs?: number }} [options]
 */
export function createMessageApi(options = {}) {
  const maxItems = options.maxItems ?? MAX_ITEMS;
  const maxBytes = options.maxBytes ?? MAX_COLLECTION_BYTES;
  const maxRecordingBytes = options.maxRecordingBytes ?? MAX_RECORDING_BYTES;
  /** @type {Map<string, StoredMessage>} */
  const messages = new Map();
  let bytes = 0;
  let incoming = 0;
  let generation = 0;
  let requests = 0;

  /** @param {Response} res @param {number} status @param {unknown} value */
  function json(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(value));
  }

  /** @param {Request} req @param {Response} res */
  async function handle(req, res) {
    // Reject requests from other sites, including their preflights. Vite also checks Host.
    const origin = req.headers.origin;
    const host = req.headers.host ?? '';
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host) ||
        (origin !== undefined && origin !== `http://${host}` && origin !== `https://${host}`) ||
        req.headers['sec-fetch-site'] === 'cross-site') {
      json(res, 403, { error: 'This API accepts same-origin local requests only.' }); return;
    }
    const url = new URL(req.url ?? '/', `http://${host}`);
    const match = /^\/api\/messages\/([a-zA-Z0-9-]{8,80})(\/audio)?$/.exec(url.pathname);
    if (req.method === 'GET' && url.pathname === '/api/messages') {
      json(res, 200, { messages: [...messages.values()].map(value => value.meta), requests, bytes, generation }); return;
    }
    if (req.method === 'DELETE' && url.pathname === '/api/messages') {
      messages.clear(); bytes = 0; requests = 0; generation++;
      json(res, 200, { cleared: true }); return;
    }
    if (req.method === 'GET' && match?.[2]) {
      const message = messages.get(match[1]);
      if (!message) { json(res, 404, { error: 'This message is no longer on the local server.' }); return; }
      const size = message.body.length;
      const etag = `"${message.digest}"`;
      const headers = { 'Content-Type': message.meta.mimeType, 'Accept-Ranges': 'bytes', ETag: etag,
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
      // No Last-Modified validator is advertised. Only an exact strong ETag permits If-Range.
      const range = req.headers['if-range'] === undefined || req.headers['if-range'] === etag ?
        byteRange(req.headers.range, size) : null;
      if (range === 'unsatisfiable') {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}`, 'Content-Length': 0 });
        res.end(); return;
      }
      if (range) {
        res.writeHead(206, { ...headers, 'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
          'Content-Length': range.end - range.start + 1 });
        res.end(message.body.subarray(range.start, range.end + 1)); return;
      }
      res.writeHead(200, { ...headers, 'Content-Length': size });
      res.end(message.body); return;
    }
    if (req.method !== 'PUT' || !match || match[2]) { json(res, 404, { error: 'Unknown endpoint.' }); return; }
    requests++;
    const requestGeneration = generation;
    const id = match[1];
    const conversation = req.headers['x-conversation'];
    const mimeType = req.headers['content-type'] ?? '';
    const scenario = req.headers['x-example-scenario'] ?? 'normal';
    if (typeof conversation !== 'string' || !CONVERSATIONS.includes(conversation) ||
        !/^audio\/(webm|ogg|mp4|wav|mpeg)(?:;[\x20-\x7e]{1,120})?$/i.test(mimeType) ||
        !['normal', 'reject', 'delay', 'drop-response'].includes(String(scenario))) {
      json(res, 400, { error: 'Unsupported conversation, audio type or test scenario.' }); return;
    }
    // Cap simultaneous request buffering as well as retained data.
    if (incoming >= 2) { json(res, 429, { error: 'Another upload is in progress. Retry shortly.' }); return; }
    const advertisedSize = Number(req.headers['content-length']);
    if (Number.isFinite(advertisedSize) && advertisedSize > maxRecordingBytes) {
      json(res, 413, { error: 'Recording exceeds the upload limit.' }); return;
    }
    incoming++;
    /** @type {Buffer[]} */
    const chunks = [];
    let received = 0;
    try {
      for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += buffer.length;
        if (received > maxRecordingBytes) { json(res, 413, { error: 'Recording exceeds the upload limit.' }); return; }
        chunks.push(buffer);
      }
      if (!received) { json(res, 400, { error: 'The recording is empty.' }); return; }
      const body = Buffer.concat(chunks);
      const digest = createHash('sha256').update(body).digest('hex');
      if (scenario === 'delay') await new Promise(resolve => setTimeout(resolve, options.delayMs ?? 2000));
      if (req.aborted || res.destroyed) return;
      if (generation !== requestGeneration) { json(res, 409, { error: 'The collection was cleared. This upload was not accepted.' }); return; }
      // Check identity after reading/delaying so concurrent retries cannot both commit.
      const existing = messages.get(id);
      if (existing) {
        if (existing.digest !== digest || existing.meta.conversation !== conversation || existing.meta.mimeType !== mimeType) {
          json(res, 409, { error: 'This message identifier already belongs to different audio.' }); return;
        }
        // Browsers may transparently retry an idempotent PUT. Keep the fault active
        // for that request; the app's explicit retry uses the normal scenario.
        if (scenario === 'drop-response') { res.destroy(); return; }
        json(res, 200, existing.meta); return;
      }
      if (scenario === 'reject') { json(res, 503, { error: 'Simulated rejection. Your recording was not accepted; retry it.' }); return; }
      if (messages.size >= maxItems || bytes + body.length > maxBytes) {
        json(res, 507, { error: 'The local conversation is full. Clear it before sending more audio.' }); return;
      }
      const meta = { id, conversation, mimeType, bytes: body.length, createdAt: Date.now() };
      messages.set(id, { meta, body, digest }); bytes += body.length;
      if (scenario === 'drop-response') { res.destroy(); return; }
      json(res, 201, meta);
    } finally { incoming--; }
  }

  /** @param {Request} req @param {Response} res @param {() => void} next */
  const middleware = (req, res, next) => {
    if (!req.url?.startsWith('/api/')) { next(); return; }
    void handle(req, res).catch(() => {
      if (!res.headersSent && !res.destroyed) json(res, 400, { error: 'Upload interrupted. Acceptance could not be confirmed.' });
      else res.destroy();
    });
  };
  return middleware;
}

/** @returns {import('vite').Plugin} */
export function messageApiPlugin() {
  return {
    name: 'recstead-example-messages',
    configureServer(server) { server.middlewares.use(createMessageApi()); },
    configurePreviewServer(server) { server.middlewares.use(createMessageApi()); },
  };
}
