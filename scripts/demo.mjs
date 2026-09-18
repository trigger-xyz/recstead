import { runNpm } from './lib/npm.mjs';
import { createServer } from 'vite';
runNpm(['run', 'build'], { stdio: 'inherit' });
const server = await createServer({ configFile: 'examples/vite.config.mjs' });
await server.listen();
server.printUrls();
