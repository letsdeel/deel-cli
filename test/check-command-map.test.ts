import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("a command line must parse, with lowercase kebab-case words", () => {
  assert.match(failures([entry("GET", "/x", "deel Things list")]).join(), /'Things' is not lowercase kebab-case/);
  assert.match(failures([entry("GET", "/x", "things list")]).join(), /does not start with deel/);
  assert.match(failures([entry("GET", "/x", "deel things list [--bulk")]).join(), /opens a bracket it never closes/);
});

test("every path ID needs an argument, in path order", () => {
  assert.match(failures([entry("GET", "/a/{a_id}/b/{b_id}", "deel things get <b>")]).join(), /path param \{a_id\} of \/a\/\{a_id\}\/b\/\{b_id\} has no argument/);
  assert.deepEqual(failures([entry("GET", "/a/{a_id}/b/{b_id}", "deel things get <a> <b>")]), []);
  assert.match(failures([entry("GET", "/a/{a_id}/b/{b_id}", "deel things get <b> <a>")]).join(), /arguments must follow the path order/);
  assert.match(failures([entry("GET", "/a", "deel things get <thing>")]).join(), /<thing> matches no path param/);
  assert.deepEqual(failures([entry("GET", "/benefits", "deel benefits offerings list --country <country>")]), []);
});

test("a flag that picks an endpoint never takes a global flag's name", () => {
  assert.match(failures([entry("POST", "/shifts/raw", "deel shifts create --raw")]).join(), /--raw is a global flag/);
  assert.match(failures([entry("GET", "/x/{id}", "deel things get --json <thing>")]).join(), /--json is a global flag/);
});

test("command lines and endpoints are unique, unless two entries share a collapse key", () => {
  assert.match(failures([entry("POST", "/a/{id}/stop", "deel things stop <thing>"), entry("POST", "/a/{id}/end", "deel things stop <thing>")]).join(), /same command line as \/a\/\{id\}\/stop/);
  assert.match(failures([entry("GET", "/a/{id}", "deel things get <thing>"), entry("GET", "/a/{key}", "deel things show <thing>")]).join(), /same endpoint as \/a\/\{id\}/);
  assert.deepEqual(failures([entry("GET", "/a", "deel things list"), entry("GET", "/eor/a", "deel things list --worker-type eor")]), []);
  const collapsed = checkMap([entry("POST", "/a/{id}/stop", "deel things stop <thing>", { collapse: "stop" }), entry("POST", "/b/{id}/stop", "deel things stop <thing>", { collapse: "stop" })]);
  assert.deepEqual([collapsed.failures.length, collapsed.warnings.length], [0, 1]);
});

test("names: the map may not take a hand-picked or static name, and a released command line never changes", () => {
  const reserved = { commands: [{ command: ["jobs", "list"], method: "GET", path: "/jobs" }], topLevel: new Set(["auth"]) };
  const clash = checkMap([entry("GET", "/foo/baz", "deel jobs list")], { reserved }).failures;
  assert.match(clash.map((f) => f.message).join(), /"deel jobs list".*clashes with a hand-picked command/);
  assert.match(checkMap([entry("GET", "/auth/x", "deel auth things list")], { reserved }).failures.map((f) => f.message).join(), /shadow the static "deel auth"/);

  const released = [{ command: ["things", "get"], method: "GET", path: "/things/{id}", params: [], form: { positionals: [{ label: "thing", param: "id" }], scopes: [], selectors: [] } }] as unknown as Descriptor[];
  assert.deepEqual(checkMap([entry("GET", "/things/{id}", "deel things get <thing>")], { released }).failures, []);
  assert.match(checkMap([entry("GET", "/things/{id}", "deel things show <thing>")], { released }).failures.map((f) => f.message).join(), /released as "deel things get <thing>", the map now says "deel things show <thing>"/);
  assert.match(checkMap([entry("GET", "/other", "deel other list")], { released }).failures.map((f) => f.message).join(), /removed from the map/);
});

test("every domain of the map has a stage and description in domains.json", () => {
  const failures = checkMap([entry("GET", "/x", "deel widgets list")], { domains: ["contracts"] }).failures;
  assert.match(failures.map((f) => f.message).join(), /'widgets' is not in src\/public-api\/domains.json/);
  assert.deepEqual(checkMap([entry("GET", "/x", "deel contracts list")], { domains: ["contracts"] }).failures, []);
});
