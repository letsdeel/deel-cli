import { test } from "node:test";
import assert from "node:assert/strict";
import { execute } from "../src/core/executor.ts";
import { createContext } from "../src/core/context.ts";
import { captureIO } from "../src/core/io.ts";
import { manifest } from "../src/manifest.generated.ts";
import type { HttpRequest, HttpResponse } from "../src/core/http.ts";
import type { CliError } from "../src/core/errors.ts";

const FILE_ID = "4c1b7a52-3d18-4f69-8e0a-9b6f2d57c314";
const OUTPUT = { json: true, quiet: false, raw: false };

function descriptor(command: string[]) {
  const found = manifest.descriptors.find((d) => d.command.join(" ") === command.join(" "));
  assert.ok(found, `descriptor ${command.join(" ")} exists`);
  return found;
}

function ctxWith(handler: (req: HttpRequest) => HttpResponse) {
  const io = captureIO({});
  const seen: HttpRequest[] = [];
  const ctx = createContext({
    config: { env: "demo", baseUrl: "https://example.test/rest" },
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
  return { ctx, seen, out: () => JSON.parse(io.stdout.join("")) };
}

const RUN = { output: OUTPUT, debug: false, form: false };

test("files status sends the one-time secret as the x-one-time-secret header, not in the URL", async () => {
  const { ctx, seen, out } = ctxWith(() => ({ status: 200, headers: {}, text: "", json: { data: { file_id: FILE_ID, status: "ready" } } }));
  await execute(descriptor(["files", "status"]), { flags: { file_id: FILE_ID, one_time_secret: "secret-value" }, files: {} }, ctx, RUN);
  assert.equal(seen[0].method, "GET");
  assert.equal(new URL(seen[0].url).pathname, `/rest/files/${FILE_ID}/status`);
  assert.equal(new URL(seen[0].url).search, "");
  assert.equal(seen[0].headers["x-one-time-secret"], "secret-value");
  assert.equal(out().data.status, "ready");
});

test("files status and complete refuse to run without the one-time secret", async () => {
  for (const action of ["status", "complete"]) {
    const { ctx, seen } = ctxWith(() => ({ status: 200, headers: {}, text: "", json: {} }));
    await assert.rejects(
      execute(descriptor(["files", action]), { flags: { file_id: FILE_ID }, body: { upload_id: "u", parts: [] }, files: {} }, ctx, RUN),
      /Missing required --one_time_secret/,
    );
    assert.equal(seen.length, 0);
  }
});

test("files complete wraps the parts under data and sends the secret header", async () => {
  const { ctx, seen } = ctxWith(() => ({ status: 204, headers: {}, text: "", json: null }));
  const body = { upload_id: "upload-1", parts: [{ number: 1, etag: "abc" }] };
  await execute(descriptor(["files", "complete"]), { flags: { file_id: FILE_ID, one_time_secret: "secret-value" }, body, files: {} }, ctx, RUN);
  assert.equal(seen[0].method, "POST");
  assert.equal(new URL(seen[0].url).pathname, `/rest/files/${FILE_ID}/complete`);
  assert.equal(seen[0].headers["x-one-time-secret"], "secret-value");
  assert.deepEqual(JSON.parse(String(seen[0].body)), { data: body });
});

test("files create sends the optional x-upload-method header only when asked", async () => {
  const handler = () => ({ status: 201, headers: {}, text: "", json: { data: { file_id: FILE_ID, one_time_secret: "s", upload_parts: [] } } });
  const plain = ctxWith(handler);
  await execute(descriptor(["files", "create"]), { flags: {}, body: { filename: "logo.png", size: 179 }, files: {} }, plain.ctx, RUN);
  assert.equal(plain.seen[0].headers["x-upload-method"], undefined);
  assert.deepEqual(JSON.parse(String(plain.seen[0].body)), { data: { filename: "logo.png", size: 179 } });

  const multipart = ctxWith(handler);
  await execute(descriptor(["files", "create"]), { flags: { upload_method: "multipart" }, body: { filename: "big.bin", size: 1 }, files: {} }, multipart.ctx, RUN);
  assert.equal(multipart.seen[0].headers["x-upload-method"], "multipart");
});

test("a descriptor's header flags never reach the request path or query", () => {
  const d = descriptor(["files", "status"]);
  assert.deepEqual(d.params.map((p) => [p.name, p.in]), [["file_id", "path"], ["one_time_secret", "header"]]);
});

test("files create sends a new idempotency key on each run, whatever the --upload_method", async () => {
  const { ctx, seen } = ctxWith(() => ({ status: 201, headers: {}, text: "", json: { data: { file_id: FILE_ID } } }));
  const body = { filename: "logo.png", size: 2048 };
  await execute(descriptor(["files", "create"]), { flags: {}, body, files: {} }, ctx, RUN);
  await execute(descriptor(["files", "create"]), { flags: { upload_method: "multipart" }, body, files: {} }, ctx, RUN);
  await execute(descriptor(["files", "create"]), { flags: {}, body, files: {} }, ctx, RUN);

  const keys = seen.map((request) => request.headers["idempotency-key"]);
  assert.equal(new Set(keys).size, 3);
});

test("files status refuses an empty --one_time_secret as a missing one", async () => {
  const { ctx, seen } = ctxWith(() => ({ status: 200, headers: {}, text: "", json: { data: {} } }));
  await assert.rejects(
    () => execute(descriptor(["files", "status"]), { flags: { file_id: FILE_ID, one_time_secret: "" }, files: {} }, ctx, RUN),
    /Missing required --one_time_secret/,
  );
  assert.equal(seen.length, 0);
});

function withSecretEnv(value: string | undefined, run: () => Promise<void>) {
  const saved = process.env.DEEL_ONE_TIME_SECRET;
  if (value === undefined) delete process.env.DEEL_ONE_TIME_SECRET;
  else process.env.DEEL_ONE_TIME_SECRET = value;
  return run().finally(() => {
    if (saved === undefined) delete process.env.DEEL_ONE_TIME_SECRET;
    else process.env.DEEL_ONE_TIME_SECRET = saved;
  });
}

test("files status reads the one-time secret from DEEL_ONE_TIME_SECRET when the flag is not given", async () => {
  await withSecretEnv("secret-from-env", async () => {
    const { ctx, seen } = ctxWith(() => ({ status: 200, headers: {}, text: "", json: { data: { status: "ready" } } }));
    await execute(descriptor(["files", "status"]), { flags: { file_id: FILE_ID }, files: {} }, ctx, RUN);
    assert.equal(seen[0].headers["x-one-time-secret"], "secret-from-env");
  });
});

test("the --one_time_secret flag wins over DEEL_ONE_TIME_SECRET", async () => {
  await withSecretEnv("secret-from-env", async () => {
    const { ctx, seen } = ctxWith(() => ({ status: 200, headers: {}, text: "", json: { data: { status: "ready" } } }));
    await execute(descriptor(["files", "status"]), { flags: { file_id: FILE_ID, one_time_secret: "secret-from-flag" }, files: {} }, ctx, RUN);
    assert.equal(seen[0].headers["x-one-time-secret"], "secret-from-flag");
  });
});

test("a blank DEEL_ONE_TIME_SECRET counts as missing and the error names the variable", async () => {
  await withSecretEnv("  ", async () => {
    const { ctx, seen } = ctxWith(() => ({ status: 200, headers: {}, text: "", json: {} }));
    await assert.rejects(
      execute(descriptor(["files", "status"]), { flags: { file_id: FILE_ID }, files: {} }, ctx, RUN),
      (error: CliError) => /Missing required --one_time_secret/.test(error.message) && /DEEL_ONE_TIME_SECRET/.test(error.next ?? ""),
    );
    assert.equal(seen.length, 0);
  });
});
