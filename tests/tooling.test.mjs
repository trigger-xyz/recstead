import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const privacyScript = resolve('scripts/check-privacy.mjs');
const releaseScript = resolve('scripts/prepare-release.mjs');

/**
 * A scratch repository that ignores the machine's Git configuration and any Git command this
 * test may be running under, such as a hook with its own index.
 * @param {import('node:test').TestContext} t
 */
async function repository(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'recstead-privacy-'));
  const home = await mkdtemp(join(tmpdir(), 'recstead-git-'));
  t.after(() => Promise.all([cwd, home].map(path => rm(path, { recursive: true, force: true }))));
  await writeFile(join(home, 'config'), '');
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
    GIT_CONFIG_GLOBAL: join(home, 'config'), GIT_CONFIG_NOSYSTEM: '1' };
  const git = (/** @type {string[]} */ ...args) => execFileSync('git', args, { cwd, env });
  git('init', '--quiet');
  await writeFile(join(cwd, '.gitignore'), '.private/\n');
  git('add', '.gitignore');
  return { cwd, git, check: () => spawnSync(process.execPath, [privacyScript], { cwd, env, encoding: 'utf8' }) };
}

test('privacy check accepts ignored local records but rejects private files in the index', async t => {
  const { cwd, git, check } = await repository(t);
  await mkdir(join(cwd, '.private'));
  await writeFile(join(cwd, '.private/README.md'), 'Private fixture record\n');
  await writeFile(join(cwd, 'README.md'), 'Public fixture\n');
  git('add', 'README.md');
  const good = check();
  assert.equal(good.status, 0, good.stderr);
  git('add', '-f', '.private/README.md');
  const bad = check();
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /Private or generated material/);
});

test('redacting the worktree does not conceal a credential already staged for Git', async t => {
  const { cwd, git, check } = await repository(t);
  const sentinel = 'npm_' + 'x'.repeat(36);
  await writeFile(join(cwd, 'README.md'), sentinel);
  git('add', 'README.md');
  await writeFile(join(cwd, 'README.md'), 'The worktree is clean now.');
  const result = check();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /credential in Git index/);
  assert(!result.stderr.includes(sentinel), 'Credential contents must not appear in diagnostics');
});

test('home directories and private keys are refused in the worktree and in the index', async t => {
  const { cwd, git, check } = await repository(t);
  // Assembled here so that this file does not contain what the check looks for.
  const cases = {
    'macOS home': ['/', 'Users/alice/project/notes.txt'], 'Linux home': ['/', 'home/alice/project/notes.txt'],
    'Windows home': ['C:', '\\Users\\alice\\project'], 'Windows home in JSON': ['"C:', '\\\\Users\\\\alice\\\\project"'],
    'private key': ['-----BEGIN ', 'PRIVATE KEY-----'], 'encrypted private key': ['-----BEGIN ', 'ENCRYPTED PRIVATE KEY-----'],
    'OpenSSH private key': ['-----BEGIN ', 'OPENSSH PRIVATE KEY-----'],
  };
  for (const [name, parts] of Object.entries(cases)) {
    const sentinel = parts.join('');
    await writeFile(join(cwd, 'notes.txt'), `Before\n${sentinel}\nAfter\n`);
    const untracked = check();
    assert.notEqual(untracked.status, 0, name);
    assert.match(untracked.stderr, /in worktree: notes\.txt/, name);
    git('add', 'notes.txt');
    await writeFile(join(cwd, 'notes.txt'), 'Clean now\n');
    const staged = check();
    assert.notEqual(staged.status, 0, name);
    assert.match(staged.stderr, /in Git index: notes\.txt/, name);
    assert(!untracked.stderr.includes(sentinel) && !staged.stderr.includes(sentinel), `${name} must not appear in diagnostics`);
    git('rm', '--cached', '--quiet', '-f', 'notes.txt');
    await rm(join(cwd, 'notes.txt'));
    assert.equal(check().status, 0, name);
  }
});

test('a tracked file larger than one mebibyte does not break the privacy check', async t => {
  const { cwd, git, check } = await repository(t);
  await writeFile(join(cwd, 'large.txt'), 'a'.repeat(2 * 1024 * 1024));
  git('add', 'large.txt');
  const result = check();
  assert.equal(result.status, 0, result.stderr);
});

test('release preparation binds engine and consumer evidence to one tarball and rejects anything stale', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'recstead-release-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, '.artifacts/container'), { recursive: true });
  const version = '1.0.0-beta.0';
  const filename = `recstead-${version}.tgz`;
  const bytes = Buffer.from('Test artifact bytes; no registry operation');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const report = join(cwd, '.artifacts/release-candidate.json');
  const write = (/** @type {string} */ name, /** @type {unknown} */ value) => writeFile(join(cwd, name), JSON.stringify(value));
  const run = () => spawnSync(process.execPath, [releaseScript], { cwd, encoding: 'utf8' });
  const prepared = () => { const result = run(); assert.equal(result.status, 0, result.stderr); assert(existsSync(report)); };
  /** A refusal is a normal non-zero exit with its own diagnostic, and it leaves no report naming a publish command. */
  const refused = (/** @type {RegExp} */ diagnostic) => {
    const result = run();
    assert.equal(result.signal, null);
    assert.notEqual(result.status, 0, `Prepared despite ${diagnostic}`);
    assert.match(result.stderr, diagnostic);
    assert.equal(existsSync(report), false, `A report survived ${diagnostic}`);
  };
  // The records have the shape their producers write.
  const manifest = { name: 'recstead', version, publishConfig: { access: 'public', tag: 'next', registry: 'https://registry.npmjs.org/' } };
  const packageCheck = { version, filename, tarballSha256: hash, integrity: 'fixture', files: ['package.json'], coreWithoutReact: true,
    browserGlobalsForbiddenOnImportAndConstruction: true, typesAndExampleSources: true, installedTarballExampleBuilds: ['vanilla', 'react', 'synthetic'],
    reactClientDirective: true, reactSharesCore: true, commonJsRequire: true };
  const consumers = { version, tarballSha256: hash,
    typeChecks: ['5.0.4', '7.0.2'].flatMap(typescript => ['Bundler', 'NodeNext'].map(moduleResolution => ({ typescript, moduleResolution }))),
    next: { productionBuild: true, serverRendered: true, hydrationErrors: 0, recordedThroughHooks: true, routeChangeReleasedCapture: true } };
  const engine = (/** @type {boolean} */ nativeRecorder) => ({ version: '1', nativeRecorder, mimeType: nativeRecorder ? 'audio/webm' : null,
    resources: nativeRecorder ? { sessionsPerApp: 12 } : null, passed: nativeRecorder ? 20 : 2, failed: 0, skipped: [] });
  const evidence = (/** @type {string} */ platform, /** @type {Record<string, unknown>} */ engines) => ({ version, tarballSha256: hash, exitCode: 0, publicImportsWithoutAliases: true, playwrightArguments: [], host: { platform }, engines });
  const host = evidence('darwin', { chromium: engine(true), webkit: engine(true) });
  const container = evidence('linux', { chromium: engine(true), firefox: engine(true), webkit: engine(false) });
  const records = { 'package.json': manifest, '.artifacts/package-check.json': packageCheck, '.artifacts/consumer-check.json': consumers,
    '.artifacts/workflow-candidate.json': host, '.artifacts/container/workflow-candidate.json': container };
  /** Replace one record, expect the refusal, and put the good record back. */
  const refusedWith = async (/** @type {keyof typeof records} */ name, /** @type {unknown} */ value, /** @type {RegExp} */ diagnostic) => {
    await write(name, value); refused(diagnostic); await write(name, records[name]);
  };
  await writeFile(join(cwd, '.artifacts', filename), bytes);
  for (const [name, value] of Object.entries(records)) if (!name.includes('container')) await write(name, value);
  // The host alone has no Firefox result, so the release is not prepared.
  refused(/firefox has no passing native-recording result/);
  await write('.artifacts/container/workflow-candidate.json', container);
  prepared();
  const prepare = JSON.parse(await readFile(report, 'utf8'));
  assert.equal(prepare.sha256, hash);
  assert.equal(prepare.published, false);
  assert.match(prepare.publishCommand, /--tag next --registry=https:\/\/registry.npmjs.org\//);
  // WebKit on Linux has no MediaRecorder, so only the macOS run counts for it.
  assert.deepEqual(prepare.engines.webkit.map((/** @type {{ platform: string }} */ entry) => entry.platform), ['darwin']);
  assert.deepEqual(prepare.engines.chromium.map((/** @type {{ platform: string }} */ entry) => entry.platform), ['darwin', 'linux']);

  const linux = '.artifacts/container/workflow-candidate.json';
  const firefox = (/** @type {Record<string, unknown>} */ change) => ({ ...container, engines: { ...container.engines, firefox: { ...engine(true), ...change } } });
  await refusedWith(linux, { ...container, tarballSha256: 'stale' }, /Browser workflows checked a different tarball/);
  await refusedWith(linux, { ...container, exitCode: 1 }, /Browser workflow checks did not pass/);
  await refusedWith(linux, firefox({ failed: 1 }), /firefox has failing workflows/);
  // An engine that only reported its identity, as a focused run would, has not recorded anything.
  await refusedWith(linux, firefox({ passed: 1, mimeType: null, resources: null }), /firefox passed without recording/);
  await refusedWith(linux, firefox({ resources: null }), /firefox passed without recording/);
  await refusedWith(linux, firefox({ passed: '20' }), /firefox has a malformed result/);
  await refusedWith(linux, firefox({ version: null }), /firefox has a malformed result/);
  await refusedWith(linux, { ...container, host: {} }, /did not record their platform/);
  // A run that selected tests is not evidence for the whole suite; choosing engines is fine, if the results agree with the choice.
  const hostRecord = '.artifacts/workflow-candidate.json';
  await refusedWith(hostRecord, { ...host, playwrightArguments: ['--project=chromium', '-g', 'engine identity'] }, /ran with extra Playwright arguments \(-g engine identity\)/);
  await refusedWith(linux, { ...container, playwrightArguments: ['--project=chromium'] }, /firefox has a result but was not among the engines chosen/);
  await write(hostRecord, { ...host, playwrightArguments: ['--project=chromium', '--project=webkit'] });
  prepared();
  await write(hostRecord, host);
  // The package and consumer records must say what was checked, not only which tarball.
  const consumerRecord = '.artifacts/consumer-check.json';
  await refusedWith(consumerRecord, { ...consumers, tarballSha256: 'stale' }, /Consumer fixtures checked a different tarball/);
  await refusedWith(consumerRecord, { version, tarballSha256: hash }, /did not record their TypeScript checks/);
  await refusedWith(consumerRecord, { ...consumers, next: { ...consumers.next, productionBuild: false } }, /Next\.js consumer did not record productionBuild/);
  await refusedWith(consumerRecord, { ...consumers, next: { ...consumers.next, hydrationErrors: 1 } }, /recorded hydration errors/);
  await refusedWith('.artifacts/package-check.json', { ...packageCheck, reactSharesCore: undefined }, /package check did not record reactSharesCore/);
  // A stable version may only be prepared for the latest tag, a prerelease only for next.
  await refusedWith('package.json', { ...manifest, publishConfig: { ...manifest.publishConfig, tag: 'latest' } }, /publishConfig.tag must be next/);
  prepared();
  await writeFile(join(cwd, '.artifacts', filename), 'Changed after validation');
  refused(/tarball changed after its consumer checks/);
});
