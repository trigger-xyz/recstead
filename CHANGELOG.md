# Changelog

## 1.0.0-beta.0

First candidate for the 1.0 API. The recorder commands, options, statuses and error codes are unchanged from `0.1.0-alpha.1`.

Core:

- A repeated native `start` event is ignored. Before, it restarted the session clock, extended the duration limit and turned a paused session back to `recording`.
- The option types accept an explicit `undefined`, which keeps the default as the reference says. `{ maxBytes: maybeLimit }` now compiles under `exactOptionalPropertyTypes`.

Package:

- The React entry now imports the core entry instead of bundling its own copy. `recstead/react` shrinks from 38 kB to 6 kB, and an application that uses both entries loads the core once.
- The export map uses the `default` condition, so `require('recstead')` works on Node.js 22.12 and newer.
- The declarations are built with TypeScript 7.0.2 and checked with TypeScript 5.0.4 and 7.0.2.

Examples:

- Voice notes are stored in IndexedDB as bytes with their MIME type. WebKit rejects Blob values there in private and other ephemeral sessions, which made every save fail. Notes saved by the alphas remain readable.

Checks:

- The application workflows run in Chromium, Firefox and WebKit against the installed tarball, each encoding with its own MediaRecorder: WebM/Opus, Ogg/Opus and MP4/AAC.
- A seeded lifecycle model test runs random command, permission, native-event and timer sequences. After every step it checks tracks, listeners, timers, command outcomes, the recorded bytes, active time, warnings and session identifiers.
- Repeated-session checks count live tracks, active recorders and object URLs in each engine.
- New consumers: a type-only project and a Next.js 16 production application covering server render, hydration, recording and route-change cleanup.
- A snapshot test guards the public exports, the declarations and the package entry points.
- Hosted CI runs the Node.js checks on Linux with Node.js 22, 24 and 26 and on macOS and Windows with Node.js 24, and the browser workflows on Linux and macOS.
- Release preparation requires a passing native-recording result for all three engines, bound to the tarball hash.
- Development uses React 19.3.1, TypeScript 7.0.2, Playwright 1.65.1 and jsdom 31. The React peer range is unchanged, and CI still tests React 18.3.1 and 19.0.0.

Documentation:

- New [integration guide](docs/integration.md).
- [Testing and limits](docs/testing.md) now lists the tested engine versions and what is not verified: physical microphones, permission UI, branded browsers and mobile devices.

## 0.1.0-alpha.1

- Replace the recorder control demos with a React voice-message app and a TypeScript voice-note workspace.
- Add a bounded local HTTP message endpoint with idempotent retry, explicit uncertain acceptance, and failure scenarios.
- Support seeking in sent-message playback with HTTP byte ranges, and keep long note titles within the workspace header.
- Save complete notes in IndexedDB with atomic capacity checks, retryable failures, downloads and deletion.
- Reconnect after unexpected IndexedDB closure, and let stalled conversation clears time out and retry without losing local recordings.
- Clear stale conversation errors when reloading, while reporting any new load failure.
- Add installed-package Chromium workflow tests, HTTP/IndexedDB regressions, strict example/test typing and lint checks.
- Add a Chromium workflow job to CI and retain testing of the published alpha baseline.
- Update development tooling and pin patched minimatch for the lint dependency tree. The recorder API is unchanged.

## 0.1.0-alpha.0

This is an experimental API and does not carry a qualified browser-support guarantee.

- Add a TypeScript microphone controller with explicit start, stop, pause, resume, cancel, reset and disposal commands.
- Release streams granted after a session has been cancelled.
- Assemble native final data before returning complete output, with bounded retained payload and explicit partial failures.
- Provide a React-free ESM core and separate React hooks for recording state and playback URLs.
- Include TypeScript and React sample apps, a native encoder fixture, deterministic lifecycle tests and package-consumer checks.
- Validate bitrate bounds before acquisition and preserve typed failure codes for unexpected native error names.
- Attach React controllers and event observers before consuming layout effects while preserving sessions during Suspense hiding.
- Build on ordinary npm packing and include public documentation with the package.

Chrome/Chromium has a reported physical-microphone cleanup pass. Permission edge cases, Firefox, Safari and mobile qualification remain incomplete. See [testing](docs/testing.md).
