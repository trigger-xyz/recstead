# API reference

These APIs describe `0.1.0-alpha.0`. Type declarations shipped with the packed artifact are the complete type reference. Alpha changes may be incompatible.

## Entry points

| Import | Exports |
| --- | --- |
| `recstead` | `createRecorder`, `getCapabilities`, `isRecorderFailure` and core types |
| `recstead/core` | The same core exports |
| `recstead/react` | `useRecorder`, `useRecorderSession`, `useRecordingUrl` and hook types |

The core has no React dependency. Importing it or creating a controller does not request permission or create browser resources. Recording requires a secure browser context with `getUserMedia` and `MediaRecorder`; server rendering cannot record audio.

## Create a controller

```ts
import { createRecorder } from 'recstead';

const recorder = createRecorder({
  source: { kind: 'microphone', constraints: { echoCancellation: true } },
  maxBytes: 16 * 1024 * 1024,
  maxActiveMs: 300_000,
});
```

| Option | Default | Meaning |
| --- | --- | --- |
| `source` | `{ kind: 'microphone' }` | Audio constraints for the microphone request. External streams are not accepted |
| `mime` | Browser choice | `{ candidates: readonly string[], fallback: 'browser' \| 'error' }` |
| `audioBitsPerSecond` | Browser choice | Requested bitrate, not a guaranteed output rate |
| `maxBytes` | `16 * 1024 * 1024` | Maximum retained Blob payload |
| `maxActiveMs` | `300_000` | Recording-time limit excluding observed pauses |
| `initializationTimeoutMs` | `10_000` | Deadline after acquisition for native initialization and pause/resume transitions |
| `finalizationTimeoutMs` | `10_000` | Deadline for native completion after stop or failure |

Limits must be positive safe integers. `audioBitsPerSecond` must also be no greater than 4,294,967,295, the native unsigned-long maximum. Timeouts must be between 1,000 and 120,000 milliseconds. These deadlines need the browser event loop to run; they are not guarantees during suspension.

Options passed to `start(options)` override controller defaults for that recording. Nested `source` and `mime` options replace the corresponding defaults. Explicit `undefined` keeps the default. Changing a caller-owned options object cannot reconfigure a recording already in progress.

To request a format:

```ts
const recorder = createRecorder({
  mime: {
    candidates: ['audio/webm;codecs=opus', 'audio/mp4'],
    fallback: 'browser',
  },
});
```

The first candidate reported as supported is selected. With `fallback: 'error'`, no supported candidate rejects with `UNSUPPORTED_FORMAT` before requesting the microphone. Browser support reports are advisory; actual initialization can still fail.

## Commands

| Method | Outcome |
| --- | --- |
| `start(options?)` | Resolves to `SessionInfo` after the native start event |
| `stop()` | Resolves to the completed result, or `null` when no recording started. Rejects on failure |
| `pause()` | Resolves after pausing. Already paused is a no-op unless another transition is pending |
| `resume()` | Resolves after resuming. Already recording is a no-op unless another transition is pending |
| `cancel()` | Discards output and releases owned resources without waiting for native final events |
| `reset()` | Clears terminal output and errors. Rejects while a recording is active |
| `dispose()` | Releases resources and permanently disables this controller. Repeated disposal is safe |

A no-argument `start()` while starting or recording shares the current session outcome. Supplying options during that session rejects `BUSY`. Starting while stopping or finalizing also rejects `BUSY`.

Repeated `stop()` calls share the outcome and the same result object. Do not depend on promise identity. Stop, cancel and disposal preempt pending pause/resume commands. A cancelled command rejects `CANCELLED`; catch command rejections in application code.

There is no permission timeout. An unanswered permission request can remain pending after logical cancellation. `permissionPending` stays true until the browser request settles. A new microphone start rejects `ACQUISITION_PENDING` during that interval. A late granted stream is released without constructing a recorder.

Cancel and disposal discard output, including any output still being finalized. Neither revokes object URLs created by your application. Commands after disposal reject `DISPOSED`, except repeated `dispose()`.

## Observe state

```ts
const unsubscribe = recorder.subscribe(() => {
  const snapshot = recorder.getSnapshot();
  renderRecordingState(snapshot);
});

const removeEventListener = recorder.onEvent(event => {
  if (event.type === 'result') {
    showReview(event.result);
  }
});

// Release these subscriptions when their consumer goes away.
unsubscribe();
removeEventListener();
```

`getSnapshot()` returns a cached immutable snapshot until state changes. It contains `status`, `sessionId`, `result`, `error`, `permissionPending`, `trackMuted` and timing information.

Statuses are `idle`, `acquiring`, `initializing`, `recording`, `paused`, `stopping`, `finalizing`, `ready`, `failed` and `disposed`. `stopping` is not yet a complete result. React may batch transient state updates.

Events report state changes, results, errors and warnings. Notifications are not emitted on every audio chunk or timer tick. Result and error events identify their recording session; a callback must not assume that a historical event is the latest snapshot.

## Results and failures

A successful result includes:

| Field | Meaning |
| --- | --- |
| `sessionId` | Controller-local recording identifier |
| `blob`, `bytes` | Assembled output and its size |
| `receivedBytes` | Bytes observed, including rejected overflow data |
| `mimeType`, `mimeSource` | Output MIME evidence from chunks, the recorder, or neither |
| `recorderMimeType` | Cached native recorder MIME type |
| `completion` | `complete` or `partial` |
| `reason` | Why the recording ended |
| `activeMs`, `wallMs` | Observed recording time and elapsed time including pauses |
| `warnings` | Bounded interruption and MIME observations |

Timing measures event observations, not decoded audio duration. Results retain actual MIME evidence. Empty metadata remains unknown; Recstead does not invent a format. Conflicting chunk formats reject `MIME_MISMATCH`.

A failure rejects `stop()` with a `RecorderFailure`. Use `isRecorderFailure(error)` before inspecting its `code`, `phase`, `sessionId` or optional `partial`. The same partial result appears in the snapshot for an application that wants to offer recovery. Partial output may not decode.

Common codes include `PERMISSION_DENIED`, `DEVICE_NOT_FOUND`, `DEVICE_UNAVAILABLE`, `UNSUPPORTED_ENVIRONMENT`, `INSECURE_CONTEXT`, `UNSUPPORTED_FORMAT`, `EMPTY_OUTPUT`, `BUFFER_LIMIT`, `INITIALIZATION_TIMEOUT` and `FINALIZATION_TIMEOUT`. Command errors include `BUSY`, `INVALID_STATE`, `INVALID_OPTIONS`, `CANCELLED`, `ACQUISITION_PENDING` and `DISPOSED`.

The first fatal failure remains the primary error. Later cleanup or finalization failures do not turn it into success or replace its cause. Native causes are retained locally; do not serialize them into telemetry without reviewing their contents.

The byte cap rejects an overflowing chunk in full and keeps only the preceding contiguous output. The final chunk has to fit too. This bounds library-retained payload, not native encoder memory or recordings held by the application. Zero-byte output fails with `EMPTY_OUTPUT`.

## React hooks

```ts
const view = useRecorder(options, { onEvent });
const sharedView = useRecorderSession(existingController, { onEvent });
const url = useRecordingUrl(view.result);
```

Both recorder hooks return the snapshot plus stable `start`, `stop`, `pause`, `resume`, `cancel` and `reset` actions.

`useRecorder` owns a controller for the mounted component. It creates a fresh controller when React StrictMode replays effect setup and cleanup. Cleanup disposes that generation. Retained actions invoked after unmount reject `NOT_READY`. The latest committed options apply to the next recording; they do not change a running session.

`useRecorderSession` observes a controller supplied by the application. Unmounting only detaches the hook; it does not stop or dispose the controller. The application owns that controller's lifetime. This hook does not add support for externally supplied media streams.

`useRecordingUrl(result)` creates an object URL in an effect. It returns `null` before setup and when no result exists. Replacement and unmount revoke only URLs created by that hook. Keep the result itself if it must survive component cleanup.

The React entry preserves its `'use client'` directive. In frameworks with server components, use these hooks inside a client component. Do not pass live controllers or media streams across a server boundary.

## Capabilities

`getCapabilities(mimeTypes?)` reports whether the environment is a browser or server, secure-context availability, microphone and recorder APIs, and native support results for requested MIME types. This is a snapshot of capability reports, not permission approval or proof that recording will succeed.
