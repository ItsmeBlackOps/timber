import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWhere } from '../../web/api/_lib/where.js';
import { appScopeSql } from '../../web/api/_lib/scope.js';

test('buildWhere maps common filters to clauses + params', () => {
  const r = buildWhere(new URLSearchParams('env=prod&level=warn,error&event=cron.&data.status__gte=400'));
  assert.equal(r.ok, true);
  assert.deepEqual(r.clauses, [
    'env = $1',
    'level = ANY($2)',
    'event LIKE $3',
    '(data #>> $4)::numeric >= $5',
  ]);
  assert.deepEqual(r.params, ['prod', ['warn', 'error'], 'cron.%', ['status'], 400]);
});

test('app is captured into value.app, not a clause', () => {
  const r = buildWhere(new URLSearchParams('app=firehook'));
  assert.deepEqual(r.clauses, []);
  assert.equal(r.value.app, 'firehook');
});

test('ids.* and data.* eq use #>> with a path param (injection-safe)', () => {
  const r = buildWhere(new URLSearchParams('ids.userId=u1&data.model=gpt'));
  assert.deepEqual(r.clauses, ['ids #>> $1 = $2', 'data #>> $3 = $4']);
  assert.deepEqual(r.params, [['userId'], 'u1', ['model'], 'gpt']);
});

test('cursor becomes a keyset predicate with 2 params', () => {
  const cur = Buffer.from('1750550400000:99', 'utf8').toString('base64url');
  const r = buildWhere(new URLSearchParams(`cursor=${cur}`));
  assert.equal(r.clauses[0], '(received_at < $1 OR (received_at = $1 AND id < $2))');
  assert.equal(r.params[1], '99');
});

test('from/to add a received_at range and reject inverted windows', () => {
  const ok = buildWhere(new URLSearchParams('from=1750550400000&to=1750636800000'));
  assert.deepEqual(ok.clauses, ['received_at >= $1', 'received_at < $2']);
  assert.equal(buildWhere(new URLSearchParams('from=2026-06-02&to=2026-06-01')).ok, false);
});

test('unknown param, bad level, and catastrophic q all fail closed', () => {
  assert.equal(buildWhere(new URLSearchParams('nope=1')).ok, false);
  assert.equal(buildWhere(new URLSearchParams('level=trace')).ok, false);
  assert.equal(buildWhere(new URLSearchParams('q=(a%2B)%2B')).ok, false); // q = (a+)+
});

test('appScopeSql composes the app constraint with continuing placeholders', () => {
  const params = ['prod'];
  assert.equal(appScopeSql('web', undefined, params), 'app = $2');
  assert.deepEqual(params, ['prod', 'web']);

  const p2 = [];
  assert.equal(appScopeSql(undefined, ['a', 'b'], p2), 'app = ANY($1)');
  assert.deepEqual(p2, [['a', 'b']]);

  assert.equal(appScopeSql('x', ['a', 'b'], []), 'false'); // non-member
  assert.equal(appScopeSql(undefined, [], []), 'false'); // empty project
  assert.equal(appScopeSql(undefined, undefined, []), null); // no constraint
});
