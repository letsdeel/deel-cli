import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

test("--token-stdin reads a token that arrives after the process starts (no EAGAIN on a slow pipe)", async () => {
  // A shell pipe, not a spawn pipe: only the former makes fd 0 non-blocking once process.stdin is touched.
  const script = `(sleep 0.5; echo slow-token) | "${process.execPath}" src/main.ts oauth2-apps list --token-stdin --base-url https://127.0.0.1:1 2>&1`;
  const child = spawn("sh", ["-c", script], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, DEEL_TOKEN: "" } });
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  await new Promise((resolve) => child.on("close", resolve));
  // The unreachable host proves the token was read and the request was attempted.
  assert.match(out, /network\.error/);
  assert.doesNotMatch(out, /EAGAIN/);
});
