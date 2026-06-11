import { deriveId } from './ids.js';

export const LEVELS = ['debug', 'info', 'warn', 'error'];

const ALLOWED_KEYS = new Set(['event', 'level', 'ts', 'message', 'ids', 'data']);
const MAX_EVENT_CHARS = 200;
const TRUNCATED_HEAD_CHARS = 4096;
const DAY_MS = 86_400_000;

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const invalid = (error) => ({ ok: false, error });

// Contract C3: any charCode < 32 in `event` is invalid.
function hasControlChars(s) {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) < 32) return true;
  }
  return false;
}

export function validateEnvelope(raw, limits) {
  const { maxMessageChars = 512, maxIdsKeys = 10, maxDataBytes = 16_384 } = limits ?? {};

  if (!isPlainObject(raw)) return invalid('event envelope must be a JSON object');
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) return invalid(`unknown key "${key}"`);
  }

  const { event } = raw;
  if (typeof event !== 'string' || event.length === 0) {
    return invalid('event is required and must be a non-empty string');
  }
  if (event.length > MAX_EVENT_CHARS) return invalid(`event exceeds ${MAX_EVENT_CHARS} chars`);
  if (hasControlChars(event)) return invalid('event must not contain control characters');

  // Fixed key order (event, level, ts, message, ids, data) keeps
  // JSON.stringify(value) deterministic for deriveId.
  const value = { event, level: 'info' };

  if (raw.level !== undefined) {
    if (!LEVELS.includes(raw.level)) return invalid(`level must be one of ${LEVELS.join('|')}`);
    value.level = raw.level;
  }

  if (raw.ts !== undefined) {
    if (typeof raw.ts !== 'string' || Number.isNaN(Date.parse(raw.ts))) {
      return invalid('ts must be a Date.parse-able string');
    }
    value.ts = raw.ts;
  }

  if (raw.message !== undefined) {
    if (typeof raw.message !== 'string') return invalid('message must be a string');
    value.message =
      raw.message.length > maxMessageChars ? raw.message.slice(0, maxMessageChars) : raw.message;
  }

  if (raw.ids !== undefined) {
    if (!isPlainObject(raw.ids)) return invalid('ids must be a plain object');
    const keys = Object.keys(raw.ids);
    if (keys.length > maxIdsKeys) return invalid(`ids exceeds ${maxIdsKeys} keys`);
    const ids = {};
    for (const k of keys) {
      const v = raw.ids[k];
      const t = typeof v;
      if (t !== 'string' && t !== 'number' && t !== 'boolean') {
        return invalid(`ids.${k} must be a string, number, or boolean`);
      }
      ids[k] = String(v);
    }
    value.ids = ids;
  }

  if (raw.data !== undefined) {
    if (!isPlainObject(raw.data)) return invalid('data must be a plain object');
    const serialized = JSON.stringify(raw.data);
    value.data =
      serialized.length > maxDataBytes
        ? {
            _truncated: true,
            _originalBytes: serialized.length,
            _head: serialized.slice(0, TRUNCATED_HEAD_CHARS),
          }
        : raw.data;
  }

  return { ok: true, value };
}

export function validateBatch(parsedBody, limits) {
  const { maxBatch = 500 } = limits ?? {};
  const batch = Array.isArray(parsedBody) ? parsedBody : [parsedBody];

  if (batch.length === 0) return { ok: false, status: 400, error: 'empty batch' };
  if (batch.length > maxBatch) {
    return { ok: false, status: 413, error: `batch exceeds ${maxBatch} events` };
  }

  const events = new Array(batch.length);
  for (let i = 0; i < batch.length; i++) {
    const res = validateEnvelope(batch[i], limits);
    if (!res.ok) return { ok: false, status: 400, index: i, error: res.error };
    events[i] = res.value;
  }
  return { ok: true, events };
}

export function enrich(value, { app, env, receivedAtIso, seq, ttlDays }) {
  const doc = {
    _id: deriveId({ app, receivedAtIso, seq, envelope: value }),
    app,
    env,
    event: value.event,
    level: value.level,
  };
  if (value.ts !== undefined) doc.ts = value.ts;
  if (value.message !== undefined) doc.message = value.message;
  if (value.ids !== undefined) doc.ids = value.ids;
  if (value.data !== undefined) doc.data = value.data;
  doc.receivedAt = receivedAtIso;
  doc.expiresAt = new Date(Date.parse(receivedAtIso) + ttlDays[value.level] * DAY_MS).toISOString();
  return doc;
}
