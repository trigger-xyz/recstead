import React, { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { isRecorderFailure } from 'recstead';
import { useRecorder, useRecordingUrl } from 'recstead/react';
function RecorderPanel() {
  const recorder = useRecorder({ maxActiveMs: 120_000 });
  const url = useRecordingUrl(recorder.result);
  const [error, setError] = useState<string | null>(null);
  const run = (operation: () => Promise<unknown>) => {
    setError(null);
    void operation().catch(cause => {
      if (isRecorderFailure(cause) && cause.code === 'CANCELLED') return;
      setError(cause instanceof Error ? cause.message : 'Recording failed.');
    });
  };
  return <section aria-label="Voice recorder">
    <p className="status" role="status">{recorder.status}</p>
    {recorder.permissionPending && <p>Resolve or dismiss the outstanding browser permission prompt before starting again.</p>}
    <div className="controls">
      <button disabled={recorder.permissionPending || !['idle', 'ready', 'failed'].includes(recorder.status)} onClick={() => run(() => recorder.start())}>Record</button>
      <button disabled={recorder.status !== 'recording'} onClick={() => run(recorder.pause)}>Pause</button>
      <button disabled={recorder.status !== 'paused'} onClick={() => run(recorder.resume)}>Resume</button>
      <button disabled={!['acquiring', 'initializing', 'recording', 'paused'].includes(recorder.status)} onClick={() => run(recorder.stop)}>Stop</button>
      <button onClick={() => run(recorder.cancel)}>Discard</button>
    </div>
    {(error || recorder.error) && <p role="alert">{error ?? recorder.error?.message}</p>}
    {recorder.result?.completion === 'partial' && <p role="alert">This recording is incomplete and may not play.</p>}
    {url && <audio controls src={url} aria-label="Recorded voice note" />}
    <pre>{recorder.result ? JSON.stringify({ bytes: recorder.result.bytes, mimeType: recorder.result.mimeType, completion: recorder.result.completion, reason: recorder.result.reason, activeMs: recorder.result.activeMs }, null, 2) : 'No recording yet.'}</pre>
  </section>;
}
function App() {
  const [mounted, setMounted] = useState(true);
  return <><p>Unmount the recorder while recording or waiting for permission to exercise cleanup. Audio stays in this browser.</p>
    <button onClick={() => setMounted(value => !value)}>{mounted ? 'Unmount recorder' : 'Mount recorder'}</button>
    {mounted ? <RecorderPanel /> : <p>Recorder unmounted. Any active session was discarded.</p>}
    <p className="muted">Unmounting does not dismiss the browser's own permission dialog. A late stream is released when that request resolves.</p></>;
}
const container = document.getElementById('root');
if (!container) throw new Error('The recorder page is missing its root element.');
const root = createRoot(container);
root.render(<StrictMode><App /></StrictMode>);
// Navigation can place the page in the back/forward cache without unmounting
// React. Release the owned recorder and playback URL before that happens.
window.addEventListener('pagehide', () => root.unmount(), { once: true });
window.addEventListener('pageshow', event => { if (event.persisted) window.location.reload(); });
