import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FORCED_EXIT_MS } from "../src/core/constants.ts";
import { exitAfterFlush } from "../src/core/io.ts";

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
