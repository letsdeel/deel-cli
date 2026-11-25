import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CLI_VERSION } from "../src/version.ts";
import { tempDir } from "./stubs.ts";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));

// The real entry point in a child process, with no token, no keychain entries and no local log.
function deel(t: Parameters<typeof tempDir>[0], ...args: string[]) {
  const env = { PATH: process.env.PATH ?? "", HOME: tempDir(t), DEEL_LOG: "off" };
  return spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env, timeout: 30_000 });
}

test("a successful command exits 0 and prints to stdout only", (t) => {
  const result = deel(t, "--version");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `deel ${CLI_VERSION}`);
  assert.equal(result.stderr, "");
});

test("a failing command exits 1 with exactly one JSON error envelope on stderr", (t) => {
  const result = deel(t, "app", "search");
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  // JSON.parse of the whole stream fails if a second envelope follows the first.
  assert.deepEqual(JSON.parse(result.stderr), { error: { code: "usage.app", message: "Usage: deel app search <what the action does> [--limit 1-20]" } });
});

const FLOOD = fileURLToPath(new URL("./fixtures/flood-stdout.mjs", import.meta.url));
const FLOOD_BYTES = 300_000; // well past the 64 KB a pipe buffers

// Runs the real entry point; argument errors are refused before any request, so no network is touched.
function runMain(args: string[], env: Record<string, string> = {}) {
  // NO_COLOR is dropped, not set empty: Node prints a warning on stderr when both it and FORCE_COLOR are set, and the
  // process now ends on its own (it no longer calls process.exit), so that warning would land beside the envelope.
  const { NO_COLOR: _noColor, ...inherited } = process.env;
  return spawnSync(process.execPath, [MAIN, ...args], {
    encoding: "utf8",
    env: { ...inherited, ...env, FORCE_COLOR: "1" },
  });
}

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

test("a parser usage error is a plain-text JSON envelope with a next step", () => {
  const result = runMain(["contracts", "list", "--order_direction", "sideways"]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.ok(!result.stderr.includes("\u001b"), `escape codes in: ${JSON.stringify(result.stderr)}`);
  const { error } = JSON.parse(result.stderr);
  assert.equal(error.code, "usage");
  assert.match(error.message, /Invalid value for argument: --order_direction \(sideways\)\. Expected one of: asc, desc\./);
  assert.match(error.next, /--help/);
});

test("a missing required argument is reported the same way", () => {
  const result = runMain(["immigration", "quotes", "list", "--beta"]);
  assert.equal(result.status, 1);
  assert.ok(!result.stderr.includes("\u001b"));
  const { error } = JSON.parse(result.stderr);
  assert.equal(error.code, "usage");
  assert.match(error.message, /Missing required argument/);
});
