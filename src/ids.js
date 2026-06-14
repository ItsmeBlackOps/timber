import { createHash, randomBytes } from 'node:crypto';

// seq disambiguates identical envelopes sharing app+receivedAt within one
// request (plan decision 1). The WAL persists the final doc including _id,
// so replays reuse this id and stay idempotent.
export function deriveId({ app, receivedAtIso, seq, envelope }) {
  return createHash('sha256')
    .update(`${app}\n${receivedAtIso}\n${seq}\n${JSON.stringify(envelope)}`)
    .digest('hex')
    .slice(0, 32);
}

// Process-unique seq generator feeding deriveId (plan decision 1 + decision 9).
//
// Decision 1 added `seq` so identical bodies in the same millisecond don't
// collide and silently drop. That only holds within ONE process: in cluster
// mode (decision 9, TIMBER_CLUSTER=N) every forked worker resets a plain
// counter to 0, so two workers emit byte-identical (app, receivedAt-ms, seq,
// envelope) tuples -> identical _id -> the 2nd insert raises 11000 -> the
// flusher's all-duplicate-key path advances the checkpoint and DROPS a
// 202-accepted record (PRD §3/§9 zero-loss violation).
//
// Fix: prefix the counter with a per-process random nonce so the `seq` value
// fed into the (unchanged) C3 hash is globally distinct across workers. The
// counter stays monotonic within a process; the nonce makes two processes'
// seq spaces disjoint. Replay idempotency is preserved because the WAL stores
// the final _id and replay reuses the stored doc — this generator only runs at
// first ingest, and deriveId remains pure (same seq value => same _id).
export function createSeqGenerator() {
  // 8 random bytes (64 bits) per process: collision across the handful of
  // forked workers in one cluster is astronomically unlikely.
  const nonce = randomBytes(8).toString('hex');
  let counter = 0;
  return () => `${nonce}-${counter++}`;
}
