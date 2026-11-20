import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { arch, platform, release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, firefox, webkit } from '@playwright/test';
import { createServer } from 'vite';
import { messageApiPlugin } from '../examples/server/messages.mjs';
import { runNpm } from './lib/npm.mjs';

// Usage: test-browser.mjs [--published[=version]] [--tarball=path] [playwright arguments]
// RECSTEAD_REQUIRE_ENGINES=chromium,firefox,webkit fails the run when a listed engine cannot launch.
const PUBLISHED_BASELINE = '1.0.0-beta.0';
const ENGINES = /** @type {const} */ ({ chromium, firefox, webkit });
const args = process.argv.slice(2);
const publishedArg = args.find(argument => argument === '--published' || argument.startsWith('--published='));
const tarballArg = args.find(argument => argument.startsWith('--tarball='));
const playwrightArgs = args.filter(argument => argument !== publishedArg && argument !== tarballArg);
const published = publishedArg !== undefined;
const publishedVersion = publishedArg?.split('=')[1] || PUBLISHED_BASELINE;
const target = published ? 'published' : 'candidate';
const root = process.cwd();
await mkdir('.artifacts', { recursive: true });
// Evidence describes the latest run only: a run that stops early must not leave an earlier result behind.
for (const stale of [`.artifacts/workflow-${target}.json`, `.artifacts/browser-${target}-results.json`]) await rm(stale, { force: true });
/** @type {{ name: string; version: string }} */
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const tarball = tarballArg ? resolve(tarballArg.slice('--tarball='.length)) : resolve('.artifacts', `recstead-${manifest.version}.tgz`);
const spec = published ? `recstead@${publishedVersion}` : tarball;
if (!published && !tarballArg) {
  runNpm(['run', 'build'], { stdio: 'inherit' });
  runNpm(['pack', '--json', '--ignore-scripts', '--pack-destination', '.artifacts']);
}

// An engine whose automation build cannot start on this host is reported, never counted as passing.
const requested = playwrightArgs.filter(argument => argument.startsWith('--project=')).map(argument => argument.slice('--project='.length));
const required = (process.env.RECSTEAD_REQUIRE_ENGINES ?? '').split(',').map(name => name.trim()).filter(Boolean);
/** @type {Record<string, string>} */
const unavailable = {};
/** @type {string[]} */
const runnable = [];
for (const name of /** @type {(keyof typeof ENGINES)[]} */ (Object.keys(ENGINES))) {
  if (requested.length && !requested.includes(name)) continue;
  try {
    const browser = await ENGINES[name].launch();
    await browser.close();
    runnable.push(name);
  } catch (error) {
    const lines = String(error instanceof Error ? error.message : error).split('\n').map(line => line.trim());
    unavailable[name] = [lines[0], ...lines.filter(line => /\[err\]/.test(line)).slice(0, 2)].join(' ');
    console.warn(`Engine unavailable on this host: ${name}. ${unavailable[name]}`);
  }
}
const missing = required.filter(name => (!requested.length || requested.includes(name)) && !runnable.includes(name));
assert.equal(missing.length, 0, `Required engines did not launch: ${missing.join(', ')}`);
assert(runnable.length > 0, 'No browser engine could launch on this host.');

const fixture = await realpath(await mkdtemp(join(tmpdir(), 'recstead-workflows-')));
/** @type {import('vite').ViteDevServer | undefined} */
let server;
/** @type {Record<string, unknown> | undefined} */
let record;
try {
  await writeFile(join(fixture, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  // Install a private copy of the candidate, so the recorded hash is the hash of the installed bytes.
  const candidate = join(fixture, 'candidate.tgz');
  if (!published) await cp(tarball, candidate);
  const tarballSha256 = published ? null : createHash('sha256').update(await readFile(candidate)).digest('hex');
  runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=optional', '--registry=https://registry.npmjs.org/', published ? spec : candidate], { cwd: fixture, stdio: 'pipe' });
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  for (const name of ['react', 'react-dom', 'scheduler']) {
    await symlink(join(root, 'node_modules', name), join(fixture, 'node_modules', name), linkType);
  }
  await cp('examples', join(fixture, 'examples'), { recursive: true, filter: path => !path.endsWith('vite.config.mjs') });
  /** @type {{ name: string; version: string }} */
  const installed = JSON.parse(await readFile(join(fixture, 'node_modules/recstead/package.json'), 'utf8'));
  assert.equal(installed.version, published ? publishedVersion : manifest.version);
  // No aliases: every app import resolves to the independently installed package.
  server = await createServer({ configFile: false, root: join(fixture, 'examples'),
    plugins: [messageApiPlugin()], logLevel: 'warn',
    server: { host: '127.0.0.1', port: 0, fs: { strict: true, allow: [join(fixture, 'examples'), join(fixture, 'node_modules'), join(root, 'node_modules')] } } });
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address === 'object');
  const baseURL = `http://127.0.0.1:${address.port}`;
  const startedAt = new Date().toISOString();
  const projects = runnable.map(name => `--project=${name}`);
  const child = spawn(process.execPath, [resolve('node_modules/@playwright/test/cli.js'), 'test',
    ...playwrightArgs.filter(argument => !argument.startsWith('--project=')), ...projects], {
    stdio: 'inherit', env: { ...process.env, RECSTEAD_TEST_URL: baseURL,
      RECSTEAD_TEST_PUBLISHED: published ? '1' : '', RECSTEAD_TEST_VERSION: installed.version },
  });
  const code = await new Promise(/** @param {(code: number) => void} resolve */ (resolve, reject) => {
    child.once('error', reject); child.once('exit', (code, signal) => resolve(signal ? 1 : code ?? 1));
  });
  const engines = await summarize(`.artifacts/browser-${target}-results.json`, runnable);
  record = {
    startedAt, completedAt: new Date().toISOString(), package: installed.name, version: installed.version,
    installedFrom: published ? spec : `recstead-${manifest.version}.tgz`, publicImportsWithoutAliases: true,
    tarballSha256, node: process.version, host: { platform: platform(), release: release(), arch: arch() },
    exitCode: code, playwrightArguments: playwrightArgs, engines, unavailable, physicalMicrophoneTested: false,
  };
  process.exitCode = Number(code);
} finally {
  await server?.close();
  await rm(fixture, { recursive: true, force: true });
}
// Written last, so a run that fails anywhere, including in its cleanup, leaves no record.
assert(record);
await writeFile(`.artifacts/workflow-${target}.json`, JSON.stringify(record, null, 2) + '\n');

/**
 * Count outcomes per engine from Playwright's JSON report.
 * @param {string} reportPath
 * @param {string[]} names
 */
async function summarize(reportPath, names) {
  /** @typedef {{ name: string; body?: string }} Attachment */
  /** @typedef {{ projectName: string; status: string; results: { attachments?: Attachment[] }[] }} ReportedTest */
  /** @typedef {{ specs?: { title: string; tests: ReportedTest[] }[]; suites?: Suite[] }} Suite */
  /** @type {Record<string, { version: string | null; nativeRecorder: boolean | null; source: string | null; mimeType: string | null; resources: unknown; passed: number; failed: number; skipped: string[] }>} */
  const engines = Object.fromEntries(names.map(name => [name, { version: null, nativeRecorder: null, source: null, mimeType: null, resources: null, passed: 0, failed: 0, skipped: [] }]));
  /** @type {{ suites?: Suite[] }} */
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  /** @param {Suite} suite */
  const visit = suite => {
    for (const reported of suite.specs ?? []) {
      for (const result of reported.tests) {
        const engine = engines[result.projectName];
        if (!engine) continue;
        if (result.status === 'expected') engine.passed++;
        else if (result.status === 'skipped') engine.skipped.push(reported.title);
        else engine.failed++;
        for (const attachment of result.results.flatMap(entry => entry.attachments ?? [])) {
          if (attachment.name === 'resources' && attachment.body) engine.resources = JSON.parse(Buffer.from(attachment.body, 'base64').toString('utf8'));
          if (attachment.name !== 'engine' || !attachment.body) continue;
          /** @type {{ browser?: string; nativeRecorder?: boolean; source?: string; mimeType?: string }} */
          const identity = JSON.parse(Buffer.from(attachment.body, 'base64').toString('utf8'));
          engine.version = identity.browser ?? engine.version;
          engine.nativeRecorder = identity.nativeRecorder ?? engine.nativeRecorder;
          engine.source = identity.source ?? engine.source;
          engine.mimeType = identity.mimeType ?? engine.mimeType;
        }
      }
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of report.suites ?? []) visit(suite);
  return engines;
}
