import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { isYes, promptConfirm } from "../src/core/prompt.ts";

const streams = () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const written: string[] = [];
  output.on("data", (chunk) => written.push(String(chunk)));
  return { input, output, written };
};

test("isYes accepts y and yes in any case, with spaces around, and nothing else", () => {
  for (const answer of ["y", "Y", "yes", "YES", "Yes", " y ", "yes\n"]) assert.equal(isYes(answer), true, answer);
  for (const answer of ["", "n", "no", "yep", "ye", "true", "1", "y es"]) assert.equal(isYes(answer), false, answer);
});

test("promptConfirm asks on the output and settles with the answer", async () => {
  for (const [line, expected] of [["y\n", true], ["YES\n", true], ["n\n", false], ["no\n", false], ["\n", false]] as const) {
    const { input, output, written } = streams();
    const answer = promptConfirm("Go? [y/N] ", input, output, 1_000);
    input.write(line);
    assert.equal(await answer, expected, JSON.stringify(line));
    assert.match(written.join(""), /Go\? \[y\/N\] /);
  }
});

test("promptConfirm counts a closed input as no", async () => {
  const { input, output } = streams();
  const answer = promptConfirm("Go? [y/N] ", input, output, 1_000);
  input.end();
  assert.equal(await answer, false);
});

test("promptConfirm settles as a timeout when nobody answers, and a later answer changes nothing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { input, output } = streams();
  const answer = promptConfirm("Go? [y/N] ", input, output, 60_000);
  t.mock.timers.tick(60_000);
  assert.equal(await answer, "timeout");
  input.write("y\n");
  assert.equal(await answer, "timeout");
});
