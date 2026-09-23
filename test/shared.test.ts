import { test } from "node:test";
import assert from "node:assert/strict";
import { gatherFlagValues, gatherFiles } from "../src/commands/shared.ts";

test("gatherFlagValues collects every occurrence of a repeatable flag", () => {
  assert.deepEqual(gatherFlagValues(["--job_ids", "a", "--job_ids=b", "x", "--job_ids", "c"], "job_ids"), ["a", "b", "c"]);
  assert.deepEqual(gatherFlagValues(["--other", "z"], "job_ids"), []);
});

test("gatherFiles groups multiple files under one field and keeps distinct fields", () => {
  assert.deepEqual(gatherFiles(["--file", "cv=@a.pdf", "--file=cv=@b.pdf", "--file", "photo=@p.png"]), {
    cv: ["a.pdf", "b.pdf"],
    photo: ["p.png"],
  });
});
