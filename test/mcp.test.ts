import { test } from "node:test";
import assert from "node:assert/strict";
import { MCP_ACCEPT } from "../src/core/constants.ts";
import { callTool, parseRpcBody, toolFailure } from "../src/core/mcp.ts";
import type { CliError } from "../src/core/errors.ts";
import type { HttpRequest, HttpResponse, Transport } from "../src/core/http.ts";

const URL = "https://mcp.example.test/mcp";

const reply = (status: number, body: unknown, contentType = "application/json"): HttpResponse => ({
  status,
  headers: { "content-type": contentType },
  text: typeof body === "string" ? body : JSON.stringify(body),
  json: undefined,
});

const result = (texts: string[], isError = false) => ({ jsonrpc: "2.0", id: 1, result: { content: texts.map((text) => ({ type: "text", text })), ...(isError ? { isError } : {}) } });

function recording(...responses: HttpResponse[]) {
  const requests: HttpRequest[] = [];
  const transport: Transport = async (request) => (requests.push(request), responses.shift() ?? reply(500, {}));
  return { transport, requests };
}

const call = (http: Transport, extra: Partial<Parameters<typeof callTool>[0]> = {}) =>
  callTool({ http, url: URL, requestId: "req-1", name: "search_actions", args: { query: "time off" }, retryable: true, ...extra });

test("a tool call is one JSON-RPC tools/call POST with the request id and MCP accept header", async () => {
  const { transport, requests } = recording(reply(200, result(['{"actions":[]}'])));
  const outcome = await call(transport);
  assert.deepEqual(outcome, { isError: false, texts: ['{"actions":[]}'], requestId: "req-1" });
  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.equal(request.method, "POST");
  assert.equal(request.url, URL);
  assert.equal(request.headers.accept, MCP_ACCEPT);
  assert.equal(request.headers["x-request-id"], "req-1");
  assert.equal(request.retryable, true);
  assert.deepEqual(JSON.parse(String(request.body)), { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_actions", arguments: { query: "time off" } } });
});

test("an SSE response is read from its data lines", async () => {
  const sse = `event: message\ndata: ${JSON.stringify(result(["ok"]))}\n\n`;
  const { transport } = recording(reply(200, sse, "text/event-stream"));
  assert.deepEqual((await call(transport)).texts, ["ok"]);
});

test("an SSE message split over several data lines is joined, and a reply to another call is skipped", () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "a" }] } }, null, 1);
  const multiline = body.split("\n").map((line) => `data: ${line}`).join("\n");
  assert.deepEqual(parseRpcBody(`event: message\n${multiline}\n\n`, "text/event-stream", 1)?.result, { content: [{ type: "text", text: "a" }] });
  assert.equal(parseRpcBody(JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} }), "application/json", 1), null);
  assert.deepEqual(parseRpcBody(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { a: 1 } }), "application/json", 1)?.result, { a: 1 });
  assert.deepEqual(parseRpcBody(JSON.stringify({ result: { a: 2 } }), "application/json", 1)?.result, { a: 2 });
});

test("an SSE or JSON body that isn't a message object is not a reply", () => {
  for (const data of ["null", "[]", "7", '"x"', "true"]) {
    assert.equal(parseRpcBody(`data: ${data}\n\n`, "text/event-stream", 1), null, data);
    assert.equal(parseRpcBody(data, "application/json", 1), null, data);
  }
  // A null event next to the real one doesn't hide it.
  assert.deepEqual(parseRpcBody(`data: null\n\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: 1 } })}\n\n`, "text/event-stream", 1)?.result, { ok: 1 });
});

test("parseRpcBody picks the SSE message with the call's id and skips bad lines", () => {
  const text = ["data: not json", `data: ${JSON.stringify({ jsonrpc: "2.0", id: 9, result: {} })}`, `data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { x: 1 } })}`].join("\n");
  assert.deepEqual(parseRpcBody(text, "text/event-stream", 1)?.result, { x: 1 });
  assert.equal(parseRpcBody("data: {}", "text/event-stream", 1), null);
  assert.equal(parseRpcBody("<html>", "application/json", 1), null);
});

test("an isError result is returned as data, not thrown", async () => {
  const { transport } = recording(reply(200, result(['{"statusCode":404}'], true)));
  const outcome = await call(transport);
  assert.equal(outcome.isError, true);
});

test("an HTTP 401 renews the login once and retries", async () => {
  const { transport, requests } = recording(reply(401, {}), reply(200, result(["ok"])));
  let renewals = 0;
  const outcome = await call(transport, { onUnauthorized: async () => (renewals++, true) });
  assert.equal(renewals, 1);
  assert.equal(requests.length, 2);
  assert.deepEqual(outcome.texts, ["ok"]);
});

test("a second 401, or one with nothing to renew, is auth.expired with the request id", async () => {
  for (const onUnauthorized of [async () => true, async () => false, undefined]) {
    const { transport } = recording(reply(401, {}), reply(401, {}));
    await assert.rejects(
      () => call(transport, { onUnauthorized }),
      (error: CliError) => error.code === "auth.expired" && error.next === "deel auth login" && error.requestId === "req-1",
    );
  }
});

test("another HTTP status is http.<status>", async () => {
  const { transport } = recording(reply(502, "bad gateway", "text/plain"));
  await assert.rejects(() => call(transport), (error: CliError) => error.code === "http.502" && error.requestId === "req-1");
});

test("a body that is not JSON-RPC is mcp.response", async () => {
  const { transport } = recording(reply(200, "<html></html>", "text/html"));
  await assert.rejects(() => call(transport), (error: CliError) => error.code === "mcp.response");
});

test("a 200 reply with no tool result is mcp.response, not an empty success", async () => {
  for (const body of [{}, [], { message: "Service Unavailable" }, { jsonrpc: "2.0", id: 1 }, { jsonrpc: "2.0", id: 1, result: "ok" }, { jsonrpc: "2.0", id: 1, result: [] }, { jsonrpc: "2.0", id: 1, result: {} }, { jsonrpc: "2.0", id: 1, result: { content: "x" } }]) {
    const { transport } = recording(reply(200, body));
    await assert.rejects(() => call(transport), (error: CliError) => error.code === "mcp.response" && error.requestId === "req-1", JSON.stringify(body));
  }
});

test("parseRpcBody rejects a JSON array", () => {
  assert.equal(parseRpcBody("[]", "application/json", 1), null);
});

test("the request keeps the reply out of the local log", async () => {
  const { transport, requests } = recording(reply(200, result(["ok"])));
  await call(transport);
  assert.equal(requests[0].omitBodyFromLog, true);
});

test("an unknown tool means app actions are off on the server", async () => {
  const { transport } = recording(reply(200, { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Tool search_actions not found" } }));
  await assert.rejects(() => call(transport), (error: CliError) => error.code === "app.unavailable");
});

test("a server error that happens to say \"not found\" is not the unknown-tool answer", async () => {
  const { transport } = recording(reply(200, { jsonrpc: "2.0", id: 1, error: { code: -32603, message: "Internal error: record not found" } }));
  await assert.rejects(() => call(transport), (error: CliError) => error.code === "mcp.rpc" && /-32603/.test(error.message));
});

test("another JSON-RPC error is mcp.rpc with a printable message", async () => {
  const { transport } = recording(reply(200, { jsonrpc: "2.0", id: 1, error: { code: -32603, message: "boom\u001b[31m" } }));
  await assert.rejects(() => call(transport), (error: CliError) => error.code === "mcp.rpc" && error.message === "boom [31m (JSON-RPC -32603)");
});

test("non-text content items are ignored", async () => {
  const body = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "image", data: "x" }, { type: "text", text: "a" }, null] } };
  const { transport } = recording(reply(200, body));
  assert.deepEqual((await call(transport)).texts, ["a"]);
});

test("toolFailure reads the status, code, message and details of the server's error payload", () => {
  const payload = { status: "error", statusCode: 403, message: "needs a scope", errors: [{ message: "needs a scope", code: "INSUFFICIENT_SCOPES" }], details: { a: 1 } };
  assert.deepEqual(toolFailure({ isError: true, texts: [JSON.stringify(payload)], requestId: "r" }), {
    statusCode: 403,
    code: "INSUFFICIENT_SCOPES",
    message: "needs a scope",
    details: { a: 1 },
  });
});

test("toolFailure falls back to the text for a plain-text error and invents no status", () => {
  assert.deepEqual(toolFailure({ isError: true, texts: ["something broke"], requestId: "r" }), { message: "something broke" });
  assert.deepEqual(toolFailure({ isError: true, texts: [], requestId: "r" }), { message: "The tool call failed." });
});
