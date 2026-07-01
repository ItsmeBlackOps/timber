// Logflare ingest helper. buildLogflarePayload is a pure function (testable
// without network). forwardToLogflare is fire-and-forget: it never throws and
// never blocks the Neon insert response path.
import { logflareConfig } from './env.js';

const LOGFLARE_URL = 'https://api.logflare.app/api/logs';

export function buildLogflarePayload(events, principal, now) {
  const receivedAt = now.toISOString();
  const batch = events.map((e) => {
    const metadata = {
      app: principal.app,
      env: principal.env ?? '',
      level: e.level,
      receivedAt,
    };
    if (e.ts != null) metadata.ts = new Date(e.ts).toISOString();
    if (e.message != null) metadata.message = e.message;
    if (e.ids != null) metadata.ids = e.ids;
    if (e.data != null) metadata.data = e.data;
    return { message: e.event, metadata };
  });
  return { batch };
}

export async function forwardToLogflare(events, principal) {
  const { sourceId, apiKey } = logflareConfig();
  if (!sourceId || !apiKey) return;
  const payload = buildLogflarePayload(events, principal, new Date());
  try {
    await fetch(`${LOGFLARE_URL}?source=${encodeURIComponent(sourceId)}`, {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    // fire-and-forget: log to stderr but never surface to caller
    console.error('[timber] logflare forward failed', err?.message);
  }
}
