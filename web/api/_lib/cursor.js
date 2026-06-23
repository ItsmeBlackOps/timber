// Keyset cursor for GET /v1/logs. Encodes the last row's (received_at, id) as
// base64url "<epochMs>:<id>"; the query resumes at rows strictly older than it.

export function encodeCursor({ receivedAt, id }) {
  const ms = receivedAt instanceof Date ? receivedAt.getTime() : Date.parse(receivedAt);
  if (Number.isNaN(ms)) throw new Error('encodeCursor: invalid receivedAt');
  return Buffer.from(`${ms}:${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(s) {
  try {
    const [ms, id] = Buffer.from(s, 'base64url').toString('utf8').split(':');
    if (!/^\d+$/.test(ms) || !/^\d+$/.test(id)) return null;
    // id stays a string: events.id is bigint, and Number() would lose precision
    // past 2^53, corrupting the keyset boundary. Postgres casts the text param.
    return { receivedAt: new Date(Number(ms)), id };
  } catch {
    return null;
  }
}
