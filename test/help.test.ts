import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli.ts";
import { EXIT } from "../src/core/errors.ts";
import { RESERVED_COMMANDS } from "../src/core/constants.ts";
import { manifest as handPicked } from "../src/manifest.generated.ts";
import { domainOf, setGeneratedDescriptorsForTests, STAGE_ORDER } from "../src/public-api/commands.ts";
import { groupTitle, suggestions } from "../src/help.ts";
import { parseDefinitions } from "../scripts/public-api/definitions.ts";
import { generate } from "../scripts/public-api/generate.ts";
import type { MapEntry } from "../scripts/public-api/command-map.ts";

const endpoints: Array<[string, string, string, string]> = [
  ["GET", "/contracts", "deel contracts list", "List of contracts"],
  ["GET", "/contracts/{contract_id}", "deel contracts get <contract>", "Retrieve a single contract"],
  ["GET", "/eor/contracts/{contract_id}/details", "deel contracts get <contract> --worker-type eor", "Retrieve EOR contract details"],
  ["POST", "/contracts/{contract_id}/invitations", "deel contracts invite send <contract>", "Send contract to worker"],
  ["GET", "/contracts/{contract_id}/amendments", "deel contracts amendments list <contract>", "List contract amendments"],
  ["POST", "/contracts/{contract_id}/amendments", "deel contracts amendments create <contract>", "Create an amendment"],
  ["GET", "/people", "deel people list", "List of people"],
  ["GET", "/Users", "deel scim users list", "List users"],
];
const definitions = parseDefinitions(endpoints.map(([method, path, , summary]) => ({
  api: path === "/Users" ? "scim" : "rest", method, path, version: "2026-01-01", beta_until: null, sunset_at: null, operation: { summary, responses: { "200": { description: "ok" } } },
})));
const map: MapEntry[] = endpoints.map(([method, path, command]) => ({ method, path, command, ...(path === "/Users" ? { api: "scim" as const } : {}) }));
const generated = generate(definitions, { reserved: { commands: handPicked.descriptors, topLevel: RESERVED_COMMANDS }, map, now: new Date("2026-10-30T00:00:00Z") });

async function capture(argv: string[], descriptors = generated.manifest.descriptors): Promise<{ code: number; out: string; err: string }> {
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

test("the fixture generates without errors", () => {
  assert.deepEqual(generated.errors, []);
});

// The first word of every line of the root help's command list, in order.
function rootWords(out: string): string[] {
  const list = out.slice(out.indexOf("Commands:\n") + "Commands:\n".length, out.indexOf("\nAdd --help to a command"));
  return list.trimEnd().split("\n").map((line) => line.trim().split(/\s+/)[0]);
}

test("root help lists one line per top-level word, the word first, with no stage names", async () => {
  for (const argv of [["--help"], []]) {
    const { code, out } = await capture(argv);
    assert.equal(code, EXIT.OK);
    assert.match(out, /^ {2}auth {3,}Authentication \(\d+ commands\)$/m);
    // A domain is its own word, even when it has a single command (`people`, `scim`), never `people list` or `scim users list`.
    assert.match(out, /^ {2}people {3,}.*\(1 command\)$/m);
    assert.match(out, /^ {2}contracts {3,}Every working arrangement: .* \(6 commands\)$/m);
    assert.match(out, /^ {2}scim {3,}.*\(1 command\)$/m);
    assert.doesNotMatch(out, /^ {2}(people list|scim users)/m);
    assert.doesNotMatch(out, /^ {2}(CLI|People|Hiring|Platform|Other)\b {2,}/m, "no stage column");
    // The static commands first, then the lifecycle order of domains.json (People, Hiring, Pay, Platform), by name within a stage.
    // Alphabetical order of the words alone would put `contracts` before `people`.
    assert.deepEqual(rootWords(out), ["auth", "commands", "job", "people", "contracts", "adjustments", "jobs", "scim"]);
    assert.match(out, /^GLOBAL OPTIONS/m);
  }
});

test("group help lists one line per endpoint, collapses single-child chains and counts bigger groups", async () => {
  const { code, out } = await capture(["contracts", "--help"]);
  assert.equal(code, EXIT.OK);
  assert.match(out, /^deel contracts — Every working arrangement/m);
  assert.match(out, /^ {2}list {3,}List of contracts$/m);
  assert.match(out, /^ {2}get <contract> {3,}Retrieve a single contract$/m);
  assert.match(out, /^ {2}get <contract> --worker-type eor {3,}Retrieve EOR contract details$/m);
  assert.match(out, /^ {2}invite send <contract> {3,}Send contract to worker$/m);
  assert.match(out, /^ {2}amendments {3,}2 commands$/m);
  assert.match(out, /^Flags that pick the endpoint:\n {2}--worker-type <type> /m);
  assert.match(out, /^Add --help to a line's words for its arguments, flags and fields \(e\.g\. deel contracts list --help\)\.$/m);
});

test("a group without --help prints its help too, and a nested group is titled with its path", async () => {
  assert.match((await capture(["contracts"])).out, /^deel contracts — /m);
  const nested = await capture(["contracts", "amendments"]);
  assert.match(nested.out, /^deel contracts amendments$/m);
  assert.match(nested.out, /^ {2}list <contract> {3,}List contract amendments$/m);
  assert.doesNotMatch(nested.out, /Flags that pick the endpoint/);
});

test("help examples keep only the words, so they paste into a shell", async () => {
  const { out } = await capture(["contracts", "amendments", "--help"]);
  assert.match(out, /\(e\.g\. deel contracts amendments list --help\)\.$/m);
  assert.match((await capture(["--help"])).out, /^Add --help to a command to see its commands \(e\.g\. deel [a-z -]+ --help\)\./m);
});

test("a static group uses its own description and the static footer", async () => {
  const { code, out } = await capture(["auth", "--help"]);
  assert.equal(code, EXIT.OK);
  assert.match(out, /^Authentication$/m);
  assert.match(out, /^ {2}login {3,}Sign in through your browser/m);
  assert.match(out, /^ {2}status {3,}Validate the current token$/m);
  assert.match(out, /^Add --help to a line's words for its flags \(e\.g\. deel auth login --help\)\.$/m);
  assert.doesNotMatch(out, /Flags that pick the endpoint/);
});

// run() throws a usage error; main.ts turns it into the exit code and the printed error.
async function usageError(argv: string[]): Promise<{ code?: string; message: string; next?: string }> {
  try {
    await capture(argv);
  } catch (error) {
    const { code, message, next } = error as { code?: string; message: string; next?: string };
    return { code, message, next };
  }
  assert.fail(`${argv.join(" ")} did not fail`);
}

test("an unknown word suggests the closest commands, at the top level and under a group", async () => {
  const top = await usageError(["contrakts"]);
  assert.equal(top.code, "usage.command");
  assert.equal(top.message, "Unknown command 'contrakts'. Did you mean: contracts?");
  const under = await usageError(["contracts", "amendmnts", "list"]);
  assert.equal(under.message, "Unknown command 'deel contracts amendmnts'. Did you mean: amendments?");
  assert.equal(under.next, "Run 'deel contracts --help' to see its commands.");
  assert.equal((await usageError(["zzzzzz"])).message, "Unknown command 'zzzzzz'.");
});

test("a flag's value before or after the words is not a command word", async () => {
  for (const argv of [["--env", "demo", "contracts", "--help"], ["contracts", "--env", "demo"], ["--base-url", "https://api.test", "contracts"], ["--debug", "--fields", "id", "contracts"], ["contracts", "--worker-type", "eor", "--help"]]) {
    const { code, out } = await capture(argv);
    assert.equal(code, EXIT.OK, argv.join(" "));
    assert.match(out, /^deel contracts — /m, argv.join(" "));
  }
  const leaf = await capture(["--env", "demo", "contracts", "get", "--worker-type", "eor", "--help"]);
  assert.match(leaf.out, /USAGE {2}deel contracts get <contract> --worker-type eor/);
});

test("a command runs with a global flag and its value after the words", async () => {
  const realFetch = globalThis.fetch;
  const realToken = process.env.DEEL_TOKEN;
  const urls: string[] = [];
  globalThis.fetch = (async (url: unknown) => (urls.push(String(url)), Response.json({ data: {} }))) as typeof fetch;
  process.env.DEEL_TOKEN = "test-token";
  try {
    for (const argv of [["contracts", "get", "c1", "--env", "demo", "--no-log"], ["contracts", "get", "c1", "--worker-type", "eor", "--env", "demo", "--no-log"]]) {
      urls.length = 0;
      const { code, err } = await capture(argv);
      assert.equal(code, EXIT.OK, `${argv.join(" ")}: ${err}`);
      assert.equal(urls.length, 1, argv.join(" "));
    }
    assert.match(urls[0], /\/eor\/contracts\/c1\/details$/);
  } finally {
    globalThis.fetch = realFetch;
    if (realToken === undefined) delete process.env.DEEL_TOKEN;
    else process.env.DEEL_TOKEN = realToken;
  }
});

test("suggestions: prefixes first, then small edit distances, at most five", () => {
  assert.deepEqual(suggestions("con", ["contracts", "countries", "people"]), ["contracts"]);
  assert.deepEqual(suggestions("lsit", ["list", "get"]), ["list"]);
  assert.deepEqual(suggestions("", ["list"]), []);
  assert.equal(suggestions("a", ["a1", "a2", "a3", "a4", "a5", "a6"]).length, 5);
});

test("every domain has a stage and a description, and a group title uses them", () => {
  assert.ok(STAGE_ORDER.length > 0);
  assert.deepEqual(domainOf("contracts")?.stage, "Hiring");
  assert.equal(domainOf("nope"), undefined);
  assert.match(groupTitle(["contracts"]), /^deel contracts — Every working arrangement/);
  assert.equal(groupTitle(["contracts", "amendments"]), "deel contracts amendments");
});

// ---- a group whose lines use every kind of picking flag ----

// A group whose lines use every kind of picking flag: a worker type, `--as`, `--file-format`, `--bulk`, a scope, and
// two lines that differ only in the name of their path ID (R7b).
const fleetEndpoints: Array<[string, string, string]> = [
  ["GET", "/fleet/{ship_id}", "deel ships get <ship>"],
  ["GET", "/eor/fleet/{ship_id}", "deel ships get <ship> --worker-type eor"],
  ["GET", "/gp/fleet/{sailor_id}", "deel ships get <sailor> --worker-type gp"],
  ["GET", "/workers/fleet/{ship_id}/pdf", "deel ships get <ship> --file-format pdf --as worker"],
  ["POST", "/fleet/reviews/many", "deel ships reviews create --bulk"],
  ["POST", "/fleet/{ship_id}/reviews", "deel ships reviews create <ship>"],
  ["GET", "/gp/crews/{crew_id}/ships", "deel ships list --crew <crew> [--worker-type gp]"],
  ["POST", "/fleet/notes", "deel ships notes create [--bulk]"],
  ["GET", "/eor/workers/fleet/{ship_id}/pdf", "deel ships get <ship> --file-format pdf --worker-type eor --as worker"],
  ["GET", "/ats/jobs", "deel ats jobs list"],
];
const fleetDefinitions = parseDefinitions(
  fleetEndpoints.map(([method, path]) => ({
    api: "rest", method, path, version: "2026-01-01", beta_until: null, sunset_at: null,
    operation: { summary: `${method} ${path}`, responses: { "200": { description: "ok" } }, ...(method === "POST" ? { requestBody: { content: { "application/json": { schema: { type: "object", properties: { note: { type: "string" } } } } } } } : {}) },
  })),
);
const fleet = generate(fleetDefinitions, {
  reserved: { commands: [], topLevel: new Set() },
  now: new Date("2026-10-30T00:00:00Z"),
  map: fleetEndpoints.map(([method, path, command]) => ({ method, path, command })),
});

test("the picking-flag fixture generates cleanly", () => {
  assert.deepEqual(fleet.errors, []);
});

test("group help lists a line per endpoint and names each path ID when the worker types differ (R7b)", async () => {
  const { code, out } = await capture(["ships", "--help"], fleet.manifest.descriptors);
  assert.equal(code, EXIT.OK);
  assert.match(out, /^ {2}get <ship> {2,}/m);
  assert.match(out, /^ {2}get <ship> --worker-type eor {2,}/m);
  assert.match(out, /^ {2}get <sailor> --worker-type gp {2,}/m);
  assert.match(out, /^ {2}get <ship> --file-format pdf --as worker {2,}/m);
  assert.match(out, /^ {2}list \[--worker-type gp\] --crew <crew> {2,}GET \/gp\/crews\/\{crew_id\}\/ships$/m);
});

test("group help explains each flag its lines use, and only those", async () => {
  const { out } = await capture(["ships", "--help"], fleet.manifest.descriptors);
  const legend = out.slice(out.indexOf("Flags that pick the endpoint:"), out.indexOf("Add --help"));
  assert.match(legend, /^ {2}--worker-type <type> /m);
  assert.match(legend, /^ {2}--as <side> /m);
  assert.match(legend, /^ {2}--file-format <format> /m);
  assert.doesNotMatch(legend, /--status/);
  // `--bulk` is on the `reviews` line, not on the group's own.
  const reviews = await capture(["ships", "reviews", "--help"], fleet.manifest.descriptors);
  assert.match(reviews.out, /^ {2}--bulk {2,}many at once$/m);
  assert.match(reviews.out, /^ {2}create --bulk {2,}/m);
  assert.doesNotMatch(reviews.out, /--as <side>/);
});

test("a value of a flag that picks an endpoint is not a command word, whichever kind of flag it is", async () => {
  const cases = [
    ["ships", "--worker-type", "gp", "--help"], // a selector with a value
    ["ships", "--file-format", "pdf", "--help"],
    ["ships", "--crew", "c1", "--help"], // a scope
    ["ships", "--bulk", "--help"], // a switch takes no value
  ];
  for (const argv of cases) {
    const { code, out, err } = await capture(argv, fleet.manifest.descriptors);
    assert.equal(code, EXIT.OK, `${argv.join(" ")}: ${err}`);
    assert.match(out, /^deel ships/m, argv.join(" "));
  }
});

test("a switch such as --bulk does not swallow the word after it", async () => {
  // If --bulk were read as taking a value, `reviews` would be that value and the group's own help would print.
  const { code, out } = await capture(["ships", "--bulk", "reviews", "--help"], fleet.manifest.descriptors);
  assert.equal(code, EXIT.OK);
  assert.match(out, /^ {2}create --bulk {2,}/m);
  assert.doesNotMatch(out, /^ {2}get <ship>/m);
});

test("a word that is not a command is named in the error even after a picking flag's value", async () => {
  await assert.rejects(capture(["--as", "worker", "shps"], fleet.manifest.descriptors), (error: Error) => /Unknown command 'shps'\./.test(error.message) && /Did you mean: ships\?/.test(error.message));
});

test("a flag written as an optional switch, [--bulk], is explained too", async () => {
  const { out } = await capture(["ships", "notes", "--help"], fleet.manifest.descriptors);
  assert.match(out, /^ {2}create \[--bulk\] {2,}/m);
  assert.match(out, /^ {2}--bulk {2,}many at once$/m);
});

test("group help orders the rows: verbs in their usual order, then leaves, chains and groups by name", async () => {
  const { out } = await capture(["contracts", "--help"]);
  const rows = out.slice(out.indexOf("Commands:\n") + "Commands:\n".length, out.indexOf("\nFlags that pick")).trimEnd().split("\n").map((line) => line.trim().split(/ {3,}/)[0]);
  assert.deepEqual(rows, ["list", "get <contract>", "get <contract> --worker-type eor", "invite send <contract>", "amendments"]);
});

test("root help sorts the words of a stage by name, and puts a word domains.json does not know last", async () => {
  const words = rootWords((await capture([], [...generated.manifest.descriptors, ...fleet.manifest.descriptors])).out);
  // `ats` was added after `contracts`, so only the sort puts it first within Hiring.
  assert.ok(words.indexOf("ats") !== -1 && words.indexOf("ats") < words.indexOf("contracts"), "ats before contracts");
  assert.equal(words.at(-1), "ships", "a word domains.json does not know comes last");
  assert.ok(words.indexOf("scim") < words.indexOf("ships"));
});

test("--help on a static leaf prints its usage and runs nothing", async () => {
  const realFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => (requests++, new Response("{}"))) as typeof fetch;
  try {
    for (const [argv, flag] of [[["auth", "login", "--help"], "--input"], [["commands", "--help"], "--filter"], [["job", "status", "--help"], "--input"]] as const) {
      const { code, out, err } = await capture([...argv]);
      assert.equal(code, EXIT.OK, `${argv.join(" ")}: ${err}`);
      assert.match(out, /USAGE/, argv.join(" "));
      assert.ok(out.includes(flag), `${argv.join(" ")} lists ${flag}`);
    }
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a name longer than the name column overflows it; the shorter lines keep one description column", async () => {
  const { out } = await capture(["ships", "--help"], fleet.manifest.descriptors);
  const lines = out.split("\n");
  const long = lines.find((line) => line.includes("--file-format pdf --worker-type eor --as worker"))!;
  const short = lines.find((line) => line.includes("list [--worker-type gp] --crew <crew>"))!;
  const get = lines.find((line) => /^ {2}get <ship> {3,}GET /.test(line))!;
  // The column is 44 wide (2 for the indent, 3 between name and description); the long name is not cut or wrapped.
  const column = 2 + 44 + 3;
  assert.equal(short.indexOf("GET /gp/crews"), column);
  assert.equal(get.indexOf("GET /fleet"), column);
  assert.equal(long.indexOf("GET /eor/workers"), long.indexOf("--as worker") + "--as worker".length + 3);
  assert.ok(long.indexOf("GET /eor/workers") > column, "the long line's description starts after the column");
});
