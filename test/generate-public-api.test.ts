import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/definitions/${name}`, import.meta.url));

// The script locks released names against the committed manifest unless told otherwise, so the tests name their own.
const EMPTY = join(mkdtempSync(join(tmpdir(), "generate-public-api-empty-")), "manifest.json");
writeFileSync(EMPTY, JSON.stringify({ generator: "scripts/generate-public-api.ts", descriptors: [] }));

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
  const { code, stderr } = generate(["--from", fixture("widgets.json"), "--out", dir, "--summary", summary, "--previous", EMPTY]);
  assert.equal(code, 0, stderr);
  assert.match(stderr, /9 command\(s\) from 11 definition\(s\): 9 added, 0 changed, 0 removed \(bump: minor\)/);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  assert.equal(manifest.generator, "scripts/generate-public-api.ts");
  assert.equal(manifest.descriptors.length, 9);
  assert.equal(JSON.parse(readFileSync(summary, "utf8")).bump, "minor");
});

test("--from-openapi generates from an OpenAPI document", () => {
  const dir = mkdtempSync(join(tmpdir(), "generate-public-api-"));
  const { code, stderr } = generate(["--from-openapi", fixture("openapi-with-refs.json"), "--out", dir, "--previous", EMPTY]);
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
  const { code, stderr } = generate(["--from", clash, "--out", out, "--previous", EMPTY]);
  assert.equal(code, 1);
  assert.match(stderr, /defined more than once/);
  assert.match(stderr, /nothing written/);
  assert.equal(existsSync(join(out, "manifest.json")), false);
});

test("--previous locks the released names, and an unchanged run reports no bump", () => {
  const dir = mkdtempSync(join(tmpdir(), "generate-public-api-"));
  assert.equal(generate(["--from", fixture("widgets.json"), "--out", dir, "--previous", EMPTY]).code, 0);
  const released = join(dir, "manifest.json");

  const same = generate(["--from", fixture("widgets.json"), "--out", join(dir, "again"), "--previous", released]);
  assert.equal(same.code, 0, same.stderr);
  assert.match(same.stderr, /0 added, 0 changed, 0 removed \(bump: none\)/);

  const manifest = JSON.parse(readFileSync(released, "utf8"));
  manifest.descriptors[0].command = ["released", "elsewhere"];
  const renamed = join(dir, "renamed.json");
  writeFileSync(renamed, JSON.stringify(manifest));
  const locked = generate(["--from", fixture("widgets.json"), "--out", join(dir, "locked"), "--previous", renamed]);
  assert.equal(locked.code, 1);
  assert.match(locked.stderr, /Lock: .*released as "deel released elsewhere"/);
  assert.equal(existsSync(join(dir, "locked", "manifest.json")), false);
});

test("--previous must name a file that exists", () => {
  const { code, stderr } = generate(["--from", fixture("widgets.json"), "--out", mkdtempSync(join(tmpdir(), "generate-public-api-")), "--previous", "/nonexistent/manifest.json"]);
  assert.equal(code, 1);
  assert.match(stderr, /does not exist/);
});

test("input that holds no definitions exits 1 and leaves the manifest alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "generate-public-api-"));
  const empty = join(dir, "empty.json");
  writeFileSync(empty, "[]");
  const out = join(dir, "out");
  const { code, stderr } = generate(["--from", empty, "--out", out, "--previous", EMPTY]);
  assert.equal(code, 1);
  assert.match(stderr, /holds no definitions; nothing written/);
  assert.equal(existsSync(join(out, "manifest.json")), false);

  const notOpenApi = join(dir, "error-body.json");
  writeFileSync(notOpenApi, JSON.stringify({ message: "Forbidden" }));
  const second = generate(["--from-openapi", notOpenApi, "--out", out, "--previous", EMPTY]);
  assert.equal(second.code, 1);
  assert.match(second.stderr, /Not an OpenAPI document/);
  assert.equal(existsSync(join(out, "manifest.json")), false);
});
