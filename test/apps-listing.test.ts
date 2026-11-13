import { test } from "node:test";
import assert from "node:assert/strict";
import { execute } from "../src/core/executor.ts";
import { createContext } from "../src/core/context.ts";
import { captureIO } from "../src/core/io.ts";
import { manifest } from "../src/manifest.generated.ts";
import { run } from "../src/cli.ts";
import { printContract } from "../src/help.ts";
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

test("oauth2-apps listing get puts the app id in the path and prints the listing with its nullable fields", async () => {
  const listing = { app_id: APP_ID, status: "published", latest_revision: { status: "rejected", review_notes: "Add a demo video." }, logo_url: null };
  const { ctx, seen, out } = ctxWith(() => ({ status: 200, headers: {}, text: "", json: { data: listing } }));
  await execute(descriptor(["oauth2-apps", "listing", "get"]), { flags: { app_id: APP_ID }, files: {} }, ctx, { output: OUTPUT, debug: false, form: false });
  assert.equal(seen[0].method, "GET");
  assert.equal(new URL(seen[0].url).pathname, `/rest/oauth2-apps/${APP_ID}/listing`);
  assert.deepEqual(out().data, listing);
});

test("app-store categories lists the categories", async () => {
  const { ctx, seen, out } = ctxWith(() => ({ status: 200, headers: {}, text: "", json: { data: [{ id: 182, name: "Collaboration" }] } }));
  await execute(descriptor(["app-store", "categories"]), { flags: {}, files: {} }, ctx, { output: OUTPUT, debug: false, form: false });
  assert.equal(new URL(seen[0].url).pathname, "/rest/app-store/categories");
  assert.equal(out().data[0].id, 182);
});

test("oauth2-apps listing get --help --json marks the nullable response fields", async () => {
  const { code, out } = await capture(["oauth2-apps", "listing", "get", "--help", "--json"]);
  assert.equal(code, 0);
  const fields: { name: string; nullable?: boolean }[] = JSON.parse(out).response.fields;
  assert.equal(fields.find((f) => f.name === "latest_revision")?.nullable, true);
  assert.equal(fields.find((f) => f.name === "logo_url")?.nullable, true);
  assert.equal(fields.find((f) => f.name === "app_id")?.nullable, undefined);
});
