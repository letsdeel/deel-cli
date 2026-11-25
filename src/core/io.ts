// IOStreams: the single injectable owner of stdout/stderr/stdin + TTY and
// interactivity detection. Commands write through this, never process.* —
// which makes output capturable in tests and TTY handling consistent.

import { readFileSync } from "node:fs";
import { isatty } from "node:tty";
import { AGENT_ENV_SIGNALS, FORCED_EXIT_MS } from "./constants.ts";

export type IOStreams = {
  out(text: string): void;
  err(text: string): void;
  readStdin(): string;
  isTTY: boolean;
  interactive: boolean; // stdout is a terminal and no agent/CI signal is set: output may be formatted for a person
  canPrompt: boolean; // a person can answer a [y/N] question: stdin and stderr are terminals and no agent/CI signal is set
};

export function isAgentEnv(env: NodeJS.ProcessEnv): boolean {
  return AGENT_ENV_SIGNALS.some((signal) => (signal === "CI" ? env.CI === "true" : Boolean(env[signal])));
}

// Whether a person can answer a [y/N] question: the answer is read from stdin and the question is asked on stderr, so
// both must be terminals, and nobody answers under CI or an agent even when it gives the CLI a pty. stdout doesn't
// count: `| jq` still prompts.
export function canPromptFrom(stdinIsTTY: boolean, stderrIsTTY: boolean, env: NodeJS.ProcessEnv): boolean {
  return stdinIsTTY && stderrIsTTY && !isAgentEnv(env);
}

// Real streams backed by the process. Interactive only on a TTY with no agent/CI signal. A prompt is read from stdin
// and asked on stderr, so stdout may still be piped (`| jq`). isatty(0) is asked instead of process.stdin.isTTY:
// creating process.stdin on a pipe makes fd 0 non-blocking, which breaks a later --token-stdin read (EAGAIN).
export function realIO(): IOStreams {
  const isTTY = Boolean(process.stdout.isTTY);
  const agent = isAgentEnv(process.env);
  return {
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
    readStdin: () => readFileSync(0, "utf8"),
    isTTY,
    interactive: isTTY && !agent,
    canPrompt: canPromptFrom(isatty(0), isatty(2), process.env),
  };
}

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
export function captureIO(opts: { stdin?: string; isTTY?: boolean; canPrompt?: boolean } = {}): IOStreams & { stdout: string[]; stderr: string[] } {
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
    canPrompt: opts.canPrompt ?? isTTY,
  };
}
