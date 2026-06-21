import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appScope } from '../src/query/scope.js';

test('no app, no project -> no constraint', () => {
  assert.deepEqual(appScope(undefined, undefined), {});
  assert.deepEqual(appScope('', undefined), {});
});
test('single app, no project -> equality', () => {
  assert.deepEqual(appScope('web', undefined), { app: 'web' });
});
test('project only -> $in over member apps', () => {
  assert.deepEqual(appScope(undefined, ['web', 'api']), { app: { $in: ['web', 'api'] } });
});
test('empty project -> matches nothing', () => {
  assert.deepEqual(appScope(undefined, []), { app: { $in: [] } });
});
test('app within project -> drill-down equality', () => {
  assert.deepEqual(appScope('web', ['web', 'api']), { app: 'web' });
});
test('app outside project -> matches nothing', () => {
  assert.deepEqual(appScope('x', ['web', 'api']), { app: { $in: [] } });
});
