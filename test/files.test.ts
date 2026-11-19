import { test } from "node:test";
import assert from "node:assert/strict";
import { execute } from "../src/core/executor.ts";
import { createContext } from "../src/core/context.ts";
import { captureIO } from "../src/core/io.ts";
import { redactHeaders } from "../src/core/auth.ts";
import { loadGeneratedDescriptors } from "../src/public-api/commands.ts";
import { run } from "../src/cli.ts";
import { CliError } from "../src/core/errors.ts";
import type { HttpRequest, HttpResponse } from "../src/core/http.ts";

const FILE_ID = "e8fe2571-d869-4e4a-a8a6-9e5457354c43";
const SECRET = "s3cr3t-value-for-tests";
const OUTPUT = { json: true, quiet: false, raw: false };
const descriptors = await loadGeneratedDescriptors();

function descriptor(method: string, path: string) {
  const found = descriptors.find((d) => d.method === method && d.path === path);
  assert.ok(found, `descriptor ${method} ${path} exists`);
  return found;
}

function ctxWith(handler: (req: HttpRequest) => HttpResponse) {
  const io = captureIO({});
  const seen: HttpRequest[] = [];
  const ctx = createContext({
    config: { env: "demo", baseUrl: "https://example.test/rest", issuer: "https://example.test", clientId: "cli", oauthBaseUrlOk: true },
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
  return { ctx, seen };
}

const ok = (): HttpResponse => ({ status: 200, headers: {}, text: "", json: { data: { file_id: FILE_ID, status: "ready" } } });
const headerOf = (req: HttpRequest, name: string) => Object.entries(req.headers).find(([key]) => key.toLowerCase() === name)?.[1];

test("the file commands keep their names and carry the header the endpoint declares", () => {
  assert.deepEqual(descriptor("POST", "/files").command, ["files", "create"]);
  assert.deepEqual(descriptor("GET", "/files/{fileid}/status").command, ["files", "status", "get"]);
  assert.deepEqual(descriptor("POST", "/files/{fileid}/complete").command, ["files", "update"]);
  const secret = descriptor("GET", "/files/{fileid}/status").params.find((p) => p.in === "header");
  assert.deepEqual([secret?.name, secret?.flag, secret?.required], ["x-one-time-secret", "one-time-secret", true]);
  assert.equal(descriptor("POST", "/files").params.find((p) => p.in === "header")?.required, false);
});

test("files status get sends the one-time secret as the x-one-time-secret header", async () => {
  const { ctx, seen } = ctxWith(ok);
  await execute(descriptor("GET", "/files/{fileid}/status"), { flags: { fileid: FILE_ID, "x-one-time-secret": SECRET }, files: {} }, ctx, { output: OUTPUT, debug: false, form: false });
  assert.equal(new URL(seen[0].url).pathname, `/rest/files/${FILE_ID}/status`);
  assert.equal(headerOf(seen[0], "x-one-time-secret"), SECRET);
});

test("a required header that is missing is refused before any request", async () => {
  const { ctx, seen } = ctxWith(ok);
  await assert.rejects(
    () => execute(descriptor("GET", "/files/{fileid}/status"), { flags: { fileid: FILE_ID }, files: {} }, ctx, { output: OUTPUT, debug: false, form: false }),
    (error: unknown) => error instanceof CliError && error.code === "usage.header" && /--one-time-secret/.test(error.message) && /DEEL_ONE_TIME_SECRET/.test(error.next ?? ""),
  );
  assert.equal(seen.length, 0);
});

test("an optional header is sent only when given", async () => {
  const create = descriptor("POST", "/files");
  const a = ctxWith(ok);
  await execute(create, { flags: {}, body: { filename: "logo.png" }, files: {} }, a.ctx, { output: OUTPUT, debug: false, form: false });
  assert.equal(headerOf(a.seen[0], "x-upload-method"), undefined);
  const b = ctxWith(ok);
  await execute(create, { flags: { "x-upload-method": "multipart" }, body: { filename: "logo.png" }, files: {} }, b.ctx, { output: OUTPUT, debug: false, form: false });
  assert.equal(headerOf(b.seen[0], "x-upload-method"), "multipart");
});

// The flag and the environment, through the whole command line: the flag is optional for citty so the environment can fill it.
async function runStatus(argv: string[], env: Record<string, string | undefined>, command: string[] = ["files", "status", "get", FILE_ID]) {
  const sent: Record<string, string>[] = [];
  const realFetch = globalThis.fetch;
  const saved: Record<string, string | undefined> = {};
  const vars = { DEEL_TOKEN: "a-token", DEEL_LOG: "off", DEEL_CLI_BASE_URL: "https://example.test/rest", DEEL_ONE_TIME_SECRET: undefined, DEEL_UPLOAD_METHOD: undefined, ...env };
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    sent.push(Object.fromEntries(new Headers(init?.headers).entries()));
    return new Response(JSON.stringify({ data: { file_id: FILE_ID, status: "ready" } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const original = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    const result = await run([...command, ...argv]).then(() => undefined, (error: unknown) => error);
    return { sent, error: result };
  } finally {
    process.stdout.write = original;
    globalThis.fetch = realFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("the secret is read from DEEL_ONE_TIME_SECRET when the flag is not given, and the flag wins when both are", async () => {
  const fromEnv = await runStatus([], { DEEL_ONE_TIME_SECRET: "from-env" });
  assert.equal(fromEnv.error, undefined);
  assert.equal(fromEnv.sent[0]["x-one-time-secret"], "from-env");
  const both = await runStatus(["--one-time-secret", "from-flag"], { DEEL_ONE_TIME_SECRET: "from-env" });
  assert.equal(both.sent[0]["x-one-time-secret"], "from-flag");
});

test("with neither the flag nor the environment variable the command stops before any request", async () => {
  const none = await runStatus([], {});
  assert.ok(none.error instanceof CliError && none.error.code === "usage.header");
  assert.equal(none.sent.length, 0);
});

test("an environment value is checked against the header's allowed values before any request", async () => {
  const create = ["files", "create"];
  const body = ["--input", '{"filename":"a.png"}'];
  const bad = await runStatus(body, { DEEL_UPLOAD_METHOD: "Multipart" }, create);
  assert.ok(bad.error instanceof CliError && bad.error.code === "usage.header" && /DEEL_UPLOAD_METHOD/.test(bad.error.message));
  assert.equal(bad.sent.length, 0);
  const good = await runStatus(body, { DEEL_UPLOAD_METHOD: "multipart" }, create);
  assert.equal(good.error, undefined);
  assert.equal(good.sent[0]["x-upload-method"], "multipart");
});

test("an array-typed header reads its environment variable too, comma-separated", async () => {
  // No endpoint declares an array header yet, so give the status command one for this test.
  const status = (await loadGeneratedDescriptors()).find((d) => d.method === "GET" && d.path === "/files/{fileid}/status")!;
  const extra = { name: "x-list", in: "header", type: "array", required: false, flag: "list" } as (typeof status.params)[number];
  status.params.push(extra);
  try {
    const out = await runStatus(["--one-time-secret", "s"], { DEEL_LIST: "a, b" });
    assert.equal(out.error, undefined);
    assert.equal(out.sent[0]["x-list"], "a,b");
  } finally {
    status.params.splice(status.params.indexOf(extra), 1);
  }
});

test("a header given several values is sent comma-joined", () => {
  const params = [{ name: "x-list", in: "header", type: "array", required: true, flag: "list" }];
  const { ctx, seen } = ctxWith(ok);
  return execute({ ...descriptor("GET", "/files/{fileid}/status"), params: [descriptor("GET", "/files/{fileid}/status").params[0], ...params] } as never, { flags: { fileid: FILE_ID, "x-list": ["a", "b"] }, files: {} }, ctx, { output: OUTPUT, debug: false, form: false }).then(() => assert.equal(headerOf(seen[0], "x-list"), "a,b"));
});

test("the secret is masked in the request headers the local log records", () => {
  assert.equal(redactHeaders({ "x-one-time-secret": SECRET, accept: "application/json" })["x-one-time-secret"], "***");
});

test("--help says the secret can come from the environment", async () => {
  const out: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
  try {
    assert.equal(await run(["files", "status", "get", FILE_ID, "--help"]), 0);
  } finally {
    process.stdout.write = original;
  }
  assert.match(out.join(""), /--one-time-secret=<string>\s+\(required\)\s+One-time secret from the register response\. Or set DEEL_ONE_TIME_SECRET; the flag wins\./);
});
