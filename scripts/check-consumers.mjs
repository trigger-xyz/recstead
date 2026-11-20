import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { runNpm } from './lib/npm.mjs';

// Install the packed tarball into independent consumers:
//   1. a type-only project compiled by the oldest and newest supported TypeScript;
//   2. a Next.js application: production build, server render, hydration,
//      a recording through the hooks, and cleanup when the route changes.
const TYPESCRIPT = { floor: '5.0.4', latest: '7.0.2' };
const NEXT = { next: '16.4.6', react: '19.3.1', 'react-dom': '19.3.1', typescript: '7.0.2',
  '@types/react': '19.3.0', '@types/react-dom': '19.3.0', '@types/node': '26.6.6' };
const install = ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/'];

/** @type {{ version: string }} */
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
// A failed run must not leave an earlier passing record behind.
await rm('.artifacts/consumer-check.json', { force: true });
const temp = await realpath(await mkdtemp(join(tmpdir(), 'recstead-consumers-')));
/** @type {import('node:child_process').ChildProcess | undefined} */
let server;
/** @type {import('@playwright/test').Browser | undefined} */
let browser;
/** @type {Record<string, unknown> | undefined} */
let record;
try {
  // Both consumers install one private copy, so the recorded hash is the hash of the installed bytes.
  const tarball = join(temp, `recstead-${manifest.version}.tgz`);
  await cp(resolve('.artifacts', `recstead-${manifest.version}.tgz`), tarball);
  const tarballSha256 = createHash('sha256').update(await readFile(tarball)).digest('hex');
  // 1. Declarations under the supported TypeScript range and both common resolution modes.
  const types = join(temp, 'types');
  await cp('tests/fixtures/types', types, { recursive: true });
  await writeFile(join(types, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  runNpm([...install, tarball, ...Object.entries(TYPESCRIPT).map(([name, version]) => `ts-${name}@npm:typescript@${version}`)], { cwd: types, stdio: 'pipe' });
  /** @type {{ typescript: string; moduleResolution: string }[]} */
  const typeChecks = [];
  for (const [name, version] of Object.entries(TYPESCRIPT)) {
    /** @type {{ version: string; bin: Record<string, string> }} */
    const compiler = JSON.parse(await readFile(join(types, `node_modules/ts-${name}/package.json`), 'utf8'));
    assert.equal(compiler.version, version);
    for (const [module, moduleResolution] of [['ESNext', 'Bundler'], ['NodeNext', 'NodeNext']]) {
      const project = join(types, `tsconfig.${name}.${moduleResolution}.json`);
      await writeFile(project, JSON.stringify({ compilerOptions: { target: 'ES2022', module, moduleResolution, jsx: 'react-jsx',
        lib: ['ES2022', 'DOM', 'DOM.Iterable'], types: [], strict: true, exactOptionalPropertyTypes: true, noEmit: true, skipLibCheck: false }, files: ['consumer.ts'] }));
      execFileSync(process.execPath, [join(types, `node_modules/ts-${name}`, compiler.bin.tsc), '-p', project], { cwd: types, stdio: 'inherit' });
      typeChecks.push({ typescript: version, moduleResolution });
    }
  }
  console.log(`Types: consumer compiled with TypeScript ${Object.values(TYPESCRIPT).join(' and ')}.`);

  // 2. Next.js production application.
  const app = join(temp, 'next');
  await cp('tests/fixtures/next', app, { recursive: true });
  runNpm([...install, tarball, ...Object.entries(NEXT).map(([name, version]) => `${name}@${version}`)], { cwd: app, stdio: 'pipe' });
  const next = join(app, 'node_modules/next/dist/bin/next');
  const env = { ...process.env, NEXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'production' };
  execFileSync(process.execPath, [next, 'build'], { cwd: app, stdio: 'inherit', env });
  // Another process can take a free port between the probe and the server binding it, so a
  // server that exits before answering is started again on another port.
  let origin = '';
  for (let attempt = 0; attempt < 3 && !origin; attempt++) {
    const candidate = `http://127.0.0.1:${await freePort()}`;
    const serving = spawn(process.execPath, [next, 'start', '-H', '127.0.0.1', '-p', new URL(candidate).port], { cwd: app, stdio: 'inherit', env });
    server = serving;
    const answered = await waitFor(async () => serving.exitCode !== null || (await fetch(candidate).catch(() => null))?.ok === true, 'The Next.js server did not start.')
      .then(() => serving.exitCode === null);
    if (answered) origin = candidate;
  }
  assert(origin, 'The Next.js server exited before answering, three times.');

  browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  // What the server sent, read as a browser without JavaScript shows it. Nothing can hydrate here.
  const served = await browser.newContext({ javaScriptEnabled: false });
  const markup = await served.newPage();
  await markup.goto(origin);
  assert.equal(await markup.getByText('Rendered on:').textContent(), 'Rendered on: server', 'The server component must render with the core on the server.');
  assert.equal(await markup.getByRole('status').textContent(), 'Status: idle', 'The recorder hook must render its idle snapshot on the server.');
  await served.close();

  const page = await browser.newPage();
  /** @type {string[]} */
  const problems = [];
  page.on('pageerror', error => problems.push(error.message));
  page.on('console', message => { if (message.type() === 'error') problems.push(message.text()); });
  await page.addInitScript(() => {
    const acquire = MediaDevices.prototype.getUserMedia;
    // The tracks themselves are kept: one removed from its stream without being stopped is still live.
    /** @type {MediaStreamTrack[]} */
    const tracks = [];
    Object.assign(window, { capturedTracks: tracks });
    MediaDevices.prototype.getUserMedia = async function (/** @type {MediaStreamConstraints | undefined} */ constraints) {
      const stream = await acquire.call(this, constraints); tracks.push(...stream.getTracks()); return stream;
    };
  });
  const status = page.getByRole('status');
  const captured = () => page.evaluate(() => /** @type {{ capturedTracks: MediaStreamTrack[] }} */ (/** @type {unknown} */ (window))
    .capturedTracks.map(track => track.readyState));
  const liveTracks = async () => (await captured()).filter(state => state !== 'ended').length;
  /** Record long enough for the encoder to have produced audio, then stop. */
  const recordAndStop = async () => {
    await page.getByRole('button', { name: 'Record' }).click();
    await status.filter({ hasText: 'Status: recording' }).waitFor();
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: 'Stop' }).click();
    await status.filter({ hasText: 'Status: ready' }).waitFor();
    // The URL must still be usable: a revoked one keeps its text but can no longer be read or decoded.
    const seconds = await page.getByLabel('Recording').evaluate(async element => {
      const context = new AudioContext();
      try { return (await context.decodeAudioData(await (await fetch(/** @type {HTMLAudioElement} */ (element).src)).arrayBuffer())).duration; }
      finally { await context.close(); }
    });
    assert(seconds > 0.1, 'A completed recording must be playable through the URL hook.');
  };
  await page.goto(origin);
  await recordAndStop();
  assert.equal(await liveTracks(), 0, 'Stop must release the microphone.');
  // Leave the route while recording: unmounting the hook must release capture.
  await page.getByRole('button', { name: 'Record' }).click();
  await status.filter({ hasText: 'Status: recording' }).waitFor();
  assert.equal(await liveTracks(), 1);
  await page.getByRole('link', { name: 'Other page' }).click();
  await page.getByRole('heading', { name: 'Other page' }).waitFor();
  await waitFor(async () => await liveTracks() === 0, 'Leaving the route must release the microphone.');
  // The same document is still loaded, so this was a client-side transition, and a new mount records again.
  await page.getByRole('link', { name: 'Recorder page' }).click();
  await status.filter({ hasText: 'Status: idle' }).waitFor();
  await recordAndStop();
  assert.deepEqual(await captured(), ['ended', 'ended', 'ended'], 'Three recordings in one document, each with its microphone released.');
  assert.deepEqual(problems, [], 'Hydration and runtime must not report errors.');

  record = { checkedAt: new Date().toISOString(), version: manifest.version,
    tarballSha256, node: process.version, platform: process.platform, typeChecks,
    next: { versions: NEXT, browser: `chromium ${browser.version()}`, productionBuild: true, serverRendered: true, hydrationErrors: 0,
      recordedThroughHooks: true, routeChangeReleasedCapture: true } };
} finally {
  // Every step runs even if an earlier one fails, and the server has exited before its files are removed.
  await browser?.close().catch(() => {});
  if (server && server.exitCode === null) {
    const exited = new Promise(done => server?.once('exit', done));
    server.kill();
    await Promise.race([exited, new Promise(done => setTimeout(done, 5000))]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
// The record is written last: a run that fails anywhere, including in its cleanup, leaves none.
assert(record);
await writeFile('.artifacts/consumer-check.json', JSON.stringify(record, null, 2) + '\n');
console.log(`Next.js ${NEXT.next}: production build, server render, hydration, recording and route cleanup passed.`);

/** @returns {Promise<number>} */
function freePort() {
  return new Promise((done, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => (address && typeof address === 'object' ? done(address.port) : reject(new Error('No port'))));
    });
  });
}

/** @param {() => Promise<boolean>} condition @param {string} message */
async function waitFor(condition, message) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await condition()) return;
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error(message);
}
