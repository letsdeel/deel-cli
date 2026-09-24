// The injected Context handed to every command — the one composition point for
// I/O, HTTP, time, and randomness. Real dependencies by default; tests pass fakes.

import { randomUUID } from "node:crypto";
import type { Config } from "./config.ts";
import type { IOStreams } from "./io.ts";
import { realIO } from "./io.ts";
import type { Transport } from "./http.ts";
import { fetchTransport, compose, withAuth, withVersion, withRequestId, withRetry, withLogging } from "./http.ts";
import type { Logger } from "./logging.ts";
import { log as defaultLog } from "./logging.ts";
import { CLI_VERSION } from "../version.ts";

export type Ctx = {
  io: IOStreams;
  http: Transport; // composed transport (auth + version + request-id + retry + logging)
  clock: () => number;
  newRequestId: () => string;
  logger: Logger;
  config: Config;
  token: string | null;
};

export type CreateContextOpts = {
  config: Config;
  token: string | null;
  io?: IOStreams;
  clock?: () => number;
  rng?: () => string;
  logger?: Logger;
  baseTransport?: Transport; // inject a fake in tests
};

export function createContext(o: CreateContextOpts): Ctx {
  const io = o.io ?? realIO();
  const clock = o.clock ?? (() => Date.now());
  const newRequestId = o.rng ?? (() => randomUUID());
  const logger = o.logger ?? defaultLog;
  const base = o.baseTransport ?? fetchTransport;

  // Outermost -> innermost: retry wraps everything; header middlewares run before
  // the send; logging (innermost) sees the final headers and times the real fetch.
  const http = compose(
    base,
    withRetry(),
    withRequestId(newRequestId),
    withVersion(CLI_VERSION),
    withAuth(o.token),
    withLogging(logger, clock),
  );

  return { io, http, clock, newRequestId, logger, config: o.config, token: o.token };
}
