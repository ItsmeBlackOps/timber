import { createHash } from 'node:crypto';

// seq disambiguates identical envelopes sharing app+receivedAt within one
// request (plan decision 1). The WAL persists the final doc including _id,
// so replays reuse this id and stay idempotent.
export function deriveId({ app, receivedAtIso, seq, envelope }) {
  return createHash('sha256')
    .update(`${app}\n${receivedAtIso}\n${seq}\n${JSON.stringify(envelope)}`)
    .digest('hex')
    .slice(0, 32);
}
