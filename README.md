# Recstead

Browser microphone recording with a TypeScript core and React hooks.

`0.1.0-alpha.0` is experimental. The API can change. Chrome/Chromium has a reported physical-microphone cleanup pass. Firefox, Safari and mobile browsers remain unqualified. See [testing and limitations](docs/testing.md) for the evidence and remaining checks.

Recstead owns microphone acquisition, recording state and the tracks it acquires. It returns a complete Blob after the recorder delivers its final data. Your application owns playback, uploads and any recordings it keeps.

## Install the alpha

The npm alpha uses the `next` tag:

```sh
npm install recstead@next
```

Before the first publication, use the locally packed artifact described below.

## Build and try locally

Use Node.js 22.12 or newer to work on the repository.

```sh
npm ci
npm run check
npm run demo
```

The demo command prints the address to open. Choose the [plain TypeScript or React sample app](https://github.com/trigger-xyz/recstead/tree/main/examples), or run the generated-audio encoder check. The recorder apps request microphone access only when you press Record. A secure browser context is required.

The check command builds and verifies the package, including a local tarball. To evaluate a local build, install that artifact from your application. For sibling application and Recstead directories:

```sh
npm install ../recstead/.artifacts/recstead-0.1.0-alpha.0.tgz
```

React applications also need React 18.3.1 or newer within the package's declared peer range. Core-only applications do not need React. This package is ESM only.

## Record with the core

```ts
import { createRecorder, isRecorderFailure } from 'recstead';

const recorder = createRecorder();

async function record() {
  try {
    await recorder.start();
  } catch (error) {
    if (isRecorderFailure(error) && error.code === 'CANCELLED') return;
    throw error;
  }
}

async function finish() {
  const result = await recorder.stop();
  if (result) {
    // The application decides whether to play, retain or upload this Blob.
    return result.blob;
  }
  return null;
}

async function discard() {
  await recorder.cancel();
}

async function destroy() {
  await recorder.dispose();
}
```

Call `record()` from a user action. Call `finish()` to preserve output, `discard()` to drop it, and `destroy()` when the application no longer needs the controller. Handle rejected commands in your UI.

`stop()` waits for final output. During a pending permission request, it cancels the session and returns `null`. Cancellation cannot dismiss the browser's permission prompt. A stream granted afterward is released, and the cancelled session cannot start recording. Another start on the same controller rejects `ACQUISITION_PENDING` until that request settles.

## Record in React

```tsx
'use client';

import { useState } from 'react';
import { isRecorderFailure } from 'recstead';
import { useRecorder, useRecordingUrl } from 'recstead/react';

export function VoiceMessage() {
  const recorder = useRecorder();
  const url = useRecordingUrl(recorder.result);
  const [message, setMessage] = useState<string | null>(null);

  function run(action: () => Promise<unknown>) {
    setMessage(null);
    void action().catch(error => {
      if (isRecorderFailure(error) && error.code === 'CANCELLED') return;
      setMessage(error instanceof Error ? error.message : 'Recording failed.');
    });
  }

  return (
    <section aria-label="Voice message">
      <p>Status: {recorder.status}</p>
      <button
        disabled={recorder.permissionPending ||
          !['idle', 'ready', 'failed'].includes(recorder.status)}
        onClick={() => run(() => recorder.start())}
      >Record</button>
      <button
        disabled={!['acquiring', 'initializing', 'recording', 'paused'].includes(recorder.status)}
        onClick={() => run(recorder.stop)}
      >Stop</button>
      <button onClick={() => run(recorder.cancel)}>Discard</button>
      {message && <p role="alert">{message}</p>}
      {recorder.error && <p role="alert">{recorder.error.message}</p>}
      {recorder.result?.completion === 'partial' &&
        <p>The recording is incomplete and may not play.</p>}
      {url && <audio controls src={url} />}
    </section>
  );
}
```

`useRecorder` disposes its controller on unmount, discarding an active recording. Await `stop()` before navigation if you need its result. `useRecordingUrl` creates and revokes its own playback URL.

## Scope and output

- Microphone audio only. No screen, camera, external streams or background-recording guarantee.
- Start, pause, resume, stop, cancel, reset and terminal disposal.
- A React-free core from `recstead` or `recstead/core`, with hooks in `recstead/react`.
- Browser-native encoding. No WAV conversion, resampling or automatic upload.
- Defaults of 16 MiB retained payload and 300,000 active milliseconds per recording. These limits do not bound the browser's total memory use.

The result reports the observed MIME type. Relabelling a Blob does not convert its bytes. Check your server's accepted container and codec before uploading. A failed recording may expose a clearly marked partial result; never treat it as complete output.

Read the [API reference](docs/api.md), [architecture](docs/architecture.md) and [contribution guide](CONTRIBUTING.md). Recstead is released under the [MIT license](LICENSE).
