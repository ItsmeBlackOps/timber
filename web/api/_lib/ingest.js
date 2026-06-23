// Pure builder for the ingest multi-row INSERT. Kept separate from the handler so
// the enrich + SQL shaping is unit-testable without a database. Each event gets
// app/env from the authenticated principal, received_at = now, and expires_at =
// now + the per-level TTL (debug 7 / info 30 / warn 90 / error 90 days).
const DAY_MS = 86_400_000;
const COLS = 10;

export function buildInsert(events, principal, ttl, now) {
  const params = [];
  const tuples = events.map((e, i) => {
    const b = i * COLS;
    params.push(
      principal.app,
      principal.env ?? '',
      e.event,
      e.level,
      e.ts ? new Date(e.ts).toISOString() : null,
      e.message ?? null,
      e.ids == null ? null : JSON.stringify(e.ids),
      e.data == null ? null : JSON.stringify(e.data),
      now.toISOString(),
      new Date(now.getTime() + ttl[e.level] * DAY_MS).toISOString(),
    );
    return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7}::jsonb,$${b + 8}::jsonb,$${b + 9},$${b + 10})`;
  });
  const text =
    'INSERT INTO events (app, env, event, level, ts, message, ids, data, received_at, expires_at) VALUES ' +
    tuples.join(',');
  return { text, params };
}
