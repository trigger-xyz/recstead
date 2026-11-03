import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { arch, platform, release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { messageApiPlugin } from '../examples/server/messages.mjs';
import { runNpm } from './lib/npm.mjs';

const published = process.argv.includes('--published');
const root = process.cwd();
await mkdir('.artifacts', { recursive: true });
/** @type {{ name: string; version: string }} */
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const spec = published ? 'recstead@0.1.0-alpha.0' : resolve('.artifacts', `recstead-${manifest.version}.tgz`);
if (!published) {
  runNpm(['run', 'build'], { stdio: 'inherit' });
  runNpm(['pack', '--json', '--ignore-scripts', '--pack-destination', '.artifacts']);
}
const tarballSha256 = published ? null : createHash('sha256').update(await readFile(spec)).digest('hex');
const fixture = await realpath(await mkdtemp(join(tmpdir(), 'recstead-workflows-')));
/** @type {import('vite').ViteDevServer | undefined} */
let server;
try {
  await writeFile(join(fixture, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=optional', '--registry=https://registry.npmjs.org/', spec], { cwd: fixture, stdio: 'pipe' });
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  for (const name of ['react', 'react-dom', 'scheduler']) {
    await symlink(join(root, 'node_modules', name), join(fixture, 'node_modules', name), linkType);
  }
  await cp('examples', join(fixture, 'examples'), { recursive: true, filter: path => !path.endsWith('vite.config.mjs') });
  /** @type {{ name: string; version: string }} */
  const installed = JSON.parse(await readFile(join(fixture, 'node_modules/recstead/package.json'), 'utf8'));
  assert.equal(installed.version, published ? '0.1.0-alpha.0' : manifest.version);
  // No aliases: every app import resolves to the independently installed package.
  server = await createServer({ configFile: false, root: join(fixture, 'examples'),
    plugins: [messageApiPlugin()], logLevel: 'warn',
    server: { host: '127.0.0.1', port: 0, fs: { strict: true, allow: [join(fixture, 'examples'), join(fixture, 'node_modules'), join(root, 'node_modules')] } } });
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address === 'object');
  const baseURL = `http://127.0.0.1:${address.port}`;
  const startedAt = new Date().toISOString();
  const child = spawn(process.execPath, [resolve('node_modules/@playwright/test/cli.js'), 'test'], {
    stdio: 'inherit', env: { ...process.env, RECSTEAD_TEST_URL: baseURL,
      RECSTEAD_TEST_PUBLISHED: published ? '1' : '', RECSTEAD_TEST_VERSION: installed.version },
  });
  const code = await new Promise(/** @param {(code: number) => void} resolve */ (resolve, reject) => {
    child.once('error', reject); child.once('exit', (code, signal) => resolve(signal ? 1 : code ?? 1));
  });
  await writeFile(`.artifacts/workflow-${published ? 'published' : 'candidate'}.json`, JSON.stringify({
    startedAt, completedAt: new Date().toISOString(), package: installed.name, version: installed.version,
    installedFrom: published ? spec : `.artifacts/recstead-${manifest.version}.tgz`, publicImportsWithoutAliases: true,
    tarballSha256, node: process.version, host: { platform: platform(), release: release(), arch: arch() },
    exitCode: code, physicalMicrophoneTested: false,
  }, null, 2) + '\n');
  process.exitCode = Number(code);
} finally {
  await server?.close();
  await rm(fixture, { recursive: true, force: true });
}
