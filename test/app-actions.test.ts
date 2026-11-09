import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APP_TOOL,
  actionInput,
  appError,
  assertEligible,
  coerceInput,
  createAppClient,
  getAction,
  inputSkeleton,
  runAction,
  runCall,
  runOutcome,
  searchActions,
} from "../src/core/app-actions.ts";
import type { ActionDetail, AppClient } from "../src/core/app-actions.ts";
import type { ResolvedToken } from "../src/core/auth.ts";
import type { CliError } from "../src/core/errors.ts";
import type { HttpRequest, HttpResponse, Transport } from "../src/core/http.ts";
import type { ToolResult } from "../src/core/mcp.ts";
import type { OAuthSource } from "../src/core/oauth.ts";

// Made-up actions only: deel-cli is public.
const APPROVE: ActionDetail = {
  name: "approve_widget",
  title: "Approve a widget",
  method: "POST",
  scopes: ["widgets:write"],
  run_with: APP_TOOL.runWrite,
  input_schema: {
    type: "object",
    properties: {
      path_params: { type: "object", properties: { widget_id: { type: "string" } }, required: ["widget_id"] },
      query: { type: "object", properties: { limit: { type: "integer" }, note: { type: "string" } } },
      body: { type: "object", properties: { reason: { type: "string" }, urgent: { type: "boolean" }, level: { enum: ["low", "high"] } } },
    },
  },
};
const LIST: ActionDetail = { name: "list_widgets", method: "GET", scopes: ["widgets:read"], run_with: APP_TOOL.runRead, input_schema: { type: "object", properties: {} } };

const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
const failure = (statusCode: number, code?: string, message = "failed") =>
  JSON.stringify({ status: "error", statusCode, message, errors: [{ message, ...(code ? { code } : {}) }] });

const ok = (...texts: string[]): ToolResult => ({ isError: false, texts, requestId: "req" });
const err = (statusCode: number, code?: string, message?: string): ToolResult => ({ isError: true, texts: [failure(statusCode, code, message)], requestId: "req" });

// A fake AppClient answering each call from a queue, recording the tool, arguments and retry flag.
function scripted(...results: ToolResult[]) {
  const calls: Array<{ tool: string; args: Record<string, unknown>; retryable: boolean }> = [];
  const client: AppClient = { call: async (tool, args, { retryable }) => (calls.push({ tool, args, retryable }), results.shift() ?? assert.fail(`unexpected ${tool}`)) };
  return { client, calls };
}

// ---------------- eligibility ----------------

const oauthSource = (accessToken: string) => ({ current: () => ({ access_token: accessToken }) }) as unknown as OAuthSource;

test("no login, or a PAT saved by an earlier release, is auth.oauth_required before any call", () => {
  const cases: ResolvedToken[] = [{ token: null, source: "none" }, { token: "pat", source: "keychain" }];
  for (const resolved of cases) assert.throws(() => assertEligible(resolved), (error: CliError) => error.code === "auth.oauth_required" && /deel auth login/.test(error.next ?? ""));
});

test("a token without a client_id claim is a PAT", () => {
  assert.throws(() => assertEligible({ token: jwt({ sub: "1" }), source: "env" }), (error: CliError) => error.code === "auth.oauth_required");
});

test("a DEEL_TOKEN that is not a JWT is refused, a stored OAuth login that isn't decodable is left to the server", () => {
  assert.throws(() => assertEligible({ token: "opaque", source: "env" }), (error: CliError) => error.code === "auth.oauth_required");
  assert.doesNotThrow(() => assertEligible({ token: "opaque", source: "oauth", oauth: oauthSource("opaque") }));
});

test("a token that hides PII or employment data is app.sensitive_data_hidden", () => {
  for (const claim of ["hide_pii_data", "hide_employment_data"]) {
    assert.throws(() => assertEligible({ token: jwt({ client_id: "c", [claim]: true }), source: "stdin" }), (error: CliError) => error.code === "app.sensitive_data_hidden");
  }
});

test("an OAuth login is checked on its current access token", () => {
  const good = jwt({ client_id: "c" });
  assert.doesNotThrow(() => assertEligible({ token: "stale", source: "oauth", oauth: oauthSource(good) }));
  assert.throws(() => assertEligible({ token: good, source: "oauth", oauth: oauthSource(jwt({ client_id: "c", hide_pii_data: true })) }), (error: CliError) => error.code === "app.sensitive_data_hidden");
});

// ---------------- client: retries and renewal ----------------

const rpc = (result: unknown): HttpResponse => ({ status: 200, headers: { "content-type": "application/json" }, text: JSON.stringify({ jsonrpc: "2.0", id: 1, result }), json: undefined });
const content = (texts: string[], isError = false) => rpc({ content: texts.map((text) => ({ type: "text", text })), ...(isError ? { isError } : {}) });

function client(responses: HttpResponse[], opts: { renew?: () => Promise<boolean> } = {}) {
  const requests: HttpRequest[] = [];
  const sleeps: number[] = [];
  let id = 0;
  const http: Transport = async (request) => (requests.push(request), responses.shift() ?? assert.fail("unexpected request"));
  const appClient = createAppClient({ http, url: "https://mcp.example.test/mcp", newRequestId: () => `r${++id}`, renew: opts.renew, sleep: async (ms) => void sleeps.push(ms) });
  return { appClient, requests, sleeps };
}

test("a transient failure on a retryable call is retried with backoff, and each attempt has its own request id", async () => {
  const { appClient, requests, sleeps } = client([content([failure(503, "UPSTREAM_UNAVAILABLE")], true), content([failure(429)], true), content(["ok"])]);
  const result = await appClient.call(APP_TOOL.search, { query: "x" }, { retryable: true });
  assert.deepEqual(result.texts, ["ok"]);
  assert.deepEqual(sleeps, [200, 400]);
  assert.deepEqual(requests.map((request) => request.headers["x-request-id"]), ["r1", "r2", "r3"]);
});

test("a write is never retried", async () => {
  const { appClient, requests } = client([content([failure(504, "UPSTREAM_TIMEOUT")], true)]);
  const result = await appClient.call(APP_TOOL.runWrite, { name: "x" }, { retryable: false });
  assert.equal(result.isError, true);
  assert.equal(requests.length, 1);
});

test("a permanent failure is returned at once", async () => {
  const { appClient, requests } = client([content([failure(404, "ACTION_NOT_FOUND")], true)]);
  assert.equal((await appClient.call(APP_TOOL.get, { name: "x" }, { retryable: true })).isError, true);
  assert.equal(requests.length, 1);
});

test("AUTHENTICATION_REQUIRED renews the login once and retries, also on a write", async () => {
  let renewals = 0;
  const { appClient, requests } = client([content([failure(401, "AUTHENTICATION_REQUIRED")], true), content(["done"])], { renew: async () => (renewals++, true) });
  assert.deepEqual((await appClient.call(APP_TOOL.runWrite, { name: "x" }, { retryable: false })).texts, ["done"]);
  assert.equal(renewals, 1);
  assert.equal(requests.length, 2);
});

test("a login is renewed at most once per call, across an HTTP 401 and an isError 401", async () => {
  let renewals = 0;
  const unauthorized: HttpResponse = { status: 401, headers: {}, text: "", json: undefined };
  const { appClient } = client([unauthorized, content([failure(401, "AUTHENTICATION_REQUIRED")], true)], { renew: async () => (renewals++, true) });
  const result = await appClient.call(APP_TOOL.search, { query: "x" }, { retryable: false });
  assert.equal(result.isError, true);
  assert.equal(renewals, 1);
});

// ---------------- errors ----------------

test("the server's error codes map to CLI errors with a next step", () => {
  const mapped = (statusCode: number, code: string | undefined, context = {}, message = "server said no") => appError({ statusCode, code, message }, "req", context);
  assert.equal(mapped(401, "AUTHENTICATION_REQUIRED").code, "auth.expired");
  assert.equal(mapped(403, "TOKEN_TYPE_NOT_ALLOWED", {}, "App actions need an OAuth token").code, "auth.oauth_required");
  assert.equal(mapped(403, "TOKEN_TYPE_NOT_ALLOWED", {}, "not available to a token that hides PII or employment data").code, "app.sensitive_data_hidden");
  assert.equal(mapped(403, "APP_ACTIONS_NOT_ALLOWED").code, "app.unavailable");
  assert.equal(mapped(503, "APP_ACTIONS_NOT_CONFIGURED").code, "app.unavailable");
  const notFound = mapped(404, "ACTION_NOT_FOUND", { action: "nope" });
  assert.equal(notFound.code, "app.action_not_found");
  assert.match(notFound.message, /"nope"/);
  assert.match(notFound.next ?? "", /deel app search/);
  assert.match(mapped(403, "INSUFFICIENT_SCOPES", { scopes: ["a:write", "b:write"] }).next ?? "", /--scopes a:write,b:write/);
  assert.match(mapped(403, "INSUFFICIENT_SCOPES").next ?? "", /--scopes <scope>/);
  assert.match(mapped(403, "INSUFFICIENT_SCOPES", {}, "x needs one of these scopes: a:read, b:read").next ?? "", /--scopes a:read,b:read/);
  assert.match(mapped(400, "INVALID_ARGUMENTS", { action: "x" }).next ?? "", /deel app describe x/);
  assert.equal(mapped(400, "INVALID_ARGUMENTS").next, undefined);
  assert.equal(mapped(400, "WRONG_ACTION_KIND").code, "app.wrong_kind");
  assert.equal(mapped(403, "PERMISSION_DENIED").code, "app.permission_denied");
  assert.equal(mapped(401, "INVALID_MCP_ASSERTION").code, "app.invalid_mcp_assertion");
  assert.equal(mapped(418, undefined).code, "app.http_418");
  assert.equal(mapped(500, "UPSTREAM_SERVER_ERROR").code, "app.upstream_server_error");
  assert.equal(mapped(403, "INSUFFICIENT_SCOPES").requestId, "req");
});

test("a rate limit says to check before re-running a write", () => {
  assert.equal(appError({ statusCode: 429, message: "slow down" }, "r").next, "Wait a moment and try again.");
  assert.match(appError({ statusCode: 429, message: "slow down" }, "r", { write: true }).next ?? "", /check whether the action ran/);
});

test("a write that got no answer has an unknown outcome", () => {
  for (const code of ["UPSTREAM_TIMEOUT", "UPSTREAM_UNAVAILABLE", "UPSTREAM_SERVER_ERROR", undefined]) {
    const error = appError({ statusCode: code === "UPSTREAM_TIMEOUT" ? 504 : 503, code, message: "no answer." }, "r", { write: true });
    assert.equal(error.code, "app.outcome_unknown");
    assert.match(error.next ?? "", /read action/);
  }
  assert.equal(appError({ statusCode: 400, code: "UPSTREAM_CLIENT_ERROR", message: "bad" }, "r", { write: true }).code, "app.upstream_client_error");
  assert.equal(appError({ statusCode: 504, code: "UPSTREAM_TIMEOUT", message: "The action timed out" }, "r", { write: true }).message, "The action timed out. The action may or may not have run.");
  assert.equal(appError({ statusCode: 504, code: "UPSTREAM_TIMEOUT", message: "No answer." }, "r", { write: true }).message, "No answer. The action may or may not have run.");
});

// ---------------- search and describe ----------------

test("search sends the query and limit and returns the actions", async () => {
  const { client: fake, calls } = scripted(ok(JSON.stringify({ actions: [{ name: "list_widgets" }] })));
  const found = await searchActions(fake, "widgets", 5);
  assert.deepEqual(found, { actions: [{ name: "list_widgets" }], requestId: "req" });
  assert.deepEqual(calls, [{ tool: APP_TOOL.search, args: { query: "widgets", limit: 5 }, retryable: true }]);
});

test("search checks its arguments before calling", async () => {
  const { client: fake, calls } = scripted();
  await assert.rejects(() => searchActions(fake, "  "), (error: CliError) => error.code === "usage.app");
  for (const limit of [0, 21, 1.5]) await assert.rejects(() => searchActions(fake, "x", limit), (error: CliError) => error.code === "usage.app");
  assert.equal(calls.length, 0);
});

test("search maps an isError result and rejects a result that isn't JSON", async () => {
  await assert.rejects(() => searchActions(scripted(err(403, "APP_ACTIONS_NOT_ALLOWED")).client, "x"), (error: CliError) => error.code === "app.unavailable");
  await assert.rejects(() => searchActions(scripted(ok("not json")).client, "x"), (error: CliError) => error.code === "mcp.response" && error.requestId === "req");
  assert.deepEqual((await searchActions(scripted(ok("{}")).client, "x")).actions, []);
});

test("getAction returns the action and names it in errors", async () => {
  assert.deepEqual((await getAction(scripted(ok(JSON.stringify(LIST))).client, "list_widgets")).action, LIST);
  await assert.rejects(() => getAction(scripted(err(404, "ACTION_NOT_FOUND")).client, "nope"), (error: CliError) => error.code === "app.action_not_found" && /"nope"/.test(error.message));
});

// ---------------- run ----------------

test("--input must be an object of path_params, query and body", () => {
  assert.deepEqual(actionInput(undefined), {});
  assert.deepEqual(actionInput({ path_params: { a: 1 }, body: [] }), { path_params: { a: 1 }, body: [] });
  for (const bad of ["x", [1], null]) assert.throws(() => actionInput(bad), (error: CliError) => error.code === "usage.app_input");
  assert.throws(() => actionInput({ widget_id: 1 }), (error: CliError) => error.code === "usage.app_input" && /widget_id/.test(error.message));
});

test("path and query values follow the schema's string or number types; the body is left as is", () => {
  const input = { path_params: { widget_id: 123 }, query: { limit: "5", note: true, other: 7 }, body: { reason: 1 } };
  assert.deepEqual(coerceInput(input, APPROVE.input_schema), { path_params: { widget_id: "123" }, query: { limit: 5, note: "true", other: 7 }, body: { reason: 1 } });
  assert.deepEqual(coerceInput({ query: { limit: "many" } }, APPROVE.input_schema), { query: { limit: "many" } });
  assert.deepEqual(coerceInput({}, undefined), {});
});

test("run uses the tool get_action names in run_with, and a write when it names none", () => {
  assert.equal(runCall(LIST, {}).tool, APP_TOOL.runRead);
  assert.equal(runCall(APPROVE, {}).tool, APP_TOOL.runWrite);
  assert.equal(runCall({ name: "x" }, {}).tool, APP_TOOL.runWrite);
  assert.deepEqual(runCall(APPROVE, { path_params: { widget_id: 9 } }).arguments, { name: "approve_widget", path_params: { widget_id: "9" } });
});

test("a read is retryable and a write is not", async () => {
  const read = scripted(ok("[]"));
  await runAction(read.client, LIST, {});
  assert.deepEqual(read.calls, [{ tool: APP_TOOL.runRead, args: { name: "list_widgets" }, retryable: true }]);
  const write = scripted(ok("{}"));
  await runAction(write.client, APPROVE, { path_params: { widget_id: "w1" } });
  assert.deepEqual(write.calls, [{ tool: APP_TOOL.runWrite, args: { name: "approve_widget", path_params: { widget_id: "w1" } }, retryable: false }]);
});

test("WRONG_ACTION_KIND retries once with the other tool", async () => {
  const { client: fake, calls } = scripted(err(400, "WRONG_ACTION_KIND"), ok('{"status":"ok"}'));
  const outcome = await runAction(fake, LIST, {});
  assert.deepEqual(outcome.data, { status: "ok" });
  assert.deepEqual(calls.map((call) => [call.tool, call.retryable]), [[APP_TOOL.runRead, true], [APP_TOOL.runWrite, false]]);
});

test("a failed run carries the action's scopes into the next step", async () => {
  await assert.rejects(() => runAction(scripted(err(403, "INSUFFICIENT_SCOPES")).client, APPROVE, {}), (error: CliError) => error.code === "auth.insufficient_scope" && /widgets:write/.test(error.next ?? ""));
  await assert.rejects(() => runAction(scripted(err(504, "UPSTREAM_TIMEOUT")).client, APPROVE, {}), (error: CliError) => error.code === "app.outcome_unknown");
});

test("a run returns the body as JSON when it parses, as text otherwise", () => {
  assert.deepEqual(runOutcome(ok('{"id":"w1"}')), { data: { id: "w1" }, requestId: "req" });
  assert.deepEqual(runOutcome(ok("plain text")), { data: "plain text", requestId: "req" });
  assert.deepEqual(runOutcome(ok()), { data: "", requestId: "req" });
});

test("a cut body stays text and reports how much was shown", () => {
  const notice = "[Response truncated: the action returned 162732 bytes; only the first 102400 bytes are shown.]";
  assert.deepEqual(runOutcome(ok('{"items":[1,2', notice)), { data: '{"items":[1,2', requestId: "req", truncated: { total_bytes: 162732, shown_bytes: 102400 } });
});

// ---------------- describe --generate-input ----------------

test("the input skeleton follows the schema", () => {
  assert.deepEqual(inputSkeleton(APPROVE), {
    path_params: { widget_id: "" },
    query: { limit: 0, note: "" },
    body: { reason: "", urgent: false, level: "low" },
  });
  assert.deepEqual(inputSkeleton(LIST), {});
  assert.deepEqual(inputSkeleton({ name: "x" }), {});
  const combined: ActionDetail = { name: "x", input_schema: { type: "object", properties: { path_params: { type: "object", properties: { id: { allOf: [{ type: "string" }, { pattern: "x" }] }, tags: { type: "array" }, n: { type: "number" } } } } } };
  assert.deepEqual(inputSkeleton(combined), { path_params: { id: "", tags: [], n: 0 } });
});
