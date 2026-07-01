// GET /v1/logflare — proxy search queries to the configured Logflare Endpoint.
// Accepts the same filter params as GET /v1/logs (app, env, level, event, since,
// limit) and returns items in the same shape so clients can switch sources easily.
import { requireRead } from '../_lib/auth.js';
import { json, badRequest, methodNotAllowed } from '../_lib/respond.js';
import { logflareConfig } from '../_lib/env.js';

const LOGFLARE_ENDPOINT = 'https://api.logflare.app/api/endpoints/query';
const INT_RE = /^-?\d+$/;

function parseParams(sp) {
  const limit = sp.get('limit');
  if (limit !== null && !INT_RE.test(limit)) {
    return { ok: false, error: `invalid limit "${limit}"` };
  }
  return {
    ok: true,
    value: {
      app: sp.get('app') ?? null,
      env: sp.get('env') ?? null,
      level: sp.get('level') ?? null,
      event: sp.get('event') ?? null,
      since: sp.get('since') ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      limit: limit ? Math.min(Math.max(Number(limit), 1), 500) : 100,
    },
  };
}

function buildEndpointUrl(endpointId, params) {
  const url = new URL(`${LOGFLARE_ENDPOINT}/${endpointId}`);
  if (params.app) url.searchParams.set('@app', params.app);
  if (params.env) url.searchParams.set('@env', params.env);
  if (params.level) url.searchParams.set('@level', params.level);
  if (params.event) url.searchParams.set('@event', params.event);
  url.searchParams.set('@since', params.since);
  url.searchParams.set('@limit', String(params.limit));
  return url.toString();
}

function normalizeRow(row) {
  const doc = {
    app: row['metadata.app'] ?? row.app ?? '',
    env: row['metadata.env'] ?? row.env ?? '',
    event: row.event_message ?? row.event ?? '',
    level: row['metadata.level'] ?? row.level ?? '',
    receivedAt: row.timestamp ?? row['metadata.receivedAt'] ?? null,
  };
  if (row['metadata.ts']) doc.ts = row['metadata.ts'];
  if (row['metadata.message']) doc.message = row['metadata.message'];
  if (row['metadata.ids']) doc.ids = row['metadata.ids'];
  if (row['metadata.data']) doc.data = row['metadata.data'];
  return doc;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  if (!requireRead(req, res)) return;

  const { endpointId, apiKey } = logflareConfig();
  if (!endpointId || !apiKey) {
    return json(res, 503, { error: 'logflare not configured' });
  }

  const sp = new URL(req.url, 'http://localhost').searchParams;
  const parsed = parseParams(sp);
  if (!parsed.ok) return badRequest(res, parsed.error);

  const url = buildEndpointUrl(endpointId, parsed.value);
  let upstream;
  try {
    upstream = await fetch(url, { headers: { 'X-API-KEY': apiKey } });
  } catch (err) {
    return json(res, 502, { error: 'logflare unreachable' });
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    return json(res, 502, { error: 'logflare error', detail: text });
  }

  const body = await upstream.json();
  const items = (body.result ?? []).map(normalizeRow);
  return json(res, 200, { items, nextCursor: null, source: 'logflare' });
}
