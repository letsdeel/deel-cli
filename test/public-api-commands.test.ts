import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { run } from "../src/cli.ts";
import { createContext } from "../src/core/context.ts";
import { captureIO } from "../src/core/io.ts";
import { execute } from "../src/core/executor.ts";
import type { Descriptor } from "../src/types.ts";
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

async function capture(argv: string[], descriptors = manifest.descriptors): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = ((chunk: any) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
  process.stderr.write = ((chunk: any) => (err.push(String(chunk)), true)) as typeof process.stderr.write;
  setGeneratedDescriptorsForTests(descriptors);
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

// ---- running generated commands: the request each one sends, with fetch stubbed ----

type Sent = { method: string; url: URL; body: unknown };

async function callApi(argv: string[], descriptors = manifest.descriptors) {
  const sent: Sent[] = [];
  const realFetch = globalThis.fetch;
  const realToken = process.env.DEEL_TOKEN;
  process.env.DEEL_TOKEN = "tok_test";
  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    sent.push({ method: init.method ?? "GET", url: new URL(String(input)), body: init.body ? JSON.parse(String(init.body)) : undefined });
    return Response.json({ data: [] });
  }) as typeof fetch;
  try {
    return { ...(await capture([...argv, "--base-url", "https://example.test/rest"], descriptors)), sent };
  } catch (error) {
    // main.ts prints a CliError and exits non-zero; the test sees the same outcome.
    return { code: EXIT.ERROR, out: "", err: (error as Error).message, sent };
  } finally {
    globalThis.fetch = realFetch;
    if (realToken === undefined) delete process.env.DEEL_TOKEN;
    else process.env.DEEL_TOKEN = realToken;
  }
}

test("a param named like a global flag is sent under its API name when given as --<name>-param", async () => {
  const { code, sent } = await callApi(["widgets", "update", "--widget_id", "w_1", "--input", "name=renamed", "--fields-param", "id"]);
  assert.equal(code, EXIT.OK);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, "PATCH");
  assert.equal(sent[0].url.pathname, "/rest/widgets/w_1");
  assert.equal(sent[0].url.searchParams.get("fields"), "id");
  assert.deepEqual(sent[0].body, { name: "renamed" });
});

test("a merged command calls the collection without path params and the parent-scoped endpoint with them", async () => {
  const collection = await callApi(["widgets", "notes", "list"]);
  const scoped = await callApi(["widgets", "notes", "list", "--widget_id", "w_1"]);
  assert.equal(collection.code, EXIT.OK);
  assert.equal(scoped.code, EXIT.OK);
  assert.equal(collection.sent[0].url.pathname, "/rest/widgets/notes");
  assert.equal(scoped.sent[0].url.pathname, "/rest/widgets/w_1/notes");
});

// Two forms of one merged command, each with a query param the other does not have.
const boxForms = generate(
  parseDefinitions(
    [
      { path: "/boxes/items", parameters: [{ name: "color", in: "query", schema: { type: "string" } }] },
      { path: "/boxes/{box_id}/items", parameters: [{ name: "box_id", in: "path", schema: { type: "string" } }, { name: "size", in: "query", schema: { type: "string" } }] },
    ].map(({ path, parameters }) => ({
      api: "rest", method: "GET", path, version: "2026-01-01", beta_until: null, sunset_at: null,
      operation: { summary: "List items", parameters, responses: { "200": { description: "ok" } } },
    })),
  ),
  { reserved: { commands: [], topLevel: new Set() }, overrides: {}, now: new Date("2026-10-30T00:00:00Z") },
).manifest.descriptors;

test("a merged command sends the query params of the form its path params select", async () => {
  const { code, sent } = await callApi(["boxes", "items", "list", "--box_id", "b1", "--size", "xl"], boxForms);
  assert.equal(code, EXIT.OK);
  assert.equal(sent[0].url.pathname, "/rest/boxes/b1/items");
  assert.equal(sent[0].url.searchParams.get("size"), "xl");
});

test("a merged command rejects a flag that belongs to the other form instead of dropping it", async () => {
  const { code, err, sent } = await callApi(["boxes", "items", "list", "--box_id", "b1", "--color", "red"], boxForms);
  assert.notEqual(code, EXIT.OK);
  assert.match(err, /--color does not apply to GET \/boxes\/\{box_id\}\/items/);
  assert.equal(sent.length, 0);
});

test("a SCIM command is refused before any request, so the token never reaches the /rest API", async () => {
  const { code, err, sent } = await callApi(["scim", "users", "list"]);
  assert.notEqual(code, EXIT.OK);
  assert.match(err, /SCIM commands are not supported/);
  assert.equal(sent.length, 0);
});

test("a missing required query param is reported under the flag the user types", async () => {
  const descriptor: Descriptor = {
    command: ["things", "list"], method: "GET", path: "/things", version: "2026-01-01", async: false, bodyKind: "none",
    supportsMultipart: false, bodyWrapper: "none", fileFields: [], bodyProps: [], responseKind: "none", responseFields: [],
    params: [{ name: "fields", in: "query", type: "string", required: true, flag: "fields-param" }],
  };
  const ctx = createContext({
    config: { env: "demo", baseUrl: "https://example.test/rest" }, token: "tok_test", io: captureIO({}), logger: () => {},
    baseTransport: async () => { throw new Error("no request expected"); },
  });
  await assert.rejects(execute(descriptor, { flags: {}, files: {} }, ctx, { output: {} as any, debug: false, form: false }), /--fields-param/);
});

// Both forms of this merged command need a path param, so running it with none selects no endpoint.
const partForms = generate(
  parseDefinitions(
    ["/boxes/{box_id}/parts", "/boxes/{box_id}/{shop_id}/parts"].map((path) => ({
      api: "rest", method: "GET", path, version: "2026-01-01", beta_until: null, sunset_at: null,
      operation: { summary: "List parts", responses: { "200": { description: "ok" } } },
    })),
  ),
  { reserved: { commands: [], topLevel: new Set() }, overrides: {}, now: new Date("2026-10-30T00:00:00Z") },
);

test("a merged command whose forms all need path params says so and sends nothing when none is given", async () => {
  assert.deepEqual(partForms.errors, []);
  assert.equal(partForms.manifest.descriptors.length, 2);
  const { code, err, sent } = await callApi(["boxes", "parts", "list"], partForms.manifest.descriptors);
  assert.notEqual(code, EXIT.OK);
  assert.match(err, /Missing path parameters for every form of 'deel boxes parts list'/);
  assert.equal(sent.length, 0);

  const { code: ok, sent: calls } = await callApi(["boxes", "parts", "list", "--box_id", "b1", "--shop_id", "s1"], partForms.manifest.descriptors);
  assert.equal(ok, EXIT.OK);
  assert.equal(calls[0].url.pathname, "/rest/boxes/b1/s1/parts");
});
