import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, validateProjectInput } from '../src/projects.js';

test('slugify: kebab-cases and trims', () => {
  assert.equal(slugify('Acme Platform'), 'acme-platform');
  assert.equal(slugify('  Weird__Name!!  '), 'weird-name');
});

test('validate create: requires a non-empty name', () => {
  assert.equal(validateProjectInput({}, { partial: false }).ok, false);
  assert.equal(validateProjectInput({ name: '   ' }).ok, false);
});

test('validate create: trims name, defaults apps to []', () => {
  const r = validateProjectInput({ name: '  Acme  ' });
  assert.deepEqual(r, { ok: true, value: { name: 'Acme', apps: [] } });
});

test('validate: apps must be unique non-empty strings', () => {
  assert.equal(validateProjectInput({ name: 'A', apps: ['', 'x'] }).ok, false);
  assert.equal(validateProjectInput({ name: 'A', apps: [1] }).ok, false);
  assert.deepEqual(
    validateProjectInput({ name: 'A', apps: ['web', 'web', 'api'] }).value.apps,
    ['web', 'api'],
  );
});

test('validate: rejects unknown keys', () => {
  assert.equal(validateProjectInput({ name: 'A', color: 'red' }).ok, false);
});

test('validate patch: name optional, unknown key rejected', () => {
  assert.deepEqual(validateProjectInput({ apps: ['x'] }, { partial: true }), {
    ok: true, value: { apps: ['x'] },
  });
  assert.equal(validateProjectInput({ slug: 'a' }, { partial: true }).ok, false);
});
