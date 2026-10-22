import { test } from "node:test";
import assert from "node:assert/strict";
import { createContext } from "../src/core/context.ts";
import { captureIO } from "../src/core/io.ts";
import type { HttpRequest, HttpResponse } from "../src/core/http.ts";
import { HEADER } from "../src/core/constants.ts";
import { buildSimulateBody } from "../src/core/webhooks.ts";
import { runSimulate, webhooksCommand } from "../src/commands/webhooks.ts";
import { run } from "../src/cli.ts";

const CONFIG = { env: "demo", baseUrl: "https://example.test/rest" };
const JSON_OUTPUT = { json: true, quiet: false, raw: false };
const HUMAN_OUTPUT = { json: false, quiet: false, raw: false };
const RATE_LIMIT_HINT = "10 simulations per hour per event type";
const NOT_FOUND_HINT = "No webhook with this id in your organization, or the event type has no sample payload";

const ok = (json: unknown, status = 200): HttpResponse => ({ status, headers: {}, text: "", json });

function simulation(isSuccess: boolean, statusCode: number) {
  return {
    data: {
      is_success: isSuccess,
      delivery: { attempt_id: 987, status: isSuccess ? "success" : "failed", response_status_code: statusCode, duration_ms: 87 },
    },
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

const usage = (err: any) => err.code === "usage.webhooks";

test("buildSimulateBody maps --event to data.event_type and requires it", () => {
  assert.deepEqual(buildSimulateBody("contract.created"), { data: { event_type: "contract.created" } });
  assert.deepEqual(buildSimulateBody("  contract.created "), { data: { event_type: "contract.created" } });
  assert.throws(() => buildSimulateBody(undefined), (err: any) => usage(err) && /--event/.test(err.message));
  assert.throws(() => buildSimulateBody("  "), (err: any) => usage(err) && /--event/.test(err.message));
});

test("webhooks simulate POSTs {data: {event_type}} to /webhooks/{id}/simulate once, without retry or a derived idempotency key", async () => {
  const { ctx, io, seen } = ctxWith(() => ok(simulation(true, 200)));
  await runSimulate(ctx, "wh/1", buildSimulateBody("contract.created"), JSON_OUTPUT);
  assert.equal(seen.length, 1);
  const req = seen[0];
  assert.equal(req.method, "POST");
  assert.equal(req.url, "https://example.test/rest/webhooks/wh%2F1/simulate");
  assert.equal(req.headers[HEADER.contentType], "application/json");
  assert.deepEqual(JSON.parse(String(req.body)), { data: { event_type: "contract.created" } });
  assert.equal(req.retryable, false);
  assert.equal(req.headers[HEADER.idempotencyKey], undefined);
  assert.equal(req.meta?.idempotency_key, undefined);
  assert.equal(req.meta?.command, "webhooks simulate");
  assert.deepEqual(JSON.parse(io.stdout.join("")).data, simulation(true, 200).data);
  assert.equal(io.stderr.join(""), "");
});

test("webhooks simulate sends an Idempotency-Key only when --idempotency-key is given", async () => {
  const { ctx, seen } = ctxWith(() => ok(simulation(true, 200)));
  await runSimulate(ctx, "wh_1", buildSimulateBody("contract.created"), JSON_OUTPUT, "my-key");
  assert.equal(seen[0].headers[HEADER.idempotencyKey], "my-key");
  assert.equal(seen[0].retryable, false);
});

test("webhooks simulate prints success, receiver status code, duration and attempt id in the human view", async () => {
  const { ctx, io } = ctxWith(() => ok(simulation(true, 204)), { isTTY: true });
  await runSimulate(ctx, "wh_1", buildSimulateBody("contract.created"), HUMAN_OUTPUT);
  const out = io.stdout.join("");
  assert.match(out, /success: true/);
  assert.match(out, /receiver status code: 204/);
  assert.match(out, /duration: 87 ms/);
  assert.match(out, /attempt id: 987/);
  assert.match(out, /delivery status: success/);
});

test("webhooks simulate with is_success false prints the delivery, then fails", async () => {
  const { ctx, io, seen } = ctxWith(() => ok(simulation(false, 503)), { isTTY: true });
  await assert.rejects(
    () => runSimulate(ctx, "wh_1", buildSimulateBody("contract.created"), HUMAN_OUTPUT),
    (err: any) => err.code === "webhooks.simulate_failed" && /503/.test(err.message) && /publicly reachable/.test(err.next) && /2xx/.test(err.next),
  );
  assert.equal(seen.length, 1);
  const out = io.stdout.join("");
  assert.match(out, /success: false/);
  assert.match(out, /receiver status code: 503/);
  assert.match(out, /attempt id: 987/);
  assert.match(out, /delivery status: failed/);
});

test("webhooks simulate with is_success false still renders the JSON data before failing", async () => {
  const { ctx, io } = ctxWith(() => ok(simulation(false, 500)));
  await assert.rejects(() => runSimulate(ctx, "wh_1", buildSimulateBody("contract.created"), JSON_OUTPUT), (err: any) => err.code === "webhooks.simulate_failed");
  const data = JSON.parse(io.stdout.join("")).data;
  assert.equal(data.is_success, false);
  assert.equal(data.delivery.response_status_code, 500);
});

test("webhooks simulate with delivery null prints placeholders, then fails", async () => {
  const { ctx, io, seen } = ctxWith(() => ok({ data: { is_success: false, delivery: null } }), { isTTY: true });
  await assert.rejects(
    () => runSimulate(ctx, "wh_1", buildSimulateBody("contract.created"), HUMAN_OUTPUT),
    (err: any) => err.code === "webhooks.simulate_failed" && /contract\.created/.test(err.message) && /with no status code/.test(err.message),
  );
  assert.equal(seen.length, 1);
  const out = io.stdout.join("");
  assert.match(out, /success: false/);
  assert.match(out, /receiver status code: -/);
  assert.match(out, /duration: - ms/);
  assert.match(out, /attempt id: -/);
  assert.match(out, /delivery status: -/);
});

test("webhooks simulate with delivery null still renders the JSON data before failing", async () => {
  const { ctx, io } = ctxWith(() => ok({ data: { is_success: false, delivery: null } }));
  await assert.rejects(() => runSimulate(ctx, "wh_1", buildSimulateBody("contract.created"), JSON_OUTPUT), (err: any) => err.code === "webhooks.simulate_failed");
  assert.deepEqual(JSON.parse(io.stdout.join("")).data, { is_success: false, delivery: null });
});

test("webhooks simulate surfaces a 429 after exactly one request, keeping the API code and adding the rate-limit hint", async () => {
  const { ctx, io, seen } = ctxWith(() => ok({ errors: [{ code: "TOO_MANY_REQUESTS", message: "Too many requests" }] }, 429));
  await assert.rejects(
    () => runSimulate(ctx, "wh_1", buildSimulateBody("contract.created"), JSON_OUTPUT),
    (err: any) =>
      err.code === "TOO_MANY_REQUESTS" &&
      err.message === "Too many requests" &&
      err.requestId === "req-fixed-id" &&
      err.next.includes(RATE_LIMIT_HINT) &&
      !err.next.includes(NOT_FOUND_HINT),
  );
  assert.equal(seen.length, 1);
  assert.equal(io.stdout.join(""), "");
});

test("webhooks simulate adds the rate-limit hint to a bare 429", async () => {
  const { ctx, seen } = ctxWith(() => ok(null, 429));
  await assert.rejects(
    () => runSimulate(ctx, "wh_1", buildSimulateBody("contract.created"), JSON_OUTPUT),
    (err: any) => err.code === "http.429" && err.next.includes(RATE_LIMIT_HINT),
  );
  assert.equal(seen.length, 1);
});

test("webhooks simulate maps an API 404 to a CliError with the not-found hint and without the rate-limit hint", async () => {
  const { ctx, io, seen } = ctxWith(() => ok({ errors: [{ code: "NOT_FOUND", message: "Webhook not found" }] }, 404));
  await assert.rejects(
    () => runSimulate(ctx, "wh_missing", buildSimulateBody("contract.created"), JSON_OUTPUT),
    (err: any) =>
      err.code === "NOT_FOUND" &&
      err.message === "Webhook not found" &&
      err.requestId === "req-fixed-id" &&
      err.next.includes(NOT_FOUND_HINT) &&
      !String(err.next ?? "").includes(RATE_LIMIT_HINT),
  );
  assert.equal(seen.length, 1);
  assert.equal(io.stdout.join(""), "");
});

test("webhooks simulate decides the not-found hint on the 404 status, not on the error code", async () => {
  const { ctx } = ctxWith(() => ok({ errors: [{ code: "BAD_THING", message: "x" }] }, 404));
  await assert.rejects(
    () => runSimulate(ctx, "wh_1", buildSimulateBody("contract.created"), JSON_OUTPUT),
    (err: any) => err.code === "BAD_THING" && err.message === "x" && err.next.includes(NOT_FOUND_HINT) && !err.next.includes(RATE_LIMIT_HINT),
  );
});

test("webhooks simulate decides the rate-limit hint on the 429 status, not on the error code", async () => {
  const { ctx } = ctxWith(() => ok({ errors: [{ code: "ERROR", message: "slow down" }] }, 429));
  await assert.rejects(
    () => runSimulate(ctx, "wh_1", buildSimulateBody("contract.created"), JSON_OUTPUT),
    (err: any) => err.code === "ERROR" && err.next.includes(RATE_LIMIT_HINT) && !err.next.includes(NOT_FOUND_HINT),
  );
});

test("webhooks simulate still reads the old flat { error_code, message } error shape", async () => {
  const { ctx } = ctxWith(() => ok({ error_code: "webhook.not_found", message: "Webhook not found" }, 404));
  await assert.rejects(
    () => runSimulate(ctx, "wh_missing", buildSimulateBody("contract.created"), JSON_OUTPUT),
    (err: any) =>
      err.code === "webhook.not_found" &&
      err.message === "Webhook not found" &&
      err.requestId === "req-fixed-id" &&
      err.next.includes(NOT_FOUND_HINT) &&
      !err.next.includes(RATE_LIMIT_HINT),
  );
});

test("webhooks simulate adds neither hint to other error statuses", async () => {
  const { ctx } = ctxWith(() => ok({ errors: [{ code: "BAD_REQUEST", message: "Webhook is disabled" }] }, 400));
  await assert.rejects(
    () => runSimulate(ctx, "wh_1", buildSimulateBody("contract.created"), JSON_OUTPUT),
    (err: any) => err.code === "BAD_REQUEST" && err.message === "Webhook is disabled" && err.next === undefined,
  );
});

test("deel webhooks simulate without --event or without an id is a usage error before any request", async () => {
  await assert.rejects(() => run(["webhooks", "simulate", "wh_1"]), (err: any) => usage(err) && /--event/.test(err.message));
  await assert.rejects(() => run(["webhooks", "simulate", "--event", "contract.created"]), usage);
});

test("the webhooks group exposes simulate, and its help says the receiver must be publicly reachable", () => {
  const subCommands = webhooksCommand.subCommands as unknown as Record<string, { meta: { description: string } }>;
  const description = subCommands.simulate.meta.description;
  assert.match(description, /publicly reachable/);
  assert.match(description, /does not sign or send payloads/);
});

test("--beta sends X-Beta on the simulate request, and a BETA_ACCESS_REQUIRED response points at it", async () => {
  const seen: HttpRequest[] = [];
  const ctx = createContext({
    config: { ...CONFIG, beta: true },
    token: "tok_SECRET",
    io: captureIO({ isTTY: false }),
    rng: () => "req-fixed-id",
    logger: () => {},
    baseTransport: async (req) => (seen.push(req), ok(simulation(true, 200))),
  });
  await runSimulate(ctx, "wh_1", buildSimulateBody("contract.created"), JSON_OUTPUT);
  assert.equal(seen[0].headers[HEADER.beta], "true");
  assert.equal(seen[0].headers[HEADER.authorization], "Bearer tok_SECRET");

  const betaBody = { errors: [{ code: "BETA_ACCESS_REQUIRED", message: "This API version is in beta. Please include the X-Beta: true header." }] };
  const { ctx: plain, seen: plainSeen } = ctxWith(() => ok(betaBody, 403));
  await assert.rejects(
    () => runSimulate(plain, "wh_1", buildSimulateBody("contract.created"), JSON_OUTPUT),
    (err: any) => err.code === "BETA_ACCESS_REQUIRED" && /Re-run with --beta/.test(err.next),
  );
  assert.equal(plainSeen[0].headers[HEADER.beta], undefined);
});

test("deel webhooks simulate without an id points at --id=<id> for ids that start with a dash", async () => {
  await assert.rejects(() => run(["webhooks", "simulate", "--event", "contract.created"]), (err: any) => usage(err) && /--id=<id>/.test(err.next));
});
