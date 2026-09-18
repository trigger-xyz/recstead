import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  root,
  resolve: { alias: [
    { find: 'recstead/react', replacement: fileURLToPath(new URL('../dist/react.js', import.meta.url)) },
    { find: 'recstead/core', replacement: fileURLToPath(new URL('../dist/index.js', import.meta.url)) },
    { find: 'recstead', replacement: fileURLToPath(new URL('../dist/index.js', import.meta.url)) }
  ] },
  server: { host: '127.0.0.1', port: 4173, strictPort: true, fs: { strict: true, allow: [root, fileURLToPath(new URL('../dist', import.meta.url)), fileURLToPath(new URL('../node_modules', import.meta.url))] } },
  build: { outDir: '../.artifacts/examples', emptyOutDir: true, rolldownOptions: { input: { index: `${root}index.html`, vanilla: `${root}vanilla/index.html`, react: `${root}react/index.html`, synthetic: `${root}synthetic/index.html` } } }
});
