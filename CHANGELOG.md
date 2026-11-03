# Changelog

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
