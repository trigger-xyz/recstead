import { MAX_ITEMS, MAX_COLLECTION_BYTES, MAX_RECORDING_BYTES } from '../shared/limits.mjs';

export interface Note {
  id: string;
  title: string;
  createdAt: number;
  blob: Blob;
  mimeType: string;
  activeMs: number;
}

function readNote(value: unknown): Note {
  if (typeof value !== 'object' || value === null) throw new Error('A saved note could not be read.');
  const note = value as Record<string, unknown>;
  if (typeof note.id !== 'string' || typeof note.title !== 'string' || typeof note.createdAt !== 'number' ||
      !(note.blob instanceof Blob) || typeof note.mimeType !== 'string' || typeof note.activeMs !== 'number') {
    throw new Error('A saved note could not be read.');
  }
  return { id: note.id, title: note.title, createdAt: note.createdAt, blob: note.blob,
    mimeType: note.mimeType, activeMs: note.activeMs };
}

export class NoteStorage {
  private database: Promise<IDBDatabase> | null = null;
  private closed = false;

  constructor(private readonly factory?: IDBFactory,
    private readonly name = 'recstead-voice-notes',
    private readonly limits = { count: MAX_ITEMS, bytes: MAX_COLLECTION_BYTES }) {}

  private open(): Promise<IDBDatabase> {
    if (this.closed) return Promise.reject(new Error('The note workspace is closed.'));
    if (!this.database) {
      const opening: Promise<IDBDatabase> = new Promise<IDBDatabase>((resolve, reject) => {
        const factory = this.factory ?? globalThis.indexedDB;
        if (!factory) {
          reject(new Error('Local storage is unavailable. Keep your draft or download it.')); return;
        }
        let abandoned = false;
        const request = factory.open(this.name, 1);
        request.onupgradeneeded = () => { request.result.createObjectStore('notes', { keyPath: 'id' }); };
        request.onerror = () => reject(new Error('Local storage is unavailable. Keep your draft or download it.'));
        request.onblocked = () => { abandoned = true; reject(new Error('Close other note tabs and retry opening this workspace.')); };
        request.onsuccess = () => {
          const db = request.result;
          if (this.closed || abandoned) { db.close(); reject(new Error('The note workspace is closed.')); return; }
          const forget = (): void => {
            if (this.database === opening) this.database = null;
          };
          db.onclose = forget;
          db.onversionchange = () => { db.close(); forget(); };
          resolve(db);
        };
      });
      this.database = opening;
      // A failed open can be retried after the browser's storage setting changes.
      void opening.catch(() => { if (this.database === opening) this.database = null; });
    }
    return this.database;
  }

  private async transaction<T>(mode: IDBTransactionMode,
    operation: (store: IDBObjectStore, setResult: (result: T) => void, fail: (error: Error) => void) => void): Promise<T> {
    const db = await this.open();
    if (this.closed) throw new Error('The note workspace is closed.');
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction('notes', mode);
      let result: T;
      let problem: Error | undefined;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(problem ?? new Error('Could not save changes. Local storage may be full or unavailable. Your draft is still available.'));
      tx.onerror = () => { /* The abort event reports transaction failure. */ };
      try {
        operation(tx.objectStore('notes'), value => { result = value; }, error => { problem = error; tx.abort(); });
      } catch (error) {
        problem = error instanceof Error ? error : new Error('Local storage failed.');
        tx.abort();
      }
    });
  }

  list(): Promise<Note[]> {
    return this.transaction('readonly', (store, done, fail) => {
      const request = store.getAll();
      request.onsuccess = () => {
        try {
          const values: unknown[] = request.result;
          done(values.map(readNote).sort((a, b) => b.createdAt - a.createdAt));
        } catch { fail(new Error('Saved notes could not be read. Clear this collection to reset it.')); }
      };
    });
  }

  save(note: Note, simulateFailure = false): Promise<void> {
    if (!note.id || !note.title.trim() || note.title.length > 80 || !(note.blob instanceof Blob) ||
        note.blob.size === 0 || note.blob.size > MAX_RECORDING_BYTES) {
      return Promise.reject(new Error('Give this complete recording a title of up to 80 characters.'));
    }
    // Count, size check and put share one readwrite transaction across tabs.
    return this.transaction('readwrite', (store, done, fail) => {
      const request = store.getAll();
      request.onsuccess = () => {
        let notes: Note[];
        try { const values: unknown[] = request.result; notes = values.map(readNote); }
        catch { fail(new Error('Saved notes could not be read. Clear this collection to reset it.')); return; }
        const other = notes.filter(value => value.id !== note.id);
        if (other.length >= this.limits.count || other.reduce((sum, value) => sum + value.blob.size, note.blob.size) > this.limits.bytes) {
          fail(new Error('Your note collection is full. Delete saved notes or download this draft.')); return;
        }
        store.put({ ...note, title: note.title.trim() });
        if (simulateFailure) { fail(new Error('Simulated storage failure. Your draft is still available.')); return; }
        done(undefined);
      };
    });
  }

  delete(id: string): Promise<void> {
    return this.transaction('readwrite', (store, done) => { store.delete(id); done(undefined); });
  }

  clear(): Promise<void> {
    return this.transaction('readwrite', (store, done) => { store.clear(); done(undefined); });
  }

  close(): void {
    this.closed = true;
    if (this.database) void this.database.then(db => db.close(), () => {});
  }
}
