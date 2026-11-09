// IOStreams: the single injectable owner of stdout/stderr/stdin + TTY and
// interactivity detection. Commands write through this, never process.* —
// which makes output capturable in tests and TTY handling consistent.

import { readFileSync } from "node:fs";
import { AGENT_ENV_SIGNALS } from "./constants.ts";

export type IOStreams = {
  out(text: string): void;
  err(text: string): void;
  readStdin(): string;
  isTTY: boolean;
  interactive: boolean;
};

function isAgentEnv(env: NodeJS.ProcessEnv): boolean {
  return AGENT_ENV_SIGNALS.some((signal) => (signal === "CI" ? env.CI === "true" : Boolean(env[signal])));
}

// Real streams backed by the process. Interactive only on a TTY with no agent/CI signal.
export function realIO(): IOStreams {
  const isTTY = Boolean(process.stdout.isTTY);
  const env = process.env;
  return {
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
    readStdin: () => readFileSync(0, "utf8"),
    isTTY,
    interactive: isTTY && !isAgentEnv(env),
  };
}

// How long a process with nothing left to write may stay up before it is forced to exit.
export const FORCED_EXIT_MS = 5_000;

export type ExitOpts = {
  streams?: Array<Pick<NodeJS.WriteStream, "write">>;
  setExitCode?: (code: number) => void;
  exit?: (code: number) => void;
  schedule?: (run: () => void, ms: number) => void;
};

// End the process without dropping output. process.exit() right after a write drops what is still queued for a
// pipe (it stops at 64 KB on macOS), so a large output piped into jq or a file would be cut. Under Node an
// empty write's callback runs once earlier writes are flushed; under Bun it can run before, so the process
// isn't exited directly: it sets the exit code and ends by itself once its writes are done. An unref'd timer
// still forces the exit if something else keeps the event loop alive.
export function exitAfterFlush(code: number, opts: ExitOpts = {}): void {
  const streams = opts.streams ?? [process.stdout, process.stderr];
  const setExitCode = opts.setExitCode ?? ((value: number) => void (process.exitCode = value));
  const exit = opts.exit ?? process.exit;
  const schedule = opts.schedule ?? ((run: () => void, ms: number) => void setTimeout(run, ms).unref());
  setExitCode(code);
  let pending = streams.length;
  const flushed = () => schedule(() => exit(code), FORCED_EXIT_MS);
  if (pending === 0) return flushed();
  for (const stream of streams) stream.write("", () => --pending === 0 && flushed());
}

// Test double: captures writes into buffers; feed stdin via `stdin`.
export function captureIO(opts: { stdin?: string; isTTY?: boolean } = {}): IOStreams & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const isTTY = opts.isTTY ?? false;
  return {
    stdout,
    stderr,
    out: (text) => void stdout.push(text),
    err: (text) => void stderr.push(text),
    readStdin: () => opts.stdin ?? "",
    isTTY,
    interactive: isTTY,
  };
}
