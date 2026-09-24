import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { check } from "../scripts/check-version.ts";

const pkg = (version: string) => JSON.stringify({ name: "@deel-org/cli", version });
const src = (version: string) => `// header\nexport const CLI_VERSION = "${version}";\n`;

test("passes when package.json and src/version.ts carry the same clean semver", () => {
  assert.deepEqual(check(pkg("0.1.1"), src("0.1.1")), []);
});

test("the repository's own files pass", () => {
  assert.deepEqual(
    check(readFileSync(new URL("../package.json", import.meta.url), "utf8"), readFileSync(new URL("../src/version.ts", import.meta.url), "utf8")),
    [],
  );
});

test("flags a mismatch between the two files", () => {
  const errors = check(pkg("0.1.2"), src("0.1.1"));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /package\.json \(0\.1\.2\) and src\/version\.ts \(0\.1\.1\) disagree/);
});

test("rejects a pre-release suffix in package.json — the release pipeline owns -beta.N", () => {
  const errors = check(pkg("0.1.1-beta.2"), src("0.1.1-beta.2"));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /must be a clean X\.Y\.Z/);
});

test("reports a missing CLI_VERSION export", () => {
  const errors = check(pkg("0.1.1"), "export const SOMETHING_ELSE = 1;\n");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /must contain `export const CLI_VERSION/);
});

test("reports unparseable package.json and a missing version field", () => {
  assert.deepEqual(check("{not json", src("0.1.1")), ["[version] package.json is not valid JSON"]);
  assert.deepEqual(check(JSON.stringify({ name: "x" }), src("0.1.1")), ['[version] package.json has no "version" string']);
});
