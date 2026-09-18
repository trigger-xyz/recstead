import { createRecorder, isRecorderFailure } from 'recstead';
const recorder = createRecorder({ maxActiveMs: 120_000 });
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const record = element<HTMLButtonElement>('record');
const pause = element<HTMLButtonElement>('pause');
const resume = element<HTMLButtonElement>('resume');
const stop = element<HTMLButtonElement>('stop');
const error = element<HTMLParagraphElement>('error');
const audio = element<HTMLAudioElement>('playback');
let blob: Blob | null = null;
let url: string | null = null;
function render() {
  const s = recorder.getSnapshot();
  element('status').textContent = s.status;
  element('pending').hidden = !s.permissionPending;
  record.disabled = s.permissionPending || !['idle', 'ready', 'failed'].includes(s.status);
  pause.disabled = s.status !== 'recording';
  resume.disabled = s.status !== 'paused';
  stop.disabled = !['acquiring', 'initializing', 'recording', 'paused'].includes(s.status);
  if (s.error) error.textContent = `${s.error.code}: ${s.error.message}`;
  element('partial').hidden = s.result?.completion !== 'partial';
  const next = s.result?.blob ?? null;
  if (blob !== next) {
    if (url) URL.revokeObjectURL(url);
    blob = next;
    url = blob ? URL.createObjectURL(blob) : null;
    if (url) audio.src = url;
    else { audio.removeAttribute('src'); audio.load(); }
    audio.hidden = !url;
  }
  element('details').textContent = s.result ? JSON.stringify({ bytes: s.result.bytes, mimeType: s.result.mimeType, completion: s.result.completion, reason: s.result.reason, activeMs: s.result.activeMs }, null, 2) : 'No recording yet.';
}
function run(operation: () => Promise<unknown>) {
  error.textContent = '';
  void operation().catch(cause => {
    if (isRecorderFailure(cause) && cause.code === 'CANCELLED') return;
    error.textContent = cause instanceof Error ? cause.message : 'Recording failed.';
  });
}
record.onclick = () => run(() => recorder.start());
pause.onclick = () => run(recorder.pause);
resume.onclick = () => run(recorder.resume);
stop.onclick = () => run(recorder.stop);
element('discard').onclick = () => run(recorder.cancel);
const unsubscribe = recorder.subscribe(render);
window.addEventListener('pagehide', () => {
  unsubscribe();
  if (url) URL.revokeObjectURL(url);
  void recorder.dispose();
}, { once: true });
render();

window.addEventListener('pageshow', event => { if (event.persisted) window.location.reload(); });
