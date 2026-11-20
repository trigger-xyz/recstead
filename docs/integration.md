# Integration guide

This guide covers the decisions an application makes around Recstead: who owns the recording, what to do with the Blob, and how to recover from failure. Every pattern here is taken from the two [example applications](https://github.com/trigger-xyz/recstead/tree/main/examples), which run in the [automated browser checks](testing.md).

## Decide who owns the recorder

Recstead owns the microphone request, the native recorder and the tracks it acquired. Your application owns everything after the result: playback, uploads and storage.

Choose the owner of the controller by how long a recording should live.

| The recording should end when | Use |
| --- | --- |
| The component unmounts | `useRecorder()` in that component |
| The user leaves a section, but not when one view inside it unmounts | `createRecorder()` above the views, and `useRecorderSession(recorder)` inside them |
| The page goes away | `createRecorder()` at module or application scope |

The voice-message composer uses `useRecorder`. Closing the composer or switching conversation unmounts it, which disposes the controller and discards the recording. The voice-note workspace creates one controller for the page, so recording continues while the user moves between the note list and a note.

If you create the controller yourself, dispose it yourself. Both examples also dispose when the page is hidden, so capture never continues in a page the user has left. A disposed controller cannot be reused, so they reload if the browser later restores that page from its back/forward cache:

```ts
const recorder = createRecorder({ maxActiveMs: 120_000 });

window.addEventListener('pagehide', () => { void recorder.dispose(); }, { once: true });
window.addEventListener('pageshow', event => { if (event.persisted) window.location.reload(); });
```

## Start from a user action

Call `start()` from a click or key handler, so the permission prompt appears in response to something the user did.

```ts
recordButton.onclick = () => {
  recorder.start().catch(error => {
    if (isRecorderFailure(error) && error.code === 'CANCELLED') return;
    showError(error instanceof Error ? error.message : 'Recording failed.');
  });
};
```

Every command returns a promise that can reject. A command that the user overtook rejects `CANCELLED`, which is not an error to display.

While the permission request is unanswered, `permissionPending` is true. The user may still discard: Recstead cancels the session and releases the stream if the browser grants it later.

The browser's request stays open after a discard. `permissionPending` stays true until the browser settles it, and a new `start()` in that interval rejects `ACQUISITION_PENDING`. Disable the record control while `permissionPending` is true.

## Take the result once

`stop()` resolves after the browser has delivered the final audio data. Its result is complete, or `stop()` rejects.

```ts
const result = await recorder.stop();
if (result) {
  outbox.enqueue(result.blob, result.mimeType);
  await recorder.reset();
}
```

Hand the Blob to the part of your application that will keep it, then call `reset()`. After that, the Blob belongs to your code. A later `cancel()`, `reset()` or `dispose()` does not invalidate a Blob you already hold.

`stop()` resolves `null` when no recording started, for example when the user stops during the permission request.

## Refuse partial output

When recording fails after some audio arrived, the failure carries a partial result:

```ts
try {
  await recorder.stop();
} catch (error) {
  if (isRecorderFailure(error) && error.partial) {
    offerDownload(error.partial.blob); // May not decode.
  }
}
```

The same result is in the snapshot with `completion: 'partial'`. Both examples disable Send and Save unless `result.completion === 'complete'`. A partial recording may be truncated or unplayable, so never store or send it as a normal one.

## Use the recorded format, whatever it is

Each engine chooses its own container and codec. In the tested engines:

| Engine | `result.mimeType` |
| --- | --- |
| Chromium | `audio/webm;codecs=opus` |
| Firefox | `audio/ogg; codecs=opus` |
| WebKit | `audio/mp4; codecs=mp4a.40.2` |

Send `result.mimeType` as the `Content-Type`, and store it next to the bytes. Derive file extensions from it. Do not assume WebM, and do not relabel a Blob: changing the label does not convert the audio.

If your server accepts one format only, request it and handle the refusal:

```ts
const recorder = createRecorder({
  mime: { candidates: ['audio/webm;codecs=opus'], fallback: 'error' },
});
// start() rejects UNSUPPORTED_FORMAT where the engine cannot record WebM.
```

## Upload with a stable identifier

Recstead never uploads. The message example keeps uploads in an application-owned outbox, so a request outlives the composer that produced the recording.

- Create the message identifier once, when the recording is queued. Send it with every attempt.
- Make the server treat a repeated identifier with identical bytes as the same message.
- Keep three outcomes apart: accepted, rejected and unknown. A timeout or an aborted request is unknown, because the server may have stored the message.
- Retry an unknown or rejected message with the same identifier and the same Blob. Retrying never needs the microphone again.
- Drop your reference to the Blob after the server confirms the message.

Cancelling a recorder cannot cancel an upload you already started. Abort the request yourself.

## Store bytes, not Blobs, in IndexedDB

WebKit rejects Blob values in IndexedDB for private and other ephemeral sessions. The write fails with `UnknownError: Error preparing Blob/File data to be stored in object store`. ArrayBuffer values work in every tested engine. Unlike a stored Blob, the bytes are loaded into memory whenever their record is read, so limit the size of what you store.

Read the bytes before opening the transaction. A transaction closes while you await anything other than its own requests.

```ts
const bytes = await result.blob.arrayBuffer();
const transaction = database.transaction('notes', 'readwrite');
transaction.objectStore('notes').put({ id, title, bytes, mimeType: result.mimeType });
```

Rebuild the Blob when reading:

```ts
const blob = new Blob([note.bytes], { type: note.mimeType });
```

Keep the draft until the transaction completes. If the save fails, the user still has the recording and can retry or download it. Use a stable draft identifier so a retry cannot create a second note.

## Own your playback URLs

`useRecordingUrl(result)` creates an object URL and revokes it when the result changes or the component unmounts. Without React, pair every `URL.createObjectURL` with a `URL.revokeObjectURL` when you replace or remove the player.

Recstead never revokes a URL your application created.

## Routes and server rendering

The core can be imported on a server. It reads browser APIs only inside `start()`. `getCapabilities()` reports `environment: 'server'` there.

The hooks belong in client components. `recstead/react` carries its own `'use client'` directive. During server rendering the hooks return the idle snapshot, so the markup hydrates without a mismatch.

A recording made with `useRecorder` ends when its component unmounts, including on a client-side route change. To keep a result across navigation, await `stop()` first and hold the Blob outside the component. To keep recording across navigation, own the controller above the router and use `useRecorderSession`.

## Handle failure by code

Check `isRecorderFailure(error)` and branch on `error.code`.

| Code | What happened | What to offer |
| --- | --- | --- |
| `PERMISSION_DENIED` | The user or a browser policy refused the microphone | Explain how to allow it, then let the user retry |
| `DEVICE_NOT_FOUND`, `DEVICE_UNAVAILABLE` | No microphone, or it could not be opened | Ask the user to check the device, then retry |
| `UNSUPPORTED_ENVIRONMENT`, `INSECURE_CONTEXT` | The page cannot record at all | Hide or disable recording |
| `UNSUPPORTED_FORMAT` | None of your requested formats is available | Fall back to another format or to the browser's choice |
| `SOURCE_ENDED`, `RECORDING_FAILED`, `FINALIZATION_TIMEOUT` | Capture stopped early | Discard the partial output or offer it for download |
| `BUFFER_LIMIT` | The recording reached `maxBytes` | Tell the user the limit and keep nothing as complete |
| `EMPTY_OUTPUT` | The browser produced no audio | Let the user record again |
| `CONSTRAINTS_UNSATISFIED` | The microphone cannot meet the requested constraints | Retry with looser constraints |
| `INITIALIZATION_TIMEOUT` | The browser did not start the recorder in time | Let the user record again |
| `ACQUISITION_PENDING` | A discarded permission request is still open | Ask the user to answer the browser prompt |

The remaining codes, such as `BUSY`, `INVALID_STATE` and `CANCELLED`, report a command that did not apply. The [API reference](api.md) lists them.

A failed controller is reusable. Call `start()` again after the user acts, or `reset()` to clear the error.

`getCapabilities()` lets you decide before the user tries:

```ts
const { mediaRecorder, microphone, secureContext } = getCapabilities();
const canRecord = mediaRecorder && microphone && secureContext !== false;
```

It reports which APIs exist. It does not report permission.

## Set limits deliberately

The defaults are 16 MiB of retained audio and 300,000 milliseconds of active recording. Set `maxBytes` to what your server or storage accepts and `maxActiveMs` to what your product allows. When the duration limit is reached, the recording stops by itself and completes normally with `reason: 'duration-limit'`. When the byte limit is reached, recording fails with `BUFFER_LIMIT`.
