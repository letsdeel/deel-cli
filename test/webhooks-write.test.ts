import { test } from "node:test";
import { PassThrough } from "node:stream";
import assert from "node:assert/strict";
import { createContext } from "../src/core/context.ts";
import { captureIO } from "../src/core/io.ts";
import type { HttpRequest, HttpResponse } from "../src/core/http.ts";
import { HEADER } from "../src/core/constants.ts";
import { deriveIdempotencyKey } from "../src/core/idempotency.ts";
import { DASH_ID_HINT, SIGNING_KEY_HINT, buildCreateBody, buildUpdateBody } from "../src/core/webhooks.ts";
import { isYes, promptConfirm, readBooleanFlag, runCreate, runDelete, runUpdate, webhooksCommand, writeFlagsFrom } from "../src/commands/webhooks.ts";
import { run } from "../src/cli.ts";

const CONFIG = { env: "demo", baseUrl: "https://example.test/rest" };
const JSON_OUTPUT = { json: true, quiet: false, raw: false };
const SIGNING_KEY = "whsec_do_not_print";

const ok = (json: unknown, status = 200): HttpResponse => ({ status, headers: {}, text: "", json });

function webhook(id: string, overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  };
}

function ctxWith(handler: (req: HttpRequest) => HttpResponse, opts: { isTTY?: boolean } = {}) {
  const seen: HttpRequest[] = [];
  const io = captureIO({ isTTY: opts.isTTY ?? false });
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

const bodyOf = (req: HttpRequest) => JSON.parse(String(req.body));
const usage = (err: any) => err.code === "usage.webhooks";
const apiError = (status: number) => () => ok({ error: { code: "webhook.invalid", message: "Rejected" } }, status);

// --- raw-args helpers --------------------------------------------------------

test("writeFlagsFrom reads every --event occurrence from the raw args", () => {
  const rawArgs = ["--name", "Hook", "--event", "contract.created", "--event=timesheet.reviewed", "--url", "https://x.test", "--event", "invoice.paid"];
  const flags = writeFlagsFrom({ name: "Hook", url: "https://x.test", event: "invoice.paid" }, rawArgs);
  assert.deepEqual(flags.events, ["contract.created", "timesheet.reviewed", "invoice.paid"]);
  assert.equal(flags.name, "Hook");
  assert.equal(flags.url, "https://x.test");
  assert.equal(flags.description, undefined);
  assert.equal(flags.status, undefined);
  assert.equal(flags.includeChildOrgs, undefined);
});

test("readBooleanFlag: absent -> undefined, --flag -> true, --no-flag -> false, last occurrence wins", () => {
  assert.equal(readBooleanFlag(["--name", "x"], "include-child-orgs"), undefined);
  assert.equal(readBooleanFlag(["--include-child-orgs"], "include-child-orgs"), true);
  assert.equal(readBooleanFlag(["--no-include-child-orgs"], "include-child-orgs"), false);
  assert.equal(readBooleanFlag(["--include-child-orgs", "--no-include-child-orgs"], "include-child-orgs"), false);
  assert.equal(readBooleanFlag(["--include-child-orgs=false"], "include-child-orgs"), false);
  assert.equal(readBooleanFlag(["--include-child-orgs=true"], "include-child-orgs"), true);
  assert.throws(() => readBooleanFlag(["--include-child-orgs=maybe"], "include-child-orgs"), usage);
});

test("isYes accepts only y / yes, case-insensitive", () => {
  for (const answer of ["y", "Y", "yes", "YES", " Yes \n"]) assert.equal(isYes(answer), true);
  for (const answer of ["", "n", "no", "yep", "sure"]) assert.equal(isYes(answer), false);
});

// --- create ------------------------------------------------------------------

test("buildCreateBody maps the flags, defaults status to enabled and always sends api_version v2", () => {
  assert.deepEqual(buildCreateBody({ name: "Hook", url: "https://x.test/h", events: ["a.b", "c.d"] }), {
    name: "Hook",
    url: "https://x.test/h",
    events: ["a.b", "c.d"],
    status: "enabled",
    api_version: "v2",
  });
  assert.deepEqual(
    buildCreateBody({ name: "Hook", url: "https://x.test/h", events: ["a.b"], description: "Payroll", status: "disabled", includeChildOrgs: true }),
    { name: "Hook", url: "https://x.test/h", events: ["a.b"], status: "disabled", api_version: "v2", description: "Payroll", include_child_orgs: true },
  );
  assert.equal(buildCreateBody({ name: "Hook", url: "https://x.test/h", events: ["a.b"], includeChildOrgs: false }).include_child_orgs, false);
});

test("buildCreateBody requires --name, --url and at least one --event, and a valid --status", () => {
  const full = { name: "Hook", url: "https://x.test/h", events: ["a.b"] };
  assert.throws(() => buildCreateBody({ ...full, name: undefined }), (err: any) => usage(err) && /--name/.test(err.message));
  assert.throws(() => buildCreateBody({ ...full, url: undefined }), (err: any) => usage(err) && /--url/.test(err.message));
  assert.throws(() => buildCreateBody({ ...full, events: [] }), (err: any) => usage(err) && /--event/.test(err.message));
  assert.throws(() => buildCreateBody({ events: [] }), (err: any) => usage(err) && /--name, --url, --event/.test(err.message));
  assert.throws(() => buildCreateBody({ ...full, status: "paused" }), (err: any) => usage(err) && /--status/.test(err.message));
});

test("webhooks create POSTs the JSON body with an idempotency key and strips signing_key from the output", async () => {
  const { ctx, io, seen } = ctxWith(() => ok({ data: webhook("wh_new") }, 201));
  const body = buildCreateBody(writeFlagsFrom({ name: "Hook", url: "https://x.test/h" }, ["--name", "Hook", "--url", "https://x.test/h", "--event", "a.b", "--event", "c.d"]));
  await runCreate(ctx, body, JSON_OUTPUT);
  assert.equal(seen.length, 1);
  const req = seen[0];
  assert.equal(req.method, "POST");
  assert.equal(req.url, "https://example.test/rest/webhooks");
  assert.equal(req.headers[HEADER.contentType], "application/json");
  assert.equal(req.headers[HEADER.idempotencyKey], deriveIdempotencyKey({ method: "POST", path: "/webhooks", query: {}, body }));
  assert.equal(req.retryable, true);
  assert.equal(req.meta?.command, "webhooks create");
  assert.deepEqual(bodyOf(req), { name: "Hook", url: "https://x.test/h", events: ["a.b", "c.d"], status: "enabled", api_version: "v2" });
  const out = io.stdout.join("");
  assert.equal(out.includes("signing_key"), false);
  assert.equal(out.includes(SIGNING_KEY), false);
  assert.equal(JSON.parse(out).data.id, "wh_new");
  assert.equal(io.stderr.join(""), `signing_key omitted: ${SIGNING_KEY_HINT}\n`);
});

test("webhooks create sends the --idempotency-key override as is", async () => {
  const { ctx, seen } = ctxWith(() => ok({ data: webhook("wh_new") }, 201));
  await runCreate(ctx, buildCreateBody({ name: "Hook", url: "https://x.test/h", events: ["a.b"] }), JSON_OUTPUT, "my-key");
  assert.equal(seen[0].headers[HEADER.idempotencyKey], "my-key");
  assert.equal(seen[0].meta?.idempotency_key, "my-key");
});

test("deel webhooks create without --name/--url/--event is a usage error before any request", async () => {
  await assert.rejects(() => run(["webhooks", "create", "--url", "https://x.test/h", "--event", "a.b"]), usage);
  await assert.rejects(() => run(["webhooks", "create", "--name", "Hook", "--event", "a.b"]), usage);
  await assert.rejects(() => run(["webhooks", "create", "--name", "Hook", "--url", "https://x.test/h"]), usage);
});

test("webhooks create maps an API 4xx to a CliError", async () => {
  const { ctx, io } = ctxWith(apiError(400));
  await assert.rejects(
    () => runCreate(ctx, buildCreateBody({ name: "Hook", url: "https://x.test/h", events: ["a.b"] }), JSON_OUTPUT),
    (err: any) => err.code === "webhook.invalid" && err.requestId === "req-fixed-id",
  );
  assert.equal(io.stdout.join(""), "");
});

// --- update ------------------------------------------------------------------

test("buildUpdateBody sends only the given fields", () => {
  assert.deepEqual(buildUpdateBody({ status: "disabled", events: ["a.b"] }), { status: "disabled", events: ["a.b"] });
  assert.deepEqual(buildUpdateBody({ name: "New", events: [] }), { name: "New" });
  assert.deepEqual(buildUpdateBody({ events: [], includeChildOrgs: false }), { include_child_orgs: false });
  assert.deepEqual(buildUpdateBody({ url: "https://x.test/2", description: "d", events: ["a", "b"], includeChildOrgs: true }), {
    url: "https://x.test/2",
    description: "d",
    events: ["a", "b"],
    include_child_orgs: true,
  });
});

test("buildUpdateBody rejects no field flag and a bad --status", () => {
  assert.throws(() => buildUpdateBody({ events: [] }), (err: any) => usage(err) && /at least one field/.test(err.message));
  assert.throws(() => buildUpdateBody({ status: "paused", events: [] }), (err: any) => usage(err) && /--status/.test(err.message));
});

test("update flags from raw args: --status disabled --event a.b -> exactly {status, events}; --no-include-child-orgs -> false", () => {
  const rawArgs = ["wh_1", "--status", "disabled", "--event", "a.b"];
  assert.deepEqual(buildUpdateBody(writeFlagsFrom({ id: "wh_1", status: "disabled", event: "a.b" }, rawArgs)), { status: "disabled", events: ["a.b"] });
  assert.deepEqual(buildUpdateBody(writeFlagsFrom({ id: "wh_1" }, ["wh_1", "--no-include-child-orgs"])), { include_child_orgs: false });
});

test("deel webhooks update without a field flag or with a bad --status is a usage error before any request", async () => {
  await assert.rejects(() => run(["webhooks", "update", "wh_1"]), usage);
  await assert.rejects(() => run(["webhooks", "update", "wh_1", "--status", "paused"]), usage);
  await assert.rejects(() => run(["webhooks", "update", "--status", "disabled"]), usage);
});

test("webhooks update PATCHes only the given fields and strips signing_key from the output", async () => {
  const { ctx, io, seen } = ctxWith(() => ok({ data: webhook("wh/1", { status: "disabled", events: ["a.b"] }) }));
  const body = buildUpdateBody({ status: "disabled", events: ["a.b"] });
  await runUpdate(ctx, "wh/1", body, JSON_OUTPUT);
  const req = seen[0];
  assert.equal(req.method, "PATCH");
  assert.equal(req.url, "https://example.test/rest/webhooks/wh%2F1");
  assert.equal(req.headers[HEADER.contentType], "application/json");
  assert.ok(req.headers[HEADER.idempotencyKey]);
  assert.deepEqual(bodyOf(req), { status: "disabled", events: ["a.b"] });
  const out = io.stdout.join("");
  assert.equal(out.includes("signing_key"), false);
  assert.equal(out.includes(SIGNING_KEY), false);
  assert.equal(JSON.parse(out).data.status, "disabled");
  assert.match(io.stderr.join(""), new RegExp(SIGNING_KEY_HINT));
});

test("webhooks update maps an API 4xx to a CliError", async () => {
  const { ctx } = ctxWith(apiError(404));
  await assert.rejects(() => runUpdate(ctx, "wh_missing", { name: "x" }, JSON_OUTPUT), (err: any) => err.code === "webhook.invalid");
});

// --- delete ------------------------------------------------------------------

test("webhooks delete --yes sends DELETE without prompting and prints the id", async () => {
  const { ctx, io, seen } = ctxWith(() => ok({ data: { deleted: true } }));
  let asked = false;
  await runDelete(ctx, "wh_1", { yes: true, confirm: async () => (asked = true) }, JSON_OUTPUT);
  assert.equal(asked, false);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "DELETE");
  assert.equal(seen[0].url, "https://example.test/rest/webhooks/wh_1");
  assert.equal(seen[0].body, null);
  assert.ok(seen[0].headers[HEADER.idempotencyKey]);
  assert.deepEqual(JSON.parse(io.stdout.join("")).data, { id: "wh_1", deleted: true });
});

test("webhooks delete falls back to { deleted: true } when the API answers without a body", async () => {
  const { ctx, io } = ctxWith(() => ({ status: 204, headers: {}, text: "", json: undefined }));
  await runDelete(ctx, "wh_1", { yes: true }, JSON_OUTPUT);
  assert.deepEqual(JSON.parse(io.stdout.join("")).data, { id: "wh_1", deleted: true });
});

test("webhooks delete never prints a signing_key the API echoes back, and hints on stderr", async () => {
  const { ctx, io } = ctxWith(() => ok({ data: webhook("wh_1") }));
  await runDelete(ctx, "wh_1", { yes: true }, JSON_OUTPUT);
  const out = io.stdout.join("");
  assert.equal(out.includes(SIGNING_KEY), false);
  assert.equal(out.includes("signing_key"), false);
  assert.equal(JSON.parse(out).data.id, "wh_1");
  assert.equal(io.stderr.join(""), `signing_key omitted: ${SIGNING_KEY_HINT}\n`);
});

test("promptConfirm answers yes and no from one line of input", async () => {
  for (const [line, expected] of [["y\n", true], ["yes\n", true], ["n\n", false], ["\n", false]] as const) {
    const input = new PassThrough();
    const answer = promptConfirm("Delete? ", input, new PassThrough());
    input.write(line);
    assert.equal(await answer, expected, JSON.stringify(line));
  }
});

test("promptConfirm settles as no when the input closes without an answer (EOF)", async () => {
  const input = new PassThrough();
  const answer = promptConfirm("Delete? ", input, new PassThrough());
  input.end();
  assert.equal(await answer, false);
});

test("webhooks delete on an interactive terminal asks and deletes on yes", async () => {
  const { ctx, seen } = ctxWith(() => ok({ data: { deleted: true } }), { isTTY: true });
  const questions: string[] = [];
  const confirm = async (question: string) => {
    questions.push(question);
    return true;
  };
  await runDelete(ctx, "wh_1", { yes: false, confirm }, JSON_OUTPUT);
  assert.deepEqual(questions, ["Delete webhook wh_1? [y/N] "]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "DELETE");
});

test("webhooks delete on an interactive terminal aborts on no without any request", async () => {
  const { ctx, io, seen } = ctxWith(() => ok({ data: { deleted: true } }), { isTTY: true });
  await assert.rejects(
    () => runDelete(ctx, "wh_1", { yes: false, confirm: async () => false }, JSON_OUTPUT),
    (err: any) => err.code === "webhooks.delete_aborted",
  );
  assert.equal(seen.length, 0);
  assert.equal(io.stdout.join(""), "");
});

test("webhooks delete without --yes outside a terminal is a usage error without any request", async () => {
  const { ctx, seen } = ctxWith(() => ok({ data: { deleted: true } }));
  let asked = false;
  await assert.rejects(
    () => runDelete(ctx, "wh_1", { yes: false, confirm: async () => (asked = true) }, JSON_OUTPUT),
    (err: any) => usage(err) && /Refusing to delete webhook wh_1/.test(err.message) && /--yes/.test(err.next),
  );
  assert.equal(asked, false);
  assert.equal(seen.length, 0);
});

test("webhooks delete maps an API 404 to a CliError", async () => {
  const { ctx } = ctxWith(apiError(404));
  await assert.rejects(() => runDelete(ctx, "wh_missing", { yes: true }, JSON_OUTPUT), (err: any) => err.code === "webhook.invalid" && err.requestId === "req-fixed-id");
});

test("deel webhooks delete without an id is a usage error", async () => {
  await assert.rejects(() => run(["webhooks", "delete", "--yes"]), usage);
});

test("the webhooks group exposes create, update, enable, disable and delete", () => {
  const subCommands = webhooksCommand.subCommands as unknown as Record<string, unknown>;
  for (const name of ["list", "get", "event-types", "create", "update", "enable", "disable", "delete"]) assert.ok(subCommands[name], name);
});

test("deel webhooks enable and disable without an id are a usage error", async () => {
  await assert.rejects(() => run(["webhooks", "enable"]), (err: any) => usage(err) && err.next === DASH_ID_HINT);
  await assert.rejects(() => run(["webhooks", "disable"]), (err: any) => usage(err) && err.next === DASH_ID_HINT);
});

test("deel webhooks update and delete without an id point at --id=<id> for ids that start with a dash", async () => {
  await assert.rejects(() => run(["webhooks", "update", "--status", "disabled"]), (err: any) => usage(err) && err.next === DASH_ID_HINT);
  await assert.rejects(() => run(["webhooks", "delete", "--yes"]), (err: any) => usage(err) && err.next === DASH_ID_HINT);
});
