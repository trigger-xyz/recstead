import { StrictMode, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import type { RecordingResult } from 'recstead';
import { useRecorder, useRecordingUrl } from 'recstead/react';
import { canStart, canStop, errorMessage, formatBytes, statusLabel } from '../shared/recording.js';
import { MAX_RECORDING_BYTES } from '../shared/limits.mjs';
import { Outbox, type OutboxEntry, type SendScenario } from './outbox.js';

const outbox = new Outbox();

function LocalAudio({ blob, label }: { blob: Blob; label: string }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const value = URL.createObjectURL(blob);
    setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [blob]);
  return <audio controls src={url} aria-label={label} />;
}

function MessageCard({ entry }: { entry: OutboxEntry }) {
  const { message, state } = entry;
  return <li className={`message message-${state}`}>
    <div className="item-heading"><strong>Your voice message</strong><span className="pill">{state === 'unknown' ? 'Acceptance unknown' : state}</span></div>
    <p className="caption">{formatBytes(message.bytes)} · {new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
    {entry.blob ? <LocalAudio blob={entry.blob} label="Unsent voice message" /> :
      <audio controls src={`/api/messages/${message.id}/audio`} aria-label="Accepted voice message" />}
    <p className="caption" role="status">{entry.detail}</p>
    <div className="actions">
      {state === 'pending' && <button className="quiet" onClick={() => outbox.cancelRequest(message.id)}>Stop waiting</button>}
      {(state === 'unknown' || state === 'rejected') && <>
        <button onClick={() => { void outbox.send(message.id); }}>Retry send</button>
        <button className="quiet" onClick={() => outbox.remove(message.id)}>Remove from this view</button>
      </>}
    </div>
    {state === 'unknown' && <p className="caption">Removing this item does not undo a message already accepted by the local server.</p>}
  </li>;
}

function Composer({ conversation, onClose }: { conversation: string; onClose: () => void }) {
  const recorder = useRecorder({ maxBytes: MAX_RECORDING_BYTES, maxActiveMs: 120_000 });
  const url = useRecordingUrl(recorder.result);
  const [error, setError] = useState('');
  const [scenario, setScenario] = useState<SendScenario>('normal');
  const recordButton = useRef<HTMLButtonElement>(null);
  useEffect(() => recordButton.current?.focus(), []);
  function run(action: () => Promise<unknown>): void {
    setError('');
    void action().catch(cause => setError(errorMessage(cause)));
  }
  function send(result: RecordingResult): void {
    try {
      outbox.enqueue(result, conversation, scenario);
      setScenario('normal');
      run(recorder.reset);
      recordButton.current?.focus();
    } catch (cause) { setError(errorMessage(cause)); }
  }
  return <section className="composer" aria-label="Voice message composer">
    <div className="item-heading"><h2>Say it in your own voice</h2><button className="quiet" onClick={onClose}>Close composer</button></div>
    <p className={`recording-status ${recorder.status === 'recording' ? 'live' : ''}`} role="status">{statusLabel(recorder.status)}</p>
    {recorder.permissionPending && <p className="notice">You can discard now. If permission is granted afterward, the microphone will be released. Resolve the browser prompt before trying again.</p>}
    <div className="actions">
      <button className="primary" ref={recordButton} disabled={recorder.permissionPending || !canStart(recorder.status)} onClick={() => run(() => recorder.start())}>{recorder.result ? 'Record again' : 'Record'}</button>
      {(recorder.status === 'recording' || recorder.status === 'paused') &&
        <button onClick={() => run(recorder.status === 'paused' ? recorder.resume : recorder.pause)}>{recorder.status === 'paused' ? 'Resume' : 'Pause'}</button>}
      <button disabled={!canStop(recorder.status)} onClick={() => run(recorder.stop)}>Stop</button>
      <button className="quiet" onClick={() => { run(recorder.cancel); recordButton.current?.focus(); }}>Discard</button>
    </div>
    {(error || recorder.error) && <p role="alert">{error || recorder.error?.message}</p>}
    {recorder.result?.completion === 'partial' && <p role="alert">This recording is incomplete and cannot be sent. Discard it and try again.</p>}
    {url && <div className="draft"><p className="caption">Listen before sending · {formatBytes(recorder.result?.bytes ?? 0)}</p><audio controls src={url} aria-label="Message draft" /></div>}
    <button className="primary send" disabled={recorder.result?.completion !== 'complete'} onClick={() => { if (recorder.result) send(recorder.result); }}>Send voice message</button>
    <details className="test-panel"><summary>Test scenarios</summary>
      <label>Next send <select value={scenario} onChange={event => setScenario(event.target.value as SendScenario)}>
        <option value="normal">Normal</option><option value="reject">Reject before acceptance</option>
        <option value="delay">Slow response</option><option value="drop-response">Accept, then lose the response</option>
      </select></label><p className="caption">These failures affect the local example server. Retry always checks the same message identifier.</p>
    </details>
  </section>;
}

function App() {
  const [conversation, setConversation] = useState('team');
  const [open, setOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState('');
  const snapshot = useSyncExternalStore(outbox.subscribe, outbox.getSnapshot);
  const openButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { void outbox.load(); }, []);
  useEffect(() => { if (!open) openButton.current?.focus(); }, [open]);
  const entries = snapshot.entries.filter(entry => entry.message.conversation === conversation);
  return <div className="workspace">
    <aside className="sidebar"><p className="eyebrow">CONVERSATIONS</p><nav aria-label="Conversations">
      {(['team', 'friends'] as const).map(id => <button key={id} className={conversation === id ? 'selected' : ''}
        aria-pressed={conversation === id} disabled={clearing} onClick={() => setConversation(id)}>
        <span className="avatar">{id === 'team' ? 'S' : 'F'}</span><span>{id === 'team' ? 'Studio team' : 'Friends'}<small>Local conversation</small></span>
      </button>)}
    </nav><p className="caption sidebar-note">Messages go to this computer's example server. They disappear when it restarts. Nothing is delivered to another person.</p></aside>
    <section className="workspace-main" aria-label="Conversation">
      <header className="workspace-header"><div><p className="eyebrow">VOICE MESSAGES</p><h1>{conversation === 'team' ? 'Studio team' : 'Friends'}</h1></div>
        <button className="primary" ref={openButton} disabled={open || clearing} onClick={() => setOpen(true)}>New voice message</button></header>
      {(error || snapshot.error) && <p role="alert">{error || snapshot.error} <button className="quiet" onClick={() => { setError(''); void outbox.load(); }}>Reload conversation</button></p>}
      {snapshot.loading && <p role="status">Loading conversation…</p>}
      {entries.length ? <ol className="messages" aria-label="Messages">{entries.map(entry => <MessageCard key={entry.message.id} entry={entry} />)}</ol> :
        <div className="empty"><span className="empty-symbol" aria-hidden="true">◉</span><h2>A little more personal.</h2><p>Record a thought, listen back, and send it when you're ready.</p></div>}
      {open && <Composer key={conversation} conversation={conversation} onClose={() => setOpen(false)} />}
      <footer className="workspace-footer"><span>{entries.length} {entries.length === 1 ? 'message' : 'messages'} · local only</span><button className="quiet" disabled={clearing || snapshot.entries.length === 0}
        onClick={() => {
          if (!window.confirm('Clear all local conversations and unsent recordings?')) return;
          setOpen(false); setClearing(true); setError('');
          void outbox.clear().catch(cause => setError(errorMessage(cause))).finally(() => setClearing(false));
        }}>Clear conversations</button></footer>
    </section>
  </div>;
}

const container = document.getElementById('root');
if (!container) throw new Error('The message app is missing its root element.');
const root = createRoot(container);
root.render(<StrictMode><App /></StrictMode>);
window.addEventListener('pagehide', () => { root.unmount(); outbox.dispose(); }, { once: true });
window.addEventListener('pageshow', event => { if (event.persisted) window.location.reload(); });
