# Testing and limits

Every check behind a Recstead release is automated. This page lists what those checks cover for `1.0.0-beta.0`, how to run them, and what they do not cover.

## Tested engines

The example applications run against the packed tarball, installed into a separate project with no source aliases. Each engine records through its own `MediaRecorder`, and the tests decode the output.

| Engine | Version | Host | Recorded format | Audio source |
| --- | --- | --- | --- | --- |
| Chromium | 159.0 | macOS, Linux | `audio/webm;codecs=opus` | Engine test device |
| Firefox | 159.0 | Linux | `audio/ogg; codecs=opus` | Engine test device |
| WebKit | 27.2 | macOS | `audio/mp4; codecs=mp4a.40.2` | Generated tone |

These are the browser builds shipped with Playwright 1.65.1. Chromium and Firefox generate their own microphone input. The WebKit build has no capture device, so the tests supply a Web Audio tone when the application asks for the microphone; WebKit's recorder still encodes it.

The WebKit build for Linux has no `MediaRecorder`. On Linux the WebKit run checks two things: both applications report `UNSUPPORTED_ENVIRONMENT` and never request capture, and their layouts fit a narrow viewport.

## What the checks cover

Browser workflows, in every engine above:

- Record, pause, resume and stop, then decode the result. Final-only output and output in several chunks.
- Send a voice message over HTTP, including a lost response, a rejected upload, a stopped request and a send still pending when its composer closes. Retries reuse the same bytes without another microphone request, and the server's copy matches the recording byte for byte.
- Save, reload, replay, download and delete voice notes in IndexedDB, including a failed save and unavailable storage. Stored notes and downloads match the recording byte for byte.
- Discard, close or navigate while the permission request is pending, then grant it. The late stream is released and nothing is recorded.
- A denied request, followed by a successful retry.
- A recorder error during capture. The partial output cannot be sent or saved as complete.
- Twelve consecutive sessions in each application, ending with no live track, no active recorder and no retained object URL.

Two checks run in fewer engines. Forcing IndexedDB closed needs the Chromium DevTools protocol, so that workflow runs in Chromium only. The generated-tone encoder page needs Web Audio, which headless Firefox cannot start on a host without an audio output device; Firefox's other workflows cover its encoder.

Core and hooks, in Node.js with controllable browser substitutes:

- Deterministic tests for delayed acquisition, cancellation, native event order, limits, timeouts and MIME evidence.
- A lifecycle model test. It runs 400 seeded random sequences of commands, permission outcomes, native events and timer advances. After every step it checks that only the active session holds a live track, listeners or timers, that every command settles with the right outcome, that an earlier session or a late permission answer cannot change the current state, that the output holds exactly the audio delivered, and that active time matches the clock. Hosted CI runs 5,000 more sequences with a new seed on every run.
- React tests for StrictMode, Suspense, layout effects and URL ownership, on React 18.3.1, 19.0.0 and 19.3.1.
- A snapshot of the public exports, declarations and package entry points, so an API change cannot happen by accident.

Package consumers, from the same tarball:

- A core-only project with no React and no browser globals, loaded with `import` and with `require()`.
- A type-only project compiled by TypeScript 5.0.4 and 7.0.2, with `Bundler` and `NodeNext` module resolution.
- A Next.js 16.4.6 application with React 19.3.1: production build, server render, hydration without errors, a recording through the hooks, and release of the microphone when the route changes.

Hosted CI runs the Node.js checks on Linux with Node.js 22, 24 and 26, and on macOS and Windows with Node.js 24. It runs the browser workflows on Linux in all three engines and on macOS in Chromium and WebKit.

## Not verified

No check uses a physical microphone, answers a real permission prompt or observes an operating-system capture indicator. Treat the following as untested:

- Hardware behavior: device disconnection, device switching, sample-rate changes and operating-system audio interruptions.
- Browser permission UI, including a prompt left unanswered. The tests delay and reject the request in script instead.
- Branded Chrome, Edge, Firefox on macOS or Windows, and Safari. The engines above are their automation builds.
- Mobile browsers: backgrounding, screen lock, calls and other interruptions.
- Whether a third-party service accepts a recorded container or codec.

Recstead fails with a typed error when the environment lacks the APIs it needs. It makes no promise beyond the engines in the table.

## Run the checks

Use Node.js 22.22.2 or newer in the 22.x line, 24.15 or newer in the 24.x line, or 26 and newer.

```sh
npm ci
npm run check
```

`check` lints, type-checks, builds, runs the Node.js tests, verifies that no private file is visible to Git and inspects the packed tarball.

```sh
npx playwright install chromium firefox webkit
npm run test:browser
npm run check:consumers
```

`test:browser` runs the workflows in every engine that can launch on your machine and reports the others as unavailable. Pass `-- --project=chromium` to choose engines. Set `RECSTEAD_REQUIRE_ENGINES=chromium,firefox,webkit` to fail when a listed engine cannot launch. `check:consumers` runs the TypeScript and Next.js fixtures. `npm run check:all` runs all three commands.

```sh
npm run test:browser:container
```

This runs the three Linux engines in Playwright's container image against the tarball already packed on your machine. It needs Docker. Use it when an engine does not launch natively.

`npm run test:browser:published` runs the same workflows against the published `0.1.0-alpha.1` package, pinned by version.

Reports, traces and screenshots are written to `.artifacts/`, which Git ignores. Each run records the engine versions, the outcome counts and the SHA-256 of the tarball it tested.

To explore other lifecycle sequences:

```sh
RECSTEAD_MODEL_SEED=7 RECSTEAD_MODEL_RUNS=20000 node --test tests/model.test.mjs
```

A failure prints its seed and the shortest sequence that still reproduces it.

## Known limits

- Browser permission prompts have no standard cancellation API. Recstead cancels its own session and releases a later grant.
- Timers and data events may be delayed when a page is hidden, suspended or under load.
- The byte cap covers retained payload, not total browser memory. Large native chunks can still be allocated before Recstead sees them.
- Observed active time differs from decoded audio duration.
- MIME support reports do not prove that a particular backend accepts the encoded output.
- A partial recording may be unplayable.

## Report a problem

Supply a minimal reproduction, exact package, browser and operating-system versions, the command sequence, the expected result, the observed state or error code, and whether the issue also occurs with the native browser APIs. Use generated audio. Remove account identifiers, tokens, native error causes containing private data and personal media before sharing logs.
