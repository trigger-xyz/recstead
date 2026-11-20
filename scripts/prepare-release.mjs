import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';

// Bind every piece of release evidence to one tarball. Nothing here publishes.
const ENGINES = ['chromium', 'firefox', 'webkit'];
// A report from an earlier run names a publish command; it must not outlive a run that fails.
await rm('.artifacts/release-candidate.json', { force: true });
/** Every named flag must be exactly true: a record written by an older or partial check is not evidence. */
const completed = (/** @type {Record<string, unknown> | undefined} */ record, /** @type {string[]} */ flags, /** @type {string} */ what) => {
  for (const flag of flags) assert.equal(record?.[flag], true, `${what} did not record ${flag}.`);
};
/** @type {{ name: string; version: string; publishConfig?: { access?: string; tag?: string; registry?: string } }} */
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
/** @type {{ version: string; filename: string; tarballSha256: string; integrity: string; files: string[] } & Record<string, unknown>} */
const checked = JSON.parse(await readFile('.artifacts/package-check.json', 'utf8'));
completed(checked, ['coreWithoutReact', 'browserGlobalsForbiddenOnImportAndConstruction', 'typesAndExampleSources',
  'reactClientDirective', 'reactSharesCore', 'commonJsRequire'], 'The package check');
assert.equal(manifest.name, 'recstead');
const version = /^\d+\.\d+\.\d+(-(?:alpha|beta|rc)\.\d+)?$/.exec(manifest.version);
assert(version, `Unexpected version: ${manifest.version}`);
// Prereleases stay on the next tag; only a stable version may move latest.
const tag = version[1] ? 'next' : 'latest';
assert.equal(checked.version, manifest.version);
assert.equal(checked.filename, `${manifest.name}-${manifest.version}.tgz`);
assert.equal(manifest.publishConfig?.access, 'public');
assert.equal(manifest.publishConfig?.tag, tag, `publishConfig.tag must be ${tag} for ${manifest.version}.`);
assert.equal(manifest.publishConfig?.registry, 'https://registry.npmjs.org/');
const artifact = `./.artifacts/${checked.filename}`;
const hash = createHash('sha256').update(await readFile(artifact)).digest('hex');
assert.equal(hash, checked.tarballSha256, 'The tarball changed after its consumer checks.');

/** @typedef {{ version: string | null; nativeRecorder: boolean | null; mimeType: string | null; resources: { sessionsPerApp?: number } | null; passed: number; failed: number; skipped: string[] }} EngineResult */
/** @typedef {{ version: string; tarballSha256: string | null; exitCode: number; publicImportsWithoutAliases: boolean; playwrightArguments?: string[]; host?: { platform: string }; engines?: Record<string, EngineResult> }} Workflows */
// The host run is required. The container run supplies engines this host cannot launch.
const sources = ['.artifacts/workflow-candidate.json', '.artifacts/container/workflow-candidate.json'].filter((path, index) => index === 0 || existsSync(path));
/** @type {Record<string, { evidence: string; platform: string; version: string | null; mimeType: string | null; passed: number; skipped: string[] }[]>} */
const engines = Object.fromEntries(ENGINES.map(name => [name, []]));
for (const path of sources) {
  /** @type {Workflows} */
  const workflows = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(workflows.version, manifest.version, `Browser workflows checked a different package version: ${path}`);
  assert.equal(workflows.tarballSha256, hash, `Browser workflows checked a different tarball: ${path}`);
  assert.equal(workflows.exitCode, 0, `Browser workflow checks did not pass: ${path}`);
  assert.equal(workflows.publicImportsWithoutAliases, true, 'Browser workflows must use installed public exports.');
  // Choosing engines is allowed. Any other Playwright argument may have selected a subset of the workflows.
  const extra = (workflows.playwrightArguments ?? ['(not recorded)']).filter(argument => !argument.startsWith('--project='));
  assert.equal(extra.length, 0, `Browser workflows ran with extra Playwright arguments (${extra.join(' ')}): ${path}`);
  const platform = workflows.host?.platform;
  assert(typeof platform === 'string' && platform, `Browser workflows did not record their platform: ${path}`);
  const chosen = (workflows.playwrightArguments ?? []).map(argument => argument.slice('--project='.length));
  for (const [name, result] of Object.entries(workflows.engines ?? {})) {
    assert(!chosen.length || chosen.includes(name), `${name} has a result but was not among the engines chosen in ${path}`);
    assert(typeof result.version === 'string' && result.version && typeof result.nativeRecorder === 'boolean' &&
      Number.isInteger(result.passed) && Number.isInteger(result.failed) && Array.isArray(result.skipped), `${name} has a malformed result in ${path}`);
    assert.equal(result.failed, 0, `${name} has failing workflows in ${path}`);
    // An engine build without MediaRecorder only proves the unsupported-environment path.
    if (result.nativeRecorder !== true) continue;
    // The engine has to have recorded: the format comes from an uploaded and decoded recording,
    // the resource counts from the repeated-session workflow. Reporting its identity is not enough.
    assert(result.passed > 0 && typeof result.mimeType === 'string' && result.mimeType.startsWith('audio/') &&
      Number(result.resources?.sessionsPerApp) > 0, `${name} passed without recording in ${path}`);
    engines[name]?.push({ evidence: path, platform, version: result.version,
      mimeType: result.mimeType, passed: result.passed, skipped: result.skipped });
  }
}
for (const name of ENGINES) {
  assert(engines[name]?.length, `${name} has no passing native-recording result for this tarball. Run npm run test:browser:container, or npm run test:browser on a host where ${name} launches.`);
}
/** @type {{ version: string; tarballSha256: string; typeChecks?: unknown[]; next?: Record<string, unknown> }} */
const consumers = JSON.parse(await readFile('.artifacts/consumer-check.json', 'utf8'));
assert.equal(consumers.version, manifest.version, 'Consumer fixtures checked a different package version.');
assert.equal(consumers.tarballSha256, hash, 'Consumer fixtures checked a different tarball.');
assert(Array.isArray(consumers.typeChecks) && consumers.typeChecks.length >= 4, 'Consumer fixtures did not record their TypeScript checks.');
completed(consumers.next, ['productionBuild', 'serverRendered', 'recordedThroughHooks', 'routeChangeReleasedCapture'], 'The Next.js consumer');
assert.equal(consumers.next?.hydrationErrors, 0, 'The Next.js consumer recorded hydration errors.');

const publishCommand = `npm publish ${artifact} --access public --tag ${tag} --registry=https://registry.npmjs.org/`;
const report = {
  preparedAt: new Date().toISOString(), name: manifest.name, version: manifest.version,
  artifact, sha256: hash, integrity: checked.integrity, files: checked.files,
  tag, registry: manifest.publishConfig.registry, published: false,
  engines, browserWorkflows: sources, consumers: '.artifacts/consumer-check.json',
  publishCommand,
  remainingChecks: ['Commit and push the public source, then confirm hosted CI for that commit.', 'Confirm the npm account, publishing authentication and that this version is unpublished.', 'Recheck the artifact hash immediately before publishing.'],
};
await writeFile('.artifacts/release-candidate.json', JSON.stringify(report, null, 2) + '\n');
console.log(`Prepared ${manifest.name}@${manifest.version}\nSHA-256 ${hash}\nEngines: ${ENGINES.map(name => `${name} ${engines[name]?.map(entry => `${entry.version} on ${entry.platform}`).join(', ')}`).join('; ')}\nPublication has not run. After the remaining release checks:\n${publishCommand}`);
