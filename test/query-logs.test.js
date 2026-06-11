// Contract C8: /v1/logs query parsing (param → Mongo filter), opaque keyset
// cursor, and runLogsQuery pagination over a collection.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

import { encodeCursor, decodeCursor } from '../src/query/cursor.js';
import { parseLogsQuery, runLogsQuery } from '../src/query/logs.js';
import { createFakeCollection } from './helpers/fake-collection.js';

const ISO = '2026-06-11T10:00:00.000Z';
const b64u = (s) => Buffer.from(s, 'utf8').toString('base64url');
const parse = (init, limits) => parseLogsQuery(new URLSearchParams(init), limits);

function assertFail(result, re) {
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, 'string');
  if (re) assert.match(result.error, re);
}

describe('cursor encode/decode', () => {
  test('encodeCursor → base64url of {r: iso, i: id}', () => {
    const s = encodeCursor({ receivedAt: new Date(ISO), id: 'abc' });
    assert.match(s, /^[A-Za-z0-9_-]+$/); // URL-safe, unpadded
    assert.deepEqual(JSON.parse(Buffer.from(s, 'base64url').toString('utf8')), { r: ISO, i: 'abc' });
  });

  test('encodeCursor accepts receivedAt as Date or ISO string identically', () => {
    assert.equal(
      encodeCursor({ receivedAt: ISO, id: 'abc' }),
      encodeCursor({ receivedAt: new Date(ISO), id: 'abc' }),
    );
  });

  test('roundtrip returns Date + id', () => {
    const c = decodeCursor(encodeCursor({ receivedAt: new Date(ISO), id: 'id-7' }));
    assert.ok(c.receivedAt instanceof Date);
    assert.equal(c.receivedAt.toISOString(), ISO);
    assert.equal(c.id, 'id-7');
  });

  test('garbage input → null', () => {
    const bad = [
      undefined,
      null,
      42,
      '',
      '!!!!',
      'AAAA', // valid base64url, not JSON
      b64u('plain text'),
      b64u('123'),
      b64u('"str"'),
      b64u('[]'),
      b64u('null'),
      b64u('{"r":"2026-01-01T00:00:00.000Z"}'), // missing i
      b64u('{"i":"x"}'), // missing r
      b64u('{"r":"not a date","i":"x"}'),
      b64u('{"r":123,"i":"x"}'),
      b64u('{"r":"2026-01-01T00:00:00.000Z","i":7}'), // non-string id
    ];
    for (const input of bad) {
      assert.equal(decodeCursor(input), null, `expected null for ${JSON.stringify(input)}`);
    }
  });
});

describe('parseLogsQuery — param → filter mapping', () => {
  test('empty query → empty filter, default limit 100', () => {
    assert.deepEqual(parse(''), { ok: true, value: { filter: {}, limit: 100 } });
  });

  test('app and env → exact string match', () => {
    assert.deepEqual(parse('app=dailyDashboard&env=prod').value.filter, {
      app: 'dailyDashboard',
      env: 'prod',
    });
  });

  test('level csv → $in', () => {
    assert.deepEqual(parse('level=info,error').value.filter, { level: { $in: ['info', 'error'] } });
    assert.deepEqual(parse('level=warn').value.filter, { level: { $in: ['warn'] } });
  });

  test('event → anchored prefix regex, no case-insensitivity', () => {
    assert.deepEqual(parse('event=ai.').value.filter, { event: { $regex: '^ai\\.' } });
  });

  test('event regex metacharacters are escaped', () => {
    assert.deepEqual(parse({ event: 'a+b(c' }).value.filter, { event: { $regex: '^a\\+b\\(c' } });
  });

  test('from/to ISO → receivedAt {$gte: Date, $lt: Date}', () => {
    const r = parse(`from=2026-06-11T09:00:00.000Z&to=${ISO}`);
    assert.deepEqual(r.value.filter, {
      receivedAt: { $gte: new Date('2026-06-11T09:00:00.000Z'), $lt: new Date(ISO) },
    });
  });

  test('from/to accept epoch-ms digit strings', () => {
    assert.deepEqual(parse('from=1718000000000').value.filter, {
      receivedAt: { $gte: new Date(1718000000000) },
    });
    assert.deepEqual(parse('to=1718000000000').value.filter, {
      receivedAt: { $lt: new Date(1718000000000) },
    });
  });

  test('ids.<key> → exact string match on dotted path', () => {
    assert.deepEqual(parse('ids.requestId=r-42').value.filter, { 'ids.requestId': 'r-42' });
  });

  test('data.<path> string value → exact match', () => {
    assert.deepEqual(parse('data.model=claude-opus-4').value.filter, {
      'data.model': 'claude-opus-4',
    });
  });

  test('data.<path> numeric value → {$in: [number, string]}', () => {
    assert.deepEqual(parse('data.latencyMs=42').value.filter, {
      'data.latencyMs': { $in: [42, '42'] },
    });
    assert.deepEqual(parse('data.score=-1.5').value.filter, {
      'data.score': { $in: [-1.5, '-1.5'] },
    });
  });

  test('data.<path> true/false → {$in: [boolean, string]}', () => {
    assert.deepEqual(parse('data.ok=true').value.filter, { 'data.ok': { $in: [true, 'true'] } });
    assert.deepEqual(parse('data.ok=false').value.filter, { 'data.ok': { $in: [false, 'false'] } });
  });

  test('data.<path>__gte / __lte merge into one range object per path', () => {
    assert.deepEqual(parse('data.latencyMs__gte=100&data.latencyMs__lte=500.5').value.filter, {
      'data.latencyMs': { $gte: 100, $lte: 500.5 },
    });
    assert.deepEqual(parse('data.n__gte=3').value.filter, { 'data.n': { $gte: 3 } });
    assert.deepEqual(parse('data.n__lte=-2.5').value.filter, { 'data.n': { $lte: -2.5 } });
  });

  test('q → case-insensitive regex over message', () => {
    assert.deepEqual(parse('q=slow query').value.filter, {
      message: { $regex: 'slow query', $options: 'i' },
    });
  });

  test('q of exactly 256 chars is accepted', () => {
    const r = parse({ q: 'a'.repeat(256) });
    assert.equal(r.ok, true);
    assert.equal(r.value.filter.message.$regex.length, 256);
  });
});

describe('parseLogsQuery — limit clamp/default', () => {
  test('default 100 when absent', () => {
    assert.equal(parse('app=x').value.limit, 100);
  });

  test('explicit integer honored, boundaries pass through', () => {
    assert.equal(parse('limit=50').value.limit, 50);
    assert.equal(parse('limit=1').value.limit, 1);
    assert.equal(parse('limit=500').value.limit, 500);
  });

  test('out-of-range integers clamp to 1..500', () => {
    assert.equal(parse('limit=0').value.limit, 1);
    assert.equal(parse('limit=-7').value.limit, 1);
    assert.equal(parse('limit=9999').value.limit, 500);
  });

  test('non-integer limit rejected', () => {
    assertFail(parse('limit=abc'), /limit/);
    assertFail(parse('limit=2.5'), /limit/);
    assertFail(parse('limit='), /limit/);
  });
});

describe('parseLogsQuery — cursor predicate', () => {
  test('valid cursor → keyset $or predicate', () => {
    const cur = encodeCursor({ receivedAt: new Date(ISO), id: 'id-10' });
    const r = parse(`cursor=${cur}`);
    assert.equal(r.ok, true);
    assert.deepEqual(r.value.filter, {
      $or: [
        { receivedAt: { $lt: new Date(ISO) } },
        { receivedAt: new Date(ISO), _id: { $lt: 'id-10' } },
      ],
    });
  });

  test('cursor predicate ANDs with the other filters', () => {
    const cur = encodeCursor({ receivedAt: new Date(ISO), id: 'id-10' });
    const r = parse(`app=dash&from=2026-06-10T00:00:00.000Z&cursor=${cur}`);
    assert.equal(r.ok, true);
    const f = r.value.filter;
    assert.equal(f.app, 'dash');
    assert.deepEqual(f.receivedAt, { $gte: new Date('2026-06-10T00:00:00.000Z') });
    assert.deepEqual(f.$or, [
      { receivedAt: { $lt: new Date(ISO) } },
      { receivedAt: new Date(ISO), _id: { $lt: 'id-10' } },
    ]);
  });
});

describe('parseLogsQuery — rejections', () => {
  const cases = [
    ['unknown param', 'foo=1', /foo/],
    ['near-miss param name', 'levels=info', /levels/],
    ['unknown level token', 'level=info,fatal', /level/],
    ['empty level value', 'level=', /level/],
    ['unparseable from', 'from=yesterday', /from/],
    ['unparseable to', 'to=2026-13-99', /to/],
    ['q longer than 256', { q: 'a'.repeat(257) }, /q /],
    ['q invalid regex', { q: '(' }, /q /],
    ['undecodable cursor', 'cursor=@@@@', /cursor/],
    ['cursor with wrong payload shape', `cursor=${b64u('{"oops":1}')}`, /cursor/],
    ['non-numeric __gte', 'data.x__gte=fast', /numeric/],
    ['non-numeric __lte', 'data.x__lte=1e', /numeric/],
    ['range op with empty data path', 'data.__gte=5', /data\.__gte/],
    ['bare ids. param', 'ids.=x', /ids\./],
    ['bare data. param', 'data.=x', /data\./],
  ];
  for (const [name, init, re] of cases) {
    test(`rejects ${name}`, () => {
      assertFail(parse(init), re);
    });
  }
});

describe('runLogsQuery — collection call shape', () => {
  function spyCollection(rows) {
    const calls = {};
    const cursor = {
      sort(s) {
        calls.sort = s;
        return cursor;
      },
      limit(n) {
        calls.limit = n;
        return cursor;
      },
      async toArray() {
        return rows;
      },
    };
    return {
      calls,
      find(filter) {
        calls.filter = filter;
        return cursor;
      },
    };
  }

  test('sorts {receivedAt:-1,_id:-1} and over-fetches limit+1', async () => {
    const col = spyCollection([]);
    const filter = { app: 'x' };
    await runLogsQuery(col, { filter, limit: 10 });
    assert.equal(col.calls.filter, filter);
    assert.deepEqual(col.calls.sort, { receivedAt: -1, _id: -1 });
    assert.equal(col.calls.limit, 11);
  });

  test('limit+1 rows returned → drops last, nextCursor = last kept row', async () => {
    const t = (n) => new Date(Date.UTC(2026, 5, 11, 10, n));
    const col = spyCollection([
      { _id: 'c', receivedAt: t(3) },
      { _id: 'b', receivedAt: t(2) },
      { _id: 'a', receivedAt: t(1) },
    ]);
    const { items, nextCursor } = await runLogsQuery(col, { filter: {}, limit: 2 });
    assert.deepEqual(items.map((d) => d._id), ['c', 'b']);
    const c = decodeCursor(nextCursor);
    assert.equal(c.id, 'b');
    assert.equal(c.receivedAt.getTime(), t(2).getTime());
  });

  test('rows within limit → nextCursor null', async () => {
    const col = spyCollection([{ _id: 'a', receivedAt: new Date(ISO) }]);
    const { items, nextCursor } = await runLogsQuery(col, { filter: {}, limit: 2 });
    assert.equal(items.length, 1);
    assert.equal(nextCursor, null);
  });
});

describe('runLogsQuery — end-to-end on fake collection', () => {
  const BASE = Date.parse(ISO);
  const EXPIRES = new Date(BASE + 30 * 86_400_000);

  // 25 docs in groups of 4 sharing one receivedAt → ties; _id breaks them.
  function makeDocs() {
    const docs = [];
    for (let i = 0; i < 25; i++) {
      docs.push({
        _id: `id-${String(i).padStart(2, '0')}`,
        app: 'dailyDashboard',
        env: 'prod',
        event: i % 2 === 0 ? 'ai.request' : 'db.query',
        level: ['debug', 'info', 'warn', 'error'][i % 4],
        message: `event number ${i}`,
        ids: { requestId: `r-${i}` },
        data: { latencyMs: i * 10, ok: i % 2 === 0 },
        receivedAt: new Date(BASE + Math.floor(i / 4) * 60_000),
        expiresAt: EXPIRES,
      });
    }
    return docs;
  }

  async function seeded() {
    const col = createFakeCollection();
    const docs = makeDocs();
    await col.insertMany(docs, { ordered: false });
    return { col, docs };
  }

  async function run(col, init) {
    const parsed = parse(init);
    assert.equal(parsed.ok, true, parsed.error);
    return runLogsQuery(col, parsed.value);
  }

  const expectedIdsDesc = (docs) =>
    [...docs]
      .sort((a, b) => b.receivedAt - a.receivedAt || (a._id < b._id ? 1 : -1))
      .map((d) => d._id);

  test('25 docs, limit 10 → 3 pages, no overlap/gap, ties stay stable', async () => {
    const { col, docs } = await seeded();
    const pages = [];
    let init = 'limit=10';
    while (true) {
      const page = await run(col, init);
      pages.push(page);
      if (page.nextCursor === null) break;
      init = `limit=10&cursor=${page.nextCursor}`;
    }
    assert.equal(pages.length, 3);
    assert.deepEqual(pages.map((p) => p.items.length), [10, 10, 5]);
    assert.notEqual(pages[0].nextCursor, null);
    assert.notEqual(pages[1].nextCursor, null);
    assert.equal(pages[2].nextCursor, null);

    const seen = pages.flatMap((p) => p.items.map((d) => d._id));
    assert.equal(new Set(seen).size, 25, 'no duplicates across pages');
    assert.deepEqual(seen, expectedIdsDesc(docs), 'global order receivedAt desc, _id desc');

    // page 1 ends mid-tie-group (id-15..id-12 share receivedAt) — the cursor
    // second branch must pick up the rest of the group on page 2
    assert.equal(pages[0].items.at(-1)._id, 'id-15');
    assert.equal(pages[1].items[0]._id, 'id-14');
    assert.equal(pages[0].items.at(-1).receivedAt, pages[1].items[0].receivedAt);
  });

  test('results exactly filling the limit → nextCursor null', async () => {
    const { col } = await seeded();
    const r = await run(col, 'limit=25');
    assert.equal(r.items.length, 25);
    assert.equal(r.nextCursor, null);
  });

  test('no matches → empty items, nextCursor null', async () => {
    const { col } = await seeded();
    const r = await run(col, 'app=nope');
    assert.deepEqual(r, { items: [], nextCursor: null });
  });

  test('Date fields are serialized to ISO strings in items', async () => {
    const { col } = await seeded();
    const r = await run(col, 'limit=1');
    const doc = r.items[0];
    assert.equal(typeof doc.receivedAt, 'string');
    assert.equal(doc.receivedAt, new Date(BASE + 6 * 60_000).toISOString());
    assert.equal(typeof doc.expiresAt, 'string');
    assert.equal(doc.expiresAt, EXPIRES.toISOString());
  });

  test('filters apply end-to-end', async () => {
    const { col } = await seeded();

    // numeric coercion: stored number matched via {$in:[40,'40']}
    let r = await run(col, 'data.latencyMs=40');
    assert.deepEqual(r.items.map((d) => d._id), ['id-04']);

    // boolean coercion
    r = await run(col, 'data.ok=false');
    assert.equal(r.items.length, 12);
    assert.ok(r.items.every((d) => d.data.ok === false));

    // __gte/__lte merged range
    r = await run(col, 'data.latencyMs__gte=200&data.latencyMs__lte=230');
    assert.deepEqual(r.items.map((d) => d._id), ['id-23', 'id-22', 'id-21', 'id-20']);

    // event prefix
    r = await run(col, 'event=ai.');
    assert.equal(r.items.length, 13);
    assert.ok(r.items.every((d) => d.event === 'ai.request'));

    // level csv
    r = await run(col, 'level=warn,error');
    assert.equal(r.items.length, 12);
    assert.ok(r.items.every((d) => d.level === 'warn' || d.level === 'error'));

    // time window [BASE+60s, BASE+120s) → group i=4..7 only
    r = await run(col, `from=${BASE + 60_000}&to=${BASE + 120_000}`);
    assert.deepEqual(r.items.map((d) => d._id), ['id-07', 'id-06', 'id-05', 'id-04']);

    // ids exact match
    r = await run(col, 'ids.requestId=r-7');
    assert.deepEqual(r.items.map((d) => d._id), ['id-07']);

    // q regex over message, case-insensitive
    r = await run(col, { q: 'NUMBER 7$' });
    assert.deepEqual(r.items.map((d) => d._id), ['id-07']);
  });
});
