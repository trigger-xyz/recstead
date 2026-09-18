# Sample apps

From the repository root, run `npm ci`, then `npm run demo`. Open the local address printed by Vite.

- **Plain TypeScript** demonstrates the controller, command errors, subscriptions and playback URL cleanup.
- **React** runs under StrictMode and includes a mount/unmount control for testing the owned hook lifetime. Both recorder pages dispose their controllers when leaving the page, including when the browser caches the page for back navigation.
- **Synthetic encoder check** generates audio and decodes the returned recordings without requesting microphone access. It checks final-only output separately from multiple chunks with pause/resume, including native data/stop event order and resource cleanup.

The two recorder apps use your microphone only after you press Record. They do not upload audio. The dev server listens on loopback only. Vite resolves the public `recstead` and `recstead/react` imports to the built `dist/` files. Restart `npm run demo` after changing library source to rebuild it. `npm run check:package` separately installs the tarball and builds these apps against that installed package.

Use HTTPS or a loopback development address for microphone access. Test the permission prompt, cancel before accepting, normal stop, pause/resume, discard, and React unmount. Browser permission and hardware checks are manual; the generated-tone check does not replace them.
