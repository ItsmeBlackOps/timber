// In-memory stand-in for a MongoDB collection (contract C12). Supports exactly
// the surface the flusher (C6) and query modules (C8/C9/C10) exercise, and
// fails fast (throws) on anything outside it so contract drift is caught in tests.

// BSON cross-type sort order subset (Null < Numbers < String < Object < Array < Boolean < Date).
const TYPE_RANK = { null: 1, number: 2, string: 3, object: 4, array: 5, boolean: 8, date: 9 };

function bsonType(v) {
  if (v === null || v === undefined) return 'null';
  if (v instanceof Date) return 'date';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  if (t === 'number') return 'number';
  if (t === 'string') return 'string';
  if (t === 'boolean') return 'boolean';
  return 'object';
}

// Stable scalar key for value identity (group keys, $addToSet membership, object equality).
function canonicalKey(v) {
  switch (bsonType(v)) {
    case 'null': return 'null';
    case 'date': return `d:${v.getTime()}`;
    case 'number': return `n:${v}`;
    case 'string': return `s:${v}`;
    case 'boolean': return `b:${v}`;
    case 'array': return `a:[${v.map(canonicalKey).join(',')}]`;
    default:
      return `o:{${Object.keys(v).sort().map((k) => `${k}=${canonicalKey(v[k])}`).join(',')}}`;
  }
}

function compareValues(a, b) {
  const ta = bsonType(a);
  const tb = bsonType(b);
  if (ta !== tb) return TYPE_RANK[ta] - TYPE_RANK[tb];
  switch (ta) {
    case 'null': return 0;
    case 'date': return a.getTime() - b.getTime();
    case 'number': return a - b;
    case 'boolean': return (a ? 1 : 0) - (b ? 1 : 0);
    case 'string': return a < b ? -1 : a > b ? 1 : 0;
    default: {
      const ka = canonicalKey(a);
      const kb = canonicalKey(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    }
  }
}

const valuesEqual = (a, b) => compareValues(a, b) === 0;

function resolvePath(doc, path) {
  let cur = doc;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

function isOperatorObject(cond) {
  if (cond === null || typeof cond !== 'object') return false;
  if (Array.isArray(cond) || cond instanceof Date || cond instanceof RegExp) return false;
  const keys = Object.keys(cond);
  return keys.length > 0 && keys[0].startsWith('$');
}

function regexTest(value, pattern, options) {
  if (typeof value !== 'string') return false;
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern, options ?? '');
  return re.test(value);
}

// Query range operators are type-bracketed like Mongo: a number bound never
// matches a string value (and a missing field never matches a range).
function rangeCompare(value, bound) {
  const t = bsonType(value);
  if (t === 'null' || t !== bsonType(bound)) return null;
  return compareValues(value, bound);
}

function matchesField(value, cond) {
  if (!isOperatorObject(cond)) return valuesEqual(value, cond);
  for (const [op, arg] of Object.entries(cond)) {
    switch (op) {
      case '$eq': if (!valuesEqual(value, arg)) return false; break;
      case '$ne': if (valuesEqual(value, arg)) return false; break;
      case '$in': if (!arg.some((a) => valuesEqual(value, a))) return false; break;
      case '$gt': { const c = rangeCompare(value, arg); if (c === null || c <= 0) return false; break; }
      case '$gte': { const c = rangeCompare(value, arg); if (c === null || c < 0) return false; break; }
      case '$lt': { const c = rangeCompare(value, arg); if (c === null || c >= 0) return false; break; }
      case '$lte': { const c = rangeCompare(value, arg); if (c === null || c > 0) return false; break; }
      case '$regex': if (!regexTest(value, arg, cond.$options)) return false; break;
      case '$options': break; // consumed by $regex
      default: throw new Error(`fake-collection: unsupported query operator ${op}`);
    }
  }
  return true;
}

function matchesFilter(doc, filter) {
  for (const [key, cond] of Object.entries(filter ?? {})) {
    if (key === '$and') {
      if (!cond.every((f) => matchesFilter(doc, f))) return false;
    } else if (key === '$or') {
      if (!cond.some((f) => matchesFilter(doc, f))) return false;
    } else if (!matchesField(resolvePath(doc, key), cond)) {
      return false;
    }
  }
  return true;
}

function sortDocs(docs, spec) {
  const entries = Object.entries(spec);
  return [...docs].sort((a, b) => {
    for (const [path, dir] of entries) {
      const c = compareValues(resolvePath(a, path), resolvePath(b, path));
      if (c !== 0) return c * dir;
    }
    return 0;
  });
}

const isTruthy = (v) => !(v === null || v === undefined || v === false || v === 0);

function convertToDouble(spec, doc) {
  if (spec.to !== 'double') throw new Error(`fake-collection: $convert only supports to:'double', got ${spec.to}`);
  const v = evalExpr(spec.input, doc);
  if (v === null || v === undefined) return 'onNull' in spec ? evalExpr(spec.onNull, doc) : null;
  let n = NaN; // unconvertible types (object/array) fall through to the error path
  switch (bsonType(v)) {
    case 'number': n = v; break;
    case 'boolean': n = v ? 1 : 0; break;
    case 'date': n = v.getTime(); break;
    case 'string': {
      const s = v.trim();
      n = s === '' ? NaN : Number(s);
      break;
    }
  }
  if (!Number.isNaN(n)) return n;
  if ('onError' in spec) return evalExpr(spec.onError, doc);
  throw new Error('fake-collection: $convert failed');
}

function dateTrunc(spec, doc) {
  const d = evalExpr(spec.date, doc);
  if (!(d instanceof Date)) return null;
  const ms = spec.unit === 'hour' ? 3_600_000 : spec.unit === 'day' ? 86_400_000 : null;
  if (ms === null) throw new Error(`fake-collection: $dateTrunc unit ${spec.unit} unsupported`);
  return new Date(Math.floor(d.getTime() / ms) * ms);
}

function sumNumeric(values) {
  let total = 0;
  for (const v of values) {
    if (typeof v === 'number' && !Number.isNaN(v)) total += v;
  }
  return total;
}

// `vars` carries $map's bound element (referenced as `$$<as>` / `$$<as>.field`);
// empty for ordinary field expressions.
function evalExpr(expr, doc, vars = {}) {
  if (expr === null || typeof expr === 'number' || typeof expr === 'boolean') return expr;
  if (typeof expr === 'string') {
    if (!expr.startsWith('$')) return expr;
    // `$$var` / `$$var.path` resolves against the bound variables, not the doc.
    if (expr.startsWith('$$')) {
      const ref = expr.slice(2);
      const [head, ...rest] = ref.split('.');
      const base = vars[head];
      const v = rest.length === 0 ? base : resolvePath(base, rest.join('.'));
      return v === undefined ? null : v;
    }
    const v = resolvePath(doc, expr.slice(1));
    return v === undefined ? null : v; // missing fields behave as null in expressions
  }
  if (expr instanceof Date) return expr;
  if (Array.isArray(expr)) return expr.map((e) => evalExpr(e, doc, vars));
  const keys = Object.keys(expr);
  if (keys.length === 1 && keys[0].startsWith('$')) {
    const arg = expr[keys[0]];
    switch (keys[0]) {
      case '$cond': {
        const [cIf, cThen, cElse] = Array.isArray(arg) ? arg : [arg.if, arg.then, arg.else];
        return isTruthy(evalExpr(cIf, doc, vars)) ? evalExpr(cThen, doc, vars) : evalExpr(cElse, doc, vars);
      }
      case '$eq': return valuesEqual(evalExpr(arg[0], doc, vars), evalExpr(arg[1], doc, vars));
      case '$ne': return !valuesEqual(evalExpr(arg[0], doc, vars), evalExpr(arg[1], doc, vars));
      // expression comparisons use full BSON order (null sorts below numbers),
      // so $gte:[null, 400] is false — what statusErrors in C9 relies on
      case '$gte': return compareValues(evalExpr(arg[0], doc, vars), evalExpr(arg[1], doc, vars)) >= 0;
      case '$ifNull': {
        for (let i = 0; i < arg.length - 1; i++) {
          const v = evalExpr(arg[i], doc, vars);
          if (v !== null && v !== undefined) return v;
        }
        return evalExpr(arg[arg.length - 1], doc, vars);
      }
      case '$convert': return convertToDouble(arg, doc);
      case '$dateTrunc': return dateTrunc(arg, doc);
      case '$sum': {
        const v = evalExpr(arg, doc, vars);
        return Array.isArray(v) ? sumNumeric(v) : sumNumeric([v]);
      }
      // $objectToArray({a:1,b:2}) -> [{k:'a',v:1},{k:'b',v:2}]; powers the facets
      // key-discovery pipeline (C-S1). A non-object input yields [] (the C-S1
      // pipeline always feeds it a $ifNull-guarded object, so this never sees a
      // scalar in practice, but [] is the safe, Mongo-ish degenerate).
      case '$objectToArray': {
        const v = evalExpr(arg, doc, vars);
        if (v === null || typeof v !== 'object' || Array.isArray(v) || v instanceof Date) return [];
        return Object.entries(v).map(([k, val]) => ({ k, v: val }));
      }
      // $map projects each element of an input array through `in`, binding the
      // element to the `as` variable (referenced as `$$<as>...`). Used by C-S1 to
      // turn [{k,v}] into just the keys.
      case '$map': {
        const input = evalExpr(arg.input, doc, vars);
        if (!Array.isArray(input)) return null;
        const varName = arg.as ?? 'this';
        return input.map((el) => evalExpr(arg.in, doc, { ...vars, [varName]: el }));
      }
      default: throw new Error(`fake-collection: unsupported expression operator ${keys[0]}`);
    }
  }
  const out = {};
  for (const [k, v] of Object.entries(expr)) out[k] = evalExpr(v, doc, vars);
  return out;
}

function computeAccumulator(accSpec, docs) {
  const [op] = Object.keys(accSpec);
  const arg = accSpec[op];
  switch (op) {
    case '$sum':
      return sumNumeric(docs.map((d) => evalExpr(arg, d)));
    case '$addToSet': {
      const seen = new Map();
      for (const d of docs) {
        const v = evalExpr(arg, d);
        const k = canonicalKey(v);
        if (!seen.has(k)) seen.set(k, v);
      }
      return [...seen.values()];
    }
    case '$percentile': {
      const values = [];
      for (const d of docs) {
        const v = evalExpr(arg.input, d);
        if (typeof v === 'number' && !Number.isNaN(v)) values.push(v);
      }
      values.sort((a, b) => a - b);
      // Nearest-rank, one result per requested p; all-null array when no numeric
      // inputs so C9's `latencyP[0] == null` post-processing stays index-safe.
      return arg.p.map((p) => {
        if (values.length === 0) return null;
        const rank = Math.max(1, Math.ceil(p * values.length));
        return values[Math.min(rank, values.length) - 1];
      });
    }
    default: throw new Error(`fake-collection: unsupported accumulator ${op}`);
  }
}

function groupStage(docs, spec) {
  const { _id: idSpec, ...accumulators } = spec;
  const groups = new Map();
  for (const doc of docs) {
    const key = idSpec === null || idSpec === undefined ? null : evalExpr(idSpec, doc);
    const ck = canonicalKey(key);
    let g = groups.get(ck);
    if (!g) {
      g = { key, docs: [] };
      groups.set(ck, g);
    }
    g.docs.push(doc);
  }
  return [...groups.values()].map((g) => {
    const row = { _id: g.key };
    for (const [field, accSpec] of Object.entries(accumulators)) {
      row[field] = computeAccumulator(accSpec, g.docs);
    }
    return row;
  });
}

// $project: the subset the query modules use — `_id:0` to drop the id, and
// `<field>: <expression>` to compute a new field (C-S1 maps ids/data to their
// key lists). `_id` is retained unless explicitly set to 0/false. We only
// support the inclusion+computed form the contracts emit (no path-exclusion of
// arbitrary fields), and throw on anything outside it so drift is caught.
function projectStage(docs, spec) {
  const keepId = !('_id' in spec) || isTruthy(spec._id);
  const computed = Object.entries(spec).filter(([k]) => k !== '_id');
  return docs.map((doc) => {
    const out = {};
    if (keepId) out._id = doc._id;
    for (const [field, expr] of computed) {
      if (expr === 1 || expr === true) {
        // inclusion: copy the field through if present
        const v = resolvePath(doc, field);
        if (v !== undefined) out[field] = v;
      } else if (expr === 0 || expr === false) {
        throw new Error('fake-collection: $project field-exclusion is unsupported');
      } else {
        out[field] = evalExpr(expr, doc);
      }
    }
    return out;
  });
}

// $unwind: emit one doc per element of the array at `path`. Matches the default
// (no preserveNullAndEmptyArrays): missing / non-array / empty-array docs are
// dropped, exactly like the C-S1 facets pipeline relies on.
function unwindStage(docs, pathSpec) {
  const path = (typeof pathSpec === 'string' ? pathSpec : pathSpec.path).slice(1); // strip leading $
  const out = [];
  for (const doc of docs) {
    const arr = resolvePath(doc, path);
    if (!Array.isArray(arr)) continue;
    for (const el of arr) {
      const copy = structuredClone(doc);
      setPath(copy, path, el);
      out.push(copy);
    }
  }
  return out;
}

// Set a (possibly dotted) path on a plain object, creating intermediate objects.
function setPath(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] === null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function runPipeline(docs, pipeline) {
  let cur = docs;
  for (const stage of pipeline) {
    const [op] = Object.keys(stage);
    switch (op) {
      case '$match': cur = cur.filter((d) => matchesFilter(d, stage.$match)); break;
      case '$group': cur = groupStage(cur, stage.$group); break;
      case '$sort': cur = sortDocs(cur, stage.$sort); break;
      case '$project': cur = projectStage(cur, stage.$project); break;
      case '$unwind': cur = unwindStage(cur, stage.$unwind); break;
      case '$limit': cur = cur.slice(0, stage.$limit); break;
      // $count collapses the stream to a single {<name>: n}; on an EMPTY input it
      // emits NO document (Mongo semantics), which groupby/facets callers handle.
      case '$count': cur = cur.length === 0 ? [] : [{ [stage.$count]: cur.length }]; break;
      // $facet runs each named sub-pipeline over THIS stage's input independently
      // and returns a single document whose fields are those branches' arrays
      // (C-S1 ids/data discovery, C-S2 groups/totals). Each branch sees a fresh
      // copy of the input so one branch's mutation can't leak into another.
      case '$facet': {
        const result = {};
        for (const [name, sub] of Object.entries(stage.$facet)) {
          result[name] = runPipeline(cur.map((d) => structuredClone(d)), sub);
        }
        cur = [result];
        break;
      }
      default: throw new Error(`fake-collection: unsupported pipeline stage ${op}`);
    }
  }
  return cur;
}

let fallbackIdCounter = 0;

export function createFakeCollection() {
  const store = [];

  return {
    docs: store,

    async insertMany(docs, opts = {}) {
      const ordered = opts.ordered !== false;
      const writeErrors = [];
      let insertedCount = 0;
      const insertedIds = {};
      for (let i = 0; i < docs.length; i++) {
        const copy = structuredClone(docs[i]);
        if (copy._id === undefined) copy._id = `fake-id-${++fallbackIdCounter}`;
        // Scan the store (not a side index) so docs seeded directly via the raw
        // `docs` array participate in duplicate detection; in-batch dupes are
        // caught too because accepted docs land in the store immediately.
        if (store.some((d) => valuesEqual(d._id, copy._id))) {
          writeErrors.push({ code: 11000, index: i });
          if (ordered) break;
          continue;
        }
        store.push(copy);
        insertedIds[i] = copy._id;
        insertedCount++;
      }
      if (writeErrors.length > 0) {
        // Exact shape the flusher's dup detection (C6) reads: e.code single form,
        // e.writeErrors[].code per failed doc, e.result.insertedCount.
        const err = new Error(`E11000 duplicate key error (fake collection): ${writeErrors.length} duplicate(s)`);
        err.code = 11000;
        err.writeErrors = writeErrors;
        err.result = { insertedCount };
        throw err;
      }
      return { acknowledged: true, insertedCount, insertedIds };
    },

    find(filter = {}) {
      let sortSpec = null;
      let limitN = Infinity;
      const cursor = {
        sort(s) { sortSpec = s; return cursor; },
        limit(n) { limitN = n; return cursor; },
        // Real driver chains .maxTimeMS() for the query execution cap (C8
        // security mitigation). In-memory queries are instant, so this is a
        // no-op passthrough that just preserves the chainable cursor surface.
        maxTimeMS() { return cursor; },
        async toArray() {
          let res = store.filter((d) => matchesFilter(d, filter));
          if (sortSpec) res = sortDocs(res, sortSpec);
          if (limitN !== Infinity) res = res.slice(0, limitN);
          return res.map((d) => structuredClone(d));
        },
      };
      return cursor;
    },

    // Second arg mirrors the real driver's options (e.g. { maxTimeMS }); queries
    // are in-memory and instant, so it is accepted and ignored — same no-op
    // contract as the find() cursor's maxTimeMS().
    aggregate(pipeline, _opts) {
      return {
        async toArray() {
          return runPipeline(store, pipeline).map((d) => structuredClone(d));
        },
      };
    },

    async countDocuments(filter = {}) {
      return store.filter((d) => matchesFilter(d, filter)).length;
    },

    async createIndex() {
      return 'fake_index';
    },

    async createIndexes(specs = []) {
      return specs.map((_, i) => `fake_index_${i}`);
    },
  };
}
