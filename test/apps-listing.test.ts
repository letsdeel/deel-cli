import { test } from "node:test";
import assert from "node:assert/strict";
import { execute } from "../src/core/executor.ts";
import { createContext } from "../src/core/context.ts";
import { captureIO } from "../src/core/io.ts";
import { loadGeneratedDescriptors } from "../src/public-api/commands.ts";
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

test("oauth2-apps listing get puts the app id in the path and prints the listing with its nullable fields", async () => {
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
  assert.deepEqual(descriptor("GET", "/oauth2-apps/{app_id}/listing").command, ["oauth2-apps", "listing", "get"]);
  assert.deepEqual(descriptor("GET", "/app-store/categories").command, ["app-store", "categories", "list"]);
});
