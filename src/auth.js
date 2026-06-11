import { timingSafeEqual } from 'node:crypto';

const BEARER_RE = /^Bearer\s+(.+)$/i;

// timingSafeEqual throws on length mismatch, so guard first; the length check
// leaks only the key length, not its content.
function safeEqual(tokenBuf, keyBuf) {
  return tokenBuf.length === keyBuf.length && timingSafeEqual(tokenBuf, keyBuf);
}

export function createKeyring(keys) {
  const entries = keys.map(({ key, app, env, mode }) => ({
    keyBuf: Buffer.from(key, 'utf8'),
    app,
    env,
    mode,
  }));

  return {
    authenticate(header) {
      if (typeof header !== 'string') return null;
      const match = BEARER_RE.exec(header);
      if (!match) return null;
      const tokenBuf = Buffer.from(match[1], 'utf8');
      for (const { keyBuf, app, env, mode } of entries) {
        if (safeEqual(tokenBuf, keyBuf)) return { app, env, mode };
      }
      return null;
    },
  };
}

export const canWrite = (p) => p?.mode === 'write';
export const canRead = (p) => p?.mode === 'write' || p?.mode === 'read';
