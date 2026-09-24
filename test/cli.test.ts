import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli.ts";
import { EXIT } from "../src/core/errors.ts";

// Capture direct process.stdout/stderr writes for the offline routing paths
// (version, help, generate-input, unknown command) — none of these hit the network.
async function capture(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = ((chunk: any) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
  process.stderr.write = ((chunk: any) => (err.push(String(chunk)), true)) as typeof process.stderr.write;
  try {
    const code = await run(argv);
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

test("--version prints the CLI version", async () => {
  const { code, out } = await capture(["--version"]);
  assert.equal(code, EXIT.OK);
  assert.match(out, /^deel \d+\.\d+\.\d+/);
});

test("--generate-input prints a body skeleton for the variant action", async () => {
  const { code, out } = await capture(["adjustments", "create", "--invoice", "--generate-input"]);
  assert.equal(code, EXIT.OK);
  const skeleton = JSON.parse(out);
  assert.ok("contract_id" in skeleton);
});

test("--generate-input expands nested object fields (bulk item.request.*)", async () => {
  const { code, out } = await capture(["adjustments", "create-bulk", "--invoice", "--generate-input"]);
  assert.equal(code, EXIT.OK);
  const [item] = JSON.parse(out);
  assert.ok("external_id" in item);
  assert.ok("contract_id" in item.request);
});

test("action --help --json expands nested object fields (bulk item.request.*)", async () => {
  const { code, out } = await capture(["adjustments", "create-bulk", "--invoice", "--help", "--json"]);
  assert.equal(code, EXIT.OK);
  const contract = JSON.parse(out);
  const request = contract.body.fields.find((field: { name: string }) => field.name === "request");
  assert.ok(Array.isArray(request.properties));
  assert.ok(request.properties.some((field: { name: string }) => field.name === "contract_id"));
});

test("action --help --json expands nested response fields (bulk items.*)", async () => {
  const { code, out } = await capture(["adjustments", "create-bulk", "--invoice", "--help", "--json"]);
  assert.equal(code, EXIT.OK);
  const contract = JSON.parse(out);
  const items = contract.response.fields.find((field: { name: string }) => field.name === "items");
  assert.ok(Array.isArray(items.properties));
  assert.ok(items.properties.some((field: { name: string }) => field.name === "status"));
});

test("action --help resolves the descriptor even behind a value-taking flag", async () => {
  // Regression: a valued flag before --help must not hide the action contract.
  const { code, out } = await capture(["jobs", "status", "--job_id", "j_1", "--help"]);
  assert.equal(code, EXIT.OK);
  assert.match(out, /USAGE\s+deel jobs status/);
  assert.match(out, /OPTIONS/);
});

test("action --help --json emits the machine-readable contract", async () => {
  const { code, out } = await capture(["adjustments", "create", "--invoice", "--help", "--json"]);
  assert.equal(code, EXIT.OK);
  const contract = JSON.parse(out);
  assert.equal(contract.command, "adjustments create");
  assert.equal(contract.variant, "invoice");
  assert.ok(Array.isArray(contract.body.fields));
});

test("action --help --json includes a ready-to-run usage line", async () => {
  const { code, out } = await capture(["adjustments", "create-bulk", "--invoice", "--help", "--json"]);
  assert.equal(code, EXIT.OK);
  const contract = JSON.parse(out);
  assert.equal(contract.usage, "deel adjustments create-bulk --invoice [GLOBAL OPTIONS] [--input <body>]");
});

test("variant group --help without a selector lists available variants", async () => {
  const { code, out } = await capture(["adjustments", "create", "--help"]);
  assert.equal(code, EXIT.OK);
  assert.match(out, /--invoice/);
});

test("variant group --generate-input without a selector prompts to specify a variant", async () => {
  const { code, err } = await capture(["adjustments", "create", "--generate-input"]);
  assert.equal(code, EXIT.ERROR);
  assert.match(err, /Specify a variant first/);
});

test("variant group --generate-input with an explicit variant succeeds", async () => {
  const { code, out } = await capture(["adjustments", "create", "--invoice", "--generate-input"]);
  assert.equal(code, EXIT.OK);
  const skeleton = JSON.parse(out);
  assert.ok("contract_id" in skeleton);
});

test("an unknown command reports an error", async () => {
  const { code, err } = await capture(["definitely-not-a-command"]);
  assert.equal(code, EXIT.ERROR);
  assert.match(err, /Unknown command/);
});
