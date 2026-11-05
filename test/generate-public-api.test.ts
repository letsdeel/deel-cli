import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/definitions/${name}`, import.meta.url));

function generate(args: string[]) {
  const result = spawnSync(process.execPath, ["scripts/generate-public-api.ts", ...args], { cwd: ROOT, encoding: "utf8" });
  return { code: result.status, stderr: result.stderr };
}

test("it needs exactly one of --from and --from-openapi", () => {
  const none = generate([]);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /Usage: generate-public-api\.ts/);
  const both = generate(["--from", fixture("widgets.json"), "--from-openapi", fixture("openapi-with-refs.json")]);
  assert.equal(both.code, 1);
  assert.match(both.stderr, /Usage:/);
});

test("--from writes the manifest to --out and the summary to --summary", () => {
  const dir = mkdtempSync(join(tmpdir(), "generate-public-api-"));
  const summary = join(dir, "summary.json");
  const { code, stderr } = generate(["--from", fixture("widgets.json"), "--out", dir, "--summary", summary]);
  assert.equal(code, 0, stderr);
  assert.match(stderr, /9 command\(s\) from 11 definition\(s\): 9 added, 0 changed, 0 removed \(bump: minor\)/);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  assert.equal(manifest.generator, "scripts/generate-public-api.ts");
  assert.equal(manifest.descriptors.length, 9);
  assert.equal(JSON.parse(readFileSync(summary, "utf8")).bump, "minor");
});

test("--from-openapi generates from an OpenAPI document", () => {
  const dir = mkdtempSync(join(tmpdir(), "generate-public-api-"));
  const { code, stderr } = generate(["--from-openapi", fixture("openapi-with-refs.json"), "--out", dir]);
  assert.equal(code, 0, stderr);
  assert.ok(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).descriptors.length > 0);
});

test("an error exits 1 and writes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "generate-public-api-"));
  const clash = join(dir, "definitions.json");
  const entry = (path: string) => ({ api: "rest", method: "GET", path, version: "2026-01-01", operation: { summary: "x", responses: { "200": { description: "ok" } } } });
  // The same route and version twice, under two spellings of its path param.
  writeFileSync(clash, JSON.stringify([entry("/gadgets/{a}"), entry("/gadgets/{b}")]));
  const out = join(dir, "out");
  const { code, stderr } = generate(["--from", clash, "--out", out]);
  assert.equal(code, 1);
  assert.match(stderr, /defined more than once/);
  assert.match(stderr, /nothing written/);
  assert.equal(existsSync(join(out, "manifest.json")), false);
});
