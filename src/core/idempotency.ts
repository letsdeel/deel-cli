// Idempotency keys name one attempt, not the request's content: each run of a mutating command
// gets a new random key, and the transport's retries inside that run reuse it (they share the
// headers), so a retried request runs at most once. A deliberate repeat of the same command is a
// new intent and must not be deduped, which a key derived from the request could not tell apart.
// The API already checks that a reused key comes with the same method, path and body.
// To make a re-run a safe retry of an earlier one, pass that run's key with --idempotency-key.

import { randomUUID } from "node:crypto";

export function newIdempotencyKey(): string {
  return randomUUID();
}
