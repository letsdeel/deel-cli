import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindForm, isApi, mapShapeError, parseCommand, readCommandMap } from "../scripts/public-api/command-map.ts";
import type { MapEntry } from "../scripts/public-api/command-map.ts";

const entry = (method: string, path: string, command: string, extra: Partial<MapEntry> = {}): MapEntry => ({ method, path, command, ...extra });

test("parseCommand reads words, positionals, scope flags and the three kinds of selector", () => {
  assert.deepEqual(parseCommand("deel contracts get <contract> --file-format pdf [--worker-type eor] --as worker --bulk --contract <c>"), {
    words: ["contracts", "get"],
    labels: [{ label: "contract" }, { label: "c", flag: "contract" }],
    selectors: [{ flag: "file-format", value: "pdf" }, { flag: "worker-type", value: "eor", optional: true }, { flag: "as", value: "worker" }, { flag: "bulk" }],
  });
  assert.deepEqual(parseCommand("deel it seats unassign [--bulk]").selectors, [{ flag: "bulk", optional: true }]);
  assert.throws(() => parseCommand("contracts get"), /does not start with deel/);
  assert.throws(() => parseCommand("deel contracts"), /needs a domain and a verb/);
  assert.throws(() => parseCommand("deel contracts get <contract> stray"), /is not a positional or a flag/);
  assert.throws(() => parseCommand("deel contracts get [--worker-type eor"), /opens a bracket it never closes/);
  assert.throws(() => parseCommand("deel notes list [--job <job>]"), /a scope flag can't be optional/);
  // A bracket with no partner is an error, not a label or a selector that quietly means something else.
  assert.deepEqual(parseCommand("deel things list --contract <contract_id>").labels, [{ label: "contract_id", flag: "contract" }]);
  assert.throws(() => parseCommand("deel things list --contract <contract_id>]"), /"<contract_id>]" closes a bracket it never opened/);
  assert.throws(() => parseCommand("deel things list --worker-type eor]"), /"--worker-type" closes a bracket it never opened/);
  assert.throws(() => parseCommand("deel things list --bulk]"), /"--bulk]" closes a bracket it never opened/);
  assert.throws(() => parseCommand("deel things list [--worker-type eor]]"), /is not a selector value/);
  assert.throws(() => parseCommand("deel things list] get"), /"list]" is not a command word/);
});

test("bindForm binds a label to the path param whose name holds it, then the rest in path order", () => {
  const bound = (command: string, path: string, query: string[] = []) => bindForm(parseCommand(command), path, query);
  assert.deepEqual(bound("deel docs files get <document> --contract <contract>", "/workers/contracts/{contract_id}/docs/{document_id}").form, {
    positionals: [{ label: "document", param: "document_id" }],
    scopes: [{ flag: "contract", label: "contract", param: "contract_id" }],
    selectors: [],
  });
  assert.deepEqual(bound("deel att list <type> <id> <attachment-type>", "/att/{attachable_type_slug}/{attachable_id}/{attachment_type_slug}").form!.positionals.map((p) => p.param), [
    "attachable_type_slug",
    "attachable_id",
    "attachment_type_slug",
  ]);
  assert.deepEqual(bound("deel fields delete <field> --contract <contract>", "/contracts/{contract_id}/fields/{id}").form!.positionals, [{ label: "field", param: "id" }]);
  // A scope flag left over names the one query param whose name holds it.
  assert.deepEqual(bound("deel offerings list --country <country>", "/benefits", ["country_code", "team_id"]).form!.scopes, [{ flag: "country", label: "country", param: "country_code", in: "query" }]);
});

test("the committed manifest binds every entry's arguments as the command map says", () => {
  const read = (file: string) => JSON.parse(readFileSync(new URL(`../src/public-api/${file}`, import.meta.url), "utf8"));
  const descriptors: { method: string; path: string; params: { name: string; in: string }[]; form: unknown }[] = read("manifest.json").descriptors;
  let checked = 0;
  for (const entry of read("commands.json") as { method: string; path: string; command: string }[]) {
    // An entry collapsed into another one's command has no descriptor of its own.
    const descriptor = descriptors.find((d) => d.method === entry.method && d.path === entry.path);
    if (!descriptor) continue;
    const query = descriptor.params.filter((param) => param.in === "query").map((param) => param.name);
    assert.deepEqual(bindForm(parseCommand(entry.command), entry.path, query).form, descriptor.form, entry.command);
    checked++;
  }
  assert.ok(checked > 500, `${checked} entries checked`);
});

test("mapShapeError accepts a well-formed map and names the first entry that is not one", () => {
  assert.equal(mapShapeError([entry("GET", "/a", "deel a list"), { ...entry("GET", "/b", "deel b list"), collapse: "k", api: "scim" }]), undefined);
  assert.match(mapShapeError({ method: "GET" }) ?? "", /must be a JSON array/);
  const bads: Array<[unknown[], RegExp]> = [
    [[null], /^entry 0 must be an object/],
    [["deel a list"], /^entry 0 must be an object/],
    [[[]], /^entry 0 must be an object/],
    [[{ method: "GET", path: "/a" }], /^entry 0 needs a non-empty string command/],
    [[{ method: "GET", path: 1, command: "deel a" }], /^entry 0 needs a non-empty string path/],
    [[entry("", "/a", "deel a list")], /^entry 0 needs a non-empty string method/],
    [[entry("GET /a", "/a", "deel a list")], /^entry 0 has a method that is not an HTTP method name/],
    [[entry("GET", "a", "deel a list")], /^entry 0 has a path that does not start with \//],
    [[entry("GET", "/a", "deel a list"), { ...entry("GET", "/b", "deel b list"), api: "SCIM" }], /^entry 1 has an api that is neither "rest" nor "scim"/],
    [[{ ...entry("GET", "/a", "deel a list"), api: 7 }], /^entry 0 has an api/],
    [[{ ...entry("GET", "/a", "deel a list"), collapse: 3 }], /^entry 0 has a collapse that is not a non-empty string/],
    [[{ ...entry("GET", "/a", "deel a list"), collapse: "" }], /^entry 0 has a collapse/],
    [[{ ...entry("GET", "/a", "deel a list"), colapse: "k" }], /^entry 0 has unknown field\(s\) colapse/],
  ];
  for (const [bad, message] of bads) assert.match(mapShapeError(bad) ?? "", message, JSON.stringify(bad));
});

test("readCommandMap names the file and the entry at fault, for a mistyped field, a missing one, bad JSON and a missing file", () => {
  const dir = mkdtempSync(join(tmpdir(), "check-command-map-"));
  const write = (name: string, content: string) => (writeFileSync(join(dir, name), content), join(dir, name));
  const good = write("good.json", JSON.stringify([entry("GET", "/a", "deel a list")]));
  assert.deepEqual(readCommandMap(good), [entry("GET", "/a", "deel a list")]);
  assert.throws(() => readCommandMap(write("paht.json", '[{"method":"GET","paht":"/a","command":"deel a list"}]')), /paht\.json: entry 0 needs a non-empty string path/);
  assert.throws(() => readCommandMap(write("nometh.json", '[{"path":"/a","command":"deel a list"}]')), /nometh\.json: entry 0 needs a non-empty string method/);
  assert.throws(() => readCommandMap(write("object.json", "{}")), /object\.json: the command map must be a JSON array/);
  assert.throws(() => readCommandMap(write("bad.json", "[{")), /bad\.json: /);
  assert.throws(() => readCommandMap(join(dir, "missing.json")), /missing\.json/);
});

test("isApi accepts exactly the APIs the type names, and nothing inherited", () => {
  assert.deepEqual(["rest", "scim"].map(isApi), [true, true]);
  for (const bad of ["SCIM", "", "constructor", "toString", undefined, null, 1, {}]) assert.equal(isApi(bad), false, String(bad));
});
