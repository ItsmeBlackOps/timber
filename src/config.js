export class ConfigError extends Error {}

const MB = 1024 * 1024;

// Blank/whitespace-only values are treated as unset: Number('') === 0 would
// otherwise turn an empty compose var into a bogus zero.
function rawEnv(env, name) {
  const v = env[name];
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
}

function strEnv(env, name, def) {
  return rawEnv(env, name) ?? def;
}

function readNumber(env, name, def, { allowZero = false } = {}) {
  const s = rawEnv(env, name);
  if (s === undefined) return def;
  const n = Number(s);
  if (!Number.isFinite(n)) {
    throw new ConfigError(`${name} must be numeric, got ${JSON.stringify(s)}`);
  }
  if (n < 0 || (n === 0 && !allowZero)) {
    throw new ConfigError(`${name} must be ${allowZero ? '>= 0' : '> 0'}, got ${s}`);
  }
  return n;
}

function positiveInt(env, name, def) {
  const v = Math.floor(readNumber(env, name, def));
  if (v < 1) throw new ConfigError(`${name} must be a positive integer, got ${rawEnv(env, name)}`);
  return v;
}

function clampedInt(env, name, def, lo, hi) {
  const v = Math.floor(readNumber(env, name, def));
  return Math.min(hi, Math.max(lo, v));
}

function mbEnvToBytes(env, name, defMb) {
  return Math.floor(readNumber(env, name, defMb) * MB);
}

function warn(message) {
  process.stderr.write(`[timber] warning: ${message}\n`);
}

function parseKeys(env) {
  const s = rawEnv(env, 'TIMBER_KEYS');
  let entries = [];
  if (s !== undefined) {
    let parsed;
    try {
      parsed = JSON.parse(s);
    } catch (err) {
      throw new ConfigError(`TIMBER_KEYS is not valid JSON: ${err.message}`);
    }
    if (!Array.isArray(parsed)) {
      throw new ConfigError('TIMBER_KEYS must be a JSON array of {key, app, env, mode} objects');
    }
    entries = parsed.map((e, i) => {
      if (typeof e !== 'object' || e === null || Array.isArray(e)) {
        throw new ConfigError(`TIMBER_KEYS[${i}] must be an object`);
      }
      for (const field of ['key', 'app', 'env']) {
        if (typeof e[field] !== 'string' || e[field].length === 0) {
          throw new ConfigError(`TIMBER_KEYS[${i}] is missing required string field "${field}"`);
        }
      }
      if (e.mode !== 'write' && e.mode !== 'read') {
        throw new ConfigError(`TIMBER_KEYS[${i}].mode must be "write" or "read", got ${JSON.stringify(e.mode)}`);
      }
      return Object.freeze({ key: e.key, app: e.app, env: e.env, mode: e.mode });
    });
  }
  if (entries.length === 0) {
    warn('TIMBER_KEYS is empty or unset — no API keys configured, every request will be rejected');
  }
  return Object.freeze(entries);
}

export function loadConfig(env = process.env) {
  return Object.freeze({
    port: positiveInt(env, 'PORT', 7710),
    mongodbUri: rawEnv(env, 'MONGODB_URI') ?? null,
    mongoDbName: strEnv(env, 'TIMBER_DB', 'appLogs'),
    mongoCollectionName: strEnv(env, 'TIMBER_COLLECTION', 'events'),
    keys: parseKeys(env),
    walDir: strEnv(env, 'TIMBER_WAL_DIR', './wal-data'),
    walBudgetBytes: mbEnvToBytes(env, 'TIMBER_WAL_BUDGET_MB', 2048),
    walFsyncMs: clampedInt(env, 'TIMBER_WAL_FSYNC_MS', 50, 1, 1000),
    walSegmentMaxBytes: mbEnvToBytes(env, 'TIMBER_WAL_SEGMENT_MB', 64),
    walRetainHours: readNumber(env, 'TIMBER_WAL_RETAIN_HOURS', 24),
    ttlDays: Object.freeze({
      debug: readNumber(env, 'TIMBER_TTL_DEBUG_DAYS', 7),
      info: readNumber(env, 'TIMBER_TTL_INFO_DAYS', 30),
      warn: readNumber(env, 'TIMBER_TTL_WARN_DAYS', 90),
      error: readNumber(env, 'TIMBER_TTL_ERROR_DAYS', 90),
    }),
    flushBatchSize: clampedInt(env, 'TIMBER_FLUSH_BATCH', 1000, 1, 1000),
    flushIntervalMs: positiveInt(env, 'TIMBER_FLUSH_INTERVAL_MS', 200),
    // Server-side cap on read-query execution (maxTimeMS). Bounds catastrophic
    // $regex backtracking and unindexed COLLSCANs so a single read request can't
    // pin a Mongo worker indefinitely. 0 disables the cap.
    queryMaxTimeMs: clampedInt(env, 'TIMBER_QUERY_MAX_TIME_MS', 5000, 0, 600000),
    // 0 is the documented default (cluster mode off), so explicit 0 is valid here.
    clusterWorkers: Math.floor(readNumber(env, 'TIMBER_CLUSTER', 0, { allowZero: true })),
    maxBodyBytes: 1_048_576,
    maxBatch: 500,
    maxDataBytes: 16_384,
    maxMessageChars: 512,
    maxIdsKeys: 10,
  });
}
