# Changelog

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
