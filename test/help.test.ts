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

async function capture(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = ((chunk: any) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
  process.stderr.write = ((chunk: any) => (err.push(String(chunk)), true)) as typeof process.stderr.write;
  setGeneratedDescriptorsForTests(generated.manifest.descriptors);
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

test("root help lists the top-level words under the map's lifecycle stages, the static commands under CLI", async () => {
  for (const argv of [["--help"], []]) {
    const { code, out } = await capture(argv);
    assert.equal(code, EXIT.OK);
    assert.match(out, /^ {2}CLI {3,}auth {3,}\d+ commands$/m);
    assert.match(out, /^ {2}People {3,}people list {3,}List of people$/m);
    assert.match(out, /^ {2}Hiring {3,}contracts {3,}Every working arrangement: .* \(6 commands\)$/m);
    assert.match(out, /^ {2}Platform {3,}jobs {3,}/m);
    assert.match(out, /^ {3,}scim users list {3,}List users$/m);
    // The sections follow STAGE_ORDER, CLI first. Alphabetical order of the words would put `jobs` (Platform) before `people`.
    const present = ["CLI", ...STAGE_ORDER].filter((stage) => new RegExp(`^ {2}${stage} {3,}`, "m").test(out));
    assert.ok(present.length >= 4, `only ${present.join(", ")} found`);
    const positions = present.map((stage) => out.search(new RegExp(`^ {2}${stage} {3,}`, "m")));
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b), `sections out of order: ${present.join(" < ")}`);
    assert.ok(out.search(/^ {2}Platform {3,}/m) > out.search(/^ {2}People {3,}/m), "Platform comes after People");
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
