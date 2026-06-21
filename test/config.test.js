import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, ConfigError } from '../src/config.js';

const MB = 1024 * 1024;

const VALID_KEYS = JSON.stringify([
  { key: 'wk-1', app: 'dailyDashboard', env: 'prod', mode: 'write' },
  { key: 'rk-1', app: 'assistant', env: 'prod', mode: 'read' },
]);

function quietStderr(t) {
  return t.mock.method(process.stderr, 'write', () => true);
}

test('defaults: empty env yields every documented default', (t) => {
  quietStderr(t);
  const cfg = loadConfig({});

  assert.equal(cfg.port, 7710);
  assert.equal(cfg.mongodbUri, null);
  assert.equal(cfg.mongoDbName, 'appLogs');
  assert.equal(cfg.mongoCollectionName, 'events');
  assert.deepEqual(cfg.keys, []);
  assert.equal(cfg.walDir, './wal-data');
  assert.equal(cfg.walBudgetBytes, 2048 * MB);
  assert.equal(cfg.walFsyncMs, 50);
  assert.equal(cfg.walSegmentMaxBytes, 64 * MB);
  assert.equal(cfg.walRetainHours, 24);
  assert.deepEqual(cfg.ttlDays, { debug: 7, info: 30, warn: 90, error: 90 });
  assert.equal(cfg.flushBatchSize, 1000);
  assert.equal(cfg.flushIntervalMs, 200);
  assert.equal(cfg.clusterWorkers, 0);

  assert.equal(cfg.maxBodyBytes, 1_048_576);
  assert.equal(cfg.maxBatch, 500);
  assert.equal(cfg.maxDataBytes, 65_536);
  assert.equal(cfg.maxMessageChars, 512);
  assert.equal(cfg.maxIdsKeys, 10);
});

test('defaults: missing TIMBER_KEYS warns to stderr naming the variable', (t) => {
  const spy = quietStderr(t);
  loadConfig({});
  const out = spy.mock.calls.map((c) => String(c.arguments[0])).join('');
  assert.match(out, /TIMBER_KEYS/);
});

test('no stderr warning when TIMBER_KEYS provides keys', (t) => {
  const spy = quietStderr(t);
  loadConfig({ TIMBER_KEYS: VALID_KEYS });
  assert.equal(spy.mock.calls.length, 0);
});

test('every env override is honored', (t) => {
  quietStderr(t);
  const cfg = loadConfig({
    PORT: '8080',
    MONGODB_URI: 'mongodb://localhost:27017',
    TIMBER_DB: 'otherDb',
    TIMBER_COLLECTION: 'otherEvents',
    TIMBER_KEYS: VALID_KEYS,
    TIMBER_WAL_DIR: 'C:/tmp/timber-wal',
    TIMBER_WAL_BUDGET_MB: '512',
    TIMBER_WAL_FSYNC_MS: '25',
    TIMBER_WAL_SEGMENT_MB: '8',
    TIMBER_WAL_RETAIN_HOURS: '48',
    TIMBER_TTL_DEBUG_DAYS: '1',
    TIMBER_TTL_INFO_DAYS: '2',
    TIMBER_TTL_WARN_DAYS: '3',
    TIMBER_TTL_ERROR_DAYS: '4',
    TIMBER_FLUSH_BATCH: '250',
    TIMBER_FLUSH_INTERVAL_MS: '100',
    TIMBER_CLUSTER: '4',
  });

  assert.equal(cfg.port, 8080);
  assert.equal(cfg.mongodbUri, 'mongodb://localhost:27017');
  assert.equal(cfg.mongoDbName, 'otherDb');
  assert.equal(cfg.mongoCollectionName, 'otherEvents');
  assert.deepEqual(cfg.keys, [
    { key: 'wk-1', app: 'dailyDashboard', env: 'prod', mode: 'write' },
    { key: 'rk-1', app: 'assistant', env: 'prod', mode: 'read' },
  ]);
  assert.equal(cfg.walDir, 'C:/tmp/timber-wal');
  assert.equal(cfg.walBudgetBytes, 512 * MB);
  assert.equal(cfg.walFsyncMs, 25);
  assert.equal(cfg.walSegmentMaxBytes, 8 * MB);
  assert.equal(cfg.walRetainHours, 48);
  assert.deepEqual(cfg.ttlDays, { debug: 1, info: 2, warn: 3, error: 4 });
  assert.equal(cfg.flushBatchSize, 250);
  assert.equal(cfg.flushIntervalMs, 100);
  assert.equal(cfg.clusterWorkers, 4);
});

test('MB env vars convert to bytes', (t) => {
  quietStderr(t);
  const cfg = loadConfig({ TIMBER_WAL_BUDGET_MB: '100', TIMBER_WAL_SEGMENT_MB: '1' });
  assert.equal(cfg.walBudgetBytes, 100 * MB);
  assert.equal(cfg.walSegmentMaxBytes, 1 * MB);
});

test('ttl overrides apply per level, others keep defaults', (t) => {
  quietStderr(t);
  const cfg = loadConfig({ TIMBER_TTL_WARN_DAYS: '14' });
  assert.deepEqual(cfg.ttlDays, { debug: 7, info: 30, warn: 14, error: 90 });
});

test('walFsyncMs and flushBatchSize clamp into range', (t) => {
  quietStderr(t);
  const high = loadConfig({ TIMBER_WAL_FSYNC_MS: '5000', TIMBER_FLUSH_BATCH: '99999' });
  assert.equal(high.walFsyncMs, 1000);
  assert.equal(high.flushBatchSize, 1000);

  const low = loadConfig({ TIMBER_WAL_FSYNC_MS: '0.5', TIMBER_FLUSH_BATCH: '0.5' });
  assert.equal(low.walFsyncMs, 1);
  assert.equal(low.flushBatchSize, 1);
});

test('blank env values fall back to defaults', (t) => {
  quietStderr(t);
  const cfg = loadConfig({ PORT: '', MONGODB_URI: '  ', TIMBER_WAL_FSYNC_MS: ' ' });
  assert.equal(cfg.port, 7710);
  assert.equal(cfg.mongodbUri, null);
  assert.equal(cfg.walFsyncMs, 50);
});

test('ConfigError: non-numeric / non-positive numerics name the variable', (t) => {
  quietStderr(t);
  for (const [name, value] of [
    ['PORT', 'abc'],
    ['PORT', '0'],
    ['PORT', '-5'],
    ['TIMBER_WAL_BUDGET_MB', 'big'],
    ['TIMBER_WAL_FSYNC_MS', 'fast'], // non-numeric still throws; 0/negative clamp (see clamp test)
    ['TIMBER_WAL_SEGMENT_MB', '-1'],
    ['TIMBER_WAL_RETAIN_HOURS', 'soon'],
    ['TIMBER_TTL_INFO_DAYS', '0'],
    ['TIMBER_FLUSH_BATCH', 'x'],
    ['TIMBER_FLUSH_INTERVAL_MS', '-200'],
    ['TIMBER_CLUSTER', 'two'],
    ['TIMBER_CLUSTER', '-1'],
  ]) {
    assert.throws(
      () => loadConfig({ [name]: value }),
      (err) => err instanceof ConfigError && err.message.includes(name),
      `${name}=${value} must throw ConfigError naming ${name}`,
    );
  }
});

test('clusterWorkers accepts explicit 0 (its documented default = off)', (t) => {
  quietStderr(t);
  assert.equal(loadConfig({ TIMBER_CLUSTER: '0' }).clusterWorkers, 0);
});

test('clamped fields coerce out-of-range values to the bound (C1 "clamp 1..1000"), never throw', (t) => {
  quietStderr(t);
  // 0 and negative coerce up to the floor (1); over-max coerces down to the cap.
  assert.equal(loadConfig({ TIMBER_WAL_FSYNC_MS: '0' }).walFsyncMs, 1);
  assert.equal(loadConfig({ TIMBER_WAL_FSYNC_MS: '-5' }).walFsyncMs, 1);
  assert.equal(loadConfig({ TIMBER_WAL_FSYNC_MS: '5000' }).walFsyncMs, 1000);
  assert.equal(loadConfig({ TIMBER_FLUSH_BATCH: '0' }).flushBatchSize, 1);
  assert.equal(loadConfig({ TIMBER_FLUSH_BATCH: '999999' }).flushBatchSize, 1000);
  // queryMaxTimeMs clamps with a floor of 0 (0 disables the cap).
  assert.equal(loadConfig({ TIMBER_QUERY_MAX_TIME_MS: '-1' }).queryMaxTimeMs, 0);
  assert.equal(loadConfig({ TIMBER_QUERY_MAX_TIME_MS: '0' }).queryMaxTimeMs, 0);
  // non-numeric is a typo, not a bound — still throws.
  assert.throws(() => loadConfig({ TIMBER_FLUSH_BATCH: 'lots' }), ConfigError);
});

test('host: default 0.0.0.0, overridable via TIMBER_HOST', (t) => {
  quietStderr(t);
  assert.equal(loadConfig({}).host, '0.0.0.0');
  assert.equal(loadConfig({ TIMBER_HOST: '127.0.0.1' }).host, '127.0.0.1');
});

test('ConfigError: malformed TIMBER_KEYS JSON', (t) => {
  quietStderr(t);
  assert.throws(
    () => loadConfig({ TIMBER_KEYS: 'not json' }),
    (err) => err instanceof ConfigError && err.message.includes('TIMBER_KEYS'),
  );
});

test('ConfigError: TIMBER_KEYS not an array', (t) => {
  quietStderr(t);
  assert.throws(
    () => loadConfig({ TIMBER_KEYS: '{"key":"k"}' }),
    (err) => err instanceof ConfigError && err.message.includes('TIMBER_KEYS'),
  );
});

test('ConfigError: key entry missing key/app/env', (t) => {
  quietStderr(t);
  const cases = [
    [{ app: 'a', env: 'e', mode: 'write' }],
    [{ key: 'k', env: 'e', mode: 'write' }],
    [{ key: 'k', app: 'a', mode: 'write' }],
    ['not-an-object'],
  ];
  for (const entry of cases) {
    assert.throws(
      () => loadConfig({ TIMBER_KEYS: JSON.stringify(entry) }),
      (err) => err instanceof ConfigError && err.message.includes('TIMBER_KEYS'),
      `entry ${JSON.stringify(entry)} must throw`,
    );
  }
});

test('ConfigError: key mode outside {write,read}', (t) => {
  quietStderr(t);
  for (const mode of ['admin', '', undefined]) {
    const entry = { key: 'k', app: 'a', env: 'e' };
    if (mode !== undefined) entry.mode = mode;
    assert.throws(
      () => loadConfig({ TIMBER_KEYS: JSON.stringify([entry]) }),
      (err) => err instanceof ConfigError && err.message.includes('TIMBER_KEYS'),
      `mode=${String(mode)} must throw`,
    );
  }
});

test('ConfigError is an Error subclass', () => {
  const err = new ConfigError('boom');
  assert.ok(err instanceof Error);
  assert.equal(err.message, 'boom');
});

test('result is frozen (including nested keys/ttlDays)', (t) => {
  quietStderr(t);
  const cfg = loadConfig({ TIMBER_KEYS: VALID_KEYS });
  assert.ok(Object.isFrozen(cfg));
  assert.ok(Object.isFrozen(cfg.ttlDays));
  assert.ok(Object.isFrozen(cfg.keys));
  assert.ok(Object.isFrozen(cfg.keys[0]));
  assert.throws(() => { cfg.port = 1; }, TypeError);
  assert.throws(() => { cfg.ttlDays.debug = 999; }, TypeError);
});

test('key entries are normalized to exactly {key, app, env, mode}', (t) => {
  quietStderr(t);
  const cfg = loadConfig({
    TIMBER_KEYS: JSON.stringify([
      { key: 'k', app: 'a', env: 'e', mode: 'read', extra: 'ignored' },
    ]),
  });
  assert.deepEqual(cfg.keys, [{ key: 'k', app: 'a', env: 'e', mode: 'read' }]);
});

// Contract C-S4: per-event `data` cap is configurable via TIMBER_MAX_DATA_KB
// (KB -> bytes). Default 64 KB (65536), clamp 1..15360 KB, non-numeric throws.
const KB = 1024;

test('maxDataBytes: default is 64 KB (65536 bytes) when TIMBER_MAX_DATA_KB unset', (t) => {
  quietStderr(t);
  assert.equal(loadConfig({}).maxDataBytes, 65_536);
  assert.equal(loadConfig({}).maxDataBytes, 64 * KB);
});

test('maxDataBytes: TIMBER_MAX_DATA_KB is interpreted as KB and converted to bytes', (t) => {
  quietStderr(t);
  assert.equal(loadConfig({ TIMBER_MAX_DATA_KB: '256' }).maxDataBytes, 262_144);
  assert.equal(loadConfig({ TIMBER_MAX_DATA_KB: '256' }).maxDataBytes, 256 * KB);
  assert.equal(loadConfig({ TIMBER_MAX_DATA_KB: '1' }).maxDataBytes, 1 * KB);
});

test('maxDataBytes: clamps to the [1, 15360] KB range, never throws on out-of-range', (t) => {
  quietStderr(t);
  // Over the ceiling coerces down to 15360 KB (stays under Mongo's 16 MB doc limit).
  assert.equal(loadConfig({ TIMBER_MAX_DATA_KB: '999999' }).maxDataBytes, 15_360 * KB);
  // 0 and negative coerce up to the floor of 1 KB.
  assert.equal(loadConfig({ TIMBER_MAX_DATA_KB: '0' }).maxDataBytes, 1 * KB);
  assert.equal(loadConfig({ TIMBER_MAX_DATA_KB: '-5' }).maxDataBytes, 1 * KB);
});

test('maxDataBytes: non-numeric TIMBER_MAX_DATA_KB throws ConfigError naming the variable', (t) => {
  quietStderr(t);
  assert.throws(
    () => loadConfig({ TIMBER_MAX_DATA_KB: 'huge' }),
    (err) => err instanceof ConfigError && err.message.includes('TIMBER_MAX_DATA_KB'),
  );
});

test('maxDataBytes: blank/whitespace TIMBER_MAX_DATA_KB falls back to the default', (t) => {
  quietStderr(t);
  assert.equal(loadConfig({ TIMBER_MAX_DATA_KB: '  ' }).maxDataBytes, 65_536);
});

test('projects + jobs config: defaults', (t) => {
  quietStderr(t);
  const cfg = loadConfig({});
  assert.equal(cfg.mongoProjectsCollectionName, 'projects');
  assert.deepEqual(cfg.jobsEventPrefixes, ['cron.']);
});

test('projects + jobs config: overrides (CSV prefixes trimmed)', (t) => {
  quietStderr(t);
  const cfg = loadConfig({
    TIMBER_PROJECTS_COLLECTION: 'proj',
    TIMBER_JOBS_EVENT_PREFIX: 'cron., job. , task.',
  });
  assert.equal(cfg.mongoProjectsCollectionName, 'proj');
  assert.deepEqual(cfg.jobsEventPrefixes, ['cron.', 'job.', 'task.']);
});
