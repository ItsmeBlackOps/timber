import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGroupByQuery, buildGroupBySql, mapGroupByRows } from '../../web/api/_lib/sql/groupby.js';

test('parseGroupByQuery requires a whitelisted by field', () => {
  assert.equal(parseGroupByQuery(new URLSearchParams('')).ok, false);
  assert.equal(parseGroupByQuery(new URLSearchParams('by=$where')).ok, false);
  assert.equal(parseGroupByQuery(new URLSearchParams('by=app')).ok, true);
  assert.equal(parseGroupByQuery(new URLSearchParams('by=ids.userId')).ok, true);
});

test('buildGroupBySql groups a column directly', () => {
  const parsed = parseGroupByQuery(new URLSearchParams('by=app&limit=5'));
  const { text } = buildGroupBySql(parsed.value, undefined);
  assert.match(text, /SELECT app AS value, count\(\*\)::int AS count/);
  assert.match(text, /GROUP BY app/);
  assert.match(text, /ORDER BY count DESC, value ASC NULLS LAST/);
});

test('buildGroupBySql maps ids.* to a #>> path param reused across clauses', () => {
  const parsed = parseGroupByQuery(new URLSearchParams('by=ids.userId&like=ab'));
  const { text, params } = buildGroupBySql(parsed.value, undefined);
  // path param for the by expression, then the ILIKE param, then limit.
  assert.deepEqual(params.slice(-3), [['userId'], '%ab%', 20]);
  assert.match(text, /ids #>> \$\d+ AS value/);
  assert.match(text, /HAVING ids #>> \$\d+ ILIKE/);
});

test('mapGroupByRows computes otherCount from the windowed total', () => {
  const value = { by: 'app', from: new Date('2026-06-22T00:00:00Z'), to: new Date('2026-06-22T12:00:00Z') };
  const out = mapGroupByRows(
    [
      { value: 'a', count: 7, total: 12 },
      { value: 'b', count: 3, total: 12 },
    ],
    value,
  );
  assert.equal(out.total, 12);
  assert.equal(out.otherCount, 2); // 12 - (7 + 3)
  assert.deepEqual(out.groups, [{ value: 'a', count: 7 }, { value: 'b', count: 3 }]);
  assert.deepEqual(out.window, { from: '2026-06-22T00:00:00.000Z', to: '2026-06-22T12:00:00.000Z' });
});

test('mapGroupByRows handles an empty result', () => {
  const out = mapGroupByRows([], { by: 'level' });
  assert.deepEqual({ total: out.total, groups: out.groups, otherCount: out.otherCount }, { total: 0, groups: [], otherCount: 0 });
});
