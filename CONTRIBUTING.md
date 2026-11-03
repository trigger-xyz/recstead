# Contributing

Recstead is an experimental browser microphone recorder. Contributions should preserve cancellation, final-data delivery and ownership of acquired resources.

## Work locally

Use Node.js 24 or newer, or Node.js 22.13 or newer within the 22.x line, and the committed lockfile:

```sh
npm ci
npm run check
npm run demo
```

The demo command prints the address to open. Test recording with non-sensitive media. The message example sends media to its local endpoint; the note example saves it in browser storage only after Save.

For changes to examples, recording lifetimes, uploads or storage, also run:

```sh
npx playwright install chromium
npm run test:browser
```

This installs the candidate tarball in a temporary consumer and exercises its actual browser workflows. `npm run test:browser:published` checks the same examples against the pinned `0.1.0-alpha.0` baseline. Browser reports and synthetic-media traces stay under ignored `.artifacts/`. Do not collect traces from personal recordings.

`npm run check:all` combines the repository and candidate browser checks. Release preparation and the publish lifecycle require this full check, so install Chromium before running either.

`npm run lint` includes promise handling checks for the examples and browser tests. `npm run typecheck` checks library, tooling, examples and new workflow tests. The development-only minimatch override pins 11.0.1 for GHSA-g3hv-75wg-m249; remove it when the lint dependencies adopt a patched compatible range. Its changed API has been checked against the current lint/typecheck consumers.

## Make a change

Read the [API contract](docs/api.md) and [architecture](docs/architecture.md) before changing command outcomes. For a bug, add a regression that demonstrates the failure before the fix. Cover the relevant delayed event or cleanup path, including tracks granted after cancellation when acquisition is involved.

Keep the core independent of React. Imports and controller construction must not request microphone access or create browser resources. Preserve the React entry's client directive and treat React as an external peer.

Update the public docs and changelog when behavior changes. Run `npm run check` against the resulting files. Changes affecting native capture, codecs or device cleanup also need the relevant [browser checks](docs/testing.md); report checks that could not be performed.

## Reviewable reports and patches

Explain the concrete failure, the changed behavior and the verification performed. Include a minimal reproduction where possible. Avoid unrelated dependency updates and generated build output in the same patch.

Use generated or explicitly consented test media. Do not commit credentials, personal recordings, private logs or application data. For a potentially sensitive vulnerability, use the repository's private reporting channel if one is available. Avoid placing the sensitive reproduction in a public issue.

## License

By submitting a contribution, you agree that it can be distributed under the repository's [MIT license](LICENSE). Preserve license notices for any material you introduce.
