# Example applications

Use Node.js 24 or newer for development, or Node.js 22.13 or newer within the 22.x line. From the repository root:

```sh
npm ci
npm run demo
```

Open the loopback address printed by Vite. Microphone access begins only after Record. Use non-sensitive audio when testing.

## Voice messages, React

Open `/react/`. Record, pause/resume, stop, preview and send a voice message into either local conversation. The composer uses `useRecorder`; closing it or switching conversations discards its recording. Streams granted after cancellation are released.

Send transfers the completed Blob to an application-owned outbox. The app performs an HTTP PUT to the local example server. Pending requests and accepted messages can outlive the composer. Stop waiting aborts the client request; it cannot undo an upload already accepted by the server. If acceptance is unknown, Retry send uses the same identifier and bytes, without opening the microphone again.

The local endpoint accepts audio/webm, audio/ogg, audio/mp4, audio/wav and audio/mpeg MIME types. It checks size and metadata, not the encoded codec. Playback and the native encoder checks separately verify decoding. There is no conversion or delivery to another person.

The Test scenarios panel can reject a send, delay it, or accept it and drop the response. The last case also drops automatic browser retries with that scenario; the explicit Retry send action returns to normal behavior. Accepted and unsent messages have separate playback ownership.

Clear conversations cancels outstanding sends and retains local recordings until the server confirms the clear. A stalled clear times out and restores the controls so you can retry. The server may already have cleared its collection even if no response arrived. Leaving the page cancels the request.

Server limits are 30 messages, 64 MiB retained audio, 16 MiB per recording and two concurrent buffered uploads. Capacity failures leave the draft in the outbox. Duplicate identifiers are accepted only for identical bytes, MIME and conversation. Deduplication lasts while the message remains in this server's memory. Restarting the server or Clear conversations resets that collection. Reloading the page restores accepted messages; unsent local drafts are not persisted. Removing an uncertain item from the view does not delete it from the server.

## Voice notes, plain TypeScript

Open `/vanilla/`. Record, review, name and save a note. Saved notes use IndexedDB in the browser, and can be replayed, downloaded or deleted after a reload. Nothing is uploaded from this app. Browser storage is not a backup; it may be cleared by the browser or user.

A workspace-owned controller survives switching between the note list and detail views. Its recording controls remain visible. Leaving the page ends capture; unfinished recordings and unsaved drafts do not survive a reload. Only explicit Save stores a complete recording.

The collection allows 30 notes and 64 MiB of saved audio. Count/byte checks and the write share one IndexedDB transaction, including across tabs. Fail the next save aborts that transaction. The complete draft remains available for retry or download. A stable draft identifier prevents duplicate notes on retry. Partial recordings cannot be saved as complete notes, though their bytes can be downloaded with a partial filename.

If the browser unexpectedly closes IndexedDB, the next storage operation opens a new connection. Failed saves keep the draft available for an explicit retry. Reconnecting cannot restore notes removed by clearing browser storage.

Delete and Clear all saved notes remove stored Blobs. Clear does not discard the current draft. Playback URLs are created for the visible draft/detail and revoked on replacement, deletion and teardown. Recorder reset never deletes a saved note.

## Ownership and keyboard use

| Resource | Owner |
| --- | --- |
| Microphone acquisition, native recorder, tracks, capture state | Recstead controller or owned React hook |
| Final Blob after Send/Save | Application outbox or note store |
| HTTP request, retry identifier, uncertain acceptance | Message app |
| IndexedDB transaction, collection capacity, saved-note lifetime | Note app |
| Preview/playback URLs | The view or URL hook that created them |

Use Tab to move between controls and Enter or Space to activate buttons. Opening a composer focuses Record; closing it returns focus to New voice message. Stopping a note focuses its title, and saving focuses the saved note heading. All operations also have visible controls. Test scenarios are separate from the normal recording workflow.

## Package and workflow checks

```sh
npm run check
npx playwright install chromium
npm run test:browser
npm run test:browser:published
```

`check` runs lint, strict type checks, deterministic tests, HTTP/IndexedDB tests, privacy checks and installed-tarball builds. `test:browser` builds a candidate tarball, installs it into a temporary consumer and runs the full Chromium app suite against that package with no source aliases. `test:browser:published` runs the same suite against the pinned published baseline, `recstead@0.1.0-alpha.0`. It deliberately does not follow a mutable npm tag. `check:all` combines the local checks and candidate browser suite.

The browser suite uses Chromium's generated microphone input and native MediaRecorder, verifies decoded playback, exercises actual local HTTP and IndexedDB operations, and checks owned-track and URL cleanup. Permission denial/delay and recorder error cases are injected by tests. These are not physical-microphone, Safari or mobile qualification. Reports, traces and screenshots stay in ignored `.artifacts/`. Native device checks remain a separate [testing protocol](../docs/testing.md).

The `/synthetic/` page remains available for generated-tone checks of final-only and multiple-chunk output, pause/resume, native event order, byte retention and decoding.

## Local server and builds

`npm run demo` rebuilds the library, starts Vite on loopback and adds the local message endpoint. During development, public package imports resolve to built `dist/` entries. Restart the command after library edits. The browser suite independently verifies installed-package resolution.

`npm run build:examples` produces static assets under `.artifacts/examples`. A static file host alone cannot serve the message API. To inspect the production build locally, run `npx vite preview --config examples/vite.config.mjs --host 127.0.0.1`; the preview plugin supplies the same in-memory endpoint. These examples are intended for local use and have no authentication or hosted storage. The server rejects cross-origin API requests and does not log media bodies.
