import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { build } from 'vite';
import { createHash } from 'node:crypto';
import { runNpm } from './lib/npm.mjs';
const root = process.cwd();
await mkdir('.artifacts', { recursive: true });
/** @type {unknown} */
const response = JSON.parse(runNpm(['pack', '--json', '--ignore-scripts', '--pack-destination', '.artifacts']));
assert(Array.isArray(response) && response.length === 1);
/** @type {{ name: string; version: string; filename: string; integrity: string; files: { path: string }[] }} */
const packed = response[0];
assert.equal(packed.name, 'recstead');
assert.equal(typeof packed.version, 'string');
assert.equal(packed.filename, `${packed.name}-${packed.version}.tgz`);
assert(Array.isArray(packed.files) && packed.files.every(file => typeof file.path === 'string'));
assert.equal(typeof packed.integrity, 'string');
for (const file of packed.files) {
  assert(/^(?:dist\/|docs\/[a-z-]+\.md$|README\.md$|CHANGELOG\.md$|CONTRIBUTING\.md$|LICENSE$|package\.json$)/.test(file.path), `Unexpected published file: ${file.path}`);
}
const temp = await mkdtemp(join(tmpdir(), 'recstead-package-'));
try {
  await writeFile(join(temp, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  runNpm(['install', '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund', resolve('.artifacts', packed.filename)], { cwd: temp, stdio: 'pipe' });
  const coreCheck = `import assert from 'node:assert/strict';
for (const key of ['window','document','navigator','MediaRecorder']) Object.defineProperty(globalThis,key,{configurable:true,get(){throw new Error('Unexpected browser read: '+key)}});
const core = await import('recstead');
const alias = await import('recstead/core');
assert.equal(core.createRecorder,alias.createRecorder);
const recorder=core.createRecorder();
assert.equal(recorder.getSnapshot().status,'idle');
assert.equal(recorder.getSnapshot(),recorder.getSnapshot());
let absent=false; try { import.meta.resolve('react') } catch { absent=true }
assert(absent,'React must be absent in this core-only consumer');
await recorder.dispose();`;
  await writeFile(join(temp, 'core-check.mjs'), coreCheck);
  execFileSync(process.execPath, ['core-check.mjs'], { cwd: temp, stdio: 'inherit' });
  const nodeModules = join(temp, 'node_modules');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  for (const name of ['react', 'react-dom', 'scheduler', 'csstype']) await symlink(join(root, 'node_modules', name), join(nodeModules, name), linkType);
  await mkdir(join(nodeModules, '@types'), { recursive: true });
  for (const name of ['react','react-dom','prop-types']) await symlink(join(root,'node_modules','@types',name),join(nodeModules,'@types',name),linkType);
  await cp(join(root, 'examples'), join(temp, 'examples'), { recursive: true, filter: path => !path.endsWith('vite.config.mjs') });
  await writeFile(join(temp, 'consumer.ts'), `import { createRecorder, getCapabilities, type RecorderOptions } from 'recstead';
import { createRecorder as explicit } from 'recstead/core';
import { useRecorder, useRecorderSession, useRecordingUrl } from 'recstead/react';
const options: RecorderOptions = { source: { kind: 'microphone' }, maxBytes: 1024 };
const recorder = createRecorder(options);
void [getCapabilities, explicit, useRecorder, useRecorderSession, useRecordingUrl, recorder];\n`);
  await writeFile(join(temp, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', jsx: 'react-jsx', lib: ['ES2022', 'DOM', 'DOM.Iterable'], strict: true, noEmit: true, skipLibCheck: false }, include: ['consumer.ts','examples/**/*.ts','examples/**/*.tsx'] }));
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(temp, 'tsconfig.json')], { stdio: 'inherit' });
  await build({ configFile: false, root: join(temp, 'examples'), logLevel: 'warn', build: { outDir: join(temp, 'built-examples'), emptyOutDir: true, rolldownOptions: { input: { vanilla: join(temp,'examples/vanilla/index.html'), react: join(temp,'examples/react/index.html'), synthetic: join(temp,'examples/synthetic/index.html') } } } });
  // Every relative Markdown link in the delivered documentation must resolve.
  const packageRoot = join(nodeModules, 'recstead');
  for (const file of packed.files.filter(file => file.path.endsWith('.md'))) {
    const text = await readFile(join(packageRoot, file.path), 'utf8');
    for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1];
      if (!target || /^(?:[a-z]+:|#)/i.test(target)) continue;
      const path = resolve(packageRoot, file.path, '..', target.split('#')[0]);
      await readFile(path);
    }
  }
  const reactEntry = await readFile(join(nodeModules, 'recstead/dist/react.js'), 'utf8');
  assert(/^['"]use client['"];/.test(reactEntry), 'React entry must retain use client directive');
  for (const name of ['index.js.map','react.js.map']) {
    /** @type {{ sources: string[] }} */
    const map = JSON.parse(await readFile(join(nodeModules,'recstead/dist',name),'utf8'));
    assert(map.sources.every(source => !source.startsWith('/') && !source.includes('.private')), 'Source maps must use public relative source paths');
  }
  const tarballSha256 = createHash('sha256').update(await readFile(resolve('.artifacts', packed.filename))).digest('hex');
  await writeFile('.artifacts/package-check.json', JSON.stringify({ version: packed.version, filename: packed.filename, integrity: packed.integrity, tarballSha256, files: packed.files.map(file=>file.path), coreWithoutReact: true, browserGlobalsForbiddenOnImportAndConstruction: true, typesAndExampleSources: true, installedTarballExampleBuilds: ['vanilla','react','synthetic'], reactClientDirective: true }, null, 2)+'\n');
  console.log(`Packed ${packed.filename}: ${packed.files.length} allowed files; isolated core, types, and sample apps passed.`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
