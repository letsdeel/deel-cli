import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkMap } from "../scripts/check-command-map.ts";
import type { MapEntry } from "../scripts/public-api/command-map.ts";
import type { Descriptor } from "../src/types.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const entry = (method: string, path: string, command: string, extra: Partial<MapEntry> = {}): MapEntry => ({ method, path, command, ...extra });
const failures = (entries: MapEntry[]) => checkMap(entries).failures.map((f) => f.message);

test("the committed command map passes", () => {
  const map = JSON.parse(readFileSync(new URL("../src/public-api/commands.json", import.meta.url), "utf8")) as MapEntry[];
  assert.deepEqual(checkMap(map).failures, []);
  const run = spawnSync(process.execPath, ["scripts/check-command-map.ts"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /command map: 0 failure\(s\)/);
});

test("the check exits 1 and names each failure when the map file it is given has one", () => {
  const map = join(mkdtempSync(join(tmpdir(), "check-command-map-")), "commands.json");
  writeFileSync(map, JSON.stringify([entry("GET", "/a/{a_id}", "deel things get")]));
  const run = spawnSync(process.execPath, ["scripts/check-command-map.ts", map], { cwd: ROOT, encoding: "utf8" });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /^FAIL {2}path param \{a_id\} of \/a\/\{a_id\} has no argument in the command$/m);
  assert.match(run.stderr, /^command map: [1-9]\d* failure\(s\)/m);
});





test("a map file that isn't an array of entries fails with a clear message instead of a stack trace", () => {
  const dir = mkdtempSync(join(tmpdir(), "check-command-map-"));
  for (const [name, content] of [["object.json", '{"method":"GET"}'], ["missing.json", '[{"method":"GET","path":"/a"}]']]) {
    const file = join(dir, name);
    writeFileSync(file, content);
    const run = spawnSync(process.execPath, ["scripts/check-command-map.ts", file], { cwd: ROOT, encoding: "utf8" });
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /^FAIL {2}.*check-command-map-.*: (the command map must be a JSON array|entry 0 needs a non-empty string command)/m);
    assert.doesNotMatch(run.stderr, /at .*\.ts:\d+/);
  }
});

test("a command line must parse, with lowercase kebab-case words", () => {
  assert.match(failures([entry("GET", "/x", "deel Things list")]).join(), /'Things' is not lowercase kebab-case/);
  assert.match(failures([entry("GET", "/x", "things list")]).join(), /does not start with deel/);
  assert.match(failures([entry("GET", "/x", "deel things list [--bulk")]).join(), /opens a bracket it never closes/);
});

test("every path ID needs an argument, in path order", () => {
  assert.match(failures([entry("GET", "/a/{a_id}/b/{b_id}", "deel things get <b>")]).join(), /path param \{a_id\} of \/a\/\{a_id\}\/b\/\{b_id\} has no argument/);
  assert.deepEqual(failures([entry("GET", "/a/{a_id}/b/{b_id}", "deel things get <a_id> <b_id>")]), []);
  assert.match(failures([entry("GET", "/a/{a_id}/b/{b_id}", "deel things get <b_id> <a_id>")]).join(), /arguments must follow the path order/);
  assert.match(failures([entry("GET", "/a", "deel things get <thing>")]).join(), /<thing> matches no path param/);
  assert.deepEqual(failures([entry("GET", "/benefits", "deel benefits offerings list --country <country>")]), []);
});

test("an argument is named after the path param it fills, ignoring case", () => {
  assert.match(failures([entry("GET", "/a/{contract_id}", "deel things get <contract>")]).join(), /<contract> fills \{contract_id\}, so it is written <contract_id>/);
  assert.deepEqual(failures([entry("GET", "/a/{roleid}", "deel things get <roleId>")]), []);
  assert.match(failures([entry("GET", "/a/{contract_id}/b", "deel things b list --contract <contract>"), entry("GET", "/b", "deel things b list")]).join(), /<contract> fills \{contract_id\}/);
  assert.deepEqual(failures([entry("GET", "/benefits", "deel benefits offerings list --country <country_code>")]), []);
});

test("a flag that picks an endpoint never takes a global flag's name", () => {
  assert.match(failures([entry("POST", "/shifts/raw", "deel shifts create --raw")]).join(), /--raw is a global flag/);
  assert.match(failures([entry("GET", "/x/{id}", "deel things get --json <id>")]).join(), /--json is a global flag/);
});

test("command lines and endpoints are unique, unless two entries share a collapse key", () => {
  assert.match(failures([entry("POST", "/a/{id}/stop", "deel things stop <id>"), entry("POST", "/a/{id}/end", "deel things stop <id>")]).join(), /same command line as \/a\/\{id\}\/stop/);
  assert.match(failures([entry("GET", "/a/{id}", "deel things get <id>"), entry("GET", "/a/{key}", "deel things show <key>")]).join(), /same endpoint as \/a\/\{id\}/);
  assert.deepEqual(failures([entry("GET", "/a", "deel things list"), entry("GET", "/eor/a", "deel things list --worker-type eor")]), []);
  const collapsed = checkMap([entry("POST", "/a/{id}/stop", "deel things stop <id>", { collapse: "stop" }), entry("POST", "/b/{ref}/stop", "deel things stop <id>", { collapse: "stop" })]);
  assert.deepEqual([collapsed.failures.length, collapsed.warnings.length], [0, 1]);
});

test("names: the map may not take a hand-picked or static name, and a released command line never changes", () => {
  const reserved = { commands: [{ command: ["jobs", "list"], method: "GET", path: "/jobs" }], topLevel: new Set(["auth"]) };
  const clash = checkMap([entry("GET", "/foo/baz", "deel jobs list")], { reserved }).failures;
  assert.match(clash.map((f) => f.message).join(), /"deel jobs list".*clashes with a hand-picked command/);
  assert.match(checkMap([entry("GET", "/auth/x", "deel auth things list")], { reserved }).failures.map((f) => f.message).join(), /shadow the static "deel auth"/);

  const released = [{ command: ["things", "get"], method: "GET", path: "/things/{id}", params: [], form: { positionals: [{ label: "id", param: "id" }], scopes: [], selectors: [] } }] as unknown as Descriptor[];
  assert.deepEqual(checkMap([entry("GET", "/things/{id}", "deel things get <id>")], { released }).failures, []);
  assert.match(checkMap([entry("GET", "/things/{id}", "deel things show <id>")], { released }).failures.map((f) => f.message).join(), /released as "deel things get <id>", the map now says "deel things show <id>"/);
  assert.match(checkMap([entry("GET", "/other", "deel other list")], { released }).failures.map((f) => f.message).join(), /removed from the map/);
});

test("every domain of the map has a stage and description in domains.json", () => {
  const failures = checkMap([entry("GET", "/x", "deel widgets list")], { domains: ["contracts"] }).failures;
  assert.match(failures.map((f) => f.message).join(), /'widgets' is not in src\/public-api\/domains.json/);
  assert.deepEqual(checkMap([entry("GET", "/x", "deel contracts list")], { domains: ["contracts"] }).failures, []);
});
