import { test } from "node:test";
import assert from "node:assert/strict";
import { validate, section, TYPE_LABELS, GENERATED_MANIFEST } from "../scripts/check-pr.ts";
import type { PrInput } from "../scripts/check-pr.ts";

// Mirrors .github/pull_request_template.md filled in the way /ship fills it.
const GOOD_BODY = `## Description
Adds a fork-aware PR validator so CI and /ship share one rule set.

## Testing
**How I Tested:**
- npm run check, plus new unit tests for every rule

**Evidence/Proof:**
<!-- none -->

## Release checklist
- [x] npm run check passes locally
`;

function pr(overrides: Partial<PrInput> = {}): PrInput {
  return {
    title: "add PR validator",
    body: GOOD_BODY,
    labels: ["chore", "ai-assisted"],
    author: "dusko-bajic-deel",
    isFork: false,
    base: "dev",
    files: ["scripts/check-pr.ts", "test/check-pr.test.ts"],
    ...overrides,
  };
}

test("a template-conformant Deel PR passes with no errors or warnings", () => {
  const r = validate(pr());
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test("section() isolates an h2 and keeps h3 sub-headings inside it", () => {
  const body = "## Description\nintro\n### Detail\nmore\n## Testing\nhow";
  assert.equal(section(body, "Description"), "\nintro\n### Detail\nmore\n");
  assert.equal(section(body, "Testing"), "\nhow");
  assert.equal(section(body, "Missing"), null);
});

test("HTML comments left over from the template do not count as a description", () => {
  const body = GOOD_BODY.replace(
    "Adds a fork-aware PR validator so CI and /ship share one rule set.",
    "<!-- What changes and why. Anything a user will notice goes here. -->",
  );
  const r = validate(pr({ body }));
  assert.equal(r.errors.filter((e) => e.includes("## Description")).length, 1);
});

test("a Testing section without a How I Tested entry fails", () => {
  const body = GOOD_BODY.replace("**How I Tested:**\n- npm run check, plus new unit tests for every rule\n", "- ran stuff\n");
  const r = validate(pr({ body }));
  assert.equal(r.errors.filter((e) => e.includes("How I Tested")).length, 1);
});

test("How I Tested accepts the ### heading form and inline text", () => {
  const heading = GOOD_BODY.replace("**How I Tested:**\n", "### How I Tested\n");
  assert.deepEqual(validate(pr({ body: heading })).errors, []);
  const inline = GOOD_BODY.replace("**How I Tested:**\n- npm run check, plus new unit tests for every rule\n", "**How I Tested:** ran the full check suite locally\n");
  assert.deepEqual(validate(pr({ body: inline })).errors, []);
});

test("fork PRs are not blocked on a missing label, but are told what a maintainer will do", () => {
  const r = validate(pr({ title: "Fix typo in help", labels: [], isFork: true, author: "octocat" }));
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => w.includes("no type label")));
});

test("exactly one type label is required on Deel branches", () => {
  const none = validate(pr({ labels: ["ai-assisted"] }));
  assert.equal(none.errors.filter((e) => e.includes("type label")).length, 1);
  const two = validate(pr({ labels: ["bug", "chore"], files: ["src/core/http.ts", "test/http.test.ts"] }));
  assert.deepEqual(two.errors, []);
  assert.ok(two.warnings.some((w) => w.includes("more than one type label")));
  assert.deepEqual([...TYPE_LABELS], ["bug", "enhancement", "refactor", "documentation", "chore"]);
});

test("bug and enhancement PRs must touch a test file — refactor/docs/chore need not", () => {
  for (const type of ["bug", "enhancement"]) {
    const r = validate(pr({ labels: [type], files: ["src/core/http.ts"] }));
    assert.equal(r.errors.filter((e) => e.includes("must add or update a test")).length, 1, type);
    assert.deepEqual(validate(pr({ labels: [type], files: ["src/core/http.ts", "test/http.test.ts"] })).errors, []);
  }
  assert.deepEqual(validate(pr({ labels: ["refactor"], files: ["src/core/http.ts"] })).errors, []);
});

test("a changed generated manifest needs the script-generated label", () => {
  const r = validate(pr({ files: [GENERATED_MANIFEST, "src/commands.map.ts"] }));
  assert.equal(r.errors.filter((e) => e.includes("script-generated")).length, 1);
  assert.deepEqual(validate(pr({ files: [GENERATED_MANIFEST], labels: ["chore", "script-generated"] })).errors, []);
  const fork = validate(pr({ files: [GENERATED_MANIFEST], isFork: true }));
  assert.deepEqual(fork.errors, []);
  assert.ok(fork.warnings.some((w) => w.includes("came from the extractor")));
});

test("a non-dev base branch is a warning, not an error", () => {
  const r = validate(pr({ base: "stacked-parent" }));
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => w.includes("dev is the only release line")));
});

test("bot PRs skip the body checks entirely", () => {
  const r = validate(pr({ author: "dependabot[bot]", body: "Bumps actions/checkout from 5 to 6.", labels: ["dependencies"] }));
  assert.deepEqual(r.errors, []);
  assert.ok(r.notices[0].includes("bot"));
});

test("CRLF bodies are normalised before matching", () => {
  assert.deepEqual(validate(pr({ body: GOOD_BODY.replace(/\n/g, "\r\n") })).errors, []);
});
