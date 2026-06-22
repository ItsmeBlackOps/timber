// SQL port of src/query/logs.js buildLogsFilter. Same param surface, escaping,
// date coercion, ReDoS guard, and inverted-window check; emits positional
// clauses + params instead of a Mongo filter. `app` is captured into value.app
// (not a clause) so appScopeSql produces the single app constraint, matching the
// Mongo appScope precedence. ids.*/data.* paths are passed as a text[] parameter
// to `#>>`, never interpolated, so a dotted key cannot inject SQL.
import { LEVELS } from './validate.js';
import { decodeCursor } from './cursor.js';

const MAX_Q_CHARS = 256;
const NUMERIC_RE = /^-?\d+(\.\d+)?$/;
const EPOCH_MS_RE = /^\d+$/;

const fail = (error) => ({ ok: false, error });

// Escape LIKE metacharacters so an event prefix is matched literally.
const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);

function parseDateValue(v) {
  if (EPOCH_MS_RE.test(v)) return new Date(Number(v));
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t);
}

// ReDoS guard for `q`, ported verbatim from src/query/logs.js. Postgres ~* uses a
// safe engine, but the guard is kept for parity and defense-in-depth (a future
// client-side preview, or an uncapped scan). Rejects three exponential families:
// nested quantifiers, quantified alternation with prefix-overlapping branches,
// and adjacent unbounded quantifiers over the same atom.
function hasCatastrophicBacktracking(pattern) {
  const groupHasUnbounded = [false];
  const groupBranches = [['']];
  const prevAtom = [null];
  const prevAtomUnbounded = [false];
  let inClass = false;

  const isUnbounded = (c) => c === '+' || c === '*';
  const top = () => groupHasUnbounded.length - 1;
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
      if (noteAtom(pattern.slice(i, i + 2), pattern[i + 2])) return true;
      i++;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') {
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
        groupHasUnbounded.push(false);
        groupBranches.push(['']);
        prevAtom.push(null);
        prevAtomUnbounded.push(false);
      }
      const next = pattern[i + 1];
      const outerUnbounded = next === '+' || next === '*' || next === '{';
      if (innerUnbounded && outerUnbounded) return true;
      if (outerUnbounded && branches.length > 1) {
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
    if (noteAtom(ch, pattern[i + 1])) return true;
  }
  return false;
}

// buildWhere(searchParams) -> { ok, clauses, params, value } | { ok:false, error }.
// clauses use $N placeholders into params (1-based, in push order). value.app
// holds the `app` filter for appScopeSql. `limit`/`cursor` knobs: limit is
// skipped (callers clamp it); cursor becomes the keyset predicate.
export function buildWhere(searchParams) {
  const params = searchParams instanceof URLSearchParams ? searchParams : new URLSearchParams(searchParams);
  const clauses = [];
  const vals = [];
  const value = {};
  let fromDate = null;
  let toDate = null;

  const push = (v) => {
    vals.push(v);
    return `$${vals.length}`;
  };

  for (const [name, v] of params) {
    if (name === 'limit') {
      continue;
    } else if (name === 'app') {
      value.app = v; // appScopeSql emits the clause
    } else if (name === 'env') {
      clauses.push(`env = ${push(v)}`);
    } else if (name === 'level') {
      const tokens = v.split(',');
      for (const t of tokens) {
        if (!LEVELS.includes(t)) return fail(`invalid level "${t}"`);
      }
      clauses.push(`level = ANY(${push(tokens)})`);
    } else if (name === 'event') {
      clauses.push(`event LIKE ${push(escapeLike(v) + '%')}`);
    } else if (name === 'from' || name === 'to') {
      const d = parseDateValue(v);
      if (d === null) return fail(`invalid ${name} "${v}" (ISO-8601 or epoch-ms expected)`);
      if (name === 'from') fromDate = d;
      else toDate = d;
    } else if (name === 'q') {
      if (v.length > MAX_Q_CHARS) return fail(`q exceeds ${MAX_Q_CHARS} chars`);
      try {
        new RegExp(v);
      } catch {
        return fail('q is not a valid regular expression');
      }
      if (hasCatastrophicBacktracking(v)) {
        return fail('q rejected: pattern risks catastrophic backtracking (nested/overlapping/adjacent quantifiers)');
      }
      clauses.push(`message ~* ${push(v)}`);
    } else if (name === 'cursor') {
      const c = decodeCursor(v);
      if (c === null) return fail('invalid cursor');
      const a = push(c.receivedAt.toISOString());
      const b = push(c.id);
      clauses.push(`(received_at < ${a} OR (received_at = ${a} AND id < ${b}))`);
    } else if (name.startsWith('ids.') && name.length > 'ids.'.length) {
      const path = name.slice('ids.'.length).split('.');
      clauses.push(`ids #>> ${push(path)} = ${push(v)}`);
    } else if (name.startsWith('data.') && name.length > 'data.'.length) {
      const rangeOp = name.endsWith('__gte') ? '>=' : name.endsWith('__lte') ? '<=' : null;
      if (rangeOp === null) {
        const path = name.slice('data.'.length).split('.');
        clauses.push(`data #>> ${push(path)} = ${push(v)}`);
      } else {
        const pathStr = name.slice('data.'.length, -'__gte'.length);
        if (pathStr.length === 0) return fail(`unknown parameter "${name}"`);
        if (!NUMERIC_RE.test(v)) return fail(`${name} requires a numeric value`);
        const path = pathStr.split('.');
        clauses.push(`(data #>> ${push(path)})::numeric ${rangeOp} ${push(Number(v))}`);
      }
    } else {
      return fail(`unknown parameter "${name}"`);
    }
  }

  if (fromDate && toDate && fromDate.getTime() >= toDate.getTime()) {
    return fail('from must be earlier than to (got an inverted or empty time window)');
  }
  if (fromDate) clauses.push(`received_at >= ${push(fromDate.toISOString())}`);
  if (toDate) clauses.push(`received_at < ${push(toDate.toISOString())}`);

  return { ok: true, clauses, params: vals, value };
}
