import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createKeyring, canWrite, canRead } from '../src/auth.js';

const KEYS = [
  { key: 'wk-dash-prod-001', app: 'dailyDashboard', env: 'prod', mode: 'write' },
  { key: 'wk-scraper-dev-9', app: 'scraper', env: 'dev', mode: 'write' },
  { key: 'rk-assistant-001', app: 'assistant', env: 'prod', mode: 'read' },
];

describe('createKeyring().authenticate', () => {
  const keyring = createKeyring(KEYS);

  test('valid write key returns principal with app/env/mode only', () => {
    const p = keyring.authenticate('Bearer wk-dash-prod-001');
    assert.deepEqual(p, { app: 'dailyDashboard', env: 'prod', mode: 'write' });
  });

  test('each key maps to its own principal', () => {
    const p = keyring.authenticate('Bearer wk-scraper-dev-9');
    assert.deepEqual(p, { app: 'scraper', env: 'dev', mode: 'write' });
  });

  test('valid read key returns mode read', () => {
    const p = keyring.authenticate('Bearer rk-assistant-001');
    assert.deepEqual(p, { app: 'assistant', env: 'prod', mode: 'read' });
  });

  test('unknown key returns null', () => {
    assert.equal(keyring.authenticate('Bearer no-such-key-0000'), null);
  });

  test('missing header returns null', () => {
    assert.equal(keyring.authenticate(undefined), null);
  });

  test('empty string header returns null', () => {
    assert.equal(keyring.authenticate(''), null);
  });

  test('non-Bearer scheme returns null', () => {
    assert.equal(keyring.authenticate('Basic wk-dash-prod-001'), null);
  });

  test('bare key without scheme returns null', () => {
    assert.equal(keyring.authenticate('wk-dash-prod-001'), null);
  });

  test('Bearer with no token returns null', () => {
    assert.equal(keyring.authenticate('Bearer'), null);
    assert.equal(keyring.authenticate('Bearer '), null);
  });

  test('scheme is case-insensitive: bearer', () => {
    const p = keyring.authenticate('bearer wk-dash-prod-001');
    assert.deepEqual(p, { app: 'dailyDashboard', env: 'prod', mode: 'write' });
  });

  test('scheme is case-insensitive: BEARER', () => {
    const p = keyring.authenticate('BEARER rk-assistant-001');
    assert.deepEqual(p, { app: 'assistant', env: 'prod', mode: 'read' });
  });

  test('scheme is case-insensitive: mixed case', () => {
    const p = keyring.authenticate('BeArEr wk-dash-prod-001');
    assert.deepEqual(p, { app: 'dailyDashboard', env: 'prod', mode: 'write' });
  });

  test('extra whitespace between scheme and token is tolerated', () => {
    const p = keyring.authenticate('Bearer    wk-dash-prod-001');
    assert.deepEqual(p, { app: 'dailyDashboard', env: 'prod', mode: 'write' });
  });

  test('tab between scheme and token is tolerated', () => {
    const p = keyring.authenticate('Bearer\twk-dash-prod-001');
    assert.deepEqual(p, { app: 'dailyDashboard', env: 'prod', mode: 'write' });
  });

  test('trailing whitespace is part of the token per the scheme regex', () => {
    // /^Bearer\s+(.+)$/ captures trailing spaces into the token => no match.
    assert.equal(keyring.authenticate('Bearer wk-dash-prod-001 '), null);
  });

  test('token of different length than any key does not throw', () => {
    assert.equal(keyring.authenticate('Bearer x'), null);
    assert.equal(
      keyring.authenticate('Bearer a-token-much-longer-than-any-configured-key-value'),
      null,
    );
  });

  test('prefix of a real key does not authenticate', () => {
    assert.equal(keyring.authenticate('Bearer wk-dash-prod-00'), null);
  });

  test('same-length wrong key returns null', () => {
    assert.equal(keyring.authenticate('Bearer wk-dash-prod-002'), null);
  });

  test('empty keyring authenticates nothing', () => {
    const empty = createKeyring([]);
    assert.equal(empty.authenticate('Bearer wk-dash-prod-001'), null);
  });

  test('returned principal is a fresh object per call', () => {
    const a = keyring.authenticate('Bearer wk-dash-prod-001');
    a.mode = 'read';
    const b = keyring.authenticate('Bearer wk-dash-prod-001');
    assert.equal(b.mode, 'write');
  });
});

describe('canWrite / canRead truth table', () => {
  test('canWrite', () => {
    assert.equal(canWrite({ mode: 'write' }), true);
    assert.equal(canWrite({ mode: 'read' }), false);
    assert.equal(canWrite({ mode: 'other' }), false);
    assert.equal(canWrite(null), false);
    assert.equal(canWrite(undefined), false);
  });

  test('canRead', () => {
    assert.equal(canRead({ mode: 'write' }), true);
    assert.equal(canRead({ mode: 'read' }), true);
    assert.equal(canRead({ mode: 'other' }), false);
    assert.equal(canRead(null), false);
    assert.equal(canRead(undefined), false);
  });
});
