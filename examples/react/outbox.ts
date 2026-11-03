import type { RecordingResult } from 'recstead';
import { MAX_ITEMS, MAX_COLLECTION_BYTES, CONVERSATIONS } from '../shared/limits.mjs';

const REQUEST_TIMEOUT_MS = 10_000;

export type SendState = 'pending' | 'accepted' | 'rejected' | 'unknown';
export type SendScenario = 'normal' | 'delay' | 'reject' | 'drop-response';
export interface Message {
  id: string;
  conversation: string;
  bytes: number;
  mimeType: string;
  createdAt: number;
}
export interface OutboxEntry {
  message: Message;
  blob: Blob | null;
  state: SendState;
  detail: string;
}
export interface OutboxSnapshot {
  entries: readonly OutboxEntry[];
  loading: boolean;
  error: string;
}

function parseMessage(value: unknown): Message {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid response from the local server.');
  const message = value as Record<string, unknown>;
  if (typeof message.id !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(message.id) ||
      typeof message.conversation !== 'string' || !CONVERSATIONS.includes(message.conversation) ||
      typeof message.bytes !== 'number' || !Number.isSafeInteger(message.bytes) || message.bytes <= 0 ||
      typeof message.mimeType !== 'string' || !message.mimeType.startsWith('audio/') ||
      typeof message.createdAt !== 'number' || !Number.isFinite(message.createdAt)) {
    throw new Error('Invalid response from the local server.');
  }
  return { id: message.id, conversation: message.conversation, bytes: message.bytes,
    mimeType: message.mimeType, createdAt: message.createdAt };
}

function responseError(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'error' in value && typeof value.error === 'string') return value.error;
  return 'The local server rejected this recording.';
}

/** Requests belong to the application, independently of the composer lifetime. */
export class Outbox {
  private snapshot: OutboxSnapshot = { entries: [], loading: false, error: '' };
  private readonly listeners = new Set<() => void>();
  private readonly pending = new Map<string, AbortController>();
  private loadController: AbortController | null = null;
  private clearController: AbortController | null = null;
  private generation = 0;
  private revision = 0;
  private disposed = false;

  constructor(private readonly request: typeof fetch = (input, init) => globalThis.fetch(input, init),
    private readonly makeId: () => string = () => crypto.randomUUID()) {}

  getSnapshot = (): OutboxSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private update(change: Partial<OutboxSnapshot>): void {
    if (this.disposed) return;
    if (change.entries) this.revision++;
    this.snapshot = { ...this.snapshot, ...change };
    for (const listener of this.listeners) listener();
  }

  private replace(id: string, patch: Partial<OutboxEntry>): void {
    this.update({ entries: this.snapshot.entries.map(entry => entry.message.id === id ? { ...entry, ...patch } : entry) });
  }

  async load(): Promise<void> {
    if (this.disposed || this.clearController) return;
    this.loadController?.abort();
    const controller = new AbortController();
    this.loadController = controller;
    const generation = this.generation;
    const revision = this.revision;
    this.update({ loading: true, error: '' });
    try {
      const response = await this.request('/api/messages', { signal: controller.signal });
      if (!response.ok) throw new Error('The local message server is unavailable. Start it with npm run demo.');
      const body: unknown = await response.json();
      if (typeof body !== 'object' || body === null || !('messages' in body) || !Array.isArray(body.messages) || body.messages.length > MAX_ITEMS) {
        throw new Error('Invalid conversation response.');
      }
      const messages = body.messages.map(parseMessage);
      if (controller.signal.aborted || generation !== this.generation) return;
      // Pending and uncertain operations remain owned by this app, even if a GET races with PUT.
      const local = this.snapshot.entries.filter(entry => entry.state !== 'accepted' || revision !== this.revision);
      const ids = new Set(local.map(entry => entry.message.id));
      this.update({ entries: [...messages.filter(message => !ids.has(message.id)).map(message =>
        ({ message, blob: null, state: 'accepted' as const, detail: 'Accepted by the local server' })), ...local] });
    } catch (error) {
      if (!controller.signal.aborted) this.update({ error: error instanceof Error ? error.message : 'Could not load the conversation.' });
    } finally {
      if (this.loadController === controller) { this.loadController = null; this.update({ loading: false }); }
    }
  }

  enqueue(result: RecordingResult, conversation: string, scenario: SendScenario): string {
    if (this.disposed || this.clearController) throw new Error('The conversation is closed or being cleared.');
    if (result.completion !== 'complete' || !result.blob.size || !CONVERSATIONS.includes(conversation)) {
      throw new Error('Only a complete recording can be sent.');
    }
    if (this.snapshot.entries.length >= MAX_ITEMS ||
        this.snapshot.entries.reduce((sum, entry) => sum + (entry.blob?.size ?? 0), result.blob.size) > MAX_COLLECTION_BYTES) {
      throw new Error('The conversation is full. Clear it or remove unsent recordings.');
    }
    const id = this.makeId();
    const message = { id, conversation, bytes: result.blob.size, mimeType: result.mimeType, createdAt: Date.now() };
    this.update({ entries: [...this.snapshot.entries, { message, blob: result.blob, state: 'unknown', detail: '' }] });
    void this.send(id, scenario);
    return id;
  }

  async send(id: string, scenario: SendScenario = 'normal'): Promise<void> {
    if (this.disposed || this.clearController || this.pending.has(id)) return;
    const entry = this.snapshot.entries.find(value => value.message.id === id);
    if (!entry?.blob || entry.state === 'accepted') return;
    const controller = new AbortController();
    const generation = this.generation;
    this.pending.set(id, controller);
    this.replace(id, { state: 'pending', detail: 'Sending to the local server…' });
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.request(`/api/messages/${id}`, {
        method: 'PUT', body: entry.blob, signal: controller.signal,
        headers: { 'Content-Type': entry.message.mimeType, 'X-Conversation': entry.message.conversation, 'X-Example-Scenario': scenario },
      });
      const body: unknown = await response.json();
      if (generation !== this.generation || controller.signal.aborted) return;
      if (!response.ok) { this.replace(id, { state: 'rejected', detail: responseError(body) }); return; }
      const message = parseMessage(body);
      if (message.id !== id || message.conversation !== entry.message.conversation ||
          message.bytes !== entry.blob.size || message.mimeType !== entry.message.mimeType) {
        throw new Error('The response does not match this recording.');
      }
      this.replace(id, { message, state: 'accepted', blob: null, detail: 'Accepted by the local server' });
    } catch {
      if (generation === this.generation) this.replace(id, { state: 'unknown', detail: 'Sending could not be confirmed. Retry the same recording to check acceptance.' });
    } finally {
      clearTimeout(timeout);
      this.pending.delete(id);
      if (generation === this.generation && controller.signal.aborted) {
        this.replace(id, { state: 'unknown', detail: 'Waiting stopped. The server may already have accepted this message. Retry to check.' });
      }
    }
  }

  cancelRequest(id: string): void { this.pending.get(id)?.abort(); }

  remove(id: string): void {
    // A local removal is not a server-side undo. The UI says so for unknown outcomes.
    this.cancelRequest(id);
    this.update({ entries: this.snapshot.entries.filter(entry => entry.message.id !== id) });
  }

  async clear(): Promise<void> {
    if (this.disposed || this.clearController) return;
    const controller = new AbortController();
    this.clearController = controller;
    const generation = ++this.generation;
    this.loadController?.abort();
    for (const controller of this.pending.values()) controller.abort();
    this.update({ entries: this.snapshot.entries.map(entry => entry.state === 'pending' ?
      { ...entry, state: 'unknown', detail: 'Waiting stopped. Server acceptance is unknown.' } : entry) });
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.request('/api/messages', { method: 'DELETE', signal: controller.signal });
      if (this.disposed || generation !== this.generation) return;
      if (controller.signal.aborted || !response.ok) throw new Error('Clear was not confirmed.');
      this.update({ entries: [], error: '' });
    } catch {
      if (this.disposed || generation !== this.generation) return;
      throw new Error('Could not confirm clearing. The server may already have cleared these messages. Retry Clear conversations.');
    } finally {
      clearTimeout(timeout);
      if (this.clearController === controller) this.clearController = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.loadController?.abort();
    this.clearController?.abort();
    for (const controller of this.pending.values()) controller.abort();
    this.pending.clear();
    this.listeners.clear();
    this.snapshot = { entries: [], loading: false, error: '' };
  }
}
