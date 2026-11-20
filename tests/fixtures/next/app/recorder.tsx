'use client';

import { useState } from 'react';
import { isRecorderFailure } from 'recstead';
import { useRecorder, useRecordingUrl } from 'recstead/react';

export function VoiceRecorder() {
  const recorder = useRecorder({ maxActiveMs: 60_000 });
  const url = useRecordingUrl(recorder.result);
  const [message, setMessage] = useState('');

  function run(action: () => Promise<unknown>) {
    setMessage('');
    void action().catch(error => {
      if (isRecorderFailure(error) && error.code === 'CANCELLED') return;
      setMessage(error instanceof Error ? error.message : 'Recording failed.');
    });
  }

  return <section aria-label="Voice recorder">
    <p role="status">Status: {recorder.status}</p>
    <button onClick={() => run(() => recorder.start())}>Record</button>
    <button onClick={() => run(recorder.stop)}>Stop</button>
    {message && <p role="alert">{message}</p>}
    {url && <audio controls src={url} aria-label="Recording" />}
  </section>;
}
