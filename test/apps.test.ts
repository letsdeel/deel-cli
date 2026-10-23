import { test } from "node:test";
import assert from "node:assert/strict";
import { execute } from "../src/core/executor.ts";
import { createContext } from "../src/core/context.ts";
import { captureIO } from "../src/core/io.ts";
import { manifest } from "../src/manifest.generated.ts";
import { run } from "../src/cli.ts";
import type { HttpRequest, HttpResponse } from "../src/core/http.ts";

const APP_ID = "00000000-0000-0000-0000-000000000000";
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
  return { ctx, io, seen, out: () => JSON.parse(io.stdout.join("")) };
}

async function capture(argv: string[]): Promise<{ code: number; out: string }> {
  const out: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: any) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
  try {
    const code = await run(argv);
    return { code, out: out.join("") };
  } finally {
    process.stdout.write = original;
  }
}

test("apps list sends the paging and api_access filters as query params", async () => {
  const { ctx, seen } = ctxWith(() => ({ status: 200, headers: {}, text: "", json: { data: [], cursor: null } }));
  await execute(descriptor(["apps", "list"]), { flags: { limit: "10", cursor: "abc", api_access: "enabled" }, files: {} }, ctx, { output: OUTPUT, debug: false, form: false });
  const req = seen[0];
  assert.equal(req.method, "GET");
  assert.equal(new URL(req.url).pathname, "/rest/apps");
  assert.equal(new URL(req.url).searchParams.get("limit"), "10");
  assert.equal(new URL(req.url).searchParams.get("cursor"), "abc");
  assert.equal(new URL(req.url).searchParams.get("api_access"), "enabled");
  assert.equal(req.headers["idempotency-key"], undefined);
});

test("apps list prints the apps and surfaces the next-page cursor in meta", async () => {
  const { ctx, out } = ctxWith(() => ({ status: 200, headers: {}, text: "", json: { data: [{ id: APP_ID, name: "Sync" }], cursor: "next-1" } }));
  await execute(descriptor(["apps", "list"]), { flags: {}, files: {} }, ctx, { output: OUTPUT, debug: false, form: false });
  const parsed = out();
  assert.equal(parsed.data[0].id, APP_ID);
  assert.equal(parsed.meta.cursor, "next-1");
});

test("apps list leaves cursor out of meta on the last page", async () => {
  const { ctx, out } = ctxWith(() => ({ status: 200, headers: {}, text: "", json: { data: [], cursor: null } }));
  await execute(descriptor(["apps", "list"]), { flags: {}, files: {} }, ctx, { output: OUTPUT, debug: false, form: false });
  assert.ok(!("cursor" in out().meta));
});

test("apps get puts the app id in the path and prints the unwrapped app", async () => {
  const { ctx, seen, out } = ctxWith(() => ({ status: 200, headers: {}, text: "", json: { data: { id: APP_ID, api_access: "enabled" } } }));
  await execute(descriptor(["apps", "get"]), { flags: { app_id: APP_ID }, files: {} }, ctx, { output: OUTPUT, debug: false, form: false });
  assert.equal(new URL(seen[0].url).pathname, `/rest/apps/${APP_ID}`);
  assert.equal(out().data.api_access, "enabled");
});

test("apps get maps a 404 to a not-found error", async () => {
  const { ctx } = ctxWith(() => ({ status: 404, headers: {}, text: "", json: { errors: [{ code: "NOT_FOUND", message: "App not found" }] } }));
  await assert.rejects(() => execute(descriptor(["apps", "get"]), { flags: { app_id: APP_ID }, files: {} }, ctx, { output: OUTPUT, debug: false, form: false }), /App not found/);
});

test("apps list --help --json describes the filters and the app fields", async () => {
  const { code, out } = await capture(["apps", "list", "--help", "--json"]);
  assert.equal(code, 0);
  const contract = JSON.stringify(JSON.parse(out));
  for (const name of ["api_access", "limit", "cursor", "redirect_uris", "client_type"]) assert.match(contract, new RegExp(name));
});

test("apps get --help lists the --app_id flag", async () => {
  const { code, out } = await capture(["apps", "get", "--help"]);
  assert.equal(code, 0);
  assert.match(out, /app_id/);
});
