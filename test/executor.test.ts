import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorFromResponse, execute, withholdSecrets } from "../src/core/executor.ts";
import { createContext } from "../src/core/context.ts";
import { captureIO } from "../src/core/io.ts";
import type { Descriptor } from "../src/types.ts";
import type { HttpRequest, HttpResponse } from "../src/core/http.ts";
import type { Config } from "../src/core/config.ts";
import { HEADER } from "../src/core/constants.ts";
import { log, setLoggingEnabled, setLogBodiesEnabled } from "../src/core/logging.ts";

const CONFIG: Config = { env: "prod", baseUrl: "https://example.test/rest", issuer: null, clientId: "test-client", oauthBaseUrlOk: false };

function ctxWith(handler: (req: HttpRequest) => HttpResponse, io = captureIO({}), config: Config = CONFIG) {
  const seen: HttpRequest[] = [];
  const ctx = createContext({
    config,
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

test("--debug prints the request line with its sensitive query values masked", async () => {
  const { ctx, io } = ctxWith(() => ({ status: 200, headers: {}, text: "", json: { data: [] } }));
  const lookup: Descriptor = { ...createDescriptor, method: "GET", bodyKind: "none", bodyProps: [], params: [{ name: "email", in: "query", type: "string", required: false }, { name: "page", in: "query", type: "string", required: false }] };
  await execute(lookup, { flags: { email: "a@b.co", page: "2" }, files: {} }, ctx, { output: { json: true, quiet: false, raw: false }, debug: true, form: false });
  const line = io.stderr.join("").split("\n").find((text) => text.startsWith("[debug] GET"));
  assert.match(line ?? "", /^\[debug\] GET https:\/\/example\.test\/rest\/adjustments\?email=\*\*\*&page=2 -> 200/);
});

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
  const parsed = JSON.parse(io.stdout.join(""));
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

  const parsed = JSON.parse(io.stdout.join(""));
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
  path: "/logs/requests",
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
  path: "/logs/requests/{request_id}",
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
  assert.match(req.url, /\/rest\/logs\/requests\?status_class=4xx$/);
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
  assert.equal(url.pathname, "/rest/logs/requests");
  assert.equal(url.searchParams.get("cursor"), "eyJ0cyI6IjIwMjYifQ");
  assert.equal(url.searchParams.get("limit"), "100");
  const parsed = JSON.parse(io.stdout.join(""));
  assert.deepEqual(parsed.data, []);
  assert.deepEqual(parsed.page, { cursor: null, has_next_page: false });
});

test("execute() keeps the envelope free of page when the response has none", async () => {
  const { ctx, io, seen } = ctxWith(() => ({ status: 200, headers: {}, text: "", json: { data: { request_id: "req_1", gateway_message: "OK", hint: "" } } }));

  await execute(logsGetDescriptor, { flags: { request_id: "req 1/x" }, files: {} }, ctx, JSON_OUT);

  assert.match(seen[0].url, /\/rest\/logs\/requests\/req%201%2Fx$/); // path param is URL-encoded
  const parsed = JSON.parse(io.stdout.join(""));
  assert.ok(!("page" in parsed));
  assert.deepEqual(Object.keys(parsed), ["data", "meta"]);
  assert.equal(parsed.data.gateway_message, "OK");
});

test("execute() keeps page when data is null", async () => {
  const { ctx, io } = ctxWith(() => ({ status: 200, headers: {}, text: "", json: { data: null, page: { cursor: "c2", has_next_page: true } } }));

  await execute(logsListDescriptor, { flags: {}, files: {} }, ctx, JSON_OUT);

  const parsed = JSON.parse(io.stdout.join(""));
  assert.equal(parsed.data, null);
  assert.deepEqual(parsed.page, { cursor: "c2", has_next_page: true });
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
      request: { method: "GET", url: "/rest/logs/requests", status: 403, api_req_id: "req-fixed-id" },
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

test("--beta sends X-Beta: true on the logs request, and its absence sends no header", async () => {
  const page = { data: [], page: { cursor: null, has_next_page: false } };
  const beta = ctxWith(() => ({ status: 200, headers: {}, text: "", json: page }), captureIO({}), { ...CONFIG, beta: true });
  await execute(logsListDescriptor, { flags: {}, files: {} }, beta.ctx, JSON_OUT);
  assert.equal(beta.seen[0].headers[HEADER.beta], "true");

  const plain = ctxWith(() => ({ status: 200, headers: {}, text: "", json: page }));
  await execute(logsListDescriptor, { flags: {}, files: {} }, plain.ctx, JSON_OUT);
  assert.equal(plain.seen[0].headers[HEADER.beta], undefined);
});

test("errorFromResponse falls back to error_code when code is absent, and to http.<status> when neither is a string", () => {
  assert.equal(errorFromResponse(404, { errors: [{ error_code: "NOT_FOUND", message: "Webhook not found" }] }, "r1").code, "NOT_FOUND");
  assert.equal(errorFromResponse(404, { error_code: "NOT_FOUND", message: "Webhook not found" }, "r1").code, "NOT_FOUND");
  assert.equal(errorFromResponse(404, { errors: [{ code: "WEBHOOK_NOT_FOUND", error_code: "OTHER", message: "m" }] }, "r1").code, "WEBHOOK_NOT_FOUND");
  assert.equal(errorFromResponse(404, { errors: [{ message: "Webhook not found" }] }, "r1").code, "http.404");
  assert.equal(errorFromResponse(500, { errors: [{ error_code: 42, message: "m" }] }, "r1").code, "http.500");
});

const nullableDescriptor: Descriptor = {
  ...createDescriptor,
  params: [],
  bodyProps: [
    { name: "note", in: "body", type: "string", required: false, nullable: true },
    { name: "amount", in: "body", type: "number", required: true },
  ],
};
const execOpts = (form: boolean) => ({ output: { json: true, quiet: false, raw: false }, debug: false, form });

test("execute() sends a JSON null body field as null", async () => {
  const { ctx, seen } = ctxWith(() => ({ status: 201, headers: {}, text: "", json: { data: {} } }));

  await execute(nullableDescriptor, { flags: {}, body: { amount: 5, note: null }, files: {} }, ctx, execOpts(false));

  assert.deepEqual(JSON.parse(String(seen[0].body)), { amount: 5, note: null });
});

test("execute() refuses to send null as a multipart form field", async () => {
  const { ctx, seen } = ctxWith(() => ({ status: 201, headers: {}, text: "", json: { data: {} } }));
  const multipart: Descriptor = { ...nullableDescriptor, supportsMultipart: true };

  await assert.rejects(
    () => execute(multipart, { flags: {}, body: { amount: 5, note: null }, files: {} }, ctx, execOpts(true)),
    (error: any) => {
      assert.equal(error.code, "usage.body");
      assert.match(error.message, /--form cannot send null for note/);
      assert.match(error.next, /omit --form/);
      return true;
    },
  );
  assert.equal(seen.length, 0);
});

test("a SCIM command calls the /scim base path and renders the unwrapped SCIM body", async () => {
  const { ctx, io, seen } = ctxWith(() => ({ status: 200, headers: {}, text: "", json: { totalResults: 1, Resources: [{ id: "u1" }] } }));
  const scimDescriptor: Descriptor = {
    ...createDescriptor,
    command: ["scim", "users", "list"],
    method: "GET",
    path: "/Users",
    api: "scim",
    bodyKind: "none",
    params: [],
    bodyProps: [],
  };

  await execute(scimDescriptor, { flags: {}, body: undefined, files: {} }, ctx, { output: { json: true, quiet: false, raw: false }, debug: false, form: false });

  assert.equal(seen[0].url, "https://example.test/scim/Users");
  const parsed = JSON.parse(io.stdout.join(""));
  assert.equal(parsed.data.Resources[0].id, "u1");
});

test("a webhook's signing key is never printed, from one webhook or a list, and a note says where to find it", async () => {
  for (const json of [{ data: { id: "w1", signing_key: "sk_secret" } }, { data: [{ id: "w1", signing_key: "sk_secret" }, { id: "w2" }] }]) {
    const { ctx, io } = ctxWith(() => ({ status: 200, headers: {}, text: "", json }));
    await execute(logsGetDescriptor, { flags: { request_id: "w1" }, files: {} }, ctx, JSON_OUT);
    const out = io.stdout.join("");
    assert.ok(!out.includes("sk_secret"), out);
    assert.match(out, /"w1"/);
    assert.match(io.stderr.join(""), /signing_key is not printed: reveal the signing key in Developer Center/);
  }
});

test("with --log-bodies the local log masks a webhook's signing_key too", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deel-log-"));
  process.env.DEEL_LOG_DIR = dir;
  setLoggingEnabled(true);
  setLogBodiesEnabled(true);
  try {
    const json = { data: { id: "w1", signing_key: "sk_secret" } };
    const ctx = createContext({ config: CONFIG, token: "tok_SECRET", io: captureIO({}), clock: () => 1000, rng: () => "req-fixed-id", logger: log, baseTransport: async () => ({ status: 200, headers: {}, text: "", json }) });
    await execute(logsGetDescriptor, { flags: { request_id: "w1" }, files: {} }, ctx, JSON_OUT);
    const content = readFileSync(join(dir, "deel.log"), "utf8");
    assert.ok(!content.includes("sk_secret"), content);
    assert.equal(JSON.parse(content.trim().split("\n").pop()!).response.data.signing_key, "***");
  } finally {
    setLogBodiesEnabled(false);
    delete process.env.DEEL_LOG_DIR;
  }
});

test("withholdSecrets reads only its own keys, so a field named like an Object method is kept", () => {
  const data = JSON.parse('{"id":"a","constructor":"c","toString":"t","signing_key":"k"}');
  const { kept, withheld } = withholdSecrets(data);
  assert.deepEqual(kept, { id: "a", constructor: "c", toString: "t" });
  assert.deepEqual(withheld, ["signing_key"]);
});

test("a withheld field is withheld in every spelling of its name, and reported under the name the constant gives", () => {
  const data = [{ id: "a", signingKey: "1" }, { id: "b", Signing_Key: "2" }, { id: "c", "signing-key": "3", SIGNING_KEY: "4" }, { id: "d", signing_key: "5", signingkeys: "keep" }];
  const { kept, withheld } = withholdSecrets(data);
  assert.deepEqual(kept, [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d", signingkeys: "keep" }]);
  assert.deepEqual(withheld, ["signing_key"]);
});

const simulateDescriptor: Descriptor = {
  ...createDescriptor,
  command: ["webhooks", "test"],
  path: "/webhooks/{webhook_id}/simulate",
  params: [{ name: "webhook_id", in: "path", type: "string", required: true }],
  bodyProps: [{ name: "event_type", in: "body", type: "string", required: true }],
};
const simulateCall = { flags: { webhook_id: "wh_1" }, body: { event_type: "contract.created" }, files: {} };
const quiet = { output: { json: true, quiet: false, raw: false }, debug: false, form: false };

test("a send-once call goes out once, with no derived Idempotency-Key, so a repeat acts again", async () => {
  const failing = ctxWith(() => ({ status: 503, headers: {}, text: "", json: { error: { message: "busy" } } }));
  await assert.rejects(execute(simulateDescriptor, simulateCall, failing.ctx, quiet));
  assert.equal(failing.seen.length, 1);
  assert.equal(failing.seen[0].headers["idempotency-key"], undefined);
  // An explicit key is sent, and still no retry: the call acts again each time.
  const keyed = ctxWith(() => ({ status: 503, headers: {}, text: "", json: { error: { message: "busy" } } }));
  await assert.rejects(execute(simulateDescriptor, { ...simulateCall, idempotencyKey: "k-1" }, keyed.ctx, quiet));
  assert.equal(keyed.seen.length, 1);
  assert.equal(keyed.seen[0].headers["idempotency-key"], "k-1");
});

test("a 2xx whose response reports is_success: false prints the response, then fails", async () => {
  const { ctx, io } = ctxWith(() => ({ status: 200, headers: {}, text: "", json: { data: { is_success: false, delivery: { response_status_code: 500 } } } }));
  await assert.rejects(execute(simulateDescriptor, simulateCall, ctx, quiet), (err: any) => err.code === "api.unsuccessful" && /is_success: false/.test(err.message) && err.requestId === "req-fixed-id");
  assert.equal(JSON.parse(io.stdout.join("")).data.delivery.response_status_code, 500);
  const ok = ctxWith(() => ({ status: 200, headers: {}, text: "", json: { data: { is_success: true } } }));
  await execute(simulateDescriptor, simulateCall, ok.ctx, quiet);
  const list = ctxWith(() => ({ status: 200, headers: {}, text: "", json: { data: [{ is_success: false }] } }));
  await execute(simulateDescriptor, simulateCall, list.ctx, quiet);
  // Only the routes that report an outcome fail on it; another endpoint's is_success is just data.
  const other = ctxWith(() => ({ status: 200, headers: {}, text: "", json: { data: { is_success: false } } }));
  await execute(createDescriptor, { flags: { contract_id: "AC1" }, body: { amount: 1 }, files: {} }, other.ctx, quiet);
});

test("withholdSecrets leaves a response without secrets untouched", () => {
  const data = [{ id: "a" }, "text", null];
  const { kept, withheld } = withholdSecrets(data);
  assert.deepEqual(kept, data);
  assert.deepEqual(withheld, []);
});

test("errorFromResponse reads the message from a nested error list and from responseMessage", () => {
  const nested = errorFromResponse(500, { errors: { errors: [{ message: "SCIM job profiles could not be resolved" }] } }, "req-1");
  assert.equal(nested.message, "SCIM job profiles could not be resolved");
  const wrapped = errorFromResponse(400, { statusCode: 400, responseMessage: { message: "Missing a user header" } }, "req-2");
  assert.deepEqual([wrapped.code, wrapped.message], ["http.400", "Missing a user header"]);
});
