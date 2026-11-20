import { execFileSync } from 'node:child_process';

// Type-check the library, the tooling and the examples with TypeScript 7.
// node_modules/.bin/tsc is not used: two TypeScript versions are installed, and
// the typescript package (6) is there only for typescript-eslint's JavaScript API.
for (const project of ['tsconfig.json', 'tsconfig.tools.json', 'tsconfig.examples.json']) {
  execFileSync(process.execPath, ['node_modules/typescript-7/bin/tsc', '-p', project, '--noEmit'], { stdio: 'inherit' });
}
