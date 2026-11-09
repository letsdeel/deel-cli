import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
