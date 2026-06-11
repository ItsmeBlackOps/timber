// Opaque keyset-pagination cursor (contract C8): base64url(JSON {r: ISO receivedAt, i: _id}).
import { Buffer } from 'node:buffer';

export function encodeCursor({ receivedAt, id }) {
  const iso = receivedAt instanceof Date ? receivedAt.toISOString() : new Date(receivedAt).toISOString();
  return Buffer.from(JSON.stringify({ r: iso, i: id }), 'utf8').toString('base64url');
}

// Returns {receivedAt: Date, id: string} or null on any malformed input —
// cursors come straight from the URL, so every failure mode must be non-throwing.
export function decodeCursor(s) {
  if (typeof s !== 'string' || s.length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (typeof parsed.r !== 'string' || typeof parsed.i !== 'string') return null;
  const receivedAt = new Date(parsed.r);
  if (Number.isNaN(receivedAt.getTime())) return null;
  return { receivedAt, id: parsed.i };
}
