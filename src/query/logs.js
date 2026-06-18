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
// PRD §6.2 — is enough to send it. `new RegExp(q)` only checks *syntax*, so an
// evil pattern like `(a+)+$` sails through and triggers catastrophic
// backtracking on a V8/PCRE-classic engine.
//
// IMPORTANT — scope of this control. Mongo's PCRE2 engine (JIT + a built-in
// match/backtracking limit) does NOT exhibit V8-style exponential blowup on
// these patterns, and the runLogsQuery maxTimeMS cap bounds COLLSCAN time
// regardless; so the *server-side* ReDoS risk today is latent. This guard is
// defense-in-depth: it keeps a stated security control honest and protects any
// V8/PCRE-classic consumer of `q` (a future client-side preview, or Mongo run
// with maxTimeMS=0 on an engine without the PCRE2 limit). It is a conservative
// heuristic, NOT a complete classifier; maxTimeMS remains the universal backstop
// for the residual classes below (e.g. flat `a?a?...aaaa` optional chains).
//
// Three exponential families are rejected — verified against V8 RegExp where
// each blows up super-linearly while every benign C8 search stays flat:
//   1. Nested quantifiers: a group `)` immediately followed by an unbounded
//      quantifier (`+`, `*`, or a `{m,}` / `{m,n}` range) when the group body
//      itself contains an unbounded quantifier — `(a+)+`, `(a*)*`, `(.*)+`,
//      `(\d+){2,}`, `(?:a+)+`, and deeper nesting like `((a+)+)+`.
//   2. Quantified alternation with overlapping branches: a group closed by an
//      unbounded quantifier whose body has a top-level `|` where one branch is
//      a prefix of another (incl. identical branches) — `(a|a)+`, `(a|aa)+`,
//      `(a|ab)*`, `(a|a){2,}`. Overlap makes each input char ambiguous across
//      branches, the source of the blowup. NON-overlapping alternations such as
//      `(read|write) key` or `(read|write)+` are linear and pass.
//   3. Adjacent unbounded quantifiers over the SAME atom: `a+a+...`, `a*a*...`,
//      `\d+\d+`. The repeated overlapping atoms backtrack exponentially. A
//      single quantifier (`a+`, `user.*x`, `\d+ ms`) or quantifiers separated
//      by a mandatory atom (`[0-9]+\.[0-9]{2}`) are safe and pass.
//
// Ordinary substring/anchored searches (`^GET `, `slow query`, `(read|write)
// key`) carry none of these and pass.
function hasCatastrophicBacktracking(pattern) {
  // Per-paren-depth state stacks. Index 0 is the top level; ( pushes, ) pops.
  const groupHasUnbounded = [false]; // body at THIS depth has a +/*/{m,} quantifier
  const groupBranches = [['']]; // top-level alternation branches accumulated as
  //   atom-source strings, for the family-2 prefix-overlap check
  const prevAtom = [null]; // source text of the previous atom at this depth …
  const prevAtomUnbounded = [false]; //   … and whether it was unbounded-quantified
  let inClass = false; // inside a [...] character class: metacharacters are literal

  const isUnbounded = (c) => c === '+' || c === '*';
  const top = () => groupHasUnbounded.length - 1;
  // Record a single "atom" (literal char, escape, or [class]) and return true if
  // it forms an adjacent overlapping-quantifier run with the previous atom (f.3).
  const noteAtom = (atom, nextChar) => {
    const unbounded = isUnbounded(nextChar);
    const adjacentRun = prevAtomUnbounded[top()] && prevAtom[top()] === atom && unbounded;
    prevAtom[top()] = atom;
    prevAtomUnbounded[top()] = unbounded;
    groupBranches[top()][groupBranches[top()].length - 1] += atom;
    return adjacentRun;
  };

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];

    if (ch === '\\') {
      // An escape (`\d`, `\.`, …) is a single literal atom of two chars.
      if (noteAtom(pattern.slice(i, i + 2), pattern[i + 2])) return true;
      i++; // skip the escaped character
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') {
      // Consume the whole character class as one atom so `[0-9]+[0-9]+` is seen
      // as an adjacent run while `[0-9]+\.[0-9]{2}` is not.
      let j = i + 1;
      while (j < pattern.length && pattern[j] !== ']') {
        if (pattern[j] === '\\') j++;
        j++;
      }
      if (noteAtom(pattern.slice(i, j + 1), pattern[j + 1])) return true;
      i = j;
      continue;
    }
    if (ch === '(') {
      groupHasUnbounded.push(false);
      groupBranches.push(['']);
      prevAtom.push(null);
      prevAtomUnbounded.push(false);
      continue;
    }
    if (ch === '|') {
      // Start a new top-level branch for THIS group; reset adjacency tracking.
      groupBranches[top()].push('');
      prevAtom[top()] = null;
      prevAtomUnbounded[top()] = false;
      continue;
    }
    if (ch === ')') {
      const innerUnbounded = groupHasUnbounded.pop() ?? false;
      const branches = groupBranches.pop() ?? [''];
      prevAtom.pop();
      prevAtomUnbounded.pop();
      if (groupHasUnbounded.length === 0) {
        // unbalanced ) — re-seed the top level and keep scanning safely
        groupHasUnbounded.push(false);
        groupBranches.push(['']);
        prevAtom.push(null);
        prevAtomUnbounded.push(false);
      }
      const next = pattern[i + 1];
      const outerUnbounded = next === '+' || next === '*' || next === '{';
      if (innerUnbounded && outerUnbounded) return true; // family 1: nested quantifier
      if (outerUnbounded && branches.length > 1) {
        // family 2: quantified alternation whose branches prefix-overlap. Strip a
        // leading group-type marker ((?: (?= (?! (?<= (?<!) from the first branch.
        const norm = branches.map((b) => b.replace(/^\?(?:[:=!]|<[=!])/, ''));
        for (let a = 0; a < norm.length; a++) {
          for (let b = a + 1; b < norm.length; b++) {
            const x = norm[a];
            const y = norm[b];
            if (x.length > 0 && y.length > 0 && (x.startsWith(y) || y.startsWith(x))) {
              return true;
            }
          }
        }
      }
      // A quantifier applied to this group counts toward the ENCLOSING group's
      // "unbounded" flag, so deeper nesting like ((a+)+)+ is also caught. The
      // group is opaque as an "atom" for adjacency, so reset prev tracking.
      if (outerUnbounded) groupHasUnbounded[top()] = true;
      prevAtom[top()] = null;
      prevAtomUnbounded[top()] = outerUnbounded;
      continue;
    }
    if (ch === '+' || ch === '*') {
      groupHasUnbounded[top()] = true;
      continue;
    }
    if (ch === '{') {
      // Treat an open-ended/range repetition `{m,}` or `{m,n}` as unbounded for
      // backtracking purposes; an exact `{m}` is not.
      const close = pattern.indexOf('}', i);
      if (close !== -1) {
        const body = pattern.slice(i + 1, close);
        if (/^\d*,\d*$/.test(body)) {
          groupHasUnbounded[top()] = true;
        }
        i = close;
      }
      continue;
    }
    // ordinary literal character = a single-char atom
    if (noteAtom(ch, pattern[i + 1])) return true;
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

// Shared filter builder (contract C8 + C-S2): turns the common query surface
// — app, env, level, event, from, to, q, ids.*, data.* (eq + __gte/__lte) and
// the keyset cursor — into a Mongo filter. Factored out of parseLogsQuery so
// /v1/groupby (src/query/groupby.js) can reuse the EXACT same param semantics
// without re-implementing escaping, date coercion, the ReDoS guard, or the
// data.* range merge. `limit` is intentionally NOT handled here: it is not a
// filter clause, and each endpoint clamps it against its own bounds. Returns
// { ok: true, value: { filter } } or { ok: false, error }.
export function buildLogsFilter(searchParams) {
  const params = searchParams instanceof URLSearchParams ? searchParams : new URLSearchParams(searchParams);

  const filter = {};
  const receivedAtRange = {};

  for (const [name, value] of params) {
    if (name === 'limit') {
      continue; // pagination/size knob, parsed by the caller (not a filter)
    } else if (name === 'app' || name === 'env') {
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
        return fail('q rejected: pattern risks catastrophic backtracking (nested/overlapping/adjacent quantifiers)');
      }
      filter.message = { $regex: value, $options: 'i' };
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
    // Reject an inverted/empty window (from >= to) with a 400 instead of silently
    // mapping it to an impossible {$gte: later, $lt: earlier} that matches zero
    // docs and returns a 200. A transposed from/to is a typo, and the rest of the
    // query surface already 400s typos (unknown param, bad level, etc.); since
    // from→$gte and to→$lt can never overlap when from === to either, the
    // boundary is `>=`. Only checked when BOTH bounds are present.
    if (
      receivedAtRange.$gte !== undefined &&
      receivedAtRange.$lt !== undefined &&
      receivedAtRange.$gte.getTime() >= receivedAtRange.$lt.getTime()
    ) {
      return fail('from must be earlier than to (got an inverted or empty time window)');
    }
    filter.receivedAt = receivedAtRange;
  }

  return { ok: true, value: { filter } };
}

export function parseLogsQuery(searchParams, limits = {}) {
  const maxLimit = limits.maxLimit ?? 500;
  const defaultLimit = limits.defaultLimit ?? 100;
  const params = searchParams instanceof URLSearchParams ? searchParams : new URLSearchParams(searchParams);

  // The cursor keyset, regex/date coercion and ids./data. handling live in the
  // shared builder; parseLogsQuery only adds the logs-specific `limit` clamp.
  const built = buildLogsFilter(params);
  if (!built.ok) return built;

  let limit = defaultLimit;
  const rawLimit = params.get('limit');
  if (rawLimit !== null) {
    if (!INT_RE.test(rawLimit)) return fail(`invalid limit "${rawLimit}"`);
    limit = Math.min(Math.max(Number(rawLimit), 1), maxLimit);
  }

  return { ok: true, value: { filter: built.value.filter, limit } };
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
