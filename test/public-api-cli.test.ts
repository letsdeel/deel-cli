import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { run } from "../src/cli.ts";
import { RESERVED_COMMANDS } from "../src/core/constants.ts";
import { EXIT } from "../src/core/errors.ts";
import { manifest as handPicked } from "../src/manifest.generated.ts";
import { flagOf, generatedManifest, selectAlternate, setGeneratedDescriptorsForTests } from "../src/public-api/commands.ts";
import { parseDefinitions } from "../scripts/public-api/definitions.ts";
import { generate } from "../scripts/public-api/generate.ts";

const definitions = parseDefinitions(JSON.parse(readFileSync(new URL("./fixtures/definitions/widgets.json", import.meta.url), "utf8")));
const { manifest } = generate(definitions, {
  reserved: { commands: [], topLevel: new Set(["auth", "job"]) },
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

test("generated commands sit next to the hand-picked ones", async () => {
  const { code, out } = await capture(["--help"]);
  assert.equal(code, EXIT.OK);
  assert.match(out, /widgets/);
  assert.match(out, /adjustments/);
});

test("a generated command has the usual action help", async () => {
  const { code, out } = await capture(["widgets", "get", "--help"]);
  assert.equal(code, EXIT.OK);
  assert.match(out, /Retrieve a widget/);
  assert.match(out, /--widget_id=<string>\s+\(required\)/);
});

test("a param named like a global flag is shown with its -param flag", async () => {
  const { out } = await capture(["widgets", "update", "--help", "--json"]);
  const contract = JSON.parse(out);
  const fields = contract.params.find((param: { name: string }) => param.name === "fields");
  assert.equal(fields.flag, "fields-param");
});

test("a merged command without path params lists its forms", async () => {
  const { code, out } = await capture(["widgets", "notes", "list", "--help"]);
  assert.equal(code, EXIT.OK);
  assert.match(out, /path-param flags pick the endpoint/);
  assert.match(out, /--widget_id\s+GET \/widgets\/\{widget_id\}\/notes/);
  assert.match(out, /\(no path params\)\s+GET \/widgets\/notes/);
});

test("a merged command's path params pick the form for --help", async () => {
  const { out } = await capture(["widgets", "notes", "list", "--widget_id", "w1", "--help"]);
  assert.match(out, /List notes on a widget/);
});

test("--generate-input works on a merged command without path params", async () => {
  const { code, out } = await capture(["widgets", "notes", "list", "--generate-input"]);
  assert.equal(code, EXIT.OK);
  assert.deepEqual(JSON.parse(out), {});
});

test("selectAlternate prefers the most specific form whose path params are all given", () => {
  const notes = manifest.descriptors.filter((descriptor) => descriptor.command.join(" ") === "widgets notes list");
  assert.equal(selectAlternate(notes, (flag) => flag === "widget_id")!.path, "/widgets/{widget_id}/notes");
  assert.equal(selectAlternate(notes, () => false)!.path, "/widgets/notes");
  const deep = notes.filter((descriptor) => descriptor.path.includes("{"));
  assert.equal(selectAlternate(deep, () => false), undefined);
});

test("flagOf uses the API name unless the param has a flag", () => {
  assert.equal(flagOf({ name: "limit", in: "query", type: "integer", required: false }), "limit");
  assert.equal(flagOf({ name: "fields", in: "query", type: "string", required: false, flag: "fields-param" }), "fields-param");
});

test("the committed manifest doesn't shadow static or hand-picked commands", () => {
  const taken = new Set([...RESERVED_COMMANDS, ...handPicked.descriptors.map((descriptor) => descriptor.command.join(" "))]);
  for (const descriptor of generatedManifest.descriptors) {
    const name = descriptor.command.join(" ");
    assert.ok(!RESERVED_COMMANDS.has(descriptor.command[0]), `"deel ${name}" shadows a static command`);
    assert.ok(!taken.has(name), `"deel ${name}" clashes with a hand-picked command`);
  }
});
