import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';

// The public contract: runtime exports and shipped declarations. Any change to it
// must be deliberate. Update the snapshot with RECSTEAD_UPDATE_API=1 npm test, and
// record the change in the changelog.
const SNAPSHOT = new URL('./snapshots/api.txt', import.meta.url);
const read = async (/** @type {string} */ path) => (await readFile(new URL(`../dist/${path}`, import.meta.url), 'utf8')).replaceAll('\r\n', '\n').trim();
/** Every overload of a function, in declaration order. */
const signature = async (/** @type {string} */ path, /** @type {string} */ name) => {
  const lines = (await read(path)).split('\n').filter(text => text.startsWith(`export declare function ${name}(`));
  assert(lines.length, `${name} is missing from ${path}`);
  return lines.join('\n');
};
/** What a consumer's resolver and package manager read; condition order inside exports is significant. */
const MANIFEST_CONTRACT = ['type', 'main', 'types', 'exports', 'sideEffects', 'engines', 'peerDependencies', 'peerDependenciesMeta'];

test('public exports and declarations match the recorded contract', async () => {
  const core = Object.keys(await import('../dist/index.js')).sort();
  const hooks = Object.keys(await import('../dist/react.js')).sort();
  /** @type {Record<string, unknown>} */
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const current = [
    `recstead, recstead/core: ${core.join(', ')}`,
    `recstead/react: ${hooks.join(', ')}`,
    '', await signature('core/controller.d.ts', 'createRecorder'), await signature('core/platform.d.ts', 'getCapabilities'),
    await signature('core/errors.d.ts', 'isRecorderFailure'),
    '', '// index.d.ts', await read('index.d.ts'),
    '', '// core/index.d.ts', await read('core/index.d.ts'),
    '', '// core/types.d.ts', await read('core/types.d.ts'),
    '', '// react.d.ts', await read('react.d.ts'),
    '', '// package.json', JSON.stringify(Object.fromEntries(MANIFEST_CONTRACT.map(key => [key, manifest[key]])), null, 2), '',
  ].join('\n');
  // Only the documented value rewrites the snapshot, and never in CI, where a pass must mean a comparison.
  const update = process.env.RECSTEAD_UPDATE_API || undefined;
  assert(update === undefined || (update === '1' && !process.env.CI), 'RECSTEAD_UPDATE_API accepts only 1, and only outside CI.');
  if (update) await writeFile(SNAPSHOT, current);
  const recorded = (await readFile(SNAPSHOT, 'utf8')).replaceAll('\r\n', '\n');
  assert.equal(current, recorded, 'The public API changed. If this is deliberate, update tests/snapshots/api.txt and the changelog.');
});
