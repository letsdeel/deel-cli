import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const MAIN = new URL("../src/main.ts", import.meta.url).pathname;
const FLOOD = new URL("./fixtures/flood-stdout.mjs", import.meta.url).pathname;
const FLOOD_BYTES = 300_000; // well past the 64 KB a pipe buffers

test("the process doesn't exit before a slow reader has taken all of stdout", async () => {
  const child = spawn(process.execPath, ["--import", FLOOD, MAIN, "--version"], {
    env: { ...process.env, FLOOD_BYTES: String(FLOOD_BYTES) },
    stdio: ["ignore", "pipe", "ignore"],
  });
  child.stdout.pause();
  setTimeout(() => child.stdout.resume(), 300);

  let received = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (received += chunk));
  const code = await new Promise((resolve) => child.on("close", resolve));

  const [flood, version] = received.trimEnd().split("\n");
  assert.equal(flood.length, FLOOD_BYTES);
  assert.match(version ?? "", /^deel \d+\.\d+\.\d+/);
  assert.equal(code, 0);
});
