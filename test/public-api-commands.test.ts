import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { run } from "../src/cli.ts";
import { createContext } from "../src/core/context.ts";
import { captureIO } from "../src/core/io.ts";
import { execute } from "../src/core/executor.ts";
import type { Descriptor } from "../src/types.ts";
import { EXIT } from "../src/core/errors.ts";
import { RESERVED_COMMANDS } from "../src/core/constants.ts";
import { staticCommands } from "../src/commands/index.ts";
import { manifest as handPicked } from "../src/manifest.generated.ts";
import { generatedDescriptors, loadGeneratedDescriptors, matchForm, selectForm, setGeneratedDescriptorsForTests } from "../src/public-api/commands.ts";
import { unknownFlag } from "../src/cli.ts";
import { parseDefinitions } from "../scripts/public-api/definitions.ts";
import { generate, reservedClashes } from "../scripts/public-api/generate.ts";

const definitions = parseDefinitions(JSON.parse(readFileSync(new URL("./fixtures/definitions/widgets.json", import.meta.url), "utf8")));
const widgetsMap = JSON.parse(readFileSync(new URL("./fixtures/definitions/widgets-map.json", import.meta.url), "utf8"));
const { manifest } = generate(definitions, {
  reserved: { commands: [], topLevel: new Set(["auth", "job"]) },
  map: widgetsMap,
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
  assert.match(out, /USAGE  deel widgets get <widget> \[GLOBAL OPTIONS\]/);
  assert.match(out, /ARGUMENTS\n  <widget>   the \{widget_id\} in \/widgets\/\{widget_id\}/);
  assert.doesNotMatch(out, /--widget_id/);
});

test("a param named like a global flag is shown with its -param flag", async () => {
  const { out } = await capture(["widgets", "update", "--help", "--json"]);
  const contract = JSON.parse(out);
  const fields = contract.params.find((param: { name: string }) => param.name === "fields");
  assert.equal(fields.flag, "fields-param");
});

test("the human --help and the usage line show a renamed param under its -param flag", async () => {
  const { out } = await capture(["widgets", "update", "--help"]);
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
    // Options go before a -- terminator, which ends them.
    const end = argv.indexOf("--");
    const withBase = end === -1 ? [...argv, "--base-url", "https://example.test/rest"] : [...argv.slice(0, end), "--base-url", "https://example.test/rest", ...argv.slice(end)];
    return { ...(await capture(withBase, descriptors)), sent };
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
  const { code, sent } = await callApi(["widgets", "update", "w_1", "--input", "name=renamed", "--fields-param", "id"]);
  assert.equal(code, EXIT.OK);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, "PATCH");
  assert.equal(sent[0].url.pathname, "/rest/widgets/w_1");
  assert.equal(sent[0].url.searchParams.get("fields"), "id");
  assert.deepEqual(sent[0].body, { name: "renamed" });
});

test("a missing required query param is reported under the flag the user types", async () => {
  const descriptor: Descriptor = {
    command: ["things", "list"], method: "GET", path: "/things", version: "2026-01-01", async: false, bodyKind: "none",
    supportsMultipart: false, bodyWrapper: "none", fileFields: [], bodyProps: [], responseKind: "none", responseFields: [],
    params: [{ name: "fields", in: "query", type: "string", required: true, flag: "fields-param" }],
  };
  const ctx = createContext({
    config: { env: "demo", baseUrl: "https://example.test/rest", issuer: null, clientId: "test-client", oauthBaseUrlOk: false }, token: "tok_test", io: captureIO({}), logger: () => {},
    baseTransport: async () => { throw new Error("no request expected"); },
  });
  await assert.rejects(execute(descriptor, { flags: {}, files: {} }, ctx, { output: {} as any, debug: false, form: false }), /--fields-param/);
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

test("the committed manifest loads only when asked, and doesn't shadow static or hand-picked commands", async () => {
  setGeneratedDescriptorsForTests(undefined);
  assert.deepEqual(generatedDescriptors(), []);
  const loaded = await loadGeneratedDescriptors();
  assert.equal(generatedDescriptors(), loaded);
  const names = loaded.map((descriptor) => descriptor.command.join(" "));
  assert.deepEqual(reservedClashes(names, { commands: handPicked.descriptors, topLevel: RESERVED_COMMANDS }), []);
  setGeneratedDescriptorsForTests(undefined);
});

test("reservedClashes finds a name that shadows, replaces, groups or is grouped by a reserved command", () => {
  const reserved = { commands: [{ command: ["gizmos", "list"], method: "GET", path: "/gizmos" }, { command: ["gadgets", "show", "all"], method: "GET", path: "/gadgets" }], topLevel: new Set(["auth"]) };
  assert.equal(reservedClashes(["auth sessions list"], reserved).length, 1);
  assert.match(reservedClashes(["gizmos list"], reserved, () => " (GET /x)")[0], /"deel gizmos list" \(GET \/x\) clashes with a hand-picked command/);
  assert.match(reservedClashes(["gizmos list all"], reserved)[0], /turn the hand-picked "deel gizmos list" into a group/);
  assert.match(reservedClashes(["gadgets show"], reserved)[0], /is a group of the hand-picked "deel gadgets show all"/);
  assert.deepEqual(reservedClashes(["gizmos get", "widgets list"], reserved), []);
});

test("every static command is a reserved name, so the generator and the committed-manifest check can see it", () => {
  assert.deepEqual(Object.keys(staticCommands).sort(), [...RESERVED_COMMANDS].sort());
});

test("a path-param error names the flag the user types, including the -param rename", async () => {
  const descriptor = thing([{ name: "file", in: "path", type: "string", required: true, flag: "file-param" }], { method: "DELETE", path: "/things/{file}", command: ["things", "delete"] });
  const { code, err, sent } = await callApi(["things", "delete", "--file-param", ".."], [descriptor]);
  assert.notEqual(code, EXIT.OK);
  assert.match(err, /path parameter --file-param: "\.\."/);
  assert.equal(sent.length, 0);
});

test("a missing path param names the flag the user types, including the -param rename", async () => {
  const descriptor = thing([{ name: "file", in: "path", type: "string", required: true, flag: "file-param" }], { method: "DELETE", path: "/things/{file}", command: ["things", "delete"] });
  const ctx = createContext({
    config: { env: "demo", baseUrl: "https://example.test/rest", issuer: null, clientId: "test-client", oauthBaseUrlOk: false }, token: "tok_test", io: captureIO({}), logger: () => {},
    baseTransport: async () => { throw new Error("no request expected"); },
  });
  await assert.rejects(
    execute(descriptor, { flags: {}, files: {} }, ctx, { output: {} as any, debug: false, form: false }),
    (error: any) => error.code === "usage.path_param" && /Missing required path parameter --file-param$/.test(error.message),
  );
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

test("an enum param rejects a value outside its options before any request", async () => {
  const descriptor = thing([{ name: "status", in: "query", type: "string", required: false, enum: ["active", "inactive"] }]);
  const bad = await callApi(["things", "list", "--status", "bogus"], [descriptor]);
  assert.notEqual(bad.code, EXIT.OK);
  assert.equal(bad.sent.length, 0);
  const good = await callApi(["things", "list", "--status", "active"], [descriptor]);
  assert.equal(good.sent[0].url.searchParams.get("status"), "active");
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

test("a path value of dots is only refused when it is the whole segment, and a blank one never goes out", async () => {
  const descriptor = thing([{ name: "name", in: "path", type: "string", required: true }], { path: "/files/{name}.pdf", command: ["files", "get"] });
  const dots = await callApi(["files", "get", "--name=.."], [descriptor]);
  assert.equal(dots.code, EXIT.OK);
  assert.equal(dots.sent[0].url.pathname, "/rest/files/...pdf");
  const blank = await callApi(["files", "get", "--name", " "], [descriptor]);
  assert.notEqual(blank.code, EXIT.OK);
  assert.equal(blank.sent.length, 0);
});


// ---------------- command-map forms ----------------

const fleetDefinitions = parseDefinitions(
  [
    ["GET", "/fleet/{ship_id}", []],
    ["GET", "/eor/fleet/{ship_id}", []],
    ["GET", "/workers/fleet/{ship_id}/pdf", []],
    ["POST", "/fleet/reviews/many", []],
    ["POST", "/fleet/{ship_id}/reviews", []],
    ["GET", "/fleet/benefits", [{ name: "country_code", in: "query", required: true, schema: { type: "string" } }, { name: "team", in: "query", schema: { type: "string" } }]],
    ["GET", "/gp/crews/{crew_id}/ships", []],
  ].map(([method, path, parameters]) => ({
    api: "rest", method, path, version: "2026-01-01", beta_until: null, sunset_at: null,
    operation: { summary: `${method} ${path}`, parameters, ...(method === "POST" ? { requestBody: { content: { "application/json": { schema: { type: "object", properties: { note: { type: "string" } } } } } } } : {}), responses: { "200": { description: "ok" } } },
  })),
);
const fleet = generate(fleetDefinitions, {
  reserved: { commands: [], topLevel: new Set() },
  now: new Date("2026-10-30T00:00:00Z"),
  map: [
    { method: "GET", path: "/fleet/{ship_id}", command: "deel ships get <ship>" },
    { method: "GET", path: "/eor/fleet/{ship_id}", command: "deel ships get <ship> --worker-type eor" },
    { method: "GET", path: "/workers/fleet/{ship_id}/pdf", command: "deel ships get <ship> --file-format pdf --as worker" },
    { method: "POST", path: "/fleet/reviews/many", command: "deel ships reviews create --bulk" },
    { method: "POST", path: "/fleet/{ship_id}/reviews", command: "deel ships reviews create <ship>" },
    { method: "GET", path: "/fleet/benefits", command: "deel ships benefits list --country <country>" },
    { method: "GET", path: "/gp/crews/{crew_id}/ships", command: "deel ships list --crew <crew> [--worker-type gp]" },
  ],
});

test("the fleet fixture generates cleanly", () => {
  assert.deepEqual(fleet.errors, []);
  assert.equal(fleet.manifest.descriptors.length, 7);
});

test("the bare command calls the endpoint whose path names no worker type, and --worker-type picks the typed one", async () => {
  const bare = await callApi(["ships", "get", "s1"], fleet.manifest.descriptors);
  assert.equal(bare.code, EXIT.OK, bare.err);
  assert.equal(bare.sent[0].url.pathname, "/rest/fleet/s1");
  const typed = await callApi(["ships", "get", "s1", "--worker-type", "eor"], fleet.manifest.descriptors);
  assert.equal(typed.sent[0].url.pathname, "/rest/eor/fleet/s1");
  const spelled = await callApi(["ships", "get", "--workerType=eor", "s1"], fleet.manifest.descriptors);
  assert.equal(spelled.sent[0].url.pathname, "/rest/eor/fleet/s1");
});

test("a --worker-type no endpoint with those words supports is an error that lists the valid values", async () => {
  const { code, err, sent } = await callApi(["ships", "get", "s1", "--worker-type", "gp"], fleet.manifest.descriptors);
  assert.notEqual(code, EXIT.OK);
  assert.match(err, /'deel ships get' has no --worker-type gp\. Valid values: eor\./);
  assert.equal(sent.length, 0);
});

test("several selectors pick one endpoint only when every one of them is given", async () => {
  const pdf = await callApi(["ships", "get", "s1", "--as", "worker", "--file-format", "pdf"], fleet.manifest.descriptors);
  assert.equal(pdf.sent[0].url.pathname, "/rest/workers/fleet/s1/pdf");
  const half = await callApi(["ships", "get", "s1", "--as", "worker"], fleet.manifest.descriptors);
  assert.notEqual(half.code, EXIT.OK);
  assert.match(half.err, /match no single form of 'deel ships get'/);
  assert.equal(half.sent.length, 0);
});

test("a switch selector picks its endpoint, and without it the positional form is called", async () => {
  const bulk = await callApi(["ships", "reviews", "create", "--bulk", "--input", "note=x"], fleet.manifest.descriptors);
  assert.equal(bulk.code, EXIT.OK, bulk.err);
  assert.equal(bulk.sent[0].url.pathname, "/rest/fleet/reviews/many");
  const one = await callApi(["ships", "reviews", "create", "s1", "--input", "note=x"], fleet.manifest.descriptors);
  assert.equal(one.sent[0].url.pathname, "/rest/fleet/s1/reviews");
  assert.deepEqual(one.sent[0].body, { note: "x" });
});

test("a scope flag fills a path param, and one the map names for a query param fills that", async () => {
  const crew = await callApi(["ships", "list", "--crew", "c1"], fleet.manifest.descriptors);
  assert.equal(crew.sent[0].url.pathname, "/rest/gp/crews/c1/ships");
  const typed = await callApi(["ships", "list", "--crew", "c1", "--worker-type", "gp"], fleet.manifest.descriptors);
  assert.equal(typed.sent[0].url.pathname, "/rest/gp/crews/c1/ships");
  const benefits = await callApi(["ships", "benefits", "list", "--country", "US", "--team", "t1"], fleet.manifest.descriptors);
  assert.equal(benefits.code, EXIT.OK, benefits.err);
  assert.equal(benefits.sent[0].url.searchParams.get("country_code"), "US");
  assert.equal(benefits.sent[0].url.searchParams.get("team"), "t1");
  const missing = await callApi(["ships", "benefits", "list"], fleet.manifest.descriptors);
  assert.notEqual(missing.code, EXIT.OK);
  assert.equal(missing.sent.length, 0);
});

test("the wrong number of arguments, an empty one or an unknown flag sends nothing", async () => {
  for (const [argv, why] of [
    [["ships", "get"], /'deel ships get <ship>' takes 1 argument, not 0/],
    [["ships", "get", "s1", "s2"], /takes 1 argument, not 2/],
    [["ships", "get", "s1", "--limit", "5"], /'deel ships get <ship>' has no flag --limit/],
    [["ships", "get", ""], /Invalid value for path parameter <ship>/],
  ] as const) {
    const { code, err, sent } = await callApi([...argv], fleet.manifest.descriptors);
    assert.notEqual(code, EXIT.OK, argv.join(" "));
    assert.match(err, why, argv.join(" "));
    assert.equal(sent.length, 0, argv.join(" "));
  }
});

test("--help on shared words lists every endpoint, and its flags or its arguments narrow it to one", async () => {
  const all = await capture(["ships", "get", "--help"], fleet.manifest.descriptors);
  assert.equal(all.code, EXIT.OK);
  for (const line of ["deel ships get <ship>\n", "deel ships get <ship> --worker-type eor\n", "deel ships get <ship> --file-format pdf --as worker\n"]) assert.ok(all.out.includes(line), all.out);
  assert.match(all.out, /^ {6}GET \/eor\/fleet\/\{ship_id\}/m);
  assert.match(all.out, /add its flags before --help \(deel ships get --file-format pdf --as worker --help\); for the line without flags, put its ID before --help\.$/m);
  assert.ok(!all.out.includes("RESPONSE"), "the list stays one line per endpoint");
  const one = await capture(["ships", "get", "--worker-type", "eor", "--help"], fleet.manifest.descriptors);
  assert.match(one.out, /USAGE  deel ships get <ship> --worker-type eor \[GLOBAL OPTIONS\]/);
  const json = JSON.parse((await capture(["ships", "benefits", "list", "--help", "--json"], fleet.manifest.descriptors)).out);
  assert.equal(json.usage, "deel ships benefits list --country <country> [GLOBAL OPTIONS]");
});

test("--help after the arguments shows the endpoint that command line calls, the bare one included", async () => {
  const bare = await capture(["ships", "get", "s1", "--help"], fleet.manifest.descriptors);
  assert.equal(bare.code, EXIT.OK);
  assert.match(bare.out, /USAGE  deel ships get <ship> \[GLOBAL OPTIONS\]/);
  const typed = await capture(["ships", "get", "s1", "--worker-type", "eor", "--help"], fleet.manifest.descriptors);
  assert.match(typed.out, /USAGE  deel ships get <ship> --worker-type eor \[GLOBAL OPTIONS\]/);
  const json = JSON.parse((await capture(["ships", "get", "s1", "--help", "--json"], fleet.manifest.descriptors)).out);
  assert.equal(json.usage, "deel ships get <ship> [GLOBAL OPTIONS]");
});

test("--generate-input needs the endpoint picked first when several share the words", async () => {
  const group = await capture(["ships", "reviews", "create", "--generate-input"], fleet.manifest.descriptors);
  assert.notEqual(group.code, EXIT.OK);
  assert.match(group.err, /Specify a variant first: \n  deel ships reviews create --bulk/);
  const picked = await capture(["ships", "reviews", "create", "--bulk", "--generate-input"], fleet.manifest.descriptors);
  assert.equal(picked.code, EXIT.OK);
  assert.deepEqual(JSON.parse(picked.out), { note: "" });
});

test("a SCIM command calls the /scim base path", async () => {
  const { code, sent } = await callApi(["scim", "users", "list"]);
  assert.equal(code, EXIT.OK);
  assert.equal(sent[0].url.pathname, "/scim/Users");
});

test("matchForm and selectForm pick by selectors and scopes, and refuse a flag of another endpoint", () => {
  const gets = fleet.manifest.descriptors.filter((d) => d.command.join(" ") === "ships get");
  assert.equal(matchForm(gets, ["s1"])!.path, "/fleet/{ship_id}");
  assert.equal(matchForm(gets, ["s1", "--worker-type", "eor"])!.path, "/eor/fleet/{ship_id}");
  assert.equal(matchForm(gets, ["s1", "--file-format", "pdf"]), undefined);
  assert.throws(() => selectForm(gets, ["--as", "client", "--file-format", "pdf"]), /has no --as client\. Valid values: worker/);
});

test("unknownFlag accepts every spelling and negation of a known flag and names the first unknown one", () => {
  assert.equal(unknownFlag(["--worker-type", "eor", "--workerType=eor", "--no-json", "--json=false"], ["worker-type", "json"]), undefined);
  assert.equal(unknownFlag(["a", "--limit", "5", "--other"], ["json"]), "--limit");
  assert.equal(unknownFlag(["-x", "s1"], ["json"]), "-x");
  assert.equal(unknownFlag(["--", "--limit"], []), undefined);
});

test("an ID that starts with - goes after --, where --help is an argument too", async () => {
  const dash = await callApi(["ships", "get", "--", "-abc"], fleet.manifest.descriptors);
  assert.equal(dash.code, EXIT.OK, dash.err);
  assert.equal(dash.sent[0].url.pathname, "/rest/fleet/-abc");
  const help = await callApi(["ships", "get", "--", "--help"], fleet.manifest.descriptors);
  assert.equal(help.code, EXIT.OK, help.err);
  assert.equal(help.sent[0].url.pathname, "/rest/fleet/--help");
});

test("a switch selector reads --no-x and =false as off and takes true or false as its value", async () => {
  for (const argv of [["s1", "--no-bulk"], ["s1", "--bulk=false"], ["s1", "--bulk", "false"]]) {
    const { code, err, sent } = await callApi(["ships", "reviews", "create", ...argv, "--input", "note=x"], fleet.manifest.descriptors);
    assert.equal(code, EXIT.OK, `${argv.join(" ")}: ${err}`);
    assert.equal(sent[0].url.pathname, "/rest/fleet/s1/reviews", argv.join(" "));
  }
  const on = await callApi(["ships", "reviews", "create", "--bulk", "true", "--input", "note=x"], fleet.manifest.descriptors);
  assert.equal(on.sent[0].url.pathname, "/rest/fleet/reviews/many");
});

test("a valued selector without its value, or a short flag, is refused instead of swallowing the next token", async () => {
  const bare = await callApi(["ships", "get", "s1", "--worker-type", "--json"], fleet.manifest.descriptors);
  assert.notEqual(bare.code, EXIT.OK);
  assert.match(bare.err, /--worker-type needs a value/);
  const short = await callApi(["ships", "get", "s1", "-x"], fleet.manifest.descriptors);
  assert.notEqual(short.code, EXIT.OK);
  assert.match(short.err, /has no flag -x/);
  assert.equal(bare.sent.length + short.sent.length, 0);
});

test("--help --json describes a form's arguments, scopes and selectors, and gives every form's contract until one is picked", async () => {
  const one = JSON.parse((await capture(["ships", "list", "--help", "--json"], fleet.manifest.descriptors)).out);
  assert.deepEqual([one.arguments, one.scopes, one.selectors], [[], [{ flag: "crew", name: "crew", param: "crew_id", in: "path" }], [{ flag: "worker-type", value: "gp", optional: true }]]);
  assert.ok(!one.params.some((param: { name: string }) => param.name === "crew_id"));
  const get = JSON.parse((await capture(["ships", "get", "--worker-type", "eor", "--help", "--json"], fleet.manifest.descriptors)).out);
  assert.deepEqual([get.arguments, get.path], [[{ name: "ship", param: "ship_id" }], "/eor/fleet/{ship_id}"]);
  const forms = JSON.parse((await capture(["ships", "get", "--help", "--json"], fleet.manifest.descriptors)).out);
  assert.equal(forms.command, "ships get");
  assert.deepEqual(forms.forms.map((f: { usage: string }) => f.usage).sort(), ["deel ships get <ship> --file-format pdf --as worker [GLOBAL OPTIONS]", "deel ships get <ship> --worker-type eor [GLOBAL OPTIONS]", "deel ships get <ship> [GLOBAL OPTIONS]"]);
  // Each form carries its full contract, as a picked one does.
  for (const form of forms.forms) assert.deepEqual(Object.keys(form).filter((k) => ["arguments", "params", "body", "response", "method", "path"].includes(k)).sort(), ["arguments", "body", "method", "params", "path", "response"]);
});
