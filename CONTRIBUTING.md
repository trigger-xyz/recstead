# Contributing

Recstead is an experimental browser microphone recorder. Contributions should preserve cancellation, final-data delivery and ownership of acquired resources.

## Work locally

Use Node.js 22.12 or newer and the committed lockfile:

```sh
npm ci
npm run check
npm run demo
```

The demo command prints the address to open. Test recording with non-sensitive media.

## Make a change

Read the [API contract](docs/api.md) and [architecture](docs/architecture.md) before changing command outcomes. For a bug, add a regression that demonstrates the failure before the fix. Cover the relevant delayed event or cleanup path, including tracks granted after cancellation when acquisition is involved.

Keep the core independent of React. Imports and controller construction must not request microphone access or create browser resources. Preserve the React entry's client directive and treat React as an external peer.

Update the public docs and changelog when behavior changes. Run `npm run check` against the resulting files. Changes affecting native capture, codecs or device cleanup also need the relevant [browser checks](docs/testing.md); report checks that could not be performed.

## Reviewable reports and patches

Explain the concrete failure, the changed behavior and the verification performed. Include a minimal reproduction where possible. Avoid unrelated dependency updates and generated build output in the same patch.

Use generated or explicitly consented test media. Do not commit credentials, personal recordings, private logs or application data. For a potentially sensitive vulnerability, use the repository's private reporting channel if one is available. Avoid placing the sensitive reproduction in a public issue.

## License

By submitting a contribution, you agree that it can be distributed under the repository's [MIT license](LICENSE). Preserve license notices for any material you introduce.
