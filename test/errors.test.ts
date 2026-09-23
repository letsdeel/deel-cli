import { test } from "node:test";
import assert from "node:assert/strict";
import { EXIT, CliError, toEnvelope } from "../src/core/errors.ts";

test("exit codes are binary: success and error", () => {
  assert.equal(EXIT.OK, 0);
  assert.equal(EXIT.ERROR, 1);
});

test("toEnvelope renders the stable error shape", () => {
  const error = new CliError("auth.invalid", "Token check failed", "Re-run with a valid token");
  error.requestId = "req-1";
  assert.deepEqual(toEnvelope(error), {
    code: "auth.invalid",
    message: "Token check failed",
    next: "Re-run with a valid token",
    request_id: "req-1",
  });
});

test("CliError carries code and optional next; detail lives in the envelope", () => {
  const error = new CliError("x", "y");
  assert.equal(error.code, "x");
  assert.equal(error.message, "y");
  assert.equal(error.next, undefined);
});
