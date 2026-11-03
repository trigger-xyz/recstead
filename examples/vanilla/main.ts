import { createRecorder, type RecordingResult } from 'recstead';
import { canStart, canStop, errorMessage, extension, formatBytes, formatDuration, statusLabel } from '../shared/recording.js';
import { MAX_RECORDING_BYTES } from '../shared/limits.mjs';
import { NoteStorage, type Note } from './storage.js';

function element<T extends HTMLElement>(id: string, kind: { new(): T }): T {
  const value = document.getElementById(id);
  if (!(value instanceof kind)) throw new Error(`Missing element: ${id}`);
  return value;
}
const record = element('record', HTMLButtonElement);
const pause = element('pause', HTMLButtonElement);
const resume = element('resume', HTMLButtonElement);
const stop = element('stop', HTMLButtonElement);
const discard = element('discard', HTMLButtonElement);
const save = element('save', HTMLButtonElement);
const title = element('note-title', HTMLInputElement);
const error = element('error', HTMLParagraphElement);
const status = element('status', HTMLParagraphElement);
const playback = element('playback', HTMLAudioElement);
const savedPlayback = element('saved-playback', HTMLAudioElement);
const draftDownload = element('draft-download', HTMLAnchorElement);
const savedDownload = element('saved-download', HTMLAnchorElement);
const notice = element('notice', HTMLParagraphElement);
const storageError = element('storage-error', HTMLParagraphElement);
const list = element('note-list', HTMLElement);
const library = element('library', HTMLButtonElement);
const deleteButton = element('delete-note', HTMLButtonElement);
const clearButton = element('clear-notes', HTMLButtonElement);
const newButton = element('new-note', HTMLButtonElement);
const failSave = element('fail-save', HTMLInputElement);
const recorder = createRecorder({ maxActiveMs: 120_000, maxBytes: MAX_RECORDING_BYTES });
const storage = new NoteStorage();
let notes: Note[] = [];
let selected: string | null = null;
let draft: { id: string; result: RecordingResult } | null = null;
let draftUrl: string | null = null;
let savedUrl: string | null = null;
let shownNote: Note | null = null;
let busy = true;
let disposed = false;

function removeAudio(audio: HTMLAudioElement): void {
  audio.pause(); audio.removeAttribute('src'); audio.load();
}

function renderCapture(): void {
  if (disposed) return;
  const snapshot = recorder.getSnapshot();
  status.textContent = statusLabel(snapshot.status);
  status.classList.toggle('live', snapshot.status === 'recording');
  element('pending', HTMLParagraphElement).hidden = !snapshot.permissionPending;
  record.disabled = busy || snapshot.permissionPending || !canStart(snapshot.status);
  record.textContent = snapshot.result ? 'Record again' : 'Record';
  newButton.disabled = busy || snapshot.permissionPending || !canStart(snapshot.status);
  pause.hidden = snapshot.status !== 'recording';
  resume.hidden = snapshot.status !== 'paused';
  stop.disabled = !canStop(snapshot.status);
  discard.disabled = busy;
  save.disabled = busy || snapshot.result?.completion !== 'complete';
  title.disabled = busy;
  deleteButton.disabled = busy;
  clearButton.disabled = busy;
  if (snapshot.error) error.textContent = snapshot.error.message;
  if (draft?.result !== snapshot.result) {
    removeAudio(playback);
    if (draftUrl) URL.revokeObjectURL(draftUrl);
    draftUrl = null; draft = null;
    if (snapshot.result) {
      draft = { id: crypto.randomUUID(), result: snapshot.result };
      draftUrl = URL.createObjectURL(snapshot.result.blob);
      playback.src = draftUrl; draftDownload.href = draftUrl;
      draftDownload.download = `voice-note${snapshot.result.completion === 'partial' ? '-partial' : ''}.${extension(snapshot.result.mimeType)}`;
      title.value = '';
    } else { draftDownload.removeAttribute('href'); }
  }
  element('draft', HTMLDivElement).hidden = !draft;
  element('partial', HTMLParagraphElement).hidden = snapshot.result?.completion !== 'partial';
}

function renderLibrary(): void {
  if (disposed) return;
  list.replaceChildren();
  for (const note of notes) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = selected === note.id ? 'selected note-item' : 'note-item';
    button.setAttribute('aria-pressed', String(selected === note.id));
    const name = document.createElement('strong'); name.textContent = note.title;
    const meta = document.createElement('small'); meta.textContent = `${formatDuration(note.activeMs)} · ${formatBytes(note.blob.size)}`;
    button.append(name, meta);
    button.onclick = () => { selected = note.id; renderLibrary(); element('view-title', HTMLHeadingElement).focus(); };
    list.append(button);
  }
  element('collection-summary', HTMLParagraphElement).textContent = `${notes.length} saved · ${formatBytes(notes.reduce((sum, note) => sum + note.blob.size, 0))}`;
  const note = notes.find(value => value.id === selected) ?? null;
  if (shownNote !== note) {
    removeAudio(savedPlayback);
    if (savedUrl) URL.revokeObjectURL(savedUrl);
    savedUrl = null; shownNote = note;
    if (note) {
      savedUrl = URL.createObjectURL(note.blob);
      savedPlayback.src = savedUrl; savedDownload.href = savedUrl;
      savedDownload.download = `voice-note.${extension(note.mimeType)}`;
    } else { savedDownload.removeAttribute('href'); }
  }
  const heading = element('view-title', HTMLHeadingElement);
  heading.textContent = note?.title ?? 'A place for your thoughts.'; heading.tabIndex = -1;
  element('note-detail', HTMLElement).hidden = !note;
  element('empty', HTMLDivElement).hidden = !!note;
  if (note) element('note-meta', HTMLParagraphElement).textContent = `${new Date(note.createdAt).toLocaleDateString()} · ${formatDuration(note.activeMs)} · ${formatBytes(note.blob.size)}`;
  library.classList.toggle('selected', !note);
  renderCapture();
}

function run(operation: () => Promise<unknown>): void {
  error.textContent = ''; notice.textContent = '';
  void operation().catch(cause => { if (!disposed) error.textContent = errorMessage(cause); });
}
async function withStorage(operation: () => Promise<void>): Promise<void> {
  if (busy || disposed) return;
  busy = true; storageError.textContent = ''; renderCapture();
  try { await operation(); }
  catch (cause) { if (!disposed) storageError.textContent = errorMessage(cause); }
  finally { busy = false; renderCapture(); }
}
async function refresh(): Promise<void> {
  const values = await storage.list();
  if (!disposed) { notes = values; renderLibrary(); }
}

record.onclick = () => run(() => recorder.start());
pause.onclick = () => run(async () => { await recorder.pause(); if (!disposed) resume.focus(); });
resume.onclick = () => run(async () => { await recorder.resume(); if (!disposed) pause.focus(); });
stop.onclick = () => run(async () => { await recorder.stop(); if (!disposed && draft) title.focus(); });
discard.onclick = () => run(async () => { await recorder.cancel(); record.focus(); });
newButton.onclick = () => {
  if (draft && !window.confirm('Discard the unsaved draft and record a new note?')) return;
  selected = null; renderLibrary(); run(() => recorder.start());
  status.scrollIntoView({ block: 'center', behavior: 'smooth' });
};
library.onclick = () => { selected = null; renderLibrary(); void withStorage(refresh); };
save.onclick = () => {
  const saving = draft;
  if (!saving || saving.result.completion !== 'complete') return;
  const note: Note = { id: saving.id, title: title.value.trim(), createdAt: Date.now(),
    blob: saving.result.blob, mimeType: saving.result.mimeType, activeMs: saving.result.activeMs };
  const simulateFailure = failSave.checked; failSave.checked = false;
  void withStorage(async () => {
    await storage.save(note, simulateFailure);
    if (disposed) return;
    // The saved Blob belongs to the app now, even after the recorder is reset.
    if (draft === saving) await recorder.reset();
    selected = note.id;
    await refresh();
    notice.textContent = `Saved “${note.title}”.`;
    element('view-title', HTMLHeadingElement).focus();
  });
};
deleteButton.onclick = () => {
  const id = selected;
  if (!id) return;
  void withStorage(async () => {
    await storage.delete(id); selected = null; await refresh();
    notice.textContent = 'Note deleted.'; library.focus();
  });
};
clearButton.onclick = () => {
  if (!window.confirm('Delete all saved voice notes from this browser? This cannot be undone.')) return;
  void withStorage(async () => {
    await storage.clear(); selected = null; await refresh();
    notice.textContent = 'Saved notes cleared. Your current draft is unchanged.'; library.focus();
  });
};
const unsubscribe = recorder.subscribe(renderCapture);
renderCapture();
void refresh().catch(cause => { storageError.textContent = errorMessage(cause); })
  .finally(() => { busy = false; renderCapture(); });
window.addEventListener('pagehide', () => {
  disposed = true; unsubscribe(); void recorder.dispose(); storage.close();
  removeAudio(playback); removeAudio(savedPlayback);
  if (draftUrl) URL.revokeObjectURL(draftUrl);
  if (savedUrl) URL.revokeObjectURL(savedUrl);
  draft = null; notes = [];
}, { once: true });
window.addEventListener('pageshow', event => { if (event.persisted) window.location.reload(); });
