import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));

// Runs the real entry point; argument errors are refused before any request, so no network is touched.
function runMain(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [MAIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env, NO_COLOR: "", FORCE_COLOR: "1" },
  });
}

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
