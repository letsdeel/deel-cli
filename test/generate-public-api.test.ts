import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/definitions/${name}`, import.meta.url));

// The script locks released names against the committed manifest unless told otherwise, so the tests name their own.
const EMPTY = join(mkdtempSync(join(tmpdir(), "generate-public-api-empty-")), "manifest.json");
writeFileSync(EMPTY, JSON.stringify({ generator: "scripts/generate-public-api.ts", descriptors: [] }));

// The widgets map names every widgets endpoint, unless a test passes its own --map.
function generate(args: string[]) {
  const map = args.includes("--map") ? [] : ["--map", fixture("widgets-map.json")];
  const result = spawnSync(process.execPath, ["scripts/generate-public-api.ts", ...args, ...map], { cwd: ROOT, encoding: "utf8" });
  return { code: result.status, stderr: result.stderr };
}

test("it needs --from", () => {
  const none = generate([]);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /Usage: generate-public-api\.ts --from <file\|url>/);
});

test("a --map that is not an array of entries is an error, and nothing is written", () => {
  const dir = mkdtempSync(join(tmpdir(), "generate-public-api-"));
  const map = join(dir, "map.json");
  writeFileSync(map, JSON.stringify({ entries: [] }));
  const { code, stderr } = generate(["--from", fixture("widgets.json"), "--map", map, "--out", dir, "--previous", EMPTY]);
  assert.equal(code, 1);
  assert.match(stderr, /map\.json is not a command map \(an array of entries\)/);
  assert.equal(existsSync(join(dir, "manifest.json")), false);
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

test("an error exits 1 and writes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "generate-public-api-"));
  const clash = join(dir, "definitions.json");
  const entry = (path: string) => ({ api: "rest", method: "GET", path, version: "2026-01-01", operation: { summary: "x", responses: { "200": { description: "ok" } } } });
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

  const errorBody = join(dir, "error-body.json");
  writeFileSync(errorBody, JSON.stringify({ message: "Forbidden" }));
  const second = generate(["--from", errorBody, "--out", out, "--previous", EMPTY]);
  assert.equal(second.code, 1);
  assert.match(second.stderr, /must be a JSON array/);
  assert.equal(existsSync(join(out, "manifest.json")), false);
});

test("--previous must be a generated manifest, or the name lock would silently switch off", () => {
  const dir = mkdtempSync(join(tmpdir(), "generate-public-api-"));
  for (const wrong of [fixture("widgets.json"), (() => { const file = join(dir, "object.json"); writeFileSync(file, "{}"); return file; })()]) {
    const out = join(dir, "out");
    const { code, stderr } = generate(["--from", fixture("widgets.json"), "--out", out, "--previous", wrong]);
    assert.equal(code, 1);
    assert.match(stderr, /is not a generated manifest/);
    assert.equal(existsSync(join(out, "manifest.json")), false);
  }
});

const definitionsFile = (definitions: Array<{ method: string; path: string }>) => {
  const file = join(mkdtempSync(join(tmpdir(), "generate-public-api-defs-")), "definitions.json");
  writeFileSync(file, JSON.stringify(definitions.map(({ method, path }) => ({
    api: "rest", method, path, version: "2026-01-01", beta_until: null, sunset_at: null,
    operation: { summary: "S", responses: { "200": { description: "ok" } } },
  }))));
  return file;
};

test("without --map the committed command map names the endpoints, and an unmapped one is an error", () => {
  const dir = mkdtempSync(join(tmpdir(), "generate-public-api-"));
  const mapped = generate(["--from", definitionsFile([{ method: "GET", path: "/contracts/{contract_id}" }]), "--out", dir, "--previous", EMPTY, "--map", join(ROOT, "src/public-api/commands.json")]);
  assert.equal(mapped.code, 0, mapped.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).descriptors.map((descriptor: { command: string[] }) => descriptor.command), [["contracts", "get"]]);

  const unmapped = generate(["--from", definitionsFile([{ method: "GET", path: "/brand-new-things" }]), "--out", dir, "--previous", EMPTY, "--map", join(ROOT, "src/public-api/commands.json")]);
  assert.equal(unmapped.code, 1);
  assert.match(unmapped.stderr, /GET \/brand-new-things has no entry in src\/public-api\/commands.json/);
});

test("a path that has a hand-picked command is reported as a warning on stderr", () => {
  const map = join(mkdtempSync(join(tmpdir(), "generate-public-api-map-")), "map.json");
  writeFileSync(map, JSON.stringify([{ method: "GET", path: "/jobs", command: "deel dev jobs list" }]));
  const { stderr } = generate(["--from", definitionsFile([{ method: "GET", path: "/jobs" }]), "--out", mkdtempSync(join(tmpdir(), "generate-public-api-")), "--previous", EMPTY, "--map", map]);
  assert.match(stderr, /\[warn\] GET \/jobs has a hand-picked command/);
});

test("without --previous the released names come from the manifest committed next to the script", () => {
  const repo = mkdtempSync(join(tmpdir(), "generate-public-api-repo-"));
  for (const entry of ["scripts", "src", ".claude/skills/deel-cli-extractor", "package.json"]) cpSync(join(ROOT, entry), join(repo, entry), { recursive: true });
  symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"));
  cpSync(fixture("widgets-map.json"), join(repo, "src/public-api/commands.json"));
  writeFileSync(join(repo, "src/public-api/manifest.json"), JSON.stringify({ generator: "scripts/generate-public-api.ts", descriptors: [] }));
  const run = (extra: string[] = []) => {
    const result = spawnSync(process.execPath, ["scripts/generate-public-api.ts", "--from", fixture("widgets.json"), ...extra], { cwd: repo, encoding: "utf8" });
    return { code: result.status, stderr: result.stderr };
  };

  const first = run();
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stderr, /9 added/);
  const again = run();
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stderr, /0 added, 0 changed, 0 removed/);
  const elsewhere = run(["--out", mkdtempSync(join(tmpdir(), "generate-public-api-"))]);
  assert.equal(elsewhere.code, 0, elsewhere.stderr);
  assert.match(elsewhere.stderr, /0 added, 0 changed, 0 removed/);

  const map = join(repo, "src/public-api/commands.json");
  writeFileSync(map, readFileSync(map, "utf8").replace('"command": "deel widgets create"', '"command": "deel widgets add"'));
  const renamed = run();
  assert.equal(renamed.code, 1);
  assert.match(renamed.stderr, /Lock: POST \/widgets was released as "deel widgets create"/);
});
