# Contributing

Recstead is a browser microphone recorder. Contributions should preserve cancellation, final-data delivery and ownership of acquired resources. Every release check is automated; a change is ready when the checks below pass.

## Work locally

Use Node.js 22.22.2 or newer in the 22.x line, 24.15 or newer in the 24.x line, or 26 and newer, and the committed lockfile:

```sh
npm ci
npm run check
npm run demo
```

The demo command prints the address to open. Test recording with non-sensitive media. The message example sends media to its local endpoint; the note example saves it in browser storage only after Save.

For changes to examples, recording lifetimes, uploads or storage, also run:

```sh
npx playwright install chromium firefox webkit
npm run test:browser
npm run check:consumers
```

`test:browser` installs the candidate tarball in a temporary consumer and runs the application workflows in every engine that launches on your machine. An engine that cannot launch is reported as unavailable, not as passing. `npm run test:browser:container` runs the three Linux engines in Playwright's container image and needs Docker. `check:consumers` compiles a type-only project with the oldest and newest supported TypeScript and exercises a Next.js production build.

`npm run test:browser:published` checks the same examples against the pinned `0.1.0-alpha.1` package. Browser reports and generated-audio traces stay under ignored `.artifacts/`. Do not collect traces from personal recordings.

`npm run check:all` combines the repository, browser and consumer checks. Publishing runs it first, so install the browser engines before you publish. `npm run release:prepare` also requires a passing native-recording result for Chromium, Firefox and WebKit, each for the exact tarball being released.

`npm run lint` includes promise handling checks for the examples and browser tests. `npm run typecheck` checks library, tooling, examples and workflow tests. TypeScript 7 builds the declarations and runs the type checks; it is installed under the name `typescript-7`. The `typescript` package stays at 6 because typescript-eslint needs its JavaScript API, which TypeScript 7 does not have. Remove it when typescript-eslint works with TypeScript 7 alone.

npm blocks dependency install scripts by default. The `allowScripts` field records that the esbuild and fsevents scripts stay off; both packages work without them.

## Make a change

Read the [API contract](docs/api.md) and [architecture](docs/architecture.md) before changing command outcomes. For a bug, add a regression that demonstrates the failure before the fix. Cover the relevant delayed event or cleanup path, including tracks granted after cancellation when acquisition is involved.

The public exports and declarations are recorded in `tests/snapshots/api.txt`. A change to them fails `npm test`. If the change is deliberate, run `RECSTEAD_UPDATE_API=1 npm test`, commit the new snapshot and describe the change in the changelog. Incompatible changes need a new major version after 1.0.0.

Keep the core independent of React. Imports and controller construction must not request microphone access or create browser resources. Preserve the React entry's client directive and treat React as an external peer.

Update the public docs and changelog when behavior changes. Run `npm run check` against the resulting files. Changes affecting native capture, codecs or cleanup also need the [browser checks](docs/testing.md) in every engine.

## Reviewable reports and patches

Explain the concrete failure, the changed behavior and the verification performed. Include a minimal reproduction where possible. Avoid unrelated dependency updates and generated build output in the same patch.

Use generated or explicitly consented test media. Do not commit credentials, personal recordings, private logs or application data. For a potentially sensitive vulnerability, use the repository's private reporting channel if one is available. Avoid placing the sensitive reproduction in a public issue.

## License

By submitting a contribution, you agree that it can be distributed under the repository's [MIT license](LICENSE). Preserve license notices for any material you introduce.
