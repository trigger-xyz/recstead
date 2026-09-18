# Architecture

Recstead separates a browser recording controller from its React adapter. A controller owns one recording at a time. Each recording gets a session identifier so delayed work from an earlier recording cannot change the current one.

## Controller and native events

Commands express application intent. Native `MediaRecorder` events confirm what the browser has done. Recstead keeps these separate because `stop()` can return before the browser delivers the final audio data.

```text
idle -> acquiring -> initializing -> recording <-> paused
                                      |            |
                                      +--- stop ---+
                                              |
                                         finalizing
                                          /      \
                                       ready    failed
```

Cancellation returns to idle and discards output. Disposal is terminal. A stop during acquisition cancels that attempt and returns no recording.

Acquisition has its own pending-request guard. Browser microphone requests cannot be aborted through a standard signal. Cancelling invalidates the session immediately, then a continuation releases any stream granted later. Until that request settles, the controller rejects another acquisition attempt.

Native recorder listeners are attached before starting capture. Stop retains the data and completion listeners until finalization succeeds or reaches its deadline. Output is complete only after the final data is collected and the native stop event arrives.

## Ownership

| Resource | Owner and release |
| --- | --- |
| Acquired stream and tracks | Controller. Released after completion, startup failure, cancellation or disposal |
| Recorder listeners and timers | Session. Removed when the session ends |
| Chunk references | Session until assembly or cancellation |
| Result retained by the controller | Cleared on a new recording, cancel, reset or disposal |
| Result retained by application code | Application |
| URL created by `useRecordingUrl` | Hook. Revoked on replacement or unmount |
| URL created directly by application code | Application |
| Upload request | Application |

The library never performs an upload. Cancelling a recorder cannot cancel a request that the application already started.

## Output and errors

The chunk collector preserves arrival order and rejects an entire chunk when admitting it would exceed the byte limit. Failure output is a contiguous prefix marked partial. Native errors, empty output and finalization timeouts cannot silently become complete results.

The first fatal failure remains primary. Later observations can supply context but do not replace that cause. Native MIME evidence determines the Blob label; changing a label cannot convert audio. The package provides no encoder or transcoder.

Snapshots are immutable and cached. State transitions trigger subscription updates; audio chunks and elapsed-time ticks do not cause repeated React updates. Observer callbacks run after the controller has established its internal state and resource invariants.

## React lifetime

The owned hook binds stable actions to the currently mounted controller. Effect cleanup detaches and disposes that generation. StrictMode effect replay creates a fresh controller, so the replay cannot reuse a terminally disposed instance. A stale action cannot start capture after unmount.

The subscription hook leaves controller ownership with the application. This lets an application keep a controller above a route while a view mounts or unmounts. It does not allow borrowed media tracks.

Core imports have no browser side effects and do not import React. Browser APIs are read when an operation needs them. The React entry has its own client directive and external React peer dependency.

## Boundaries

The candidate handles foreground microphone recordings. Screen and camera capture, externally supplied streams, live uploads, persistent chunk storage, recovery after page loss, transcoding and device switching during capture are outside this implementation.

Browser suspension can delay events and timers. Payload limits do not establish a process-memory ceiling. A native API support result does not establish permission, hardware availability, codec interoperability or tested browser support. See [testing](testing.md) for those distinctions.
