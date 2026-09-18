import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const privacyScript = resolve('scripts/check-privacy.mjs');
const releaseScript = resolve('scripts/prepare-release.mjs');

test('privacy check accepts ignored local records but rejects private files in the index', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'recstead-privacy-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd });
  await writeFile(join(cwd, '.gitignore'), '.private/\n');
  await mkdir(join(cwd, '.private'));
  await writeFile(join(cwd, '.private/README.md'), 'Private fixture record\n');
  await writeFile(join(cwd, 'README.md'), 'Public fixture\n');
  execFileSync('git', ['add', '.gitignore', 'README.md'], { cwd });
  const good = spawnSync(process.execPath, [privacyScript], { cwd, encoding: 'utf8' });
  assert.equal(good.status, 0, good.stderr);
  execFileSync('git', ['add', '-f', '.private/README.md'], { cwd });
  const bad = spawnSync(process.execPath, [privacyScript], { cwd, encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /Private or generated material/);
});

test('redacting the worktree does not conceal a credential already staged for Git', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'recstead-index-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd });
  await writeFile(join(cwd, '.gitignore'), '.private/\n');
  const sentinel = 'npm_' + 'x'.repeat(36);
  await writeFile(join(cwd, 'README.md'), sentinel);
  execFileSync('git', ['add', '.gitignore', 'README.md'], { cwd });
  await writeFile(join(cwd, 'README.md'), 'The worktree is clean now.');
  const result = spawnSync(process.execPath, [privacyScript], { cwd, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /credential in Git index/);
  assert(!result.stderr.includes(sentinel), 'Credential contents must not appear in diagnostics');
});

test('release preparation records the checked artifact and rejects bytes changed afterward', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'recstead-release-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, '.artifacts'));
  const filename = 'recstead-0.1.0-alpha.0.tgz';
  const bytes = Buffer.from('Test artifact bytes; no registry operation');
  const hash = createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(cwd, '.artifacts', filename), bytes);
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: 'recstead', version: '0.1.0-alpha.0', publishConfig: { access: 'public', tag: 'next', registry: 'https://registry.npmjs.org/' } }));
  await writeFile(join(cwd, '.artifacts/package-check.json'), JSON.stringify({ version: '0.1.0-alpha.0', filename, tarballSha256: hash, integrity: 'fixture', files: ['package.json'] }));
  const good = spawnSync(process.execPath, [releaseScript], { cwd, encoding: 'utf8' });
  assert.equal(good.status, 0, good.stderr);
  const report = JSON.parse(await readFile(join(cwd, '.artifacts/release-candidate.json'), 'utf8'));
  assert.equal(report.sha256, hash);
  assert.equal(report.published, false);
  assert.match(report.publishCommand, /--tag next --registry=https:\/\/registry.npmjs.org\//);
  await writeFile(join(cwd, '.artifacts', filename), 'Changed after validation');
  const bad = spawnSync(process.execPath, [releaseScript], { cwd, encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /tarball changed after its consumer checks/);
});
