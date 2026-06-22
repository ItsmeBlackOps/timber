import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateProjectInput, slugify } from '../../web/api/_lib/projects.js';

test('slugify lowercases, collapses non-alphanumerics, trims dashes', () => {
  assert.equal(slugify('My App!!  2'), 'my-app-2');
  assert.equal(slugify('  --Hello--  '), 'hello');
});

test('validateProjectInput (create) requires name and dedupes apps', () => {
  assert.equal(validateProjectInput({}, { partial: false }).ok, false);
  const v = validateProjectInput({ name: ' A ', apps: ['x', 'x', 'y'] }, { partial: false });
  assert.deepEqual(v.value, { name: 'A', apps: ['x', 'y'] });
  assert.equal(validateProjectInput({ name: 'A', bad: 1 }).ok, false);
  assert.deepEqual(validateProjectInput({ name: 'A' }, { partial: false }).value, { name: 'A', apps: [] });
});

test('validateProjectInput (patch) allows partial bodies', () => {
  assert.deepEqual(validateProjectInput({ apps: ['z'] }, { partial: true }).value, { apps: ['z'] });
  assert.equal(validateProjectInput({}, { partial: true }).ok, true);
  assert.equal(validateProjectInput({ name: '' }, { partial: true }).ok, false);
});
