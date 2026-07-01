// Logflare ingest helper. buildLogflarePayload is a pure function (testable
// without network). forwardToLogflare never throws; it resolves to a boolean
// so the caller can use Logflare as a fallback store when Neon fails.
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
  if (!sourceId || !apiKey) return false;
  const payload = buildLogflarePayload(events, principal, new Date());
  try {
    const res = await fetch(`${LOGFLARE_URL}?source=${encodeURIComponent(sourceId)}`, {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error('[timber] logflare forward rejected', res.status);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[timber] logflare forward failed', err?.message);
    return false;
  }
}
