import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { run } from "../src/cli.ts";
import { EXIT } from "../src/core/errors.ts";
import { RESERVED_COMMANDS } from "../src/core/constants.ts";
import { staticCommands } from "../src/commands/index.ts";
import { manifest as handPicked } from "../src/manifest.generated.ts";
import { setGeneratedDescriptorsForTests } from "../src/public-api/commands.ts";
import { parseDefinitions } from "../scripts/public-api/definitions.ts";
import { generate } from "../scripts/public-api/generate.ts";

const definitions = parseDefinitions(JSON.parse(readFileSync(new URL("./fixtures/definitions/help-tree.json", import.meta.url), "utf8")));
const { manifest } = generate(definitions, {
  reserved: { commands: handPicked.descriptors, topLevel: RESERVED_COMMANDS },
  overrides: {},
  now: new Date("2026-10-30T00:00:00Z"),
});

async function capture(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = ((chunk: any) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
  process.stderr.write = ((chunk: any) => (err.push(String(chunk)), true)) as typeof process.stderr.write;
  setGeneratedDescriptorsForTests(manifest.descriptors);
  try {
    const code = await run(argv);
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    setGeneratedDescriptorsForTests(undefined);
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

test("every static command is reserved from generated names", () => {
  assert.deepEqual(Object.keys(staticCommands).sort(), [...RESERVED_COMMANDS].sort());
});

test("deel commands lists every hand-picked, generated and static command", async () => {
  const { code, out } = await capture(["commands"]);
  assert.equal(code, EXIT.OK);
  assert.match(out, /^widgets invitations create +POST +\/widgets\/\{widget_id\}\/invitations +Send a widget invitation$/m);
  assert.match(out, /^adjustments create --invoice +POST +\S+ +Create a single invoice adjustment$/m);
  assert.match(out, /^adjustments create --payroll +POST /m);
  assert.match(out, /^scim users list +GET +\/Users +List users$/m);
  assert.match(out, /^auth login +Validate a PAT/m);
  assert.match(out, /^commands +List every command/m);
  const lines = out.trimEnd().split("\n");
  assert.equal(lines.length, handPicked.descriptors.length + manifest.descriptors.length + 6); // auth x3, job x2, commands
  assert.deepEqual([...lines].sort((a, b) => a.localeCompare(b)), lines);
});

test("--filter keeps the commands matching every word", async () => {
  const { code, out } = await capture(["commands", "--filter", "widget PART"]);
  assert.equal(code, EXIT.OK);
  assert.deepEqual(out.trimEnd().split("\n").map((line) => line.split(/\s{2,}/)[0]), ["widgets parts create", "widgets parts get", "widgets parts list"]);
});

test("--filter matches the path and the summary too", async () => {
  const byPath = await capture(["commands", "--filter=/extra-info"]);
  assert.match(byPath.out, /^widgets extra-info list /);
  const bySummary = await capture(["commands", "--filter", "invitation"]);
  assert.match(bySummary.out, /^widgets invitations create /);
});

test("--json prints {command, method, path, summary} for every match", async () => {
  const { code, out } = await capture(["commands", "--json", "--filter", "gizmo"]);
  assert.equal(code, EXIT.OK);
  assert.deepEqual(JSON.parse(out), [
    { command: "gizmos get", method: "GET", path: "/gizmos/{gizmo_id}", summary: "Retrieve a gizmo" },
    { command: "gizmos list", method: "GET", path: "/gizmos", summary: "List gizmos" },
  ]);
  const statics = JSON.parse((await capture(["commands", "--json", "--filter", "keychain"])).out);
  assert.deepEqual(statics.map((row: { command: string; method: null }) => [row.command, row.method]), [["auth login", null], ["auth logout", null]]);
});

test("no match: an empty JSON array, or a note on stderr", async () => {
  assert.deepEqual(JSON.parse((await capture(["commands", "--json", "--filter", "no-such-thing"])).out), []);
  const { code, out, err } = await capture(["commands", "--filter", "no-such-thing"]);
  assert.equal(code, EXIT.OK);
  assert.equal(out, "");
  assert.match(err, /No commands match 'no-such-thing'/);
});

test("deel commands --help shows its flags", async () => {
  const { code, out } = await capture(["commands", "--help"]);
  assert.equal(code, EXIT.OK);
  assert.match(out, /--filter/);
  assert.match(out, /--json/);
});
