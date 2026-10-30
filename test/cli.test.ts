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

// ---------------- logs commands (public API request logs) ----------------

type Field = { name: string; in?: string; type: string; required: boolean; enum?: string[]; properties?: Field[] };
const byName = (fields: Field[]) => Object.fromEntries(fields.map((field) => [field.name, field])) as Record<string, Field>;

test("logs requests list --help --json exposes every filter, --cursor and the request log fields", async () => {
  const { code, out } = await capture(["logs", "requests", "list", "--help", "--json"]);
  assert.equal(code, EXIT.OK);
  const contract = JSON.parse(out);
  assert.equal(contract.command, "logs requests list");
  assert.equal(contract.usage, "deel logs requests list [GLOBAL OPTIONS]");
  assert.equal(contract.body.kind, "none");

  const params = byName(contract.params);
  for (const name of ["request_id", "token_id", "route", "path", "method", "status", "status_class", "source", "from", "to", "cursor", "limit"]) {
    assert.ok(name in params, `missing --${name}`);
    assert.equal(params[name].in, "query");
    assert.equal(params[name].required, false);
  }
  assert.deepEqual(params.status_class.enum, ["2xx", "4xx", "5xx"]);
  assert.deepEqual(params.source.enum, ["rest", "scim", "mcp"]);
  assert.equal(params.status.type, "integer");
  assert.equal(params.limit.type, "integer");

  assert.equal(contract.response.kind, "array");
  const fields = byName(contract.response.fields);
  for (const name of ["request_id", "timestamp", "source", "method", "route", "path", "status", "duration_ms", "upstream_duration_ms", "token", "ip", "user_agent", "api_version", "response_bytes", "error"]) {
    assert.ok(name in fields, `missing response field ${name}`);
  }
  assert.deepEqual(fields.token.properties!.map((field) => field.name), ["id", "type", "label", "oauth2_client_id"]);
  assert.deepEqual(fields.error.properties!.map((field) => field.name), ["code", "message"]);
  assert.ok(!("gateway_message" in fields)); // only the single-request view explains the outcome
});

test("logs requests get --help --json requires --request_id and returns gateway_message + hint", async () => {
  const { code, out } = await capture(["logs", "requests", "get", "--help", "--json"]);
  assert.equal(code, EXIT.OK);
  const contract = JSON.parse(out);
  assert.equal(contract.command, "logs requests get");
  assert.equal(contract.usage, "deel logs requests get [GLOBAL OPTIONS] --request_id=<string>");
  assert.deepEqual(contract.params.map((param: Field) => [param.name, param.in, param.required]), [["request_id", "path", true]]);
  assert.equal(contract.response.kind, "object");
  const fields = byName(contract.response.fields);
  for (const name of ["request_id", "status", "route", "token", "error", "gateway_message", "hint"]) assert.ok(name in fields, `missing response field ${name}`);
});

test("logs requests summary --help --json takes a from/to window and returns the rollup fields", async () => {
  const { code, out } = await capture(["logs", "requests", "summary", "--help", "--json"]);
  assert.equal(code, EXIT.OK);
  const contract = JSON.parse(out);
  assert.equal(contract.command, "logs requests summary");
  assert.equal(contract.usage, "deel logs requests summary [GLOBAL OPTIONS]");
  assert.deepEqual(contract.params.map((param: Field) => [param.name, param.in, param.required]), [["from", "query", false], ["to", "query", false]]);
  assert.equal(contract.response.kind, "object");
  assert.deepEqual(contract.response.fields.map((field: Field) => field.name), ["from", "to", "total", "by_status_class", "rate_limited", "p50_ms", "p95_ms", "active_tokens"]);
});

test("logs tokens list --help --json takes window, search and cursor and returns per-token activity", async () => {
  const { code, out } = await capture(["logs", "tokens", "list", "--help", "--json"]);
  assert.equal(code, EXIT.OK);
  const contract = JSON.parse(out);
  assert.equal(contract.command, "logs tokens list");
  assert.equal(contract.usage, "deel logs tokens list [GLOBAL OPTIONS]");
  assert.deepEqual(contract.params.map((param: Field) => param.name), ["from", "to", "search", "cursor", "limit"]);
  assert.equal(contract.response.kind, "array");
  const fields = byName(contract.response.fields);
  assert.deepEqual(Object.keys(fields), ["token", "calls", "errors", "last_used_at", "last_ip", "daily"]);
  assert.deepEqual(fields.token.properties!.map((field) => field.name), ["id", "type", "label"]);
  assert.equal(fields.daily.type, "array");
  assert.deepEqual(fields.daily.properties!.map((field) => field.name), ["day", "calls", "errors"]);
});

test("logs requests list --help documents --cursor and the status_class values", async () => {
  const { code, out } = await capture(["logs", "requests", "list", "--help"]);
  assert.equal(code, EXIT.OK);
  assert.match(out, /USAGE\s+deel logs requests list \[GLOBAL OPTIONS\]/);
  assert.match(out, /--cursor=<string>/);
  assert.match(out, /--status_class=<string>\s+\[2xx \| 4xx \| 5xx\]/);
  assert.match(out, /deel logs requests list --help --json/);
});

test("logs group help routes to the requests and tokens sub-groups", async () => {
  const group = await capture(["logs", "--help"]);
  assert.equal(group.code, EXIT.OK);
  assert.match(group.out, /\brequests\b/);
  assert.match(group.out, /\btokens\b/);

  const requests = await capture(["logs", "requests", "--help"]);
  assert.equal(requests.code, EXIT.OK);
  for (const action of ["list", "get", "summary"]) assert.match(requests.out, new RegExp(`\\b${action}\\b`));

  const tokens = await capture(["logs", "tokens", "--help"]);
  assert.equal(tokens.code, EXIT.OK);
  assert.match(tokens.out, /\blist\b/);
});
