import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Run the browser workflows for Chromium, Firefox and WebKit inside Playwright's
// Linux image, against the tarball already packed on this host. Only files that
// Git would publish are sent to the container. Extra arguments go to Playwright.
/** @type {{ version: string }} */
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
/** @type {{ version: string }} */
const playwright = JSON.parse(await readFile('node_modules/@playwright/test/package.json', 'utf8'));
const image = `mcr.microsoft.com/playwright:v${playwright.version}-noble`;
const tarball = `recstead-${manifest.version}.tgz`;
assert(existsSync(resolve('.artifacts', tarball)), `Pack ${tarball} first with npm run check:package.`);
const output = resolve('.artifacts/container');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await copyFile(resolve('.artifacts', tarball), join(output, tarball));

const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { encoding: 'utf8' })
  .split('\0').filter(name => name && existsSync(name));
const scratch = await mkdtemp(join(tmpdir(), 'recstead-container-'));
try {
  const list = join(scratch, 'files');
  await writeFile(list, files.join('\n') + '\n');
  const steps = ['set -e', 'mkdir -p /work', 'cd /work', 'tar -xf - --no-same-owner', 'npm ci --no-audit --no-fund',
    `npm run test:browser -- --tarball=.artifacts/${tarball} "$@"`].join('; ');
  // COPYFILE_DISABLE keeps macOS metadata files out of the archive.
  const archive = spawn('tar', ['-cf', '-', '-T', list], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const container = spawn('docker', ['run', '--rm', '-i', '--init', '--ipc=host',
    '-e', 'CI=1', '-e', 'RECSTEAD_REQUIRE_ENGINES=chromium,firefox,webkit',
    '-v', 'recstead-npm-cache:/root/.npm', '-v', `${output}:/work/.artifacts`,
    image, 'bash', '-c', steps, 'recstead', ...process.argv.slice(2)], { stdio: ['pipe', 'inherit', 'inherit'] });
  archive.stdout.pipe(container.stdin);
  const code = await new Promise(/** @param {(code: number) => void} done */ (done, reject) => {
    container.once('error', reject); container.once('exit', (status, signal) => done(signal ? 1 : status ?? 1));
  });
  console.log(`Container workflows ${code === 0 ? 'passed' : 'failed'} in ${image}. Evidence: .artifacts/container/workflow-candidate.json`);
  process.exitCode = code;
} finally {
  await rm(scratch, { recursive: true, force: true });
}
