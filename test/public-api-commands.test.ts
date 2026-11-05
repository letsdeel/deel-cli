import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { run } from "../src/cli.ts";
import { createContext } from "../src/core/context.ts";
import { captureIO } from "../src/core/io.ts";
import { execute } from "../src/core/executor.ts";
import type { Descriptor } from "../src/types.ts";
import { EXIT } from "../src/core/errors.ts";
import { API_GROUP, RESERVED_COMMANDS } from "../src/core/constants.ts";
import { staticCommands } from "../src/commands/index.ts";
import { manifest as handPicked } from "../src/manifest.generated.ts";
import { acceptsFlag, argvEnables, argvHasFlag, argvMentionsFlag, flagOf, generatedManifest, selectAlternate, setGeneratedDescriptorsForTests } from "../src/public-api/commands.ts";
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

test("generated commands sit under deel api, next to the hand-picked ones", async () => {
  const root = await capture(["--help"]);
  assert.equal(root.code, EXIT.OK);
  assert.match(root.out.replace(/\x1B\[[0-9;]*m/g, ""), /api\s+Call any documented Deel API endpoint/);
  assert.match(root.out, /adjustments/);
  assert.doesNotMatch(root.out, /widgets/);
  const api = await capture(["api", "--help"]);
  assert.equal(api.code, EXIT.OK);
  assert.match(api.out, /widgets/);
  assert.match(api.out, /scim/);
});

test("a generated command has the usual action help", async () => {
  const { code, out } = await capture(["api", "widgets", "get", "--help"]);
  assert.equal(code, EXIT.OK);
  assert.match(out, /Retrieve a widget/);
  assert.match(out, /--widget_id=<string>\s+\(required\)/);
});

test("a param named like a global flag is shown with its -param flag", async () => {
  const { out } = await capture(["api", "widgets", "update", "--help", "--json"]);
  const contract = JSON.parse(out);
  const fields = contract.params.find((param: { name: string }) => param.name === "fields");
  assert.equal(fields.flag, "fields-param");
});

test("the human --help and the usage line show a renamed param under its -param flag", async () => {
  const { out } = await capture(["api", "widgets", "update", "--help"]);
  assert.match(out, /--fields-param=<string>/);
  assert.doesNotMatch(out, /--fields=<string>/);

  const required: Descriptor = {
    command: ["things", "list"], method: "GET", path: "/things", version: "2026-01-01", async: false, bodyKind: "none",
    supportsMultipart: false, bodyWrapper: "none", fileFields: [], bodyProps: [], responseKind: "none", responseFields: [],
    params: [{ name: "fields", in: "query", type: "string", required: true, flag: "fields-param" }],
  };
  const humanHelp = await capture(["things", "list", "--help"], [required]);
  assert.match(humanHelp.out, /USAGE  deel things list \[GLOBAL OPTIONS\] --fields-param=<string>/);
  const contract = JSON.parse((await capture(["things", "list", "--help", "--json"], [required])).out);
  assert.match(contract.usage, /--fields-param=<string>/);
  assert.doesNotMatch(contract.usage, /--fields=/);
});

test("an array param renamed to -param sends every repeated value, not the global --fields", async () => {
  const descriptor: Descriptor = {
    command: ["things", "list"], method: "GET", path: "/things", version: "2026-01-01", async: false, bodyKind: "none",
    supportsMultipart: false, bodyWrapper: "none", fileFields: [], bodyProps: [], responseKind: "none", responseFields: [],
    params: [{ name: "fields", in: "query", type: "array", required: false, flag: "fields-param" }],
  };
  const { code, sent } = await callApi(["things", "list", "--fields-param", "a", "--fields-param=b"], [descriptor]);
  assert.equal(code, EXIT.OK);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].url.searchParams.getAll("fields"), ["a", "b"]);
});

test("a repeated array param is sent whole in any spelling of its flag", async () => {
  const descriptor: Descriptor = {
    command: ["things", "list"], method: "GET", path: "/things", version: "2026-01-01", async: false, bodyKind: "none",
    supportsMultipart: false, bodyWrapper: "none", fileFields: [], bodyProps: [], responseKind: "none", responseFields: [],
    params: [{ name: "contract_ids", in: "query", type: "array", required: false }],
  };
  for (const argv of [["--contract_ids", "a", "--contract_ids", "b"], ["--contract-ids", "a", "--contract-ids=b"], ["--contractIds=a", "--contractIds", "b"], ["--contract_ids", "a", "--contract-ids", "b"]]) {
    const { code, sent } = await callApi(["things", "list", ...argv], [descriptor]);
    assert.equal(code, EXIT.OK, argv.join(" "));
    assert.deepEqual(sent[0].url.searchParams.getAll("contract_ids"), ["a", "b"], argv.join(" "));
  }
});

test("a merged command without path params lists its forms", async () => {
  const { code, out } = await capture(["api", "widgets", "notes", "list", "--help"]);
  assert.equal(code, EXIT.OK);
  assert.match(out, /path-param flags pick the endpoint/);
  assert.match(out, /--widget_id\s+GET \/widgets\/\{widget_id\}\/notes/);
  assert.match(out, /\(no path params\)\s+GET \/widgets\/notes/);
});

test("a merged command's path params pick the form for --help", async () => {
  const { out } = await capture(["api", "widgets", "notes", "list", "--widget_id", "w1", "--help"]);
  assert.match(out, /--widget_id=<string>\s+\(required\)/);
  assert.doesNotMatch(out, /path-param flags pick the endpoint/);
});

test("a merged command's path params pick the form for --help however the flag is spelled", async () => {
  for (const argv of [["--widget_id=w1"], ["--widget-id", "w1"], ["--widget-id=w1"], ["--widgetId", "w1"], ["--widgetId=w1"]]) {
    const { out } = await capture(["api", "widgets", "notes", "list", ...argv, "--help"]);
    assert.match(out, /--widget_id=<string>\s+\(required\)/, argv.join(" "));
    assert.doesNotMatch(out, /path-param flags pick the endpoint/, argv.join(" "));
  }
});

test("a merged command's kebab and camel path flags select the same form when the command runs", async () => {
  for (const argv of [["--widget-id", "w_1"], ["--widgetId", "w_1"], ["--widget_id=w_1"]]) {
    const { code, sent } = await callApi(["api", "widgets", "notes", "list", ...argv]);
    assert.equal(code, EXIT.OK, argv.join(" "));
    assert.equal(sent.length, 1, argv.join(" "));
    assert.equal(sent[0].url.pathname, "/rest/widgets/w_1/notes", argv.join(" "));
  }
});

test("acceptsFlag follows the parser: written, camelCase and kebab-case spellings, acronyms included", () => {
  assert.equal(acceptsFlag("widget_id", "widget_id"), true);
  assert.equal(acceptsFlag("widget_id", "widget-id"), true);
  assert.equal(acceptsFlag("widget_id", "widgetId"), true);
  assert.equal(acceptsFlag("userIDs", "user-i-ds"), true);
  assert.equal(acceptsFlag("userIDs", "userIDs"), true);
  assert.equal(acceptsFlag("widget_id", "widget"), false);
  assert.equal(acceptsFlag("widget_id", "widget_idx"), false);
  assert.equal(acceptsFlag("limit", ""), false);
});

test("argvHasFlag matches --flag and --flag=value in every spelling, and nothing else", () => {
  assert.equal(argvHasFlag(["--widget-id", "w1"], "widget_id"), true);
  assert.equal(argvHasFlag(["--widgetId=w1"], "widget_id"), true);
  assert.equal(argvHasFlag(["--widget_idx", "w1"], "widget_id"), false);
  assert.equal(argvHasFlag(["widget_id"], "widget_id"), false);
});

test("--generate-input works on a merged command without path params", async () => {
  const { code, out } = await capture(["api", "widgets", "notes", "list", "--generate-input"]);
  assert.equal(code, EXIT.OK);
  assert.deepEqual(JSON.parse(out), {});
});

test("selectAlternate prefers the most specific form whose path params are all given", () => {
  const notes = manifest.descriptors.filter((descriptor) => descriptor.command.join(" ") === "api widgets notes list");
  assert.equal(selectAlternate(notes, (flag) => flag === "widget_id")!.path, "/widgets/{widget_id}/notes");
  assert.equal(selectAlternate(notes, () => false)!.path, "/widgets/notes");
  const deep = notes.filter((descriptor) => descriptor.path.includes("{"));
  assert.equal(selectAlternate(deep, () => false), undefined);
});

test("flagOf uses the API name unless the param has a flag", () => {
  assert.equal(flagOf({ name: "limit", in: "query", type: "integer", required: false }), "limit");
  assert.equal(flagOf({ name: "fields", in: "query", type: "string", required: false, flag: "fields-param" }), "fields-param");
});

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
  const { code, sent } = await callApi(["api", "widgets", "update", "--widget_id", "w_1", "--input", "name=renamed", "--fields-param", "id"]);
  assert.equal(code, EXIT.OK);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, "PATCH");
  assert.equal(sent[0].url.pathname, "/rest/widgets/w_1");
  assert.equal(sent[0].url.searchParams.get("fields"), "id");
  assert.deepEqual(sent[0].body, { name: "renamed" });
});

test("a merged command calls the collection without path params and the parent-scoped endpoint with them", async () => {
  const collection = await callApi(["api", "widgets", "notes", "list"]);
  const scoped = await callApi(["api", "widgets", "notes", "list", "--widget_id", "w_1"]);
  assert.equal(collection.code, EXIT.OK);
  assert.equal(scoped.code, EXIT.OK);
  assert.equal(collection.sent[0].url.pathname, "/rest/widgets/notes");
  assert.equal(scoped.sent[0].url.pathname, "/rest/widgets/w_1/notes");
});

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
  const { code, sent } = await callApi(["api", "boxes", "items", "list", "--box_id", "b1", "--size", "xl"], boxForms);
  assert.equal(code, EXIT.OK);
  assert.equal(sent[0].url.pathname, "/rest/boxes/b1/items");
  assert.equal(sent[0].url.searchParams.get("size"), "xl");
});

test("a merged command rejects a flag that belongs to the other form instead of dropping it", async () => {
  const { code, err, sent } = await callApi(["api", "boxes", "items", "list", "--box_id", "b1", "--color", "red"], boxForms);
  assert.notEqual(code, EXIT.OK);
  assert.match(err, /--color does not apply to GET \/boxes\/\{box_id\}\/items/);
  assert.equal(sent.length, 0);
});

const flagForms = generate(
  parseDefinitions(
    [
      { path: "/flags/items", parameters: [{ name: "archived", in: "query", schema: { type: "boolean" } }] },
      { path: "/flags/{flag_id}/items", parameters: [{ name: "flag_id", in: "path", schema: { type: "string" } }, { name: "size", in: "query", schema: { type: "string" } }] },
    ].map(({ path, parameters }) => ({
      api: "rest", method: "GET", path, version: "2026-01-01", beta_until: null, sunset_at: null,
      operation: { summary: "List items", parameters, responses: { "200": { description: "ok" } } },
    })),
  ),
  { reserved: { commands: [], topLevel: new Set() }, overrides: {}, now: new Date("2026-10-30T00:00:00Z") },
).manifest.descriptors;

test("a boolean flag of the other form is not mistaken for a typed flag when it is left out", async () => {
  const { code, sent } = await callApi(["api", "flags", "items", "list", "--flag_id", "f1", "--size", "xl"], flagForms);
  assert.equal(code, EXIT.OK);
  assert.equal(sent[0].url.pathname, "/rest/flags/f1/items");
  assert.equal(sent[0].url.searchParams.has("archived"), false);
});

test("a boolean flag typed for the wrong form is rejected, with or without a value", async () => {
  for (const flag of [["--archived"], ["--archived=true"], ["--no-archived"]]) {
    const { code, err, sent } = await callApi(["api", "flags", "items", "list", "--flag_id", "f1", ...flag], flagForms);
    assert.notEqual(code, EXIT.OK, flag.join(" "));
    assert.match(err, /--archived does not apply to GET \/flags\/\{flag_id\}\/items/, flag.join(" "));
    assert.equal(sent.length, 0, flag.join(" "));
  }
});

test("a boolean flag typed for its own form is sent", async () => {
  const { code, sent } = await callApi(["api", "flags", "items", "list", "--archived"], flagForms);
  assert.equal(code, EXIT.OK);
  assert.equal(sent[0].url.pathname, "/rest/flags/items");
  assert.equal(sent[0].url.searchParams.get("archived"), "true");
});

test("a SCIM command is refused before any request, so the token never reaches the /rest API", async () => {
  const { code, err, sent } = await callApi(["api", "scim", "users", "list"]);
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
  const { code, err, sent } = await callApi(["api", "boxes", "parts", "list"], partForms.manifest.descriptors);
  assert.notEqual(code, EXIT.OK);
  assert.match(err, /Missing path parameters for every form of 'deel api boxes parts list'/);
  assert.equal(sent.length, 0);

  const { code: ok, sent: calls } = await callApi(["api", "boxes", "parts", "list", "--box_id", "b1", "--shop_id", "s1"], partForms.manifest.descriptors);
  assert.equal(ok, EXIT.OK);
  assert.equal(calls[0].url.pathname, "/rest/boxes/b1/s1/parts");
});

const thing = (params: Descriptor["params"], extra: Partial<Descriptor> = {}): Descriptor => ({
  command: ["things", "list"], method: "GET", path: "/things", version: "2026-01-01", async: false, bodyKind: "none",
  supportsMultipart: false, bodyWrapper: "none", fileFields: [], bodyProps: [], responseKind: "none", responseFields: [], params, ...extra,
});

test("a repeated array param whose name has an acronym is sent whole in the spelling the parser aliases", async () => {
  const descriptor = thing([{ name: "userIDs", in: "query", type: "array", required: false }]);
  for (const argv of [["--userIDs", "a", "--userIDs", "b"], ["--user-i-ds", "a", "--user-i-ds=b"]]) {
    const { code, sent } = await callApi(["things", "list", ...argv], [descriptor]);
    assert.equal(code, EXIT.OK, argv.join(" "));
    assert.deepEqual(sent[0].url.searchParams.getAll("userIDs"), ["a", "b"], argv.join(" "));
  }
});

test("--generate-input in every spelling prints the skeleton and sends nothing", async () => {
  const descriptor = thing([], { method: "POST", bodyKind: "json", bodyProps: [{ name: "name", type: "string", required: false }] as Descriptor["bodyProps"] });
  for (const flag of ["--generate-input", "--generateInput"]) {
    const { code, out, sent } = await callApi(["things", "list", flag], [descriptor]);
    assert.equal(code, EXIT.OK, flag);
    assert.deepEqual(JSON.parse(out), { name: "" }, flag);
    assert.equal(sent.length, 0, flag);
  }
});

test("a path param that is empty, a dot segment or a swallowed flag sends nothing", async () => {
  const descriptor = thing([{ name: "thing_id", in: "path", type: "string", required: true }], { method: "DELETE", path: "/things/{thing_id}", command: ["things", "delete"] });
  for (const argv of [["--thing_id", ""], ["--thing_id="], ["--thing_id", ".."], ["--thing_id=."], ["--thing_id", "--debug"]]) {
    const { code, err, sent } = await callApi(["things", "delete", ...argv], [descriptor]);
    assert.notEqual(code, EXIT.OK, argv.join(" "));
    assert.match(err, /Invalid value for path parameter --thing_id|needs a value|Missing required/, argv.join(" "));
    assert.equal(sent.length, 0, argv.join(" "));
  }
  const ok = await callApi(["things", "delete", "--thing_id", "a b"], [descriptor]);
  assert.equal(ok.sent[0].url.pathname, "/rest/things/a%20b");
});

test("an empty path param of a merged command sends nothing instead of the other form", async () => {
  const { code, sent } = await callApi(["api", "boxes", "items", "list", "--box_id", ""], boxForms);
  assert.notEqual(code, EXIT.OK);
  assert.equal(sent.length, 0);
});

test("forms of a merged command that disagree on a flag's values do not reject each other's values", async () => {
  const forms = generate(
    parseDefinitions(
      [
        { path: "/stock/items", parameters: [{ name: "status", in: "query", schema: { type: "string", enum: ["active", "inactive"] } }] },
        { path: "/stock/{stock_id}/items", parameters: [{ name: "stock_id", in: "path", schema: { type: "string" } }, { name: "status", in: "query", schema: { type: "string", enum: ["open", "closed"] } }] },
      ].map(({ path, parameters }) => ({
        api: "rest", method: "GET", path, version: "2026-01-01", beta_until: null, sunset_at: null,
        operation: { summary: "List items", parameters, responses: { "200": { description: "ok" } } },
      })),
    ),
    { reserved: { commands: [], topLevel: new Set() }, overrides: {}, now: new Date("2026-10-30T00:00:00Z") },
  ).manifest.descriptors;
  const scoped = await callApi(["api", "stock", "items", "list", "--stock_id", "s1", "--status", "open"], forms);
  assert.equal(scoped.code, EXIT.OK);
  assert.equal(scoped.sent[0].url.searchParams.get("status"), "open");
  const plain = await callApi(["api", "stock", "items", "list", "--status", "active"], forms);
  assert.equal(plain.code, EXIT.OK);
  assert.equal(plain.sent[0].url.pathname, "/rest/stock/items");
});

test("an enum param rejects a value outside its options before any request", async () => {
  const descriptor = thing([{ name: "status", in: "query", type: "string", required: false, enum: ["active", "inactive"] }]);
  const bad = await callApi(["things", "list", "--status", "bogus"], [descriptor]);
  assert.notEqual(bad.code, EXIT.OK);
  assert.equal(bad.sent.length, 0);
  const good = await callApi(["things", "list", "--status", "active"], [descriptor]);
  assert.equal(good.sent[0].url.searchParams.get("status"), "active");
});

test("a merged command of three forms runs each one, and a path param shared with a query param of another form is a path param", async () => {
  const forms = generate(
    parseDefinitions(
      ["/trays/items", "/trays/{tray_id}/items", "/trays/{tray_id}/{slot_id}/items"].map((path) => ({
        api: "rest", method: "GET", path, version: "2026-01-01", beta_until: null, sunset_at: null,
        operation: { summary: "List items", responses: { "200": { description: "ok" } } },
      })),
    ),
    { reserved: { commands: [], topLevel: new Set() }, overrides: {}, now: new Date("2026-10-30T00:00:00Z") },
  );
  assert.deepEqual(forms.errors, []);
  assert.equal(forms.manifest.descriptors.length, 3);
  const paths = [];
  for (const argv of [[], ["--tray_id", "t1"], ["--tray_id", "t1", "--slot_id", "s1"]]) {
    const { code, sent } = await callApi(["api", "trays", "items", "list", ...argv], forms.manifest.descriptors);
    assert.equal(code, EXIT.OK, argv.join(" "));
    paths.push(sent[0].url.pathname);
  }
  assert.deepEqual(paths, ["/rest/trays/items", "/rest/trays/t1/items", "/rest/trays/t1/s1/items"]);

  const mixed = [
    thing([{ name: "id", in: "query", type: "string", required: false }], { path: "/mix" }),
    thing([{ name: "id", in: "path", type: "string", required: true }], { path: "/mix/{id}" }),
  ];
  const picked = await callApi(["things", "list", "--id", "i1"], mixed);
  assert.equal(picked.sent[0].url.pathname, "/rest/mix/i1");
});

test("selectAlternate picks the most specific form whichever order the forms come in", () => {
  const notes = manifest.descriptors.filter((descriptor) => descriptor.command.join(" ") === "api widgets notes list");
  const reversed = [...notes].sort((a, b) => a.path.length - b.path.length);
  assert.equal(selectAlternate(reversed, (flag) => flag === "widget_id")!.path, "/widgets/{widget_id}/notes");
  assert.equal(selectAlternate([...reversed].reverse(), (flag) => flag === "widget_id")!.path, "/widgets/{widget_id}/notes");
});

test("a variant flag is read in every spelling the parser accepts", async () => {
  const variants = ["bulk_update", "single_update"].map((variant) => thing([], { command: ["things", "change"], method: "POST", path: `/things/${variant}`, variant }));
  for (const flag of ["--bulk_update", "--bulk-update", "--bulkUpdate"]) {
    const { code, sent } = await callApi(["things", "change", flag], variants);
    assert.equal(code, EXIT.OK, flag);
    assert.equal(sent[0].url.pathname, "/rest/things/bulk_update", flag);
    const help = await capture(["things", "change", flag, "--help", "--json"], variants);
    assert.equal(JSON.parse(help.out).variant, "bulk_update", flag);
  }
});

const formsOf = (shapes: Array<{ path: string; parameters: unknown[] }>) =>
  generate(
    parseDefinitions(
      shapes.map(({ path, parameters }) => ({
        api: "rest", method: "GET", path, version: "2026-01-01", beta_until: null, sunset_at: null,
        operation: { summary: "List", parameters, responses: { "200": { description: "ok" } } },
      })),
    ),
    { reserved: { commands: [], topLevel: new Set() }, overrides: {}, now: new Date("2026-10-30T00:00:00Z") },
  ).manifest.descriptors;

test("a flag that is boolean in one form and a string in another is parsed by the form that is picked", async () => {
  const forms = formsOf([
    { path: "/m/items", parameters: [{ name: "flag", in: "query", schema: { type: "boolean" } }] },
    { path: "/m/{mid}/items", parameters: [{ name: "mid", in: "path", schema: { type: "string" } }, { name: "flag", in: "query", schema: { type: "string" } }] },
  ]);
  const bare = await callApi(["api", "m", "items", "list", "--flag", "--json"], forms);
  assert.equal(bare.code, EXIT.OK);
  assert.equal(bare.sent[0].url.pathname, "/rest/m/items");
  assert.equal(bare.sent[0].url.searchParams.get("flag"), "true");
  const scoped = await callApi(["api", "m", "items", "list", "--mid", "m1", "--flag", "red"], forms);
  assert.equal(scoped.sent[0].url.pathname, "/rest/m/m1/items");
  assert.equal(scoped.sent[0].url.searchParams.get("flag"), "red");
});

test("each form of a merged command validates an enum flag against its own options", async () => {
  const enumOf = (values?: string[]) => ({ name: "status", in: "query", schema: { type: "string", ...(values ? { enum: values } : {}) } });
  const pathParam = { name: "sid", in: "path", schema: { type: "string" } };
  const forms = formsOf([
    { path: "/e/items", parameters: [enumOf(["active", "inactive"])] },
    { path: "/e/{sid}/items", parameters: [pathParam, enumOf()] },
  ]);
  const rejected = await callApi(["api", "e", "items", "list", "--status", "bogus"], forms);
  assert.notEqual(rejected.code, EXIT.OK);
  assert.equal(rejected.sent.length, 0);
  const free = await callApi(["api", "e", "items", "list", "--sid", "s1", "--status", "bogus"], forms);
  assert.equal(free.sent[0].url.searchParams.get("status"), "bogus");

  const reordered = formsOf([
    { path: "/r/items", parameters: [enumOf(["active", "inactive"])] },
    { path: "/r/{sid}/items", parameters: [pathParam, enumOf(["inactive", "active"])] },
  ]);
  for (const argv of [["--status", "bogus"], ["--sid", "s1", "--status", "bogus"]]) {
    const result = await callApi(["api", "r", "items", "list", ...argv], reordered);
    assert.notEqual(result.code, EXIT.OK, argv.join(" "));
    assert.equal(result.sent.length, 0, argv.join(" "));
  }
});

test("a required flag of one form of a merged command is required only for that form", async () => {
  const forms = formsOf([
    { path: "/q/items", parameters: [] },
    { path: "/q/{qid}/items", parameters: [{ name: "qid", in: "path", schema: { type: "string" } }, { name: "scope", in: "query", required: true, schema: { type: "string" } }] },
  ]);
  const plain = await callApi(["api", "q", "items", "list"], forms);
  assert.equal(plain.code, EXIT.OK);
  assert.equal(plain.sent[0].url.pathname, "/rest/q/items");
  const missing = await callApi(["api", "q", "items", "list", "--qid", "q1"], forms);
  assert.notEqual(missing.code, EXIT.OK);
  assert.match(missing.err, /scope/);
  assert.equal(missing.sent.length, 0);
});

test("--generate-input is read as a switch: =false and --no- do not print the skeleton, =true and any spelling do", async () => {
  const descriptor = thing([], { method: "POST", bodyKind: "json", bodyProps: [{ name: "name", type: "string", required: false }] as Descriptor["bodyProps"] });
  for (const flag of ["--generate-input=false", "--no-generate-input"]) {
    const { sent } = await callApi(["things", "list", flag], [descriptor]);
    assert.equal(sent.length, 1, flag);
  }
  for (const flag of ["--generate-input=true", "--generateInput"]) {
    const { out, sent } = await callApi(["things", "list", flag], [descriptor]);
    assert.deepEqual(JSON.parse(out), { name: "" }, flag);
    assert.equal(sent.length, 0, flag);
  }
});

test("--generate-input in any spelling works on a merged command and on a variant group", async () => {
  const merged = await capture(["api", "widgets", "notes", "list", "--generateInput"]);
  assert.equal(merged.code, EXIT.OK);
  assert.deepEqual(JSON.parse(merged.out), {});
  const variants = ["a", "b"].map((variant) => thing([], { command: ["things", "change"], method: "POST", path: `/things/${variant}`, variant }));
  const group = await capture(["things", "change", "--generateInput"], variants);
  assert.notEqual(group.code, EXIT.OK);
  assert.match(group.err, /Specify a variant first/);
  const switchedOff = await capture(["things", "change", "--a=false", "--generate-input"], variants);
  assert.notEqual(switchedOff.code, EXIT.OK);
  assert.match(switchedOff.err, /Specify a variant first/);
});

test("the flag matchers only read flags: a word that merely ends like one is not a match, and --no- negates", () => {
  assert.equal(argvHasFlag(["xxwidget_id", "w1"], "widget_id"), false);
  assert.equal(argvHasFlag(["--widget_id=w1"], "widget_id"), true);
  assert.equal(acceptsFlag("generate-input", "no-generate-input"), false);
  assert.equal(argvMentionsFlag(["--no-archived"], "archived"), true);
  assert.equal(argvMentionsFlag(["--archived=false"], "archived"), true);
  assert.equal(argvMentionsFlag(["--other"], "archived"), false);
  assert.equal(argvEnables(["--archived"], "archived"), true);
  assert.equal(argvEnables(["--archived=false"], "archived"), false);
  assert.equal(argvEnables(["--no-archived"], "archived"), false);
  assert.equal(argvEnables(["xxarchived"], "archived"), false);
});

test("a path value of dots is only refused when it is the whole segment, and a blank one never goes out", async () => {
  const descriptor = thing([{ name: "name", in: "path", type: "string", required: true }], { path: "/files/{name}.pdf", command: ["files", "get"] });
  const dots = await callApi(["files", "get", "--name=.."], [descriptor]);
  assert.equal(dots.code, EXIT.OK);
  assert.equal(dots.sent[0].url.pathname, "/rest/files/...pdf");
  const blank = await callApi(["files", "get", "--name", " "], [descriptor]);
  assert.notEqual(blank.code, EXIT.OK);
  assert.equal(blank.sent.length, 0);
});

test("a path value that looks like a number reaches the URL as typed in a merged command", async () => {
  const { code, sent } = await callApi(["api", "boxes", "items", "list", "--box_id", "007", "--size", "1e3"], boxForms);
  assert.equal(code, EXIT.OK);
  assert.equal(sent[0].url.pathname, "/rest/boxes/007/items");
  assert.equal(sent[0].url.searchParams.get("size"), "1e3");
});

test("the committed manifest puts every command under deel api, and no static or hand-picked command uses the word", () => {
  assert.ok(generatedManifest.descriptors.length > 0);
  for (const descriptor of generatedManifest.descriptors) assert.equal(descriptor.command[0], API_GROUP, descriptor.command.join(" "));
  assert.ok(!(API_GROUP in staticCommands));
  assert.ok(!RESERVED_COMMANDS.has(API_GROUP));
  assert.ok(!handPicked.descriptors.some((descriptor) => descriptor.command[0] === API_GROUP));
});

test("a committed deel api command sends its endpoint and pinned version, and the hand-picked command of the same name is untouched", async () => {
  const generated = await callApi(["api", "webhooks", "list"], generatedManifest.descriptors);
  assert.equal(generated.code, EXIT.OK, generated.err);
  assert.deepEqual([generated.sent[0].method, generated.sent[0].url.pathname], ["GET", "/rest/webhooks"]);
  const help = await capture(["webhooks", "--help"], generatedManifest.descriptors);
  assert.equal(help.code, EXIT.OK);
  assert.match(help.out, /Webhook subscriptions|webhooks/);
});

test("a word under deel api that names no command is an error, not the group's help", async () => {
  const resource = await capture(["api", "widgts", "list"]);
  assert.equal(resource.code, EXIT.ERROR);
  assert.match(resource.err, /Unknown command 'widgts' under 'deel api'/);
  const action = await capture(["api", "widgets", "lst"]);
  assert.equal(action.code, EXIT.ERROR);
  assert.match(action.err, /Unknown command 'lst' under 'deel api widgets'/);
  assert.equal((await capture(["api", "widgets"])).code, EXIT.OK);
  assert.equal((await capture(["api", "widgts", "--help"])).code, EXIT.OK);
});
