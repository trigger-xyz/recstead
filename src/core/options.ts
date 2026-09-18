import { failure } from './errors.js';
import type { RecorderOptions } from './types.js';

export interface Options {
  constraints: MediaTrackConstraints | true;
  mime: RecorderOptions['mime'];
  audioBitsPerSecond: number | undefined;
  maxBytes: number;
  maxActiveMs: number;
  initializationTimeoutMs: number;
  finalizationTimeoutMs: number;
}

function copy<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => copy(item)) as T;
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value)) result[key] = copy((value as Record<string, unknown>)[key]);
    return result as T;
  }
  return value;
}

export function resolveOptions(defaults: RecorderOptions, overrides: RecorderOptions = {}): Options {
  const merged = { ...defaults };
  for (const key of Object.keys(overrides) as (keyof RecorderOptions)[]) {
    const value = overrides[key];
    if (value !== undefined) Object.assign(merged, { [key]: value });
  }
  if (merged.source !== undefined && (merged.source === null || merged.source.kind !== 'microphone')) {
    throw failure('INVALID_OPTIONS');
  }
  if (merged.source?.constraints !== undefined &&
      (typeof merged.source.constraints !== 'object' || merged.source.constraints === null || Array.isArray(merged.source.constraints))) {
    throw failure('INVALID_OPTIONS');
  }
  const integer = (value: number | undefined, fallback: number, timeout = false): number => {
    const result = value === undefined ? fallback : value;
    if (!Number.isSafeInteger(result) || result <= 0 || (timeout && (result < 1000 || result > 120000))) {
      throw failure('INVALID_OPTIONS');
    }
    return result;
  };
  const audioBitsPerSecond = merged.audioBitsPerSecond === undefined ? undefined : integer(merged.audioBitsPerSecond, 128000);
  // Web IDL unsigned long conversion otherwise wraps larger values, even to zero.
  if (audioBitsPerSecond !== undefined && audioBitsPerSecond > 0xffffffff) throw failure('INVALID_OPTIONS');
  const mime = merged.mime;
  if (mime !== undefined && (!mime || !Array.isArray(mime.candidates) ||
      !mime.candidates.every(candidate => typeof candidate === 'string' && candidate.trim().length > 0) ||
      (mime.fallback !== 'browser' && mime.fallback !== 'error'))) throw failure('INVALID_OPTIONS');
  return {
    constraints: merged.source?.constraints === undefined ? true : copy(merged.source.constraints),
    mime: mime === undefined ? undefined : { candidates: [...mime.candidates], fallback: mime.fallback },
    audioBitsPerSecond,
    maxBytes: integer(merged.maxBytes, 16 * 1024 * 1024),
    maxActiveMs: integer(merged.maxActiveMs, 300000),
    initializationTimeoutMs: integer(merged.initializationTimeoutMs, 10000, true),
    finalizationTimeoutMs: integer(merged.finalizationTimeoutMs, 10000, true),
  };
}
