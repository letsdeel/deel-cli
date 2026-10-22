import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext } from "../src/core/context.ts";
import { captureIO } from "../src/core/io.ts";
import { log, setLoggingEnabled, setLogBodiesEnabled } from "../src/core/logging.ts";
import type { Logger } from "../src/core/logging.ts";
import type { HttpRequest, HttpResponse } from "../src/core/http.ts";
import { RESERVED_COMMANDS, SENSITIVE_LOG_KEYS } from "../src/core/constants.ts";
import { DASH_ID_HINT, SIGNING_KEY_HINT, buildListQuery, resolveWebhookId, stripSigningKey } from "../src/core/webhooks.ts";
import { listFlagsFrom, requireId, runEventTypes, runGet, runList } from "../src/commands/webhooks.ts";
import { staticCommands } from "../src/commands/index.ts";
import { run } from "../src/cli.ts";
import { tempDir } from "./stubs.ts";

const CONFIG = { env: "demo", baseUrl: "https://example.test/rest" };
const JSON_OUTPUT = { json: true, quiet: false, raw: false };
const SIGNING_KEY = "whsec_do_not_print";

const ok = (json: unknown): HttpResponse => ({ status: 200, headers: {}, text: "", json });

function webhook(id: string) {
  return {
    id,
    name: `hook ${id}`,
    description: null,
    status: "enabled",
    url: `https://hooks.example.test/${id}`,
    events: ["contract.created"],
    api_version: "v2",
    signing_key: SIGNING_KEY,
    hidden: false,
    internal: false,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function ctxWith(handler: (req: HttpRequest) => HttpResponse, logger: Logger = () => {}) {
  const seen: HttpRequest[] = [];
  const io = captureIO({});
  const ctx = createContext({
    config: CONFIG,
    token: "tok_SECRET",
    io,
    clock: () => 1000,
    rng: () => "req-fixed-id",
    logger,
    baseTransport: async (req) => {
      seen.push(req);
      return handler(req);
    },
  });
  return { ctx, io, seen };
}

test("stripSigningKey removes signing_key from every webhook of a list payload without mutating it", () => {
  const payload = [webhook("wh_1"), webhook("wh_2")];
  const { data, stripped } = stripSigningKey(payload);
  assert.equal(stripped, true);
  const { signing_key: _first, ...first } = webhook("wh_1");
  const { signing_key: _second, ...second } = webhook("wh_2");
  assert.deepEqual(data, [first, second]);
  assert.equal(payload[0].signing_key, SIGNING_KEY);
});

test("stripSigningKey removes signing_key from a single (get) webhook payload", () => {
  const payload = webhook("wh_1");
  const { data, stripped } = stripSigningKey(payload);
  assert.equal(stripped, true);
  assert.equal(Object.hasOwn(data as object, "signing_key"), false);
  assert.equal((data as { id: string }).id, "wh_1");
  assert.equal(payload.signing_key, SIGNING_KEY);
});

test("stripSigningKey leaves payloads without a signing_key untouched", () => {
  assert.deepEqual(stripSigningKey([{ id: "a" }]), { data: [{ id: "a" }], stripped: false });
  assert.deepEqual(stripSigningKey(null), { data: null, stripped: false });
});

test("buildListQuery sends no paging params without --limit/--cursor/--all", () => {
  assert.equal(buildListQuery({}).toString(), "");
  assert.equal(buildListQuery({ all: true }).toString(), "");
});

test("buildListQuery maps --limit, --cursor, --status, --search and --order", () => {
  assert.equal(buildListQuery({ limit: "2" }).toString(), "limit=2");
  assert.equal(buildListQuery({ cursor: "X" }).toString(), "cursor=X");
  const filtered = buildListQuery({ status: "enabled", search: "payroll hook", order: "created_at:desc" });
  assert.equal(filtered.get("status"), "enabled");
  assert.equal(filtered.get("search"), "payroll hook");
  assert.equal(filtered.get("_order"), "created_at:desc");
  assert.equal(filtered.has("limit"), false);
  assert.equal(filtered.has("cursor"), false);
});

test("buildListQuery rejects --order together with --limit, --cursor or --all", () => {
  for (const flags of [{ limit: "2" }, { cursor: "X" }, { all: true }]) {
    assert.throws(() => buildListQuery({ order: "name", ...flags }), (err: any) => err.code === "usage.webhooks" && /--order/.test(err.message));
  }
});

test("buildListQuery rejects invalid --limit, --status, --order and --all with paging flags", () => {
  const usage = (err: any) => err.code === "usage.webhooks";
  for (const limit of ["0", "101", "abc", "2.5"]) assert.throws(() => buildListQuery({ limit }), usage);
  assert.throws(() => buildListQuery({ status: "paused" }), usage);
  assert.throws(() => buildListQuery({ order: "url" }), usage);
  assert.throws(() => buildListQuery({ order: "name:up" }), usage);
  assert.throws(() => buildListQuery({ all: true, limit: "10" }), usage);
  assert.throws(() => buildListQuery({ all: true, cursor: "X" }), usage);
});

test("listFlagsFrom reads the citty args as strings", () => {
  assert.deepEqual(listFlagsFrom({ limit: 2, status: "enabled", all: true }), {
    limit: "2",
    cursor: undefined,
    all: true,
    status: "enabled",
    search: undefined,
    order: undefined,
  });
});

test("deel webhooks list rejects --order with --limit before any request", async () => {
  await assert.rejects(() => run(["webhooks", "list", "--order", "name", "--limit", "2"]), (err: any) => err.code === "usage.webhooks");
});

test("webhooks is a static command and a reserved command name", () => {
  assert.ok(staticCommands.webhooks);
  assert.ok(RESERVED_COMMANDS.has("webhooks"));
});

test("webhooks list without flags fetches the whole list in one call and strips signing_key", async () => {
  const { ctx, io, seen } = ctxWith(() => ok({ data: [webhook("wh_1"), webhook("wh_2")], cursor: null }));
  await runList(ctx, buildListQuery({}), false, JSON_OUTPUT);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "GET");
  assert.equal(seen[0].url, "https://example.test/rest/webhooks");
  assert.equal(seen[0].retryable, true);
  const out = io.stdout.join("");
  assert.equal(out.includes("signing_key"), false);
  assert.equal(out.includes(SIGNING_KEY), false);
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed.data.map((item: { id: string }) => item.id), ["wh_1", "wh_2"]);
  assert.match(io.stderr.join(""), new RegExp(SIGNING_KEY_HINT));
});

test("webhooks list --limit 2 prints one page and surfaces the next cursor", async () => {
  const { ctx, io, seen } = ctxWith(() => ok({ data: [webhook("wh_1"), webhook("wh_2")], cursor: "Y3Vyc29y" }));
  await runList(ctx, buildListQuery({ limit: "2", status: "enabled", search: "hook" }), false, JSON_OUTPUT);
  const url = new URL(seen[0].url);
  assert.equal(url.pathname, "/rest/webhooks");
  assert.equal(url.searchParams.get("limit"), "2");
  assert.equal(url.searchParams.get("status"), "enabled");
  assert.equal(url.searchParams.get("search"), "hook");
  const parsed = JSON.parse(io.stdout.join(""));
  assert.equal(parsed.meta.next_cursor, "Y3Vyc29y");
  assert.match(io.stderr.join(""), /next page: --cursor Y3Vyc29y/);
});

test("webhooks list --all walks every page by cursor with limit=100", async () => {
  const { ctx, io, seen } = ctxWith((req) => {
    const cursor = new URL(req.url).searchParams.get("cursor");
    return cursor === null ? ok({ data: [webhook("wh_1"), webhook("wh_2")], cursor: "page2" }) : ok({ data: [webhook("wh_3")], cursor: null });
  });
  await runList(ctx, buildListQuery({ all: true, status: "enabled" }), true, JSON_OUTPUT);
  assert.equal(seen.length, 2);
  const first = new URL(seen[0].url).searchParams;
  const second = new URL(seen[1].url).searchParams;
  assert.equal(first.get("limit"), "100");
  assert.equal(first.has("cursor"), false);
  assert.equal(first.get("status"), "enabled");
  assert.equal(second.get("limit"), "100");
  assert.equal(second.get("cursor"), "page2");
  assert.equal(second.get("status"), "enabled");
  const out = io.stdout.join("");
  assert.equal(out.includes(SIGNING_KEY), false);
  assert.deepEqual(JSON.parse(out).data.map((item: { id: string }) => item.id), ["wh_1", "wh_2", "wh_3"]);
});

test("webhooks get fetches one webhook by encoded id, strips signing_key and hints on stderr", async () => {
  const { ctx, io, seen } = ctxWith(() => ok({ data: webhook("wh/1") }));
  await runGet(ctx, "wh/1", JSON_OUTPUT);
  assert.equal(seen[0].url, "https://example.test/rest/webhooks/wh%2F1");
  const out = io.stdout.join("");
  assert.equal(out.includes("signing_key"), false);
  assert.equal(JSON.parse(out).data.id, "wh/1");
  assert.equal(io.stderr.join(""), `signing_key omitted: ${SIGNING_KEY_HINT}\n`);
});

test("webhooks get maps an API error to a CliError", async () => {
  const { ctx } = ctxWith(() => ({ status: 404, headers: {}, text: "", json: { error: { code: "webhook.not_found", message: "Webhook not found" } } }));
  await assert.rejects(() => runGet(ctx, "wh_missing", JSON_OUTPUT), (err: any) => err.code === "webhook.not_found" && err.requestId === "req-fixed-id");
});

test("webhooks event-types lists the event types", async () => {
  const eventType = { id: "et_1", module_name: "contracts", module_label: "Contracts", name: "contract.created", description: null, payload_example: "{}", created_at: "x", updated_at: "x" };
  const { ctx, io, seen } = ctxWith(() => ok({ data: [eventType] }));
  await runEventTypes(ctx, JSON_OUTPUT);
  assert.equal(seen[0].url, "https://example.test/rest/webhooks/events/types");
  assert.deepEqual(JSON.parse(io.stdout.join("")).data, [eventType]);
  assert.equal(io.stderr.join(""), "");
});

test("signing_key is a sensitive log key", () => {
  assert.ok(SENSITIVE_LOG_KEYS.has("signing_key"));
});

test("with --log-bodies the local log masks signing_key in webhook responses", async (t) => {
  const dir = tempDir(t, "deel-log-");
  process.env.DEEL_LOG_DIR = dir;
  setLoggingEnabled(true);
  setLogBodiesEnabled(true);
  try {
    const { ctx } = ctxWith(() => ok({ data: [webhook("wh_1")], cursor: null }), log);
    await runList(ctx, buildListQuery({}), false, JSON_OUTPUT);
    const content = readFileSync(join(dir, "deel.log"), "utf8");
    assert.equal(content.includes(SIGNING_KEY), false);
    const entry = JSON.parse(content.trim().split("\n").pop()!);
    assert.equal(entry.command, "webhooks list");
    assert.equal(entry.response.data[0].signing_key, "***");
    assert.equal(entry.response.data[0].id, "wh_1");
  } finally {
    setLogBodiesEnabled(false);
    delete process.env.DEEL_LOG_DIR;
  }
});

test("resolveWebhookId takes the positional, or --id=<id> for an id that starts with '-'", () => {
  assert.equal(resolveWebhookId("wh_1", undefined, "u"), "wh_1");
  assert.equal(resolveWebhookId(undefined, "-WZ1uT2DFF01", "u"), "-WZ1uT2DFF01");
  assert.equal(resolveWebhookId("wh_1", "-WZ1uT2DFF01", "u"), "-WZ1uT2DFF01"); // --id wins over a stray positional
});

test("resolveWebhookId without an id is a usage error that points at --id=<id>", () => {
  for (const [positional, flag] of [[undefined, undefined], ["", "  "]] as const) {
    assert.throws(
      () => resolveWebhookId(positional, flag, "deel webhooks get <id>"),
      (err: any) => err.code === "usage.webhooks" && err.message === "Usage: deel webhooks get <id>" && err.next === DASH_ID_HINT,
    );
  }
});

test("requireId reads --id=<id> and --id <id> from the raw args, so a leading dash survives the argument parser", () => {
  assert.equal(requireId({ id: "wh_1" }, ["get", "wh_1"], "u"), "wh_1");
  assert.equal(requireId({}, ["get", "--id=-WZ1uT2DFF01"], "u"), "-WZ1uT2DFF01");
  assert.equal(requireId({}, ["get", "--id", "-WZ1uT2DFF01", "--no-log"], "u"), "-WZ1uT2DFF01");
  assert.throws(() => requireId({}, ["get", "--idempotency-key=x"], "u"), (err: any) => err.code === "usage.webhooks");
});

test("deel webhooks get without an id is a usage error before any request, and mentions --id=<id>", async () => {
  await assert.rejects(() => run(["webhooks", "get"]), (err: any) => err.code === "usage.webhooks" && err.next === DASH_ID_HINT);
});
