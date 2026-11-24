import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { isatty } from "node:tty";
import { fileURLToPath } from "node:url";
import { FORCED_EXIT_MS } from "../src/core/constants.ts";
import { canPromptFrom, captureIO, exitAfterFlush, isAgentEnv, realIO } from "../src/core/io.ts";

const IO_MODULE = fileURLToPath(new URL("../src/core/io.ts", import.meta.url));

function fakes() {
  const callbacks: Array<() => void> = [];
  const stream = { write: (_chunk: string, callback?: () => void) => (callbacks.push(callback!), true) };
  const codes: number[] = [];
  const exits: number[] = [];
  const scheduled: number[] = [];
  const opts = {
    setExitCode: (code: number) => void codes.push(code),
    exit: (code: number) => void exits.push(code),
    schedule: (run: () => void, ms: number) => (scheduled.push(ms), run()),
  };
  return { callbacks, stream, codes, exits, scheduled, opts };
}

test("exitAfterFlush sets the exit code at once and forces the exit only after every stream has flushed", () => {
  const { callbacks, stream, codes, exits, scheduled, opts } = fakes();
  exitAfterFlush(3, { ...opts, streams: [stream, stream] as never });
  assert.deepEqual(codes, [3]);
  assert.deepEqual(exits, []);
  callbacks[0]();
  assert.deepEqual(exits, []);
  callbacks[1]();
  assert.deepEqual(scheduled, [FORCED_EXIT_MS]);
  assert.deepEqual(exits, [3]);
});

test("exitAfterFlush with no streams schedules the forced exit at once", () => {
  const { codes, exits, opts } = fakes();
  exitAfterFlush(0, { ...opts, streams: [] });
  assert.deepEqual(codes, [0]);
  assert.deepEqual(exits, [0]);
});

test("a large output nobody is reading yet still arrives whole", { timeout: 30_000 }, async () => {
  const size = 300_000; // well past the 64 KB a pipe holds
  // The child queues its output, then says so on stderr; only then does the parent start reading stdout.
  const script = `import { exitAfterFlush } from ${JSON.stringify(IO_MODULE)}; process.stdout.write("x".repeat(${size})); process.stderr.write("queued"); exitAfterFlush(0);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  let received = 0;
  let reading = false;
  child.stderr.on("data", () => {
    if (reading) return;
    reading = true;
    child.stdout.on("data", (chunk: Buffer) => (received += chunk.length));
  });
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0);
  assert.equal(received, size);
});

test("canPromptFrom: a person can answer only when stdin and stderr are both terminals", () => {
  assert.equal(canPromptFrom(true, true, {}), true);
  assert.equal(canPromptFrom(false, true, {}), false, "stdin piped or closed");
  assert.equal(canPromptFrom(true, false, {}), false, "stderr redirected");
  assert.equal(canPromptFrom(false, false, {}), false);
});

test("canPromptFrom: CI and every agent signal refuse the prompt even on a terminal", () => {
  for (const env of [{ CI: "true" }, { CLAUDE_CODE: "1" }, { CURSOR: "1" }, { CODEX: "1" }]) {
    assert.equal(canPromptFrom(true, true, env), false, JSON.stringify(env));
  }
});

test("canPromptFrom: CI only counts as CI when it is exactly true, and an empty agent signal is no signal", () => {
  for (const env of [{ CI: "false" }, { CI: "" }, { CI: "1" }, { CLAUDE_CODE: "" }]) {
    assert.equal(canPromptFrom(true, true, env), true, JSON.stringify(env));
  }
});

test("isAgentEnv is what interactive output and the prompt both read", () => {
  assert.equal(isAgentEnv({}), false);
  assert.equal(isAgentEnv({ CI: "true" }), true);
  assert.equal(isAgentEnv({ CODEX: "1" }), true);
});

test("realIO decides from the process's own stdin, stderr and env", () => {
  assert.equal(realIO().canPrompt, canPromptFrom(isatty(0), isatty(2), process.env));
});

test("captureIO prompts only when asked to, defaulting to its TTY setting", () => {
  assert.equal(captureIO().canPrompt, false);
  assert.equal(captureIO({ isTTY: true }).canPrompt, true);
  assert.equal(captureIO({ isTTY: true, canPrompt: false }).canPrompt, false);
});
