import { test } from "node:test";
import assert from "node:assert/strict";
import { configFrom, gatherFlagValues, gatherFiles, readHidden, refuseMissingGlobalValues } from "../src/commands/shared.ts";

test("gatherFlagValues reads a repeatable flag in every spelling the parser accepts, in the order typed", () => {
  assert.deepEqual(gatherFlagValues(["--job-ids", "a", "--job-ids=b"], "job_ids"), ["a", "b"]);
  assert.deepEqual(gatherFlagValues(["--jobIds", "a", "--jobIds=b"], "job_ids"), ["a", "b"]);
  assert.deepEqual(gatherFlagValues(["--job_ids", "a", "--job-ids", "b", "--jobIds=c"], "job_ids"), ["a", "b", "c"]);
  assert.deepEqual(gatherFlagValues(["--job-ids", "a"], "job-ids"), ["a"]);
  assert.deepEqual(gatherFlagValues(["--job_idsx", "a", "--job-ids-x=b"], "job_ids"), []);
  assert.deepEqual(gatherFlagValues(["--user-i-ds", "a", "--userIDs=b"], "userIDs"), ["a", "b"]);
  assert.throws(() => gatherFlagValues(["--job_ids"], "job_ids"), (err: any) => err.code === "usage.flag_value" && /last argument/.test(err.message));
  assert.deepEqual(gatherFlagValues(["--description", "xxevent", "a"], "event"), []);
  assert.throws(() => gatherFlagValues(["--job-ids", "--x"], "job_ids"), (err: any) => err.code === "usage.flag_value" && /--job-ids needs a value/.test(err.message));
});

test("gatherFlagValues collects every occurrence of a repeatable flag", () => {
  assert.deepEqual(gatherFlagValues(["--job_ids", "a", "--job_ids=b", "x", "--job_ids", "c"], "job_ids"), ["a", "b", "c"]);
  assert.deepEqual(gatherFlagValues(["--other", "z"], "job_ids"), []);
  // a flag in the value position is a missing value, not a value; --name=--x still passes one that starts with --
  assert.throws(() => gatherFlagValues(["--event", "--status", "disabled"], "event"), (err: any) => err.code === "usage.flag_value" && /--event needs a value/.test(err.message));
  assert.deepEqual(gatherFlagValues(["--event=--x"], "event"), ["--x"]);
});

test("gatherFiles groups multiple files under one field and keeps distinct fields", () => {
  assert.deepEqual(gatherFiles(["--file", "cv=@a.pdf", "--file=cv=@b.pdf", "--file", "photo=@p.png"]), {
    cv: ["a.pdf", "b.pdf"],
    photo: ["p.png"],
  });
});

test("readHidden reads --base-url in every spelling the parser accepts (kebab and camel), and stops at --", () => {
  for (const argv of [["--base-url", "https://a.test"], ["--baseUrl=https://a.test"], ["--baseUrl", "https://a.test"], ["x", "--base-url=https://a.test"]]) {
    assert.equal(readHidden(argv, "base-url"), "https://a.test", argv.join(" "));
  }
  assert.equal(readHidden(["--", "--base-url", "https://a.test"], "base-url"), undefined);
  assert.equal(readHidden(["--base-urls", "https://a.test"], "base-url"), undefined);
});

test("a --file with nothing after it is a usage error, not a request sent without the file", () => {
  assert.throws(() => gatherFiles(["--file"]), (err: any) => err.code === "usage.file" && /last argument/.test(err.message));
  assert.throws(() => gatherFiles(["--file", "cv=@a.pdf", "--file"]), (err: any) => err.code === "usage.file");
  assert.deepEqual(gatherFiles(["--other", "--file", "cv=@a.pdf"]), { cv: ["a.pdf"] });
});

test("a global flag typed without its value stops the command before anything is sent, instead of defaulting to prod", () => {
  const refused = (argv: string[], flag: string) =>
    assert.throws(() => configFrom({ json: true }, argv), (err: any) => err.code === "usage.flag_value" && err.message === `--${flag} needs a value.` && /Nothing was sent/.test(err.next), argv.join(" "));
  refused(["--base-url="], "base-url");
  refused(["--base-url"], "base-url");
  refused(["list", "--base-url"], "base-url");
  refused(["--base-url", "--json"], "base-url");
  refused(["--baseUrl="], "baseUrl");
  refused(["--baseUrl", "--beta"], "baseUrl");
  refused(["--env="], "env");
  refused(["--env"], "env");
  refused(["--env", "--json"], "env");
  refused(["--ca-cert"], "ca-cert");
  refused(["--idempotency-key="], "idempotency-key");
  refused(["--idempotency-key", "--json"], "idempotency-key");
  for (const argv of [["--base-url", "https://a.test/rest"], ["--base-url=https://a.test/rest"], ["--baseUrl", "https://a.test/rest"], ["--env", "demo"], ["--env=demo"], ["--idempotency-key=k"], ["--ca-cert", "root.pem"], ["list", "--", "--base-url"], []]) {
    assert.doesNotThrow(() => refuseMissingGlobalValues(argv), argv.join(" "));
  }
  assert.equal(configFrom({ json: true }, ["--base-url", "https://a.test/rest"]).baseUrl, "https://a.test/rest");
});
