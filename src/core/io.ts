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
