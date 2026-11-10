import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli.ts";
import { EXIT } from "../src/core/errors.ts";
import { setGeneratedDescriptorsForTests } from "../src/public-api/commands.ts";
import { parseDefinitions } from "../scripts/public-api/definitions.ts";
import { generate } from "../scripts/public-api/generate.ts";

// A group whose lines use every kind of picking flag: a worker type, `--as`, `--file-format`, `--bulk`, a scope, and
// two lines that differ only in the name of their path ID (R7b).
const endpoints: Array<[string, string, string]> = [
  ["GET", "/fleet/{ship_id}", "deel ships get <ship>"],
  ["GET", "/eor/fleet/{ship_id}", "deel ships get <ship> --worker-type eor"],
  ["GET", "/gp/fleet/{sailor_id}", "deel ships get <sailor> --worker-type gp"],
  ["GET", "/workers/fleet/{ship_id}/pdf", "deel ships get <ship> --file-format pdf --as worker"],
  ["POST", "/fleet/reviews/many", "deel ships reviews create --bulk"],
  ["POST", "/fleet/{ship_id}/reviews", "deel ships reviews create <ship>"],
  ["GET", "/gp/crews/{crew_id}/ships", "deel ships list --crew <crew> [--worker-type gp]"],
];
const definitions = parseDefinitions(
  endpoints.map(([method, path]) => ({
    api: "rest", method, path, version: "2026-01-01", beta_until: null, sunset_at: null,
    operation: { summary: `${method} ${path}`, responses: { "200": { description: "ok" } }, ...(method === "POST" ? { requestBody: { content: { "application/json": { schema: { type: "object", properties: { note: { type: "string" } } } } } } } : {}) },
  })),
);
const fleet = generate(definitions, {
  reserved: { commands: [], topLevel: new Set() },
  now: new Date("2026-10-30T00:00:00Z"),
  map: endpoints.map(([method, path, command]) => ({ method, path, command })),
});

async function capture(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = ((chunk: any) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
  process.stderr.write = ((chunk: any) => (err.push(String(chunk)), true)) as typeof process.stderr.write;
  setGeneratedDescriptorsForTests(fleet.manifest.descriptors);
  try {
    const code = await run(argv);
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    setGeneratedDescriptorsForTests(undefined);
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

test("the fleet fixture generates cleanly", () => {
  assert.deepEqual(fleet.errors, []);
});

test("group help lists a line per endpoint and names each path ID when the worker types differ (R7b)", async () => {
  const { code, out } = await capture(["ships", "--help"]);
  assert.equal(code, EXIT.OK);
  assert.match(out, /^ {2}get <ship> {2,}/m);
  assert.match(out, /^ {2}get <ship> --worker-type eor {2,}/m);
  assert.match(out, /^ {2}get <sailor> --worker-type gp {2,}/m);
  assert.match(out, /^ {2}get <ship> --file-format pdf --as worker {2,}/m);
  assert.match(out, /^ {2}list \[--worker-type gp\] --crew <crew> {2,}GET \/gp\/crews\/\{crew_id\}\/ships$/m);
});

test("group help explains each flag its lines use, and only those", async () => {
  const { out } = await capture(["ships", "--help"]);
  const legend = out.slice(out.indexOf("Flags that pick the endpoint:"), out.indexOf("Add --help"));
  assert.match(legend, /^ {2}--worker-type <type> /m);
  assert.match(legend, /^ {2}--as <side> /m);
  assert.match(legend, /^ {2}--file-format <format> /m);
  assert.doesNotMatch(legend, /--status/);
  // `--bulk` is on the `reviews` line, not on the group's own.
  const reviews = await capture(["ships", "reviews", "--help"]);
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
    const { code, out, err } = await capture(argv);
    assert.equal(code, EXIT.OK, `${argv.join(" ")}: ${err}`);
    assert.match(out, /^deel ships/m, argv.join(" "));
  }
});

test("a switch such as --bulk does not swallow the word after it", async () => {
  // If --bulk were read as taking a value, `reviews` would be that value and the group's own help would print.
  const { code, out } = await capture(["ships", "--bulk", "reviews", "--help"]);
  assert.equal(code, EXIT.OK);
  assert.match(out, /^ {2}create --bulk {2,}/m);
  assert.doesNotMatch(out, /^ {2}get <ship>/m);
});

test("a word that is not a command is named in the error even after a picking flag's value", async () => {
  await assert.rejects(capture(["--as", "worker", "shps"]), (error: Error) => /Unknown command 'shps'\./.test(error.message) && /Did you mean: ships\?/.test(error.message));
});
