// Contract C8: GET /v1/logs — URL params → Mongo filter, keyset pagination.
import { LEVELS } from '../validate.js';
import { encodeCursor, decodeCursor } from './cursor.js';

const MAX_Q_CHARS = 256;
const NUMERIC_RE = /^-?\d+(\.\d+)?$/;
const EPOCH_MS_RE = /^\d+$/;
const INT_RE = /^-?\d+$/;

const fail = (error) => ({ ok: false, error });
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ReDoS guard for the `q` regex (defense-in-depth alongside the maxTimeMS cap in
// runLogsQuery). `q` is forwarded to Mongo as a $regex over an unindexed,
// optionally window-less COLLSCAN and a read key — handed to AI assistants per
// PRD §6.2 — is enough to send it. `new RegExp(q)` only checks *syntax*, so a
// nested quantifier like `(a+)+$` sails through and triggers catastrophic
// PCRE2 backtracking on the server.
//
// We reject the cheap, high-signal class: a group close `)` immediately
// followed by an "unbounded" quantifier (`+`, `*`, or any `{...}` range) when
// that group's body itself contains an unbounded quantifier — i.e. nested
// quantifiers `(a+)+`, `(a*)*`, `(.*)+`, `(\d+){2,}`, `(?:a+)+`, `(a|a)+`.
// Ordinary substring/anchored searches (`^GET `, `slow query`, `user.*x`,
// `(read|write) key`, single quantifiers) carry no nested quantifier and pass.
// This is a conservative filter, not a complete classifier; the maxTimeMS cap
// is the backstop for anything it misses (e.g. flat `a?a?...aaaa` chains).
function hasCatastrophicBacktracking(pattern) {
  // Per-group flag: did the body at THIS paren depth contain an unbounded
  // quantifier (+, *, or a {m,} / {m,n} range)? Index 0 is the top level.
  const groupHasUnbounded = [false];
  let inClass = false; // inside a [...] character class: metacharacters are literal

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];

    if (ch === '\\') {
      i++; // skip the escaped character — it is always a literal
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      continue;
    }
    if (ch === '(') {
      groupHasUnbounded.push(false);
      continue;
    }
    if (ch === ')') {
      const innerUnbounded = groupHasUnbounded.pop() ?? false;
      if (groupHasUnbounded.length === 0) groupHasUnbounded.push(false); // unbalanced ) — keep scanning safely
      const next = pattern[i + 1];
      const outerUnbounded = next === '+' || next === '*' || next === '{';
      if (innerUnbounded && outerUnbounded) return true; // nested quantifier
      // A quantifier applied to this group counts toward the ENCLOSING group's
      // "unbounded" flag, so deeper nesting like ((a+)+)+ is also caught.
      if (outerUnbounded) groupHasUnbounded[groupHasUnbounded.length - 1] = true;
      continue;
    }
    if (ch === '+' || ch === '*') {
      groupHasUnbounded[groupHasUnbounded.length - 1] = true;
      continue;
    }
    if (ch === '{') {
      // Treat an open-ended/range repetition `{m,}` or `{m,n}` as unbounded for
      // backtracking purposes; an exact `{m}` is not.
      const close = pattern.indexOf('}', i);
      if (close !== -1) {
        const body = pattern.slice(i + 1, close);
        if (/^\d*,\d*$/.test(body)) {
          groupHasUnbounded[groupHasUnbounded.length - 1] = true;
        }
        i = close;
      }
      continue;
    }
  }
  return false;
}

function parseDateValue(v) {
  if (EPOCH_MS_RE.test(v)) return new Date(Number(v));
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t);
}

// data.<path> exact values arrive as strings; match both the typed and the
// string form so `data.latencyMs=42` hits docs that stored the number 42.
function coerceDataValue(v) {
  if (NUMERIC_RE.test(v)) return { $in: [Number(v), v] };
  if (v === 'true') return { $in: [true, v] };
  if (v === 'false') return { $in: [false, v] };
  return v;
}

function mergeRange(filter, path, op, n) {
  const existing = filter[path];
  const target =
    existing !== null && typeof existing === 'object' && !Array.isArray(existing) && !(existing instanceof Date)
      ? existing
      : {};
  target[op] = n;
  filter[path] = target;
}

export function parseLogsQuery(searchParams, limits = {}) {
  const maxLimit = limits.maxLimit ?? 500;
  const defaultLimit = limits.defaultLimit ?? 100;
  const params = searchParams instanceof URLSearchParams ? searchParams : new URLSearchParams(searchParams);

  const filter = {};
  const receivedAtRange = {};
  let limit = defaultLimit;

  for (const [name, value] of params) {
    if (name === 'app' || name === 'env') {
      filter[name] = value;
    } else if (name === 'level') {
      const tokens = value.split(',');
      for (const t of tokens) {
        if (!LEVELS.includes(t)) return fail(`invalid level "${t}"`);
      }
      filter.level = { $in: tokens };
    } else if (name === 'event') {
      filter.event = { $regex: '^' + escapeRegex(value) };
    } else if (name === 'from' || name === 'to') {
      const d = parseDateValue(value);
      if (d === null) return fail(`invalid ${name} "${value}" (ISO-8601 or epoch-ms expected)`);
      receivedAtRange[name === 'from' ? '$gte' : '$lt'] = d;
    } else if (name === 'q') {
      if (value.length > MAX_Q_CHARS) return fail(`q exceeds ${MAX_Q_CHARS} chars`);
      try {
        new RegExp(value);
      } catch {
        return fail('q is not a valid regular expression');
      }
      if (hasCatastrophicBacktracking(value)) {
        return fail('q rejected: nested quantifiers risk catastrophic backtracking');
      }
      filter.message = { $regex: value, $options: 'i' };
    } else if (name === 'limit') {
      if (!INT_RE.test(value)) return fail(`invalid limit "${value}"`);
      limit = Math.min(Math.max(Number(value), 1), maxLimit);
    } else if (name === 'cursor') {
      const c = decodeCursor(value);
      if (c === null) return fail('invalid cursor');
      // Keyset predicate; top-level $or ANDs with every other filter key.
      filter.$or = [
        { receivedAt: { $lt: c.receivedAt } },
        { receivedAt: c.receivedAt, _id: { $lt: c.id } },
      ];
    } else if (name.startsWith('ids.') && name.length > 'ids.'.length) {
      filter[name] = value;
    } else if (name.startsWith('data.') && name.length > 'data.'.length) {
      const rangeOp = name.endsWith('__gte') ? '$gte' : name.endsWith('__lte') ? '$lte' : null;
      if (rangeOp === null) {
        filter[name] = coerceDataValue(value);
      } else {
        const path = name.slice(0, -'__gte'.length);
        if (path.length <= 'data.'.length) return fail(`unknown parameter "${name}"`);
        if (!NUMERIC_RE.test(value)) return fail(`${name} requires a numeric value`);
        mergeRange(filter, path, rangeOp, Number(value));
      }
    } else {
      return fail(`unknown parameter "${name}"`);
    }
  }

  if (receivedAtRange.$gte !== undefined || receivedAtRange.$lt !== undefined) {
    filter.receivedAt = receivedAtRange;
  }

  return { ok: true, value: { filter, limit } };
}

function serializeValue(v) {
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(serializeValue);
  if (v !== null && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = serializeValue(val);
    return out;
  }
  return v;
}

export async function runLogsQuery(collection, { filter, limit }, { maxTimeMS } = {}) {
  // limit+1 over-fetch: the extra row only signals that another page exists.
  let cursor = collection
    .find(filter)
    .sort({ receivedAt: -1, _id: -1 })
    .limit(limit + 1);
  // Server-side execution cap (PRD security): bounds both a catastrophic-
  // backtracking $regex that slipped past parse-time validation and a plain
  // unindexed COLLSCAN, so one read request can never pin a Mongo worker
  // indefinitely. The driver's connect/serverSelection timeouts do NOT cap
  // query execution. Only applied when a positive cap is configured.
  if (Number.isFinite(maxTimeMS) && maxTimeMS > 0) {
    cursor = cursor.maxTimeMS(maxTimeMS);
  }
  const rows = await cursor.toArray();
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const nextCursor = hasMore ? encodeCursor({ receivedAt: last.receivedAt, id: last._id }) : null;
  return { items: items.map(serializeValue), nextCursor };
}
