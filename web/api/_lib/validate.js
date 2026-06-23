// Envelope + batch validation, ported from src/validate.js. Identical rules so
// the ingest contract matches the Mongo server. deriveId/enrich are dropped:
// Postgres assigns the row id and the ingest handler computes received_at /
// expires_at.

export const LEVELS = ['debug', 'info', 'warn', 'error'];

const ALLOWED_KEYS = new Set(['event', 'level', 'ts', 'message', 'ids', 'data']);
const MAX_EVENT_CHARS = 200;
const TRUNCATED_HEAD_CHARS = 4096;

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const invalid = (error) => ({ ok: false, error });

// Bound nesting depth with an explicit, NON-recursive walk before any
// JSON.stringify (V8's serializer recurses and would overflow on a deeply-nested
// but tiny payload). `root` is depth 1; each nested object/array adds a level.
function exceedsDepth(root, maxDepth) {
  const stack = [[root, 1]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop();
    if (depth > maxDepth) return true;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const child = node[i];
        if (child !== null && typeof child === 'object') stack.push([child, depth + 1]);
      }
    } else {
      for (const key of Object.keys(node)) {
        const child = node[key];
        if (child !== null && typeof child === 'object') stack.push([child, depth + 1]);
      }
    }
  }
  return false;
}

// Contract C3: any charCode < 32 in `event` is invalid.
function hasControlChars(s) {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) < 32) return true;
  }
  return false;
}

export function validateEnvelope(raw, limits) {
  const {
    maxMessageChars = 512,
    maxIdsKeys = 10,
    maxDataBytes = 16_384,
    maxDataDepth = 32,
  } = limits ?? {};

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
    if (exceedsDepth(raw.ids, maxDataDepth)) return invalid(`ids nesting exceeds ${maxDataDepth} levels`);
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
    if (exceedsDepth(raw.data, maxDataDepth)) return invalid(`data nesting exceeds ${maxDataDepth} levels`);
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
