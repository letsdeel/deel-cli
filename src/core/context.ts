// The injected Context handed to every command — the one composition point for
// I/O, HTTP, time, and randomness. Real dependencies by default; tests pass fakes.

import { randomUUID } from "node:crypto";
import type { Config } from "./config.ts";
import type { IOStreams } from "./io.ts";
import { realIO } from "./io.ts";
import type { Transport, TokenProvider } from "./http.ts";
import { fetchTransport, compose, withAuth, withVersion, withRequestId, withRetry, withLogging, withBeta } from "./http.ts";
import type { Logger } from "./logging.ts";
import { log as defaultLog } from "./logging.ts";
import { CLI_VERSION } from "../version.ts";
import { newIdempotencyKey as randomIdempotencyKey } from "./idempotency.ts";

export type Ctx = {
  io: IOStreams;
  http: Transport; // composed transport (auth + version + request-id + retry + logging)
  clock: () => number;
  newRequestId: () => string;
  newIdempotencyKey: () => string; // one per mutating request of a run; the retries of that request reuse it
  logger: Logger;
  config: Config;
  token: string | TokenProvider | null;
};

export type CreateContextOpts = {
  config: Config;
  token: string | TokenProvider | null;
  io?: IOStreams;
  clock?: () => number;
  rng?: () => string;
  idempotencyKey?: () => string; // key generator, so tests can pin the keys
  logger?: Logger;
  baseTransport?: Transport; // inject a fake in tests
};

export function createContext(o: CreateContextOpts): Ctx {
  const io = o.io ?? realIO();
  const clock = o.clock ?? (() => Date.now());
  const newRequestId = o.rng ?? (() => randomUUID());
  const newIdempotencyKey = o.idempotencyKey ?? randomIdempotencyKey;
  const logger = o.logger ?? defaultLog;
  const base = o.baseTransport ?? fetchTransport;

  // Outermost -> innermost: retry wraps everything; header middlewares run before
  // the send; logging (innermost) sees the final headers and times the real fetch.
  const http = compose(
    base,
    withRetry(),
    withBeta(o.config.beta),
    withRequestId(newRequestId),
    withVersion(CLI_VERSION),
    withAuth(o.token),
    withLogging(logger, clock),
  );

  return { io, http, clock, newRequestId, newIdempotencyKey, logger, config: o.config, token: o.token };
}
