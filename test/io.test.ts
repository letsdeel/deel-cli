import { test } from "node:test";
import assert from "node:assert/strict";
import { isatty } from "node:tty";
import { canPromptFrom, captureIO, isAgentEnv, realIO } from "../src/core/io.ts";

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
