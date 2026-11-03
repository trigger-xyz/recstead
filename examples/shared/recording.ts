import { isRecorderFailure, type RecorderStatus } from 'recstead';

export function errorMessage(error: unknown): string {
  if (isRecorderFailure(error) && error.code === 'CANCELLED') return '';
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

export function statusLabel(status: RecorderStatus): string {
  const labels: Record<RecorderStatus, string> = {
    idle: 'Ready to record', acquiring: 'Waiting for microphone permission',
    initializing: 'Starting microphone', recording: 'Recording', paused: 'Paused',
    stopping: 'Stopping', finalizing: 'Finishing recording', ready: 'Ready to review',
    failed: 'Recording failed', disposed: 'Recorder closed',
  };
  return labels[status];
}

export function canStart(status: RecorderStatus): boolean {
  return status === 'idle' || status === 'ready' || status === 'failed';
}

export function canStop(status: RecorderStatus): boolean {
  return ['acquiring', 'initializing', 'recording', 'paused'].includes(status);
}

export function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function extension(mime: string): string {
  const type = mime.split(';')[0].trim().toLowerCase();
  return ({ 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/wav': 'wav' } as Record<string, string>)[type] ?? 'audio';
}
