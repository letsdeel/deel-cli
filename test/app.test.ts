import { test } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { positionals, runDescribe, runRun, runSearch } from "../src/commands/app.ts";
import type { AppDeps } from "../src/commands/app.ts";
import { staticCommands } from "../src/commands/index.ts";
import { RESERVED_COMMANDS } from "../src/core/constants.ts";
import { resolveConfig, resolveMcpUrl } from "../src/core/config.ts";
import type { CliError } from "../src/core/errors.ts";
import type { HttpRequest, HttpResponse, Transport } from "../src/core/http.ts";
import type { IOStreams } from "../src/core/io.ts";
import type { CredentialStore } from "../src/core/keychain.ts";
import { readOAuthEntry, writeOAuthEntry } from "../src/core/oauth.ts";
import { tempDir } from "./stubs.ts";

// Made-up actions only: deel-cli is public.
const ISSUER = "https://api.letsdeel.com";
const MCP = `${ISSUER}/mcp`;
const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
const ACCESS = jwt({ client_id: "cli", scope: "widgets:read widgets:write" });
const RENEWED = jwt({ client_id: "cli", scope: "widgets:read widgets:write", n: 2 });
const ARGS = { json: true };
const LIST = { name: "list_widgets", method: "GET", scopes: ["widgets:read"], run_with: "run_read_action", input_schema: { type: "object", properties: { query: { type: "object", properties: { status: { type: "string" } } } } } };
const APPROVE = {
  name: "approve_widget",
  method: "POST",
  scopes: ["widgets:write"],
  run_with: "run_write_action",
  input_schema: { type: "object", properties: { path_params: { type: "object", properties: { widget_id: { type: "string" } }, required: ["widget_id"] } }, required: ["path_params"] },
};

function isolated(t: TestContext, env: Record<string, string> = {}) {
  const keys = ["DEEL_LOG_DIR", "DEEL_TOKEN", "DEEL_OAUTH_ISSUER", "DEEL_ENV", "DEEL_MCP_URL"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.DEEL_LOG_DIR = tempDir(t);
  Object.assign(process.env, env);
  t.after(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

function loggedIn(accessToken = ACCESS) {
  const items = new Map<string, string>();
  const store: CredentialStore = {
    available: () => true,
    get: (account) => items.get(account) ?? null,
    set: (account, value) => (items.set(account, value), true),
    remove: (account) => items.delete(account),
  };
  writeOAuthEntry(store, ISSUER, { v: 2, access_token: accessToken, refresh_token: "rt", expires_at: new Date(Date.now() + 3600_000).toISOString() });
  return store;
}

function captureIO() {
  const out: string[] = [];
  const err: string[] = [];
  const io: IOStreams = { out: (text) => out.push(text), err: (text) => err.push(text), readStdin: () => "", isTTY: false, interactive: false };
  return { io, json: () => JSON.parse(out.join("")), out: () => out.join(""), err: () => err.join("") };
}

const toolResult = (texts: string[], isError = false) => ({ content: texts.map((text) => ({ type: "text", text })), ...(isError ? { isError } : {}) });
const failure = (statusCode: number, code: string, message = "failed") => JSON.stringify({ status: "error", statusCode, message, errors: [{ message, code }] });

// /mcp answering tools/call from a handler; OAuth discovery and the token endpoint for a refresh.
function server(handle: (tool: string, args: Record<string, unknown>, request: HttpRequest) => { texts: string[]; isError?: boolean } | HttpResponse) {
  const requests: HttpRequest[] = [];
  const transport: Transport = async (request) => {
    requests.push(request);
    const json = (status: number, body: unknown): HttpResponse => ({ status, headers: { "content-type": "application/json" }, text: JSON.stringify(body), json: body });
    if (request.url.endsWith("/.well-known/oauth-authorization-server")) {
      return json(200, { issuer: ISSUER, authorization_endpoint: `${ISSUER}/oauth/authorize`, token_endpoint: `${ISSUER}/oauth/tokens` });
    }
    if (request.url === `${ISSUER}/oauth/tokens`) return json(200, { access_token: RENEWED, refresh_token: "rt2", expires_in: 3600 });
    const rpc = JSON.parse(String(request.body)) as { params: { name: string; arguments: Record<string, unknown> } };
    const answer = handle(rpc.params.name, rpc.params.arguments, request);
    if ("status" in answer) return answer;
    return json(200, { jsonrpc: "2.0", id: 1, result: toolResult(answer.texts, answer.isError) });
  };
  return { transport, requests, tools: () => requests.filter((request) => request.url.endsWith("/mcp")).map((request) => JSON.parse(String(request.body)).params) };
}

function deps(transport: Transport, store: CredentialStore, io: IOStreams): AppDeps {
  return { baseTransport: transport, store, io, sleep: async () => {} };
}

test("app is a static command and a reserved name", () => {
  assert.ok(staticCommands.app);
  assert.ok(RESERVED_COMMANDS.has("app"));
});

test("the MCP URL is /mcp on the API host, or DEEL_MCP_URL", (t) => {
  isolated(t);
  assert.equal(resolveMcpUrl(resolveConfig({ env: "prod" })), MCP);
  assert.equal(resolveMcpUrl(resolveConfig({ env: "demo" })), "https://api-staging.letsdeel.com/mcp");
  process.env.DEEL_MCP_URL = "https://mcp.example.test/mcp/";
  assert.equal(resolveMcpUrl(resolveConfig({ env: "prod" })), "https://mcp.example.test/mcp");
  process.env.DEEL_MCP_URL = "http://mcp.example.test/mcp";
  assert.throws(() => resolveMcpUrl(resolveConfig({ env: "prod" })), (error: CliError) => error.code === "config.mcp");
});

test("search prints the actions with the request id", async (t) => {
  isolated(t);
  const io = captureIO();
  const { transport, tools, requests } = server(() => ({ texts: [JSON.stringify({ actions: [{ name: "list_widgets", method: "GET" }] })] }));
  await runSearch({ ...ARGS, _: ["pending", "widgets"], limit: "5" }, [], deps(transport, loggedIn(), io.io));
  assert.deepEqual(tools(), [{ name: "search_actions", arguments: { query: "pending widgets", limit: 5 } }]);
  const printed = io.json();
  assert.deepEqual(printed.data, { actions: [{ name: "list_widgets", method: "GET" }] });
  assert.equal(printed.meta.request_id, requests[0].headers["x-request-id"]);
  assert.equal(requests[0].url, MCP);
  assert.equal(requests[0].headers.authorization, `Bearer ${ACCESS}`);
});

test("search without words is a usage error, before any call", async (t) => {
  isolated(t);
  const { transport, requests } = server(() => assert.fail("no call expected"));
  await assert.rejects(() => runSearch({ ...ARGS, _: [] }, [], deps(transport, loggedIn(), captureIO().io)), (error: CliError) => error.code === "usage.app");
  assert.equal(requests.length, 0);
});

test("a PAT in DEEL_TOKEN is refused before any call", async (t) => {
  isolated(t, { DEEL_TOKEN: jwt({ sub: "pat" }) });
  const { transport, requests } = server(() => assert.fail("no call expected"));
  await assert.rejects(() => runSearch({ ...ARGS, _: ["x"] }, [], deps(transport, loggedIn(), captureIO().io)), (error: CliError) => error.code === "auth.oauth_required");
  assert.equal(requests.length, 0);
});

test("describe prints each action, and --generate-input prints a skeleton", async (t) => {
  isolated(t);
  const actions: Record<string, object> = { list_widgets: LIST, approve_widget: APPROVE };
  const { transport, tools } = server((_tool, args) => ({ texts: [JSON.stringify(actions[String(args.name)])] }));
  const io = captureIO();
  await runDescribe({ ...ARGS, _: ["list_widgets", "approve_widget"] }, [], deps(transport, loggedIn(), io.io));
  assert.deepEqual(io.json().data.actions, [LIST, APPROVE]);
  assert.deepEqual(tools().map((call) => call.arguments), [{ name: "list_widgets" }, { name: "approve_widget" }]);

  const skeleton = captureIO();
  await runDescribe({ ...ARGS, _: ["approve_widget"], "generate-input": true }, [], deps(transport, loggedIn(), skeleton.io));
  assert.deepEqual(JSON.parse(skeleton.out()), { path_params: { widget_id: "" } });
  await assert.rejects(() => runDescribe({ ...ARGS, _: ["a", "b"], "generate-input": true }, [], deps(transport, loggedIn(), captureIO().io)), (error: CliError) => error.code === "usage.app");
  await assert.rejects(() => runDescribe({ ...ARGS, _: [] }, [], deps(transport, loggedIn(), captureIO().io)), (error: CliError) => error.code === "usage.app");
});

test("run reads the action, then calls run_read_action with the parsed input", async (t) => {
  isolated(t);
  const { transport, tools } = server((tool) => (tool === "get_action" ? { texts: [JSON.stringify(LIST)] } : { texts: ['[{"id":"w1"}]'] }));
  const io = captureIO();
  await runRun({ ...ARGS, _: ["list_widgets"], input: "query={status=pending}" }, [], deps(transport, loggedIn(), io.io));
  assert.deepEqual(tools(), [
    { name: "get_action", arguments: { name: "list_widgets" } },
    { name: "run_read_action", arguments: { name: "list_widgets", query: { status: "pending" } } },
  ]);
  assert.deepEqual(io.json().data, [{ id: "w1" }]);
});

test("run of a write calls run_write_action without asking, and is sent once", async (t) => {
  isolated(t);
  const { transport, tools, requests } = server((tool) => (tool === "get_action" ? { texts: [JSON.stringify(APPROVE)] } : { texts: [failure(504, "UPSTREAM_TIMEOUT", "The action timed out")], isError: true }));
  await assert.rejects(
    () => runRun({ ...ARGS, _: ["approve_widget"], input: "path_params={widget_id=123}" }, [], deps(transport, loggedIn(), captureIO().io)),
    (error: CliError) => error.code === "app.outcome_unknown" && Boolean(error.requestId),
  );
  assert.deepEqual(tools()[1], { name: "run_write_action", arguments: { name: "approve_widget", path_params: { widget_id: "123" } } });
  assert.equal(requests.filter((request) => request.url === MCP).length, 2);
  assert.equal(requests[1].retryable, false);
});

test("run --dry-run prints the call and runs nothing", async (t) => {
  isolated(t);
  const { transport, tools } = server(() => ({ texts: [JSON.stringify(APPROVE)] }));
  const io = captureIO();
  await runRun({ ...ARGS, _: ["approve_widget"], input: '{"path_params":{"widget_id":"w1"}}', "dry-run": true }, [], deps(transport, loggedIn(), io.io));
  assert.equal(tools().length, 1);
  const printed = io.json();
  assert.deepEqual(printed.data, { method: "tools/call", params: { name: "run_write_action", arguments: { name: "approve_widget", path_params: { widget_id: "w1" } } } });
  assert.equal(printed.meta.dry_run, true);
});

test("run checks its arguments and --input before any call", async (t) => {
  isolated(t);
  const { transport, requests } = server(() => assert.fail("no call expected"));
  const run = (args: Record<string, unknown>) => runRun({ ...ARGS, ...args }, [], deps(transport, loggedIn(), captureIO().io));
  await assert.rejects(() => run({ _: [] }), (error: CliError) => error.code === "usage.app");
  await assert.rejects(() => run({ _: ["a", "b"] }), (error: CliError) => error.code === "usage.app");
  await assert.rejects(() => run({ _: ["a"], input: "widget_id=1" }), (error: CliError) => error.code === "usage.app_input");
  assert.equal(requests.length, 0);
});

test("a truncated response is returned as text with meta.truncated and a warning", async (t) => {
  isolated(t);
  const notice = "[Response truncated: the action returned 200000 bytes; only the first 102400 bytes are shown.]";
  const { transport } = server((tool) => (tool === "get_action" ? { texts: [JSON.stringify(LIST)] } : { texts: ['[{"id":', notice] }));
  const io = captureIO();
  await runRun({ ...ARGS, _: ["list_widgets"] }, [], deps(transport, loggedIn(), io.io));
  const printed = io.json();
  assert.equal(printed.data, '[{"id":');
  assert.deepEqual(printed.meta.truncated, { total_bytes: 200000, shown_bytes: 102400 });
  assert.match(io.err(), /cut at 102400 of 200000 bytes/);
});

test("an HTTP 401 renews the stored login and retries with the new token", async (t) => {
  isolated(t);
  const store = loggedIn();
  const { transport, requests } = server((_tool, _args, request) =>
    request.headers.authorization === `Bearer ${ACCESS}` ? { status: 401, headers: {}, text: "", json: undefined } : { texts: ['{"actions":[]}'] },
  );
  const io = captureIO();
  await runSearch({ ...ARGS, _: ["x"] }, [], deps(transport, store, io.io));
  const mcpCalls = requests.filter((request) => request.url === MCP);
  assert.deepEqual(mcpCalls.map((request) => request.headers.authorization), [`Bearer ${ACCESS}`, `Bearer ${RENEWED}`]);
  assert.equal(readOAuthEntry(store, ISSUER)?.access_token, RENEWED);
  assert.deepEqual(io.json().data, { actions: [] });
});

test("DEEL_MCP_URL points the commands at another /mcp", async (t) => {
  isolated(t, { DEEL_MCP_URL: "https://mcp.example.test/mcp" });
  const { transport, requests } = server(() => ({ texts: ['{"actions":[]}'] }));
  await runSearch({ ...ARGS, _: ["x"] }, [], deps(transport, loggedIn(), captureIO().io));
  assert.equal(requests[0].url, "https://mcp.example.test/mcp");
});

test("the value of the hidden --base-url flag is not a positional word", () => {
  const url = "https://api.example.test/rest";
  assert.deepEqual(positionals({ _: ["time", url, "off"] }, ["time", "--base-url", url, "off"]), ["time", "off"]);
  assert.deepEqual(positionals({ _: ["a"] }, ["a", `--base-url=${url}`]), ["a"]);
  assert.deepEqual(positionals({ _: ["a"] }, ["a", "--base-url"]), ["a"]);
  assert.deepEqual(positionals({}, []), []);
});
