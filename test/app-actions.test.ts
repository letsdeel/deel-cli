import { test } from "node:test";
import assert from "node:assert/strict";
import { RETRY_MAX_ATTEMPTS } from "../src/core/constants.ts";
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
import { CliError } from "../src/core/errors.ts";
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

test("a read retries a transient failure up to the attempt cap, then returns it", async () => {
  const { appClient, requests, sleeps } = client([1, 2, 3, 4].map(() => content([failure(503, "UPSTREAM_UNAVAILABLE")], true)));
  assert.equal((await appClient.call(APP_TOOL.search, { query: "x" }, { retryable: true })).isError, true);
  assert.equal(requests.length, RETRY_MAX_ATTEMPTS);
  assert.equal(sleeps.length, RETRY_MAX_ATTEMPTS - 1);
});

test("a login the client can't renew leaves the AUTHENTICATION_REQUIRED failure as the answer", async () => {
  let renewals = 0;
  const { appClient, requests } = client([content([failure(401, "AUTHENTICATION_REQUIRED")], true)], { renew: async () => (renewals++, false) });
  const result = await appClient.call(APP_TOOL.search, { query: "x" }, { retryable: true });
  assert.equal(result.isError, true);
  assert.equal(renewals, 1);
  assert.equal(requests.length, 1);
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
  // A 4xx without a code is a definitive rejection, not an unknown outcome.
  for (const statusCode of [400, 404, 422]) assert.equal(appError({ statusCode, message: "no" }, "r", { write: true }).code, `app.http_${statusCode}`);
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

test("a result in an unexpected shape is mcp.response, with the request id", async () => {
  const bad = (text: string, run: (client: AppClient) => Promise<unknown>) => assert.rejects(() => run(scripted(ok(text)).client), (error: CliError) => error.code === "mcp.response" && error.requestId === "req", text);
  for (const text of ["[]", "7", '{"actions":"x"}', '{"actions":[1]}', '{"actions":[{"title":"no name"}]}']) await bad(text, (c) => searchActions(c, "x"));
  for (const text of ["[]", '"x"', "{}", '{"name":"a","scopes":"x"}', '{"name":"a","scopes":[1]}', '{"name":"a","run_with":1}', '{"name":"a","input_schema":[]}']) await bad(text, (c) => getAction(c, "a"));
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
  for (const bad of [{ path_params: "x" }, { query: [1] }, { path_params: null }]) assert.throws(() => actionInput(bad), (error: CliError) => error.code === "usage.app_input" && /must be an object/.test(error.message));
  assert.throws(() => actionInput({ widget_id: 1 }), (error: CliError) => error.code === "usage.app_input" && /widget_id/.test(error.message));
});

test("path and query values follow the schema's string or number types; the body is left as is", () => {
  const input = { path_params: { widget_id: 123 }, query: { limit: "5", note: true, other: 7 }, body: { reason: 1 } };
  assert.deepEqual(coerceInput(input, APPROVE.input_schema), { path_params: { widget_id: "123" }, query: { limit: 5, note: "true", other: 7 }, body: { reason: 1 } });
  assert.deepEqual(coerceInput({ query: { limit: "many" } }, APPROVE.input_schema), { query: { limit: "many" } });
  assert.deepEqual(coerceInput({}, undefined), {});
});

test("shorthand text is typed by the schema through the body, objects and lists; JSON values are left as they are", () => {
  const schema: ActionDetail["input_schema"] = {
    type: "object",
    properties: {
      path_params: { type: "object", properties: { version: { type: "string" } } },
      body: { type: "object", properties: { price: { type: "number" }, qty: { type: "integer" }, ids: { type: "array", items: { type: "integer" } }, nested: { type: "object", properties: { rate: { type: ["number", "null"] } } }, note: { type: "string" } } },
    },
  };
  assert.deepEqual(
    coerceInput({ path_params: { version: "1.10" }, body: { price: "1.50", qty: "3", ids: ["1", "2"], nested: { rate: "0.5" }, note: "007", other: "9" } }, schema),
    { path_params: { version: "1.10" }, body: { price: 1.5, qty: 3, ids: [1, 2], nested: { rate: 0.5 }, note: "007", other: "9" } },
  );
  assert.deepEqual(coerceInput({ body: { qty: 3, note: 5 } }, schema), { body: { qty: 3, note: 5 } });
});

test("a number-typed field only takes decimal text: hex and exponent forms stay text", () => {
  const schema: ActionDetail["input_schema"] = { type: "object", properties: { query: { type: "object", properties: { a: { type: "integer" }, b: { type: "number" } } } } };
  assert.deepEqual(coerceInput({ query: { a: "0x10", b: "1e3" } }, schema), { query: { a: "0x10", b: "1e3" } });
});

test("ids a number can't hold stay text, and integers only coerce when exact", () => {
  assert.deepEqual(coerceInput({ path_params: { code: "00123" }, query: { id: "12345678901234567890", n: "007", ratio: "1.50" } }, { type: "object", properties: { path_params: { type: "object", properties: { code: { type: "string" } } }, query: { type: "object", properties: { id: { type: "integer" }, n: { type: "integer" }, ratio: { type: "number" } } } } }), {
    path_params: { code: "00123" },
    query: { id: "12345678901234567890", n: 7, ratio: 1.5 },
  });
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

test("a write that fails after it was sent has an unknown outcome; a read, and a failure before it ran, keep their own error", async () => {
  const failing = (error: CliError): AppClient => ({ call: async () => { throw error; } });
  for (const code of ["network.timeout", "network.error", "http.502", "http.504", "mcp.response"]) {
    const sent = new CliError(code, "Connection reset");
    sent.requestId = "r9";
    await assert.rejects(() => runAction(failing(sent), APPROVE, {}), (error: CliError) => error.code === "app.outcome_unknown" && error.requestId === "r9" && /may or may not have run/.test(error.message), code);
    await assert.rejects(() => runAction(failing(sent), LIST, {}), (error: CliError) => error.code === code, code);
  }
  const rpc = (code: number) => new CliError("mcp.rpc", `boom (JSON-RPC ${code})`);
  for (const code of [-32603, -32000, -32099]) await assert.rejects(() => runAction(failing(rpc(code)), APPROVE, {}), (error: CliError) => error.code === "app.outcome_unknown", String(code));
  for (const code of [-32602, -32601]) await assert.rejects(() => runAction(failing(rpc(code)), APPROVE, {}), (error: CliError) => error.code === "mcp.rpc", String(code));
  for (const code of ["auth.expired", "http.400", "http.429", "network.tls", "app.unavailable"]) {
    await assert.rejects(() => runAction(failing(new CliError(code, "x")), APPROVE, {}), (error: CliError) => error.code === code, code);
  }
});

test("the retry with the other tool is also checked for an unknown outcome", async () => {
  let calls = 0;
  const flaky: AppClient = { call: async () => (++calls === 1 ? err(400, "WRONG_ACTION_KIND") : Promise.reject(new CliError("network.timeout", "timed out"))) };
  await assert.rejects(() => runAction(flaky, LIST, {}), (error: CliError) => error.code === "app.outcome_unknown");
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

test("allOf parts are merged, with the parent's own keywords, not replaced by the last part", () => {
  const schema: ActionDetail["input_schema"] = {
    type: "object",
    properties: {
      body: {
        type: "object",
        properties: { own: { type: "boolean" } },
        allOf: [
          { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
          { properties: { b: { type: "integer" } }, required: ["b"] },
          { allOf: [{ properties: { c: { enum: ["x", "y"] } } }] },
        ],
      },
    },
  };
  assert.deepEqual(inputSkeleton({ name: "x", input_schema: schema }), { body: { own: false, a: "", b: 0, c: "x" } });
  assert.deepEqual(inputSkeleton({ name: "x", input_schema: { allOf: [{ properties: { a: { type: "string" } } }, { properties: { b: { type: "string" } } }] } }), { a: "", b: "" });
  assert.deepEqual(inputSkeleton({ name: "x", input_schema: { type: "object", properties: "oops" as never } }), {});
  // The same property in two parts is merged too, and a nullable type list reads as its non-null type.
  assert.deepEqual(
    inputSkeleton({ name: "x", input_schema: { allOf: [{ properties: { a: { type: "object", properties: { x: { type: "string" } } } } }, { properties: { a: { properties: { y: { type: "integer" } } } } }] } }),
    { a: { x: "", y: 0 } },
  );
  assert.deepEqual(inputSkeleton({ name: "x", input_schema: { type: ["object", "null"], properties: { n: { type: ["null", "integer"] } } } }), { n: 0 });
});
