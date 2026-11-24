import { test } from "node:test";
import assert from "node:assert/strict";
import { EXIT, CliError, failureEnvelope, isParserError, stripAnsi, toEnvelope, usageEnvelope } from "../src/core/errors.ts";

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
  const next = "Run the command with --help to see its arguments and flags.";
  assert.deepEqual(failureEnvelope(cittyUsage), { error: { code: "usage", message: "Missing required argument: ID", next } });
  assert.deepEqual(failureEnvelope(Object.assign(new Error("bad"), { code: "EARG" })), { error: { code: "usage", message: "bad", next } });

  assert.deepEqual(failureEnvelope(new TypeError("boom")), { error: { code: "unexpected", message: "boom" } });
  assert.deepEqual(failureEnvelope("plain"), { error: { code: "unexpected", message: "plain" } });
  assert.deepEqual(failureEnvelope(undefined), { error: { code: "unexpected", message: "undefined" } });
});

test("stripAnsi removes colour codes and leaves plain text alone", () => {
  assert.equal(stripAnsi("\u001b[36m--limit\u001b[39m (\u001b[36mx\u001b[39m)"), "--limit (x)");
  assert.equal(stripAnsi("\u001b[1;31mbold red\u001b[0m"), "bold red");
  assert.equal(stripAnsi("plain [36m text"), "plain [36m text");
  assert.equal(stripAnsi(""), "");
});

test("isParserError recognises the argument parser's errors and nothing else", () => {
  const parser = Object.assign(new Error("Missing required argument: --x"), { name: "CLIError" });
  assert.equal(isParserError(parser), true);
  assert.equal(isParserError(Object.assign(new Error("x"), { code: "EARG" })), true);
  assert.equal(isParserError(new CliError("usage.flag", "ours")), false);
  assert.equal(isParserError(new Error("boom")), false);
  assert.equal(isParserError(null), false);
  assert.equal(isParserError(undefined), false);
});

test("usageEnvelope gives the usage code, a plain message and a next step", () => {
  const envelope = usageEnvelope(new Error("Invalid value for argument: \u001b[36m--order\u001b[39m."));
  assert.equal(envelope.code, "usage");
  assert.equal(envelope.message, "Invalid value for argument: --order.");
  assert.match(envelope.next ?? "", /--help/);
  assert.equal(usageEnvelope({}).message, "Invalid usage.");
});
