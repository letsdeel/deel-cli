// The generated public API commands (src/public-api/commands.ts): loading the manifest, picking one endpoint
// among those sharing words, and the calls and help run() builds from them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { run } from "../src/cli.ts";
import { createContext } from "../src/core/context.ts";
import { captureIO } from "../src/core/io.ts";
import { execute } from "../src/core/executor.ts";
import type { Descriptor } from "../src/types.ts";
import { EXIT } from "../src/core/errors.ts";
import { flagOf } from "../src/core/flags.ts";
import { RESERVED_COMMANDS } from "../src/core/constants.ts";
import { manifest as handPicked } from "../src/manifest.generated.ts";
import { generatedDescriptors, loadGeneratedDescriptors, matchForm, selectForm, setGeneratedDescriptorsForTests, usageOf } from "../src/public-api/commands.ts";
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
    // --no-log keeps the calls out of the developer's own CLI log.
    const own = ["--base-url", "https://example.test/rest", "--no-log"];
    const withBase = end === -1 ? [...argv, ...own] : [...argv.slice(0, end), ...own, ...argv.slice(end)];
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
  await assert.rejects(execute(descriptor, { flags: {}, files: {} }, ctx, { output: { json: true, raw: false, quiet: false }, debug: false, form: false }), /--fields-param/);
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
    execute(descriptor, { flags: {}, files: {} }, ctx, { output: { json: true, raw: false, quiet: false }, debug: false, form: false }),
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
  // --x=--y passes a value that starts with --, so the executor's own guard is the one that refuses it.
  const swallowed = await callApi(["things", "delete", "--thing_id=--debug"], [descriptor]);
  assert.match(swallowed.err, /Invalid value for path parameter --thing_id: "--debug"/);
  assert.equal(swallowed.sent.length, 0);
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
    ["GET", "/fleet/{ship_id}/logs", [
      { name: "since", in: "query", required: true, schema: { type: "string" } },
      { name: "level", in: "query", schema: { type: "string", enum: ["info", "error"] } },
      { name: "tag", in: "query", schema: { type: "array", items: { type: "string" } } },
    ]],
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
    { method: "GET", path: "/fleet/{ship_id}/logs", command: "deel ships logs list <ship>" },
  ],
});

test("the fleet fixture generates cleanly", () => {
  assert.deepEqual(fleet.errors, []);
  assert.equal(fleet.manifest.descriptors.length, 8);
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
  const group = await callApi(["ships", "reviews", "create", "--generate-input"], fleet.manifest.descriptors);
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

test("a flag value that starts with - is taken only as --flag=value, never as a separate token", async () => {
  const attached = await callApi(["ships", "list", "--crew=-c1"], fleet.manifest.descriptors);
  assert.equal(attached.code, EXIT.OK, attached.err);
  assert.equal(attached.sent[0].url.pathname, "/rest/gp/crews/-c1/ships");
  const lists = fleet.manifest.descriptors.filter((d) => d.command.join(" ") === "ships list");
  assert.equal(selectForm(lists, ["--crew=-abc"]).path, "/gp/crews/{crew_id}/ships");
  assert.equal(selectForm(lists, ["--crew", "x", "--worker-type=gp"]).path, "/gp/crews/{crew_id}/ships");
  const separate = await callApi(["ships", "list", "--crew", "-c1"], fleet.manifest.descriptors);
  assert.notEqual(separate.code, EXIT.OK);
  assert.match(separate.err, /--crew needs a value/);
  const empty = await callApi(["ships", "list", "--crew="], fleet.manifest.descriptors);
  assert.match(empty.err, /--crew needs a value/);
  // A selector's value is checked the same way: attached, it is a value, and a wrong one is named as such.
  const wrong = await callApi(["ships", "get", "s1", "--worker-type=-x"], fleet.manifest.descriptors);
  assert.match(wrong.err, /has no --worker-type -x\. Valid values: eor\./);
  assert.equal(attached.sent.length + separate.sent.length + empty.sent.length + wrong.sent.length, 1);
});

test("an enum, a required and an array flag of a form are checked and sent like any generated command's", async () => {
  const ok = await callApi(["ships", "logs", "list", "s1", "--since", "d1", "--level", "error", "--tag", "a", "--tag=b"], fleet.manifest.descriptors);
  assert.equal(ok.code, EXIT.OK, ok.err);
  assert.equal(ok.sent[0].url.pathname, "/rest/fleet/s1/logs");
  assert.equal(ok.sent[0].url.searchParams.get("since"), "d1");
  assert.equal(ok.sent[0].url.searchParams.get("level"), "error");
  assert.deepEqual(ok.sent[0].url.searchParams.getAll("tag"), ["a", "b"]);
  const badEnum = await callApi(["ships", "logs", "list", "s1", "--since", "d1", "--level", "bogus"], fleet.manifest.descriptors);
  assert.notEqual(badEnum.code, EXIT.OK);
  const missing = await callApi(["ships", "logs", "list", "s1"], fleet.manifest.descriptors);
  assert.notEqual(missing.code, EXIT.OK);
  assert.equal(badEnum.sent.length + missing.sent.length, 0);
});

test("--help counts a flag's value as no argument: the words alone list every endpoint, an ID picks the bare one", async () => {
  for (const argv of [["--env", "demo"], ["--base-url", "https://example.test/rest"], ["--env=demo"]]) {
    const all = await capture(["ships", "get", ...argv, "--help"], fleet.manifest.descriptors);
    assert.match(all.out, /the flags pick the endpoint/, argv.join(" "));
    const bare = await capture(["ships", "get", "s1", ...argv, "--help"], fleet.manifest.descriptors);
    assert.match(bare.out, /USAGE  deel ships get <ship> \[GLOBAL OPTIONS\]/, argv.join(" "));
  }
  // A switch takes no value, so the word after it is an argument: --beta before the ID still picks the bare endpoint.
  const switched = await capture(["ships", "get", "--beta", "s1", "--help"], fleet.manifest.descriptors);
  assert.match(switched.out, /USAGE {2}deel ships get <ship> \[GLOBAL OPTIONS\]/);
  // And with no ID after it, the switch makes none: the words alone still list every endpoint.
  const noId = await capture(["ships", "get", "--beta", "--help"], fleet.manifest.descriptors);
  assert.match(noId.out, /the flags pick the endpoint/);
  // A form's own valued flag is not an argument either.
  const logs = await capture(["ships", "logs", "list", "--since", "d1", "--help"], fleet.manifest.descriptors);
  assert.match(logs.out, /USAGE  deel ships logs list <ship> \[GLOBAL OPTIONS\] --since=<string>/);
});

test("--help never lists a response field the CLI withholds", async () => {
  const webhook = thing([{ name: "id", in: "path", type: "string", required: true }], {
    command: ["hooks", "get"], path: "/hooks/{id}", responseKind: "object",
    responseFields: [{ name: "id", in: "body", type: "string", required: false }, { name: "signing_key", in: "body", type: "string", required: false, description: "Secret" }, { name: "signingKey", in: "body", type: "string", required: false }],
  });
  const human = await capture(["hooks", "get", "--help"], [webhook]);
  assert.match(human.out, /^ {2}id /m);
  assert.doesNotMatch(human.out, /signing_?key/i);
  const json = JSON.parse((await capture(["hooks", "get", "--help", "--json"], [webhook])).out);
  assert.deepEqual(json.response.fields.map((field: { name: string }) => field.name), ["id"]);
});

test("people custom-fields delete takes the field first and the worker as --person, like its siblings", async () => {
  const committed = await loadGeneratedDescriptors();
  const { code, err, sent } = await callApi(["people", "custom-fields", "delete", "field-1", "--person", "worker-1"], committed);
  assert.equal(code, EXIT.OK, err);
  assert.deepEqual([sent[0].method, sent[0].url.pathname], ["DELETE", "/rest/people/worker-1/custom_fields/field-1"]);
});

test("--help ARGUMENTS names a scope flag by the path param it fills, or by the query parameter it sets", async () => {
  const path = await capture(["ships", "list", "--help"], fleet.manifest.descriptors);
  assert.equal(path.code, EXIT.OK);
  assert.match(path.out, /^ARGUMENTS\n {2}--crew <crew> {3}the \{crew_id\} in \/gp\/crews\/\{crew_id\}\/ships\n/m);
  const query = await capture(["ships", "benefits", "list", "--help"], fleet.manifest.descriptors);
  assert.match(query.out, /^ARGUMENTS\n {2}--country <country> {3}the country_code query parameter\n/m);
  assert.doesNotMatch(query.out, /\{country_code\}/);
  // A form with a scope flag and no argument still gets its ARGUMENTS block (above); one with neither gets none.
  const none = await capture(["ships", "reviews", "create", "--bulk", "--help"], fleet.manifest.descriptors);
  assert.doesNotMatch(none.out, /ARGUMENTS/);
  const contract = JSON.parse((await capture(["ships", "benefits", "list", "--help", "--json"], fleet.manifest.descriptors)).out);
  assert.deepEqual(contract.scopes, [{ flag: "country", name: "country", param: "country_code", in: "query" }]);
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

test("endpoints that differ only by a scope flag are told apart by it, in every spelling of its value", async () => {
  const bare = await callApi(["widgets", "notes", "list"]);
  assert.equal(bare.code, EXIT.OK, bare.err);
  assert.deepEqual(bare.sent.map((s) => s.url.pathname), ["/rest/widgets/notes"]);
  for (const argv of [["--widget", "w1"], ["--widget=w1"]]) {
    const scoped = await callApi(["widgets", "notes", "list", ...argv]);
    assert.equal(scoped.code, EXIT.OK, scoped.err);
    assert.deepEqual(scoped.sent.map((s) => s.url.pathname), ["/rest/widgets/w1/notes"], argv.join(" "));
  }
  // The flag may come first among the options, and a value that starts with - is the value when attached.
  const dashed = await callApi(["widgets", "notes", "list", "--widget=-w1"]);
  assert.deepEqual(dashed.sent.map((s) => s.url.pathname), ["/rest/widgets/-w1/notes"]);
  // Typed without its value, or with the next flag in its place, it sends nothing rather than calling the bare endpoint.
  for (const argv of [["--widget"], ["--widget", "--beta"], ["--widget", "-w1"], ["--widget="]]) {
    const refused = await callApi(["widgets", "notes", "list", ...argv]);
    assert.notEqual(refused.code, EXIT.OK, argv.join(" "));
    assert.equal(refused.sent.length, 0, argv.join(" "));
  }
});

// ---------------- selector forms ----------------

const purge = generate(
  parseDefinitions([{ api: "rest", method: "POST", path: "/fleet/purge", version: "2026-01-01", beta_until: null, sunset_at: null, operation: { summary: "Purge", parameters: [], responses: { "200": { description: "ok" } } } }]),
  { reserved: { commands: [], topLevel: new Set() }, now: new Date("2026-10-30T00:00:00Z"), map: [{ method: "POST", path: "/fleet/purge", command: "deel ships purge [--bulk]" }] },
);

test("an optional switch in brackets is optional: the bare command, --bulk and --no-bulk all call the endpoint", async () => {
  assert.deepEqual(purge.errors, []);
  for (const argv of [[], ["--bulk"], ["--no-bulk"], ["--bulk=false"]]) {
    const called = await callApi(["ships", "purge", ...argv], purge.manifest.descriptors);
    assert.equal(called.code, EXIT.OK, `${argv.join(" ")}: ${called.err}`);
    assert.deepEqual(called.sent.map((s) => s.url.pathname), ["/rest/fleet/purge"], argv.join(" "));
  }
  const help = await capture(["ships", "purge", "--help"], purge.manifest.descriptors);
  assert.match(help.out, /USAGE {2}deel ships purge \[--bulk\] \[GLOBAL OPTIONS\]/);
});

// The argv that spells a form: its required selectors and scope flags, with the optional selectors left out (the
// bare command) or written out.
function spellings(form: NonNullable<Descriptor["form"]>) {
  const argvOf = (selectors: typeof form.selectors) => [
    ...selectors.flatMap((s) => (s.value === undefined ? [`--${s.flag}`] : [`--${s.flag}`, s.value])),
    ...form.scopes.flatMap((s) => [`--${s.flag}`, "x"]),
  ];
  return { bare: argvOf(form.selectors.filter((s) => !s.optional)), written: argvOf(form.selectors) };
}

test("every form of every command in the committed manifest is reachable: bare, and with its optional selectors written out", async () => {
  const committed = await loadGeneratedDescriptors();
  const groups = new Map<string, Descriptor[]>();
  for (const descriptor of committed) groups.set(descriptor.command.join(" "), [...(groups.get(descriptor.command.join(" ")) ?? []), descriptor]);
  const unreachable: string[] = [];
  for (const [words, group] of groups) {
    if (group.length < 2) continue;
    for (const descriptor of group) {
      const { bare, written } = spellings(descriptor.form!);
      for (const argv of [bare, written]) {
        const found = matchForm(group, argv);
        if (found !== descriptor) unreachable.push(`${words} ${argv.join(" ")} -> ${found ? `${found.method} ${found.path}` : "nothing"} (wanted ${descriptor.method} ${descriptor.path})`);
      }
    }
  }
  assert.deepEqual(unreachable, []);
});

test("an optional selector of the committed map works bare and written out, through run()", async () => {
  const committed = await loadGeneratedDescriptors();
  for (const argv of [[], ["--worker-type", "eor"], ["--worker-type=eor"]]) {
    const called = await callApi(["contracts", "amendments", "get", "c1", "a1", ...argv], committed);
    assert.equal(called.code, EXIT.OK, `${argv.join(" ")}: ${called.err}`);
    assert.deepEqual(called.sent.map((s) => s.url.pathname), ["/rest/eor/contracts/c1/amendments/a1"], argv.join(" "));
  }
  // The pdf line of the same words is picked by its required selector, bare or with the optional one.
  for (const argv of [["--file-format", "pdf"], ["--file-format", "pdf", "--worker-type", "eor"]]) {
    const called = await callApi(["contracts", "amendments", "get", "c1", "a1", ...argv], committed);
    assert.deepEqual(called.sent.map((s) => s.url.pathname), ["/rest/eor/contracts/c1/amendments/a1/pdf"], argv.join(" "));
  }
});

// ---------------- boolean and other flag values of a committed command ----------------

// The flags of an endpoint that take a value, as a user types them: its own parameters (not a switch, and not an
// argument the form fills) and the scope flags of its form.
function valuedFlagsOf(descriptor: Descriptor): string[] {
  const scopes = descriptor.form?.scopes ?? [];
  const own = descriptor.params.filter((param) => param.type !== "boolean" && !(descriptor.form && (param.in === "path" || scopes.some((s) => s.param === param.name))));
  return [...own.map(flagOf), ...scopes.map((s) => s.flag)];
}

// The words of a command, with its variant selector and its other required selectors and scope flags, so only the
// flag under test is missing a value.
function argvFor(descriptor: Descriptor, flag: string): string[] {
  const form = descriptor.form;
  const given = form ? spellings(form).bare.filter((_, index, all) => !all.slice(index - 1, index + 1).includes(`--${flag}`)) : [];
  return [...descriptor.command, ...(descriptor.variant ? [`--${descriptor.variant}`] : []), ...given];
}

test("every value flag of every generated command stops before any request when it is typed with no value", async () => {
  // The hand-picked commands (jobs, adjustments) are always registered, so nothing is generated beside them.
  const lists: Array<{ walk: Descriptor[]; generated: Descriptor[] }> = [{ walk: handPicked.descriptors, generated: [] }, { walk: await loadGeneratedDescriptors(), generated: await loadGeneratedDescriptors() }];
  let tried = 0;
  for (const { walk, generated } of lists) {
    for (const descriptor of walk) {
      const flags = valuedFlagsOf(descriptor);
      for (const flag of new Set(flags)) {
        for (const typed of [[`--${flag}`], [`--${flag}=`]]) {
          const called = await callApi([...argvFor(descriptor, flag), ...typed], generated);
          const where = `${descriptor.command.join(" ")} ${descriptor.variant ? `--${descriptor.variant} ` : ""}${typed.join(" ")}`;
          assert.equal(called.sent.length, 0, `${where} sent a request`);
          assert.equal(called.code, EXIT.ERROR, where);
          assert.match(called.err, /needs a value/, where);
          tried++;
        }
      }
    }
  }
  assert.ok(tried > 1400, `only ${tried} flags tried`);
});

test("a boolean query flag of a committed command reads true and false in every spelling, and the value is never an argument", async () => {
  const committed = await loadGeneratedDescriptors();
  const queryOf = async (...argv: string[]) => {
    const called = await callApi(["legal-entities", "list", ...argv], committed);
    return { ...called, query: called.sent[0]?.url.searchParams.get("include_archived") ?? null };
  };
  for (const [argv, expected] of [
    [["--include-archived"], "true"],
    [["--include-archived", "true"], "true"],
    [["--include-archived=true"], "true"],
    [["--include-archived", "false"], "false"],
    [["--include-archived=false"], "false"],
    [["--no-include-archived"], "false"],
    [["--include_archived", "false"], "false"],
    [["--includeArchived", "false"], "false"],
    [[], null],
  ] as Array<[string[], string | null]>) {
    const called = await queryOf(...argv);
    assert.equal(called.code, EXIT.OK, `${argv.join(" ")}: ${called.err}`);
    assert.equal(called.query, expected, argv.join(" "));
    assert.equal(called.sent.length, 1, argv.join(" "));
  }
  // The value belongs to the flag next to it: a second switch and an ordinary word after it are still themselves.
  const two = await callApi(["legal-entities", "list", "--include-archived", "false", "--global-payroll", "true"], committed);
  assert.deepEqual([two.sent[0].url.searchParams.get("include_archived"), two.sent[0].url.searchParams.get("global_payroll")], ["false", "true"]);
  // A word that is not true or false is still an argument, and this command takes none.
  const stray = await callApi(["legal-entities", "list", "--include-archived", "maybe"], committed);
  assert.notEqual(stray.code, EXIT.OK);
  assert.equal(stray.sent.length, 0);
  assert.match(stray.err, /takes 0 arguments, not 1/);
});

test("--help says how a boolean flag is turned on and off", async () => {
  const committed = await loadGeneratedDescriptors();
  const { code, out } = await capture(["legal-entities", "list", "--help"], committed);
  assert.equal(code, EXIT.OK);
  assert.match(out, /--include_archived=<boolean>/);
  assert.match(out, /on with --<flag>, --<flag>=true or --<flag> true, and off with --no-<flag>, --<flag>=false or --<flag> false/);
  const plain = await capture(["contracts", "get", "--help"], committed);
  assert.doesNotMatch(plain.out, /A boolean is on with/);
});

test("a flag that takes a value must be given one: bare, empty or followed by another flag sends nothing", async () => {
  const committed = await loadGeneratedDescriptors();
  const managers = ["access", "managers", "list"];
  for (const argv of [[...managers, "--limit"], [...managers, "--limit="], [...managers, "--limit", "--json"], [...managers, "--limit", "--no-log"],
    ["adjustments", "categories", "list", "--contract-types"], ["adjustments", "categories", "list", "--contract-types="],
    ["ats", "applications", "list", "--sort-order"], ["ats", "applications", "list", "--sort-order="], ["ats", "applications", "list", "--sort-order", "--json"]]) {
    const called = await callApi(argv, committed);
    assert.notEqual(called.code, EXIT.OK, argv.join(" "));
    assert.match(called.err, /--[a-z-]+ needs a value/, argv.join(" "));
    assert.equal(called.sent.length, 0, argv.join(" "));
  }
  // The flag is named as the user typed it, not by the API's spelling.
  assert.match((await callApi(["adjustments", "categories", "list", "--contract-types"], committed)).err, /--contract-types needs a value/);
  // Values that look like flags but are not: a negative number, attached or separate, and a repeated array flag.
  for (const [argv, query] of [
    [[...managers, "--limit", "-1"], "limit=-1"],
    [[...managers, "--limit=-1"], "limit=-1"],
    [[...managers, "--limit", "5"], "limit=5"],
    [["adjustments", "categories", "list", "--contract-types", "a", "--contract-types=b"], "contract_types=a&contract_types=b"],
    [["ats", "applications", "list", "--sort-order=DESC"], "sort_order=DESC"],
  ] as Array<[string[], string]>) {
    const called = await callApi(argv, committed);
    assert.equal(called.code, EXIT.OK, `${argv.join(" ")}: ${called.err}`);
    assert.equal(called.sent[0].url.search.slice(1), query, argv.join(" "));
  }
  // A wrong enum value is still the parser's own refusal, before any request.
  const wrong = await callApi(["ats", "applications", "list", "--sort-order=BAD"], committed);
  assert.notEqual(wrong.code, EXIT.OK);
  assert.equal(wrong.sent.length, 0);
});

test("a boolean flag only a sibling endpoint takes is refused, naming that endpoint, never accepted and dropped", async () => {
  const committed = await loadGeneratedDescriptors();
  // `payouts methods list` has one endpoint per worker type; only the contractor one takes --is-default.
  const refused = await callApi(["payouts", "methods", "list", "--worker-type", "employee", "--is-default"], committed);
  assert.notEqual(refused.code, EXIT.OK);
  assert.match(refused.err, /'deel payouts methods list --worker-type employee' has no flag --is-default; only 'deel payouts methods list --worker-type contractor' takes it/);
  assert.equal(refused.sent.length, 0);
  // Every spelling of the flag, on and off, with a value or attached.
  for (const flag of [["--is-default", "false"], ["--is_default=true"], ["--no-is-default"], ["--isDefault"]]) {
    const called = await callApi(["payouts", "methods", "list", "--worker-type", "employee", ...flag], committed);
    assert.notEqual(called.code, EXIT.OK, flag.join(" "));
    assert.match(called.err, /only 'deel payouts methods list --worker-type contractor' takes it/, flag.join(" "));
    assert.equal(called.sent.length, 0, flag.join(" "));
  }
  // The endpoint that has the flag still takes it, in the same spellings.
  for (const [flag, query] of [[["--is-default"], "is_default=true"], [["--is-default", "false"], "is_default=false"], [["--no-is-default"], "is_default=false"]] as Array<[string[], string]>) {
    const called = await callApi(["payouts", "methods", "list", "--worker-type", "contractor", ...flag], committed);
    assert.equal(called.code, EXIT.OK, `${flag.join(" ")}: ${called.err}`);
    assert.equal(called.sent[0].url.pathname, "/rest/payouts/contractors/methods");
    assert.equal(called.sent[0].url.search.slice(1), query, flag.join(" "));
  }
  // The same on the scoped and the bare endpoint of one command.
  const scoped = await callApi(["time-off", "list", "--person", "p1", "--include-deleted-time-offs"], committed);
  assert.notEqual(scoped.code, EXIT.OK);
  assert.match(scoped.err, /only 'deel time-off list' takes it/);
  assert.equal(scoped.sent.length, 0);
  const bare = await callApi(["time-off", "list", "--include-deleted-time-offs"], committed);
  assert.equal(bare.code, EXIT.OK, bare.err);
  assert.equal(bare.sent[0].url.search.slice(1), "include_deleted_time_offs=true");
});

test("a flag of another endpoint of the same words is refused for a selector switch too, but its off form picks the endpoint without it", async () => {
  const { sent, code, err } = await callApi(["ships", "reviews", "create", "s1", "--no-bulk", "--input", "note=x"], fleet.manifest.descriptors);
  assert.equal(code, EXIT.OK, err);
  assert.equal(sent[0].url.pathname, "/rest/fleet/s1/reviews");
  // A flag that no endpoint of these words takes is still refused, without naming an owner.
  const unknown = await callApi(["ships", "reviews", "create", "s1", "--nope"], fleet.manifest.descriptors);
  assert.notEqual(unknown.code, EXIT.OK);
  assert.match(unknown.err, /has no flag --nope\.$/);
  assert.equal(unknown.sent.length, 0);
});

test("a variant command refuses a flag only another variant takes, instead of dropping it from the request", async () => {
  const gadget = (variant: string, flag: string) =>
    thing([{ name: flag, in: "query", type: "string", required: false }], { command: ["gadgets", "create"], method: "POST", path: `/gadgets/${variant}`, variant });
  const gadgets = [gadget("red", "shade"), gadget("blue", "tint")];
  const ok = await callApi(["gadgets", "create", "--red", "--shade", "dark"], gadgets);
  assert.equal(ok.code, EXIT.OK, ok.err);
  assert.equal(ok.sent[0].url.search.slice(1), "shade=dark");
  const crossed = await callApi(["gadgets", "create", "--red", "--tint", "pale"], gadgets);
  assert.notEqual(crossed.code, EXIT.OK);
  assert.match(crossed.err, /'deel gadgets create --red' has no flag --tint/);
  assert.equal(crossed.sent.length, 0);
});

test("a command of a single endpoint refuses a flag it doesn't have instead of running without it", async () => {
  const gizmo = thing([{ name: "limit", in: "query", type: "string", required: false }], { command: ["gizmos", "list"], path: "/gizmos" });
  const ok = await callApi(["gizmos", "list", "--limit", "5"], [gizmo]);
  assert.equal(ok.code, EXIT.OK, ok.err);
  assert.equal(ok.sent[0].url.search.slice(1), "limit=5");
  const typo = await callApi(["gizmos", "list", "--limt", "5"], [gizmo]);
  assert.notEqual(typo.code, EXIT.OK);
  assert.match(typo.err, /'deel gizmos list' has no flag --limt/);
  assert.equal(typo.sent.length, 0);
});

test("every README example of a command the manifest marks beta carries --beta", () => {
  const byCommand = new Map<string, Descriptor[]>();
  for (const descriptor of (JSON.parse(readFileSync(new URL("../src/public-api/manifest.json", import.meta.url), "utf8")) as { descriptors: Descriptor[] }).descriptors) {
    const key = descriptor.command.join(" ");
    byCommand.set(key, [...(byCommand.get(key) ?? []), descriptor]);
  }
  const missing: string[] = [];
  let checked = 0;
  for (const [index, line] of readFileSync(new URL("../README.md", import.meta.url), "utf8").split("\n").entries()) {
    const example = line.trim();
    if (!example.startsWith("deel ")) continue;
    const words = example.split(/\s+/).slice(1).filter((word) => !/^[-<#]/.test(word));
    for (let count = Math.min(words.length, 5); count >= 1; count--) {
      const descriptors = byCommand.get(words.slice(0, count).join(" "));
      if (!descriptors) continue;
      if (descriptors.some((descriptor) => descriptor.beta)) {
        checked++;
        if (!/--beta\b/.test(example)) missing.push(`README.md:${index + 1} ${example.slice(0, 80)}`);
      }
      break;
    }
  }
  assert.ok(checked >= 5, `only ${checked} beta examples found; the README check has stopped matching`);
  assert.deepEqual(missing, []);
});

test("the client immigration cases and the external-ID shifts are picked by a flag, so the bare names stay free for the endpoints that supersede them", async () => {
  const real = await loadGeneratedDescriptors();
  const group = (words: string) => real.filter((descriptor) => descriptor.command.join(" ") === words);
  const usageFor = (method: string, path: string) => {
    const found = real.find((descriptor) => descriptor.method === method && descriptor.path === path);
    assert.ok(found, `${method} ${path} is in the manifest`);
    return usageOf(found);
  };
  assert.equal(usageFor("GET", "/immigration/client/cases"), "deel immigration cases list --as client");
  assert.equal(usageFor("GET", "/immigration/client/cases/{id}"), "deel immigration cases get <id> --as client");
  assert.equal(usageFor("GET", "/time_tracking/shifts/{external_id}"), "deel time-tracking shifts get <external_id> --external-id");
  assert.equal(usageFor("PATCH", "/time_tracking/shifts/{external_id}"), "deel time-tracking shifts update <external_id> --external-id");
  assert.equal(usageFor("DELETE", "/time_tracking/shifts/{external_id}"), "deel time-tracking shifts delete <external_id> --external-id");

  // The flag form calls the endpoint, and the bare line is refused until an endpoint takes the bare words.
  const cases = group("immigration cases list");
  assert.equal(selectForm(cases, ["--as", "client"]).path, "/immigration/client/cases");
  assert.equal(selectForm(cases, ["--as", "worker"]).path, "/immigration/workers/cases");
  assert.throws(() => selectForm(cases, []), /match no single form of 'deel immigration cases list'/);
  const caseGets = group("immigration cases get");
  assert.equal(selectForm(caseGets, ["--as", "client"]).path, "/immigration/client/cases/{id}");
  assert.throws(() => selectForm(caseGets, []), /match no single form of 'deel immigration cases get'/);
  for (const [verb, method] of [["get", "GET"], ["update", "PATCH"], ["delete", "DELETE"]] as const) {
    const shifts = group(`time-tracking shifts ${verb}`);
    const picked = selectForm(shifts, ["--external-id"]);
    assert.deepEqual([picked.method, picked.path], [method, "/time_tracking/shifts/{external_id}"]);
    assert.throws(() => selectForm(shifts, []), new RegExp(`match no single form of 'deel time-tracking shifts ${verb}'`));
  }
});

test("run() calls the flag forms of the renamed commands, the switch last or not, and refuses the bare lines before any request", async () => {
  const real = await loadGeneratedDescriptors();
  const get = await callApi(["time-tracking", "shifts", "get", "s1", "--external-id"], real);
  assert.equal(get.code, EXIT.OK, get.err);
  assert.equal(get.sent[0].url.pathname, "/rest/time_tracking/shifts/s1");
  const del = await callApi(["time-tracking", "shifts", "delete", "s1", "--external-id", "--raw"], real);
  assert.equal(del.code, EXIT.OK, del.err);
  assert.deepEqual([del.sent[0].method, del.sent[0].url.pathname], ["DELETE", "/rest/time_tracking/shifts/s1"]);
  const client = await callApi(["immigration", "cases", "list", "--as", "client"], real);
  assert.equal(client.code, EXIT.OK, client.err);
  assert.equal(client.sent[0].url.pathname, "/rest/immigration/client/cases");
  const clientGet = await callApi(["immigration", "cases", "get", "c1", "--as", "client"], real);
  assert.equal(clientGet.sent[0].url.pathname, "/rest/immigration/client/cases/c1");
  for (const argv of [["time-tracking", "shifts", "get", "s1"], ["immigration", "cases", "list"]]) {
    const bare = await callApi(argv, real);
    assert.notEqual(bare.code, EXIT.OK);
    assert.match(bare.err, /match no single form/);
    assert.equal(bare.sent.length, 0);
  }
});
