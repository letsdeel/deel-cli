import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FORCED_EXIT_MS, exitAfterFlush } from "../src/core/io.ts";

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

test("a large output piped to a slow reader arrives whole", () => {
  const size = 300_000; // well past the 64 KB a pipe holds
  const script = `import { exitAfterFlush } from ${JSON.stringify(IO_MODULE)}; process.stdout.write("x".repeat(${size})); exitAfterFlush(0);`;
  const reader = `import sys, time; time.sleep(0.3); print(len(sys.stdin.read()))`;
  const result = spawnSync("sh", ["-c", `"${process.execPath}" --input-type=module -e '${script}' | python3 -c '${reader}'`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), String(size));
});
