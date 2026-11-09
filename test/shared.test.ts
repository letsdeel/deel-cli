import { test } from "node:test";
import assert from "node:assert/strict";
import { gatherFlagValues, gatherFiles, nullableBoolean, nullableNumber, nullableObject, nullableString } from "../src/commands/shared.ts";

test("gatherFlagValues reads a repeatable flag in every spelling the parser accepts, in the order typed", () => {
  assert.deepEqual(gatherFlagValues(["--job-ids", "a", "--job-ids=b"], "job_ids"), ["a", "b"]);
  assert.deepEqual(gatherFlagValues(["--jobIds", "a", "--jobIds=b"], "job_ids"), ["a", "b"]);
  assert.deepEqual(gatherFlagValues(["--job_ids", "a", "--job-ids", "b", "--jobIds=c"], "job_ids"), ["a", "b", "c"]);
  assert.deepEqual(gatherFlagValues(["--job-ids", "a"], "job-ids"), ["a"]);
  assert.deepEqual(gatherFlagValues(["--job_idsx", "a", "--job-ids-x=b"], "job_ids"), []);
  assert.deepEqual(gatherFlagValues(["--user-i-ds", "a", "--userIDs=b"], "userIDs"), ["a", "b"]);
  assert.deepEqual(gatherFlagValues(["--job_ids"], "job_ids"), []);
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

test("nullable helpers send null for the literal null, the typed value otherwise, and undefined when absent", () => {
  const usage = (err: any) => err.code === "usage.flag_value";
  assert.equal(nullableString(undefined), undefined);
  assert.equal(nullableString("null"), null);
  assert.equal(nullableString("hello"), "hello");
  assert.equal(nullableString(""), "");
  assert.equal(nullableNumber("null", "--n"), null);
  assert.equal(nullableNumber("42.5", "--n"), 42.5);
  assert.equal(nullableNumber("0", "--n"), 0);
  assert.throws(() => nullableNumber("abc", "--n"), (err: any) => usage(err) && /--n must be a number or null/.test(err.message));
  assert.throws(() => nullableNumber("", "--n"), usage);
  assert.equal(nullableBoolean("null", "--b"), null);
  assert.equal(nullableBoolean("false", "--b"), false);
  assert.throws(() => nullableBoolean("maybe", "--b"), usage);
  assert.equal(nullableObject("null", "--o"), null);
  assert.deepEqual(nullableObject('{"a":1}', "--o"), { a: 1 });
  assert.throws(() => nullableObject("[1]", "--o"), usage);
  assert.throws(() => nullableObject("{bad", "--o"), usage);
});
