import { rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
await rm('dist', { recursive: true, force: true });
// TypeScript 7 compiles. The typescript package stays at 6 only because typescript-eslint needs its JavaScript API.
execFileSync(process.execPath, ['node_modules/typescript-7/bin/tsc', '--emitDeclarationOnly'], { stdio: 'inherit' });
/** @type {import('esbuild').BuildOptions} */
const shared = { outdir: 'dist', bundle: true, format: 'esm', platform: 'browser', target: 'es2022', sourcemap: true, sourcesContent: true, logLevel: 'info' };
await build({ ...shared, entryPoints: ['src/index.ts'] });
// The React entry imports the built core instead of bundling a second copy of it.
await build({ ...shared, entryPoints: ['src/react.ts'], external: ['react'], plugins: [{ name: 'shared-core', setup(bundle) {
  bundle.onResolve({ filter: /^\.\/core\/index\.js$/ }, () => ({ path: './index.js', external: true }));
} }] });
