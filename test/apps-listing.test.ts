import { test } from "node:test";
import assert from "node:assert/strict";
import { execute } from "../src/core/executor.ts";
import { createContext } from "../src/core/context.ts";
import { captureIO } from "../src/core/io.ts";
import { loadGeneratedDescriptors } from "../src/public-api/commands.ts";
import { run } from "../src/cli.ts";
import type { HttpRequest, HttpResponse } from "../src/core/http.ts";

const APP_ID = "00000000-0000-0000-0000-000000000000";
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
  return { ctx, io, seen, out: () => JSON.parse(io.stdout.join("")) };
}

test("oauth2-apps listings get puts the app id in the path and prints the listing with its nullable fields", async () => {
  const listing = { app_id: APP_ID, status: "published", latest_revision: { status: "rejected", review_notes: "Add a demo video." }, logo_url: null };
  const { ctx, seen, out } = ctxWith(() => ({ status: 200, headers: {}, text: "", json: { data: listing } }));
  await execute(descriptor("GET", "/oauth2-apps/{app_id}/listing"), { flags: { app_id: APP_ID }, files: {} }, ctx, { output: OUTPUT, debug: false, form: false });
  assert.equal(seen[0].method, "GET");
  assert.equal(new URL(seen[0].url).pathname, `/rest/oauth2-apps/${APP_ID}/listing`);
  assert.deepEqual(out().data, listing);
});

test("app-store categories list prints the categories", async () => {
  const { ctx, seen, out } = ctxWith(() => ({ status: 200, headers: {}, text: "", json: { data: [{ id: 182, name: "Collaboration" }] } }));
  await execute(descriptor("GET", "/app-store/categories"), { flags: {}, files: {} }, ctx, { output: OUTPUT, debug: false, form: false });
  assert.equal(new URL(seen[0].url).pathname, "/rest/app-store/categories");
  assert.equal(out().data[0].id, 182);
});

test("the listing commands are named by the command map", () => {
  assert.deepEqual(descriptor("GET", "/oauth2-apps/{app_id}/listing").command, ["oauth2-apps", "listings", "get"]);
  assert.deepEqual(descriptor("POST", "/oauth2-apps/{app_id}/listing").command, ["oauth2-apps", "listings", "create"]);
  assert.deepEqual(descriptor("PATCH", "/oauth2-apps/{app_id}/listing").command, ["oauth2-apps", "listings", "update"]);
  assert.deepEqual(descriptor("POST", "/oauth2-apps/{app_id}/listing/submit").command, ["oauth2-apps", "listings", "submit"]);
  assert.deepEqual(descriptor("GET", "/app-store/categories").command, ["app-store", "categories", "list"]);
});

const LISTING = "/oauth2-apps/{app_id}/listing";

test("oauth2-apps listings create wraps the body under data and sends POST to the listing path", async () => {
  const { ctx, seen, out } = ctxWith(() => ({ status: 201, headers: {}, text: "", json: { data: { app_id: APP_ID, status: "unpublished", latest_revision: null } } }));
  await execute(descriptor("POST", LISTING), { flags: { app_id: APP_ID }, body: { name: "Payroll sync" }, files: {} }, ctx, { output: OUTPUT, debug: false, form: false });
  assert.equal(seen[0].method, "POST");
  assert.equal(new URL(seen[0].url).pathname, `/rest/oauth2-apps/${APP_ID}/listing`);
  assert.deepEqual(JSON.parse(String(seen[0].body)), { data: { name: "Payroll sync" } });
  assert.ok(seen[0].headers["idempotency-key"]);
  assert.equal(out().data.latest_revision, null);
});

test("oauth2-apps listings update sends the listing fields and the logo handle under data", async () => {
  const body = {
    short_description: "Sync timesheets",
    categories: [182],
    highlights: [{ title: "Fast", text: "Quick sync" }],
    logo: { file_id: "4c1b7a52-3d18-4f69-8e0a-9b6f2d57c314", one_time_secret: "secret-value" },
  };
  const { ctx, seen } = ctxWith(() => ({ status: 200, headers: {}, text: "", json: { data: { app_id: APP_ID, latest_revision: { status: "draft", review_notes: null } } } }));
  await execute(descriptor("PATCH", LISTING), { flags: { app_id: APP_ID }, body, files: {} }, ctx, { output: OUTPUT, debug: false, form: false });
  assert.equal(seen[0].method, "PATCH");
  assert.equal(new URL(seen[0].url).pathname, `/rest/oauth2-apps/${APP_ID}/listing`);
  assert.deepEqual(JSON.parse(String(seen[0].body)), { data: body });
});

test("oauth2-apps listings submit sends a POST with no body to the submit path", async () => {
  const { ctx, seen } = ctxWith(() => ({ status: 200, headers: {}, text: "", json: { data: { app_id: APP_ID, latest_revision: { status: "in_review", review_notes: null } } } }));
  await execute(descriptor("POST", `${LISTING}/submit`), { flags: { app_id: APP_ID }, files: {} }, ctx, { output: OUTPUT, debug: false, form: false });
  assert.equal(seen[0].method, "POST");
  assert.equal(new URL(seen[0].url).pathname, `/rest/oauth2-apps/${APP_ID}/listing/submit`);
  assert.equal(seen[0].body, null);
});

test("oauth2-apps listings update describes the store page fields and requires both parts of the logo handle", () => {
  const props = descriptor("PATCH", LISTING).bodyProps;
  assert.ok(props.some((p) => p.name === "test_account_details"));
  assert.ok(!props.some((p) => p.name === "authentication"));
  const logo = props.find((p) => p.name === "logo");
  assert.deepEqual(logo?.properties?.map((p) => [p.name, p.required]), [["file_id", true], ["one_time_secret", true]]);
});

test("oauth2-apps listings update --generate-input prints a list of objects for the list fields and an object for the logo handle", async () => {
  const out: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: any) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
  let code: number;
  try {
    code = await run(["oauth2-apps", "listings", "update", "--generate-input"]);
  } finally {
    process.stdout.write = original;
  }
  assert.equal(code, 0);
  const skeleton = JSON.parse(out.join(""));
  assert.ok(Array.isArray(skeleton.highlights) && skeleton.highlights.length === 1);
  assert.ok(Array.isArray(skeleton.support_resources) && skeleton.support_resources.length === 1);
  assert.deepEqual(skeleton.logo, { file_id: "", one_time_secret: "" });
});
