import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildClientOptions, connectMongo, ensureIndexes } from '../src/mongo.js';

// C7 index list, in contract order.
const EXPECTED_SPECS = [
  { key: { receivedAt: -1 } },
  { key: { app: 1, receivedAt: -1 } },
  { key: { event: 1, receivedAt: -1 } },
  { key: { level: 1, receivedAt: -1 } },
  { key: { 'ids.requestId': 1 }, sparse: true },
  { key: { 'ids.taskId': 1 }, sparse: true },
  { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
];

function makeStubCollection({ failWith } = {}) {
  const calls = [];
  return {
    calls,
    async createIndexes(specs, options) {
      calls.push({ specs, options });
      if (failWith) throw failWith;
      return specs.map((s, i) => `idx_${i}`);
    },
  };
}

test('buildClientOptions returns exactly the C7 timeouts', () => {
  assert.deepEqual(buildClientOptions(), {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000,
  });
});

test('buildClientOptions returns a fresh object per call', () => {
  const a = buildClientOptions();
  const b = buildClientOptions();
  assert.notEqual(a, b);
  a.serverSelectionTimeoutMS = 1;
  assert.equal(buildClientOptions().serverSelectionTimeoutMS, 5000);
});

test('ensureIndexes issues the exact 7 index specs in one createIndexes call', async () => {
  const stub = makeStubCollection();
  const result = await ensureIndexes(stub);
  assert.equal(result, undefined);
  assert.equal(stub.calls.length, 1);
  assert.deepEqual(stub.calls[0].specs, EXPECTED_SPECS);
});

test('compound index key order is preserved', async () => {
  // deepEqual ignores property order; Mongo compound indexes do not.
  const stub = makeStubCollection();
  await ensureIndexes(stub);
  const keys = stub.calls[0].specs.map((s) => Object.keys(s.key));
  assert.deepEqual(keys[1], ['app', 'receivedAt']);
  assert.deepEqual(keys[2], ['event', 'receivedAt']);
  assert.deepEqual(keys[3], ['level', 'receivedAt']);
});

test('sparse applies only to ids.* indexes; TTL only to expiresAt', async () => {
  const stub = makeStubCollection();
  await ensureIndexes(stub);
  const specs = stub.calls[0].specs;
  const byFirstKey = Object.fromEntries(specs.map((s) => [Object.keys(s.key)[0], s]));
  assert.equal(byFirstKey['ids.requestId'].sparse, true);
  assert.equal(byFirstKey['ids.taskId'].sparse, true);
  assert.equal(byFirstKey.expiresAt.expireAfterSeconds, 0);
  for (const firstKey of ['receivedAt', 'app', 'event', 'level']) {
    assert.equal('sparse' in byFirstKey[firstKey], false);
    assert.equal('expireAfterSeconds' in byFirstKey[firstKey], false);
  }
});

test('ensureIndexes can be called repeatedly with identical specs', async () => {
  const stub = makeStubCollection();
  await ensureIndexes(stub);
  await ensureIndexes(stub);
  assert.equal(stub.calls.length, 2);
  assert.deepEqual(stub.calls[0].specs, stub.calls[1].specs);
});

test('ensureIndexes propagates driver errors (server boot loop relies on this to retry)', async () => {
  const boom = Object.assign(new Error('IndexOptionsConflict'), { code: 85 });
  const stub = makeStubCollection({ failWith: boom });
  await assert.rejects(() => ensureIndexes(stub), boom);
});

test('connectMongo is exported as a function (exercised only by integration tests)', () => {
  // Never invoked here: unit tests must not construct a real connection.
  assert.equal(typeof connectMongo, 'function');
});
