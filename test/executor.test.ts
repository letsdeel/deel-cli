import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute } from "../src/core/executor.ts";
import { createContext } from "../src/core/context.ts";
import { captureIO } from "../src/core/io.ts";
import type { Descriptor } from "../src/types.ts";
import type { HttpRequest, HttpResponse } from "../src/core/http.ts";

const CONFIG = { env: "demo", baseUrl: "https://example.test/rest" };

function ctxWith(handler: (req: HttpRequest) => HttpResponse, io = captureIO({})) {
  const seen: HttpRequest[] = [];
  const ctx = createContext({
    config: CONFIG,
    token: "tok_SECRET",
    io,
    clock: () => 1000,
    rng: () => "req-fixed-id",
    logger: () => {},
    baseTransport: async (req) => {
      seen.push(req);
      return handler(req);
    },
  });
  return { ctx, io, seen };
}

const createDescriptor: Descriptor = {
  command: ["adjustments", "create"],
  method: "POST",
  path: "/adjustments",
  version: "2026-01-01",
  async: false,
  bodyKind: "json",
  supportsMultipart: false,
  bodyWrapper: "none",
  params: [{ name: "contract_id", in: "query", type: "string", required: true }],
  bodyProps: [{ name: "amount", in: "body", type: "number", required: true }],
  fileFields: [],
  responseKind: "object",
  responseFields: [],
};

test("execute() drives the injected transport + IOStreams (DI)", async () => {
  const { ctx, io, seen } = ctxWith(() => ({ status: 201, headers: {}, text: "", json: { data: { id: "adj_1", amount: 5000 } } }));

  await execute(
    createDescriptor,
    { flags: { contract_id: "AC1" }, body: { amount: 5000 }, files: {} },
    ctx,
    { output: { json: true, quiet: false, raw: false }, debug: false, form: false },
  );

  // Middleware chain populated the request — no auth/version/request-id in the executor.
  const req = seen[0];
  assert.equal(req.method, "POST");
  assert.match(req.url, /\/rest\/adjustments\?contract_id=AC1$/);
  assert.equal(req.headers["authorization"], "Bearer tok_SECRET");
  assert.ok(req.headers["x-deel-cli-version"]);
  assert.equal(req.headers["x-request-id"], "req-fixed-id");
  assert.match(req.headers["idempotency-key"], /^[0-9a-f-]{36}$/);
  assert.equal(req.headers["x-version"], createDescriptor.version);

  // Output went through IOStreams, not process.stdout.
  const parsed = JSON.parse((io as any).stdout.join(""));
  assert.equal(parsed.data.id, "adj_1");
  assert.ok(!("kind" in parsed));
});

test("execute() surfaces Deel's compliant { errors: [...] } array messages", async () => {
  const { ctx } = ctxWith(() => ({
    status: 400,
    headers: {},
    text: "",
    json: { errors: [{ code: "invalid_parameter", field: "/data/email", message: "Must have required property 'email'" }] },
  }));

  await assert.rejects(
    () =>
      execute(
        createDescriptor,
        { flags: { contract_id: "AC1" }, body: { amount: 1 }, files: {} },
        ctx,
        { output: { json: true, quiet: false, raw: false }, debug: false, form: false },
      ),
    (error: any) => {
      assert.equal(error.code, "invalid_parameter");
      assert.match(error.message, /\/data\/email: Must have required property 'email'/);
      return true;
    },
  );
});

test("execute() still handles the single { error: {...} } shape", async () => {
  const { ctx } = ctxWith(() => ({ status: 409, headers: {}, text: "", json: { error: { code: "conflict", message: "Already exists" } } }));

  await assert.rejects(
    () =>
      execute(
        createDescriptor,
        { flags: { contract_id: "AC1" }, body: { amount: 1 }, files: {} },
        ctx,
        { output: { json: true, quiet: false, raw: false }, debug: false, form: false },
      ),
    (error: any) => {
      assert.equal(error.code, "conflict");
      assert.equal(error.message, "Already exists");
      return true;
    },
  );
});

test("execute() renders a 202 response body directly (no polling)", async () => {
  const bulk: Descriptor = {
    command: ["adjustments", "create-bulk"],
    method: "POST",
    path: "/adjustments-bulk",
    version: "2026-01-01",
    async: true,
    bodyKind: "json-array",
    supportsMultipart: false,
    bodyWrapper: "none",
    params: [],
    bodyProps: [],
    fileFields: [],
    responseKind: "object",
    responseFields: [],
  };

  const { ctx, io } = ctxWith(() => ({
    status: 202,
    headers: {},
    text: "",
    json: { data: { batch_id: "batch_1", items: [{ external_id: "adj-001", status: "PENDING" }] } },
  }));

  await execute(
    bulk,
    { flags: {}, body: [{ contract_id: "AC1", amount: 10 }], files: {} },
    ctx,
    { output: { json: true, quiet: false, raw: false }, debug: false, form: false },
  );

  const parsed = JSON.parse((io as any).stdout.join(""));
  assert.equal(parsed.data.batch_id, "batch_1");
  assert.equal(parsed.data.items[0].status, "PENDING");
});

test("execute() rejects a json-array body over the descriptor's maxItems", async () => {
  const bulk: Descriptor = {
    command: ["adjustments", "create-bulk"],
    variant: "invoice",
    method: "POST",
    path: "/adjustments-bulk",
    async: true,
    bodyKind: "json-array",
    supportsMultipart: false,
    bodyWrapper: "none",
    params: [],
    bodyProps: [],
    maxItems: 2,
    fileFields: [],
    responseKind: "object",
    responseFields: [],
  };
  const { ctx } = ctxWith(() => ({ status: 202, headers: {}, text: "", json: { data: {} } }));

  await assert.rejects(
    () =>
      execute(
        bulk,
        { flags: {}, body: [{ id: 1 }, { id: 2 }, { id: 3 }], files: {} },
        ctx,
        { output: { json: true, quiet: false, raw: false }, debug: false, form: false },
      ),
    (error: any) => {
      assert.equal(error.code, "usage.max_items");
      assert.match(error.message, /accepts at most 2/);
      return true;
    },
  );
});

test("execute() rejects a nested array field over its own maxItems", async () => {
  const bulk: Descriptor = {
    command: ["adjustments", "create-bulk"],
    variant: "payroll",
    method: "POST",
    path: "/adjustments/payroll/bulk",
    async: true,
    bodyKind: "json",
    supportsMultipart: false,
    bodyWrapper: "data",
    params: [],
    bodyProps: [{ name: "items", in: "body", type: "array", required: true, maxItems: 2 }],
    fileFields: [],
    responseKind: "object",
    responseFields: [],
  };
  const { ctx } = ctxWith(() => ({ status: 202, headers: {}, text: "", json: { data: {} } }));

  await assert.rejects(
    () =>
      execute(
        bulk,
        { flags: {}, body: { items: [{ id: 1 }, { id: 2 }, { id: 3 }] }, files: {} },
        ctx,
        { output: { json: true, quiet: false, raw: false }, debug: false, form: false },
      ),
    (error: any) => {
      assert.equal(error.code, "usage.max_items");
      assert.match(error.message, /--input\.items has 3 items; this operation accepts at most 2/);
      return true;
    },
  );
});

test("execute() sends repeated query params for an array-typed value", async () => {
  const listDesc: Descriptor = {
    command: ["ats", "candidates", "list"],
    method: "GET",
    path: "/ats/candidates",
    async: false,
    bodyKind: "none",
    supportsMultipart: false,
    bodyWrapper: "none",
    params: [{ name: "job_ids", in: "query", type: "array", required: false }],
    bodyProps: [],
    fileFields: [],
    responseKind: "array",
    responseFields: [],
  };
  const { ctx, seen } = ctxWith(() => ({ status: 200, headers: {}, text: "", json: { data: [] } }));

  await execute(
    listDesc,
    { flags: { job_ids: ["J1", "J2"] }, files: {} },
    ctx,
    { output: { json: true, quiet: false, raw: false }, debug: false, form: false },
  );

  assert.match(seen[0].url, /job_ids=J1&job_ids=J2/);
});

test("execute() attaches multiple files to a single multipart field", async () => {
  const upload: Descriptor = {
    command: ["cases", "documents"],
    method: "POST",
    path: "/cases/{id}/documents",
    async: false,
    bodyKind: "multipart",
    supportsMultipart: true,
    bodyWrapper: "none",
    params: [{ name: "id", in: "path", type: "string", required: true }],
    bodyProps: [{ name: "document_type", in: "body", type: "string", required: false }],
    fileFields: ["files"],
    responseKind: "object",
    responseFields: [],
  };

  const dir = mkdtempSync(join(tmpdir(), "deel-upload-"));
  const a = join(dir, "a.pdf");
  const b = join(dir, "b.pdf");
  writeFileSync(a, "file-a");
  writeFileSync(b, "file-b");

  let body: unknown;
  const { ctx } = ctxWith((req) => {
    body = req.body;
    return { status: 201, headers: {}, text: "", json: { data: { id: "doc_1" } } };
  });

  await execute(
    upload,
    { flags: { id: "C1" }, body: { document_type: "passport" }, files: { files: [a, b] } },
    ctx,
    { output: { json: true, quiet: false, raw: false }, debug: false, form: false },
  );

  assert.ok(body instanceof FormData);
  const parts = (body as FormData).getAll("files");
  assert.equal(parts.length, 2);
  assert.deepEqual(parts.map((p) => (p as File).name).sort(), ["a.pdf", "b.pdf"]);
});

// ---------------- pagination: page next to data, --cursor forwarded ----------------

const JSON_OUT = { output: { json: true, quiet: false, raw: false }, debug: false, form: false };

const logsListDescriptor: Descriptor = {
  command: ["logs", "requests", "list"],
  method: "GET",
  path: "/v2/logs/requests",
  async: false,
  bodyKind: "none",
  supportsMultipart: false,
  bodyWrapper: "none",
  params: [
    { name: "status_class", in: "query", type: "string", required: false, enum: ["2xx", "4xx", "5xx"] },
    { name: "cursor", in: "query", type: "string", required: false },
    { name: "limit", in: "query", type: "integer", required: false },
  ],
  bodyProps: [],
  fileFields: [],
  responseKind: "array",
  responseFields: [],
};

const logsGetDescriptor: Descriptor = {
  command: ["logs", "requests", "get"],
  method: "GET",
  path: "/v2/logs/requests/{request_id}",
  async: false,
  bodyKind: "none",
  supportsMultipart: false,
  bodyWrapper: "none",
  params: [{ name: "request_id", in: "path", type: "string", required: true }],
  bodyProps: [],
  fileFields: [],
  responseKind: "object",
  responseFields: [],
};

test("execute() surfaces the response page (cursor, has_next_page) next to data", async () => {
  const { ctx, io, seen } = ctxWith(() => ({
    status: 200,
    headers: {},
    text: "",
    json: { data: [{ request_id: "req_1", status: 404 }], page: { cursor: "eyJ0cyI6IjIwMjYifQ", has_next_page: true } },
  }));

  await execute(logsListDescriptor, { flags: { status_class: "4xx" }, files: {} }, ctx, JSON_OUT);

  const req = seen[0];
  assert.equal(req.method, "GET");
  assert.match(req.url, /\/rest\/v2\/logs\/requests\?status_class=4xx$/);
  assert.ok(!("idempotency-key" in req.headers)); // reads carry no idempotency key
  const parsed = JSON.parse(io.stdout.join(""));
  assert.deepEqual(Object.keys(parsed), ["data", "page", "meta"]);
  assert.equal(parsed.data[0].request_id, "req_1");
  assert.deepEqual(parsed.page, { cursor: "eyJ0cyI6IjIwMjYifQ", has_next_page: true });
  assert.equal(parsed.meta.request_id, "req-fixed-id");
});

test("execute() forwards --cursor and --limit as query params and renders the last page", async () => {
  const { ctx, io, seen } = ctxWith(() => ({ status: 200, headers: {}, text: "", json: { data: [], page: { cursor: null, has_next_page: false } } }));

  await execute(logsListDescriptor, { flags: { cursor: "eyJ0cyI6IjIwMjYifQ", limit: "100" }, files: {} }, ctx, JSON_OUT);

  const url = new URL(seen[0].url);
  assert.equal(url.pathname, "/rest/v2/logs/requests");
  assert.equal(url.searchParams.get("cursor"), "eyJ0cyI6IjIwMjYifQ");
  assert.equal(url.searchParams.get("limit"), "100");
  const parsed = JSON.parse(io.stdout.join(""));
  assert.deepEqual(parsed.data, []);
  assert.deepEqual(parsed.page, { cursor: null, has_next_page: false });
});

test("execute() keeps the envelope free of page when the response has none", async () => {
  const { ctx, io, seen } = ctxWith(() => ({ status: 200, headers: {}, text: "", json: { data: { request_id: "req_1", gateway_message: "OK", hint: "" } } }));

  await execute(logsGetDescriptor, { flags: { request_id: "req 1/x" }, files: {} }, ctx, JSON_OUT);

  assert.match(seen[0].url, /\/rest\/v2\/logs\/requests\/req%201%2Fx$/); // path param is URL-encoded
  const parsed = JSON.parse(io.stdout.join(""));
  assert.ok(!("page" in parsed));
  assert.deepEqual(Object.keys(parsed), ["data", "meta"]);
  assert.equal(parsed.data.gateway_message, "OK");
});

test("execute() does not split page out of a response that has no data envelope", async () => {
  const { ctx, io } = ctxWith(() => ({ status: 200, headers: {}, text: "", json: { items: [], page: { cursor: "x", has_next_page: false } } }));

  await execute(logsListDescriptor, { flags: {}, files: {} }, ctx, JSON_OUT);

  const parsed = JSON.parse(io.stdout.join(""));
  assert.ok(!("page" in parsed));
  assert.deepEqual(parsed.data, { items: [], page: { cursor: "x", has_next_page: false } });
});

test("execute() maps the public API error envelope of the logs endpoints unchanged", async () => {
  const { ctx, io } = ctxWith(() => ({
    status: 403,
    headers: {},
    text: "",
    json: {
      request: { method: "GET", url: "/rest/v2/logs/requests", status: 403, api_req_id: "req-fixed-id" },
      errors: [{ code: "INSUFFICIENT_SCOPES", message: "Missing required scope: api-logs:read" }],
    },
  }));

  await assert.rejects(
    () => execute(logsListDescriptor, { flags: {}, files: {} }, ctx, JSON_OUT),
    (error: any) => {
      assert.equal(error.code, "INSUFFICIENT_SCOPES");
      assert.equal(error.message, "Missing required scope: api-logs:read");
      assert.equal(error.requestId, "req-fixed-id");
      return true;
    },
  );
  assert.equal(io.stdout.length, 0); // nothing rendered on error
});
