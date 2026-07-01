// Configuration parsed from process.env (Vercel project env vars). Read fresh so
// a redeploy with new env takes effect; the keyring caches these per cold start.

const num = (v, d) => (v != null && /^\d+$/.test(v) ? Number(v) : d);

// TIMBER_KEYS: JSON array of { key, app, env, mode:'write'|'read' }. Invalid or
// missing => empty keyring (every request 401s, surfaced as a clear auth error).
export function loadKeys() {
  try {
    const arr = JSON.parse(process.env.TIMBER_KEYS ?? '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export const ttlDays = () => ({
  debug: num(process.env.TIMBER_TTL_DEBUG_DAYS, 7),
  info: num(process.env.TIMBER_TTL_INFO_DAYS, 30),
  warn: num(process.env.TIMBER_TTL_WARN_DAYS, 90),
  error: num(process.env.TIMBER_TTL_ERROR_DAYS, 90),
});

export const limits = () => ({
  maxBatch: num(process.env.TIMBER_MAX_BATCH, 500),
  maxMessageChars: 512,
  maxIdsKeys: 10,
  maxDataBytes: 16_384,
  maxDataDepth: 32,
});

export const jobPrefixes = () =>
  (process.env.TIMBER_JOB_PREFIXES ?? 'cron.').split(',').map((s) => s.trim()).filter(Boolean);

export const cronSecret = () => process.env.CRON_SECRET ?? '';

export const logflareConfig = () => ({
  sourceId: process.env.LOGFLARE_SOURCE_ID ?? '',
  apiKey: process.env.LOGFLARE_API_KEY ?? '',
  endpointId: process.env.LOGFLARE_ENDPOINT_ID ?? '',
});
