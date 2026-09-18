import { rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
await rm('dist', { recursive: true, force: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '--emitDeclarationOnly'], { stdio: 'inherit' });
await build({ entryPoints: ['src/index.ts', 'src/react.ts'], outdir: 'dist', bundle: true, format: 'esm', platform: 'browser', target: 'es2022', external: ['react'], sourcemap: true, sourcesContent: true, logLevel: 'info' });
