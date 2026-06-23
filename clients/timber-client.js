// Tiny Timber log client (Node 18+, no dependencies; uses global fetch).
// POSTs batched events to ${TIMBER_URL}/v1/logs with a write key. Drops
// heartbeat noise, gates by level, batches, applies backpressure, and never
// throws into the caller: a logging failure must not crash the app.
//
// Env: TIMBER_URL, TIMBER_WRITE_KEY, LOG_MIN_LEVEL (debug|info|warn|error).
//
//   import { createTimberClient } from './timber-client.js';
//   const timber = createTimberClient();
//   timber.log('user.signup', { message: 'new user', ids: { userId: 'u1' } });
//   timber.log('ai.call', { data: { model: 'claude', inputTokens: 800,
//     outputTokens: 120, costUsd: 0.004, latencyMs: 950 } });

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const DROP = [/no message \(still listening\)/i, /heartbeat/i, /⏳/];
const MAX_BATCH = 50;
const MAX_BUFFER = 1000;

export function createTimberClient(opts = {}) {
  const url = (opts.url ?? process.env.TIMBER_URL ?? '').replace(/\/+$/, '');
  const key = opts.key ?? process.env.TIMBER_WRITE_KEY ?? '';
  const minLevel = LEVELS[(opts.minLevel ?? process.env.LOG_MIN_LEVEL ?? 'info').toLowerCase()] ?? 20;
  const intervalMs = opts.flushIntervalMs ?? 2000;
  let buf = [];

  function log(event, { level = 'info', message, ids, data, ts } = {}) {
    if ((LEVELS[level] ?? 20) < minLevel) return;
    const haystack = `${event} ${message ?? ''}`;
    if (DROP.some((re) => re.test(haystack))) return;
    const ev = { event, level };
    if (message != null) ev.message = message;
    if (ids) ev.ids = ids;
    if (data) ev.data = data;
    if (ts) ev.ts = ts;
    if (buf.length >= MAX_BUFFER) buf.shift(); // backpressure: drop the oldest
    buf.push(ev);
  }

  async function flush() {
    if (!url || !key || buf.length === 0) return;
    const batch = buf.slice(0, MAX_BATCH);
    buf = buf.slice(MAX_BATCH);
    try {
      await fetch(url + '/v1/logs', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
        body: JSON.stringify(batch),
      });
    } catch {
      // swallow: a logging failure must never crash the app
    }
  }

  const timer = url && key ? setInterval(flush, intervalMs) : null;
  if (timer && typeof timer.unref === 'function') timer.unref();

  return {
    log,
    flush,
    close: () => {
      if (timer) clearInterval(timer);
      return flush();
    },
  };
}
