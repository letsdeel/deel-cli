// IOStreams: the single injectable owner of stdout/stderr/stdin + TTY and
// interactivity detection. Commands write through this, never process.* —
// which makes output capturable in tests and TTY handling consistent.

import { readFileSync } from "node:fs";
import { isatty } from "node:tty";
import { AGENT_ENV_SIGNALS } from "./constants.ts";

export type IOStreams = {
  out(text: string): void;
  err(text: string): void;
  readStdin(): string;
  isTTY: boolean;
  interactive: boolean; // stdout is a terminal and no agent/CI signal is set: output may be formatted for a person
  canPrompt: boolean; // a person can answer a [y/N] question: stdin and stderr are terminals and no agent/CI signal is set
};

function isAgentEnv(env: NodeJS.ProcessEnv): boolean {
  return AGENT_ENV_SIGNALS.some((signal) => (signal === "CI" ? env.CI === "true" : Boolean(env[signal])));
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
    canPrompt: isatty(0) && isatty(2) && !agent,
  };
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
