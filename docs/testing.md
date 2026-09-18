# Testing and limitations

`0.1.0-alpha.0` is experimental. The results below describe specific checks; they do not establish broad browser or device support.

## Observed alpha results

The local Node.js 25.9.0 run passed 58 tests: 44 core tests, 11 React adapter tests and three release-tooling tests. The core tests include 100 successive controller sessions. All 11 React tests also passed with React 19.0.0 and 19.3.0 in isolated consumers; the primary run used React 18.3.1.

On 2026-09-18, the generated-audio sample passed both final-only and multiple-chunk recording in embedded Chromium 153 on macOS. The final-only WebM/Opus output had one chunk and decoded to 0.42 seconds. The pause/resume case had three chunks and decoded to 1.8 seconds, with the expected 440 Hz and 880 Hz tones in order. Both cases retained every native data byte, returned output after the native stop event and ended their generated tracks. These checks substituted a synthetic stream at acquisition and did not request microphone access.

A manual tester reported that the sample apps released the browser's capture indicator after Stop, Discard and React unmount with a real microphone in Chrome or Chromium. The exact browser build, operating system and device were not recorded. Unanswered permission, late grant, denied permission and device-disconnection checks remain unconfirmed on physical hardware. Firefox, Safari and mobile browsers remain unqualified.

The packed artifact contained 21 allowed files, including public documentation. An isolated core consumer worked without React or browser globals, TypeScript checked the example sources, and all three sample apps built against the installed tarball. The React entry retained its client directive. Ordinary `npm pack` also built and produced a working package from a clean public copy with no initial build output.

The CI matrix is configured for Node.js 22/24 and React 18.3.1/19.0.0/19.3.0. Hosted CI and Windows execution have not run yet.

## Repository checks

Use Node.js 22.12 or newer:

```sh
npm ci
npm run check
```

The combined check type-checks the library and development scripts, builds the package, runs its tests, checks Git-visible files for private material and verifies the packed artifact. The individual test names describe the event sequences they cover. Inspect the current output before relying on a previous pass.

Deterministic tests exercise delayed acquisition, command cancellation, native event ordering and resource ownership using controllable browser substitutes. React tests exercise hook lifetime, layout-effect actions, Suspense and cleanup. Tooling tests exercise Git-index privacy checks and artifact hash verification. Package checks operate on the artifact a consumer would install, rather than treating source imports as package validation.

These checks do not interact with a physical microphone, dismiss a permission prompt or observe an operating-system capture indicator. They cannot qualify a native codec. Existing research experiments against another recorder do not count as Recstead validation.

## Try the demo

```sh
npm run demo
```

Open the address printed by the command in a browser with microphone recording support. Use a secure context and a non-sensitive spoken sample or generated tone. Do not include personal recordings in bug reports.

## Physical microphone checks

Record the package version, browser version, operating system, device and outcome when running these checks:

1. Start with permission unanswered. Press Discard. Grant permission afterward. The cancelled session must not start recording and its late microphone stream must end.
2. Deny permission. Confirm that the UI reports the error and a later deliberate retry can succeed after the permission setting changes.
3. Record a short sample, pause, resume and stop. Play the returned complete output and confirm that the final part is present.
4. Discard during recording. Confirm that no completed recording is offered and the browser or operating-system capture indicator clears.
5. Unmount the recording component while acquiring and while recording. Confirm that capture ends and a late permission grant does not revive it.
6. Repeat recording and stopping with the same controller. Confirm that previous playback is not confused with a new result and the microphone indicator clears after each session.
7. Disconnect the input device where practical. Confirm that the application handles failure and does not label partial output as complete.

Permission UI can outlive logical cancellation. Capture indicators can reflect other tabs or applications; check the target tab's tracks as well as the visible indicator.

## Native encoder checks

Synthetic browser recording can verify that a native encoder accepts the stream and the completed output decodes. It should record the browser build, actual MIME metadata, bytes, event order and decoded duration. Test final-only output as well as several chunks. A container header alone does not establish that output is playable.

Keep such a result separate from physical microphone and permission checks. A Chromium result does not qualify Firefox or Safari. Automated WebKit does not qualify macOS Safari, and desktop results do not qualify mobile interruptions.

## Known limits

- Browser permission prompts have no standard cancellation API. Recstead cancels its own session and releases a later grant.
- Timers and data events may be delayed when a page is hidden, suspended or under load.
- The byte cap covers retained payload, not total browser memory. Large native chunks can still be allocated before Recstead sees them.
- Observed active time differs from decoded audio duration.
- MIME support reports do not prove that a particular backend accepts the encoded output.
- A partial recording may be unplayable.
- Mobile backgrounding, screen lock, interruptions and device changes have no qualified support claim.

## Report a problem

Supply a minimal reproduction, exact package/browser/OS versions, the command sequence, expected result, observed state or error code, and whether the issue also occurs using native browser APIs. Use synthetic data. Remove account identifiers, tokens, native error causes containing private data and personal media before sharing logs.
