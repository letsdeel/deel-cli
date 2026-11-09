import { test } from "node:test";
import assert from "node:assert/strict";
import { EXIT, CliError, failureEnvelope, toEnvelope } from "../src/core/errors.ts";

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

test("failureEnvelope keeps a CliError's detail, and names citty usage errors and anything else", () => {
  const error = new CliError("auth.missing", "No API token found.", "Run 'deel auth login'");
  error.requestId = "req-2";
  assert.deepEqual(failureEnvelope(error), { error: { code: "auth.missing", message: "No API token found.", next: "Run 'deel auth login'", request_id: "req-2" } });

  const cittyUsage = Object.assign(new Error("Missing required argument: ID"), { name: "CLIError", code: "E_MISSING_ARG" });
  assert.deepEqual(failureEnvelope(cittyUsage), { error: { code: "usage", message: "Missing required argument: ID" } });
  assert.deepEqual(failureEnvelope(Object.assign(new Error("bad"), { code: "EARG" })), { error: { code: "usage", message: "bad" } });

  assert.deepEqual(failureEnvelope(new TypeError("boom")), { error: { code: "unexpected", message: "boom" } });
  assert.deepEqual(failureEnvelope("plain"), { error: { code: "unexpected", message: "plain" } });
  assert.deepEqual(failureEnvelope(undefined), { error: { code: "unexpected", message: "undefined" } });
});
