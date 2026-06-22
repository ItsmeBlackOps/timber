// Keyset cursor for GET /v1/logs. Encodes the last row's (received_at, id) as
// base64url "<epochMs>:<id>"; the query resumes at rows strictly older than it.

export function encodeCursor({ receivedAt, id }) {
  const ms = receivedAt instanceof Date ? receivedAt.getTime() : Date.parse(receivedAt);
  return Buffer.from(`${ms}:${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(s) {
  try {
    const [ms, id] = Buffer.from(s, 'base64url').toString('utf8').split(':');
    if (!/^\d+$/.test(ms) || !/^\d+$/.test(id)) return null;
    return { receivedAt: new Date(Number(ms)), id: Number(id) };
  } catch {
    return null;
  }
}
