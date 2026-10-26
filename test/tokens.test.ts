import { test } from "node:test";
import assert from "node:assert/strict";
import { createContext } from "../src/core/context.ts";
import { captureIO } from "../src/core/io.ts";
import type { HttpRequest, HttpResponse } from "../src/core/http.ts";
import { RESERVED_COMMANDS } from "../src/core/constants.ts";
import { CliError } from "../src/core/errors.ts";
import { CREATE_HINT, DASH_ID_HINT, buildTokenListQuery, resolveTokenId, validateReason } from "../src/core/api-tokens.ts";
import { isYes, listFlagsFrom, runGet, runList, runInvalidate, tokensCommand } from "../src/commands/tokens.ts";
import { staticCommands } from "../src/commands/index.ts";

const CONFIG = { env: "demo", baseUrl: "https://example.test/rest" };
const JSON_OUTPUT = { json: true, quiet: false, raw: false };
const TOKEN_ID = "7f0c1b9e-3c3a-4a63-9a43-2d6c1a0e8b51";

const ok = (json: unknown): HttpResponse => ({ status: 200, headers: {}, text: "", json });

function apiToken(id: string) {
  return { id, label: `token ${id}`, token_type: "ORGANIZATION", status: "ACTIVE", scopes: ["contracts:read"] };
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

const stdoutJson = (io: { stdout: string[] }) => JSON.parse(io.stdout.join(""));

test("tokens is a static command and reserved, so no generated command can take the name", () => {
  assert.equal(staticCommands.tokens, tokensCommand);
  assert.equal(RESERVED_COMMANDS.has("tokens"), true);
});

test("buildTokenListQuery maps every list flag to the public query parameters", () => {
  const query = buildTokenListQuery(
    listFlagsFrom({ limit: "20", cursor: "C", type: "personal", signal: "full_access", search: "payroll", owner: "42", sort: "risk" })
  );
  assert.equal(query.toString(), "limit=20&cursor=C&token_type=PERSONAL&signal=FULL_ACCESS&search=payroll&owner_profile_id=42&sort=RISK");
  assert.equal(buildTokenListQuery({}).toString(), "");
});

test("buildTokenListQuery accepts the enum filters in any case and sends the API's UPPER_SNAKE_CASE", () => {
  assert.equal(buildTokenListQuery({ type: "Organization", signal: " Stale ", sort: "NAME" }).toString(), "token_type=ORGANIZATION&signal=STALE&sort=NAME");
});

for (const [name, flags, message] of [
  ["--limit below the API minimum", { limit: "3" }, '--limit must be an integer between 4 and 100, got "3"'],
  ["a non-integer --limit", { limit: "ten" }, '--limit must be an integer between 4 and 100, got "ten"'],
  ["--all with --cursor", { all: true, cursor: "C" }, "--all cannot be combined with --limit or --cursor"],
  ["an empty --cursor", { cursor: "" }, "--cursor needs a value"],
  ["an unknown --type", { type: "worker" }, '--type must be one of: PERSONAL, ORGANIZATION, got "worker"'],
  ["an unknown --signal", { signal: "fullAccess" }, "--signal must be one of: ACTIVE, FULL_ACCESS, STALE, EXPIRING, ORPHANED, PERSONAL, INVALIDATED, got \"fullAccess\""],
  ["an unknown --sort", { sort: "oldest" }, '--sort must be one of: NEWEST, NAME, RECENT, SCOPES, RISK, got "oldest"'],
] as const) {
  test(`buildTokenListQuery rejects ${name}`, () => {
    assert.throws(() => buildTokenListQuery(flags), (error: unknown) => error instanceof CliError && error.message === message);
  });
}


test("validateReason trims, drops an empty reason and refuses one over 200 characters", () => {
  assert.equal(validateReason("  rotated  "), "rotated");
  assert.equal(validateReason("   "), undefined);
  assert.equal(validateReason(undefined), undefined);
  assert.throws(() => validateReason("x".repeat(201)), (error: unknown) => error instanceof CliError && error.message === "--reason must be at most 200 characters, got 201");
});

test("resolveTokenId prefers --id=<id> and explains how to pass an id that starts with '-'", () => {
  assert.equal(resolveTokenId("pos", "-dash", "deel tokens get <id>"), "-dash");
  assert.equal(resolveTokenId(" pos ", undefined, "deel tokens get <id>"), "pos");
  assert.throws(() => resolveTokenId(undefined, undefined, "deel tokens get <id>"), (error: unknown) => error instanceof CliError && error.next === DASH_ID_HINT);
});

test("tokens list fetches one page and prints the next cursor, has_more and total_count", async () => {
  const { ctx, io, seen } = ctxWith(() => ok({ data: [apiToken("a")], next_cursor: "NEXT", has_more: true, total_count: 7 }));

  await runList(ctx, buildTokenListQuery({ type: "organization" }), false, JSON_OUTPUT);

  assert.equal(seen[0].method, "GET");
  assert.equal(seen[0].url, "https://example.test/rest/v2/api-tokens?token_type=ORGANIZATION");
  assert.deepEqual(stdoutJson(io), { data: [apiToken("a")], meta: { next_cursor: "NEXT", has_more: true, total_count: 7 } });
  assert.equal(io.stderr.join(""), "next page: --cursor NEXT\n");
});

test("tokens list --all walks every page with the largest page size, keeping the filters", async () => {
  const pages: Record<string, unknown> = {
    "": { data: [apiToken("a")], next_cursor: "P2", has_more: true, total_count: 2 },
    P2: { data: [apiToken("b")], next_cursor: null, has_more: false, total_count: null },
  };
  const { ctx, io, seen } = ctxWith((req) => ok(pages[new URL(req.url).searchParams.get("cursor") ?? ""]));

  await runList(ctx, buildTokenListQuery({ all: true, signal: "stale" }), true, JSON_OUTPUT);

  assert.deepEqual(
    seen.map((req) => req.url),
    ["https://example.test/rest/v2/api-tokens?signal=STALE&limit=100", "https://example.test/rest/v2/api-tokens?signal=STALE&limit=100&cursor=P2"]
  );
  assert.deepEqual(stdoutJson(io).data, [apiToken("a"), apiToken("b")]);
});

test("tokens list and invalidate send X-Beta only when --beta is set", async () => {
  for (const beta of [true, false]) {
    const seen: HttpRequest[] = [];
    const ctx = createContext({
      config: { ...CONFIG, beta },
      token: "tok_SECRET",
      io: captureIO({ isTTY: false }),
      clock: () => 1000,
      rng: () => "req-fixed-id",
      logger: () => {},
      baseTransport: async (req) => (seen.push(req), ok({ data: [] })),
    });

    await runList(ctx, buildTokenListQuery({}), false, JSON_OUTPUT);
    await runInvalidate(ctx, TOKEN_ID, { yes: true }, JSON_OUTPUT);

    assert.deepEqual(
      seen.map((req) => req.headers["x-beta"]),
      beta ? ["true", "true"] : [undefined, undefined]
    );
  }
});

test("a beta-required answer tells the user to pass --beta, unless the header was already sent", async () => {
  const refusal = () => ({ status: 400, headers: {}, text: "", json: { errors: [{ code: "BETA_ACCESS_REQUIRED", message: "This API version is in beta." }] } });

  const withoutBeta = ctxWith(refusal);
  await assert.rejects(runGet(withoutBeta.ctx, TOKEN_ID, JSON_OUTPUT), (error: unknown) => error instanceof CliError && /--beta/.test(error.next ?? ""));

  const withBeta = createContext({
    config: { ...CONFIG, beta: true },
    token: "tok_SECRET",
    io: captureIO({ isTTY: false }),
    clock: () => 1000,
    rng: () => "req-fixed-id",
    logger: () => {},
    baseTransport: async () => refusal(),
  });
  await assert.rejects(runGet(withBeta, TOKEN_ID, JSON_OUTPUT), (error: unknown) => error instanceof CliError && !/--beta/.test(error.next ?? ""));
});

test("tokens get calls its endpoint with the id encoded and prints data", async () => {
  const { ctx, io, seen } = ctxWith((req) => ok({ data: { url: req.url } }));

  await runGet(ctx, "id/with slash", JSON_OUTPUT);

  assert.deepEqual(
    seen.map((req) => `${req.method} ${req.url}`),
    [
      "GET https://example.test/rest/v2/api-tokens/id%2Fwith%20slash",
    ]
  );
  assert.equal(io.stdout.length, 1);
});

test("tokens invalidate --yes sends POST with the reason and an idempotency key, and prints the result", async () => {
  const { ctx, io, seen } = ctxWith(() => ok({ data: { id: TOKEN_ID, status: "INVALIDATED" } }));

  await runInvalidate(ctx, TOKEN_ID, { yes: true, reason: "rotated" }, JSON_OUTPUT);

  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].url, `https://example.test/rest/v2/api-tokens/${TOKEN_ID}/invalidate`);
  assert.equal(seen[0].body, JSON.stringify({ data: { reason: "rotated" } }));
  assert.equal(typeof seen[0].headers["idempotency-key"], "string");
  assert.deepEqual(stdoutJson(io).data, { id: TOKEN_ID, status: "INVALIDATED" });
});

test("tokens invalidate without a reason sends no body", async () => {
  const { ctx, seen } = ctxWith(() => ok({ data: { id: TOKEN_ID, status: "INVALIDATED" } }));

  await runInvalidate(ctx, TOKEN_ID, { yes: true }, JSON_OUTPUT);

  assert.equal(seen[0].body, null);
  assert.equal(seen[0].headers["content-type"], undefined);
});

test("tokens invalidate refuses to run non-interactively without --yes and sends nothing", async () => {
  const { ctx, seen } = ctxWith(() => ok({}));

  await assert.rejects(runInvalidate(ctx, TOKEN_ID, { yes: false }, JSON_OUTPUT), (error: unknown) => error instanceof CliError && error.next === "Pass --yes to invalidate non-interactively.");
  assert.equal(seen.length, 0);
});

test("tokens invalidate on a terminal asks first, and a no sends nothing", async () => {
  const { ctx, seen } = ctxWith(() => ok({}), { isTTY: true });
  const questions: string[] = [];

  await assert.rejects(
    runInvalidate(ctx, TOKEN_ID, { yes: false, confirm: async (question) => (questions.push(question), false) }, JSON_OUTPUT),
    (error: unknown) => error instanceof CliError && error.code === "tokens.invalidate_aborted"
  );
  assert.deepEqual(questions, [`Invalidate token ${TOKEN_ID}? It stops working at once and cannot be restored. [y/N] `]);
  assert.equal(seen.length, 0);
});

test("tokens invalidate on a terminal invalidates after a yes", async () => {
  const { ctx, seen } = ctxWith(() => ok({ data: { id: TOKEN_ID, status: "INVALIDATED" } }), { isTTY: true });

  await runInvalidate(ctx, TOKEN_ID, { yes: false, confirm: async () => true }, JSON_OUTPUT);

  assert.equal(seen.length, 1);
});

test("isYes accepts y and yes in any case, nothing else", () => {
  assert.deepEqual(["y", "YES", " yes ", "n", "", "yep"].map(isYes), [true, true, true, false, false, false]);
});

test("an API error surfaces as a CLI error with the request id", async () => {
  const { ctx } = ctxWith(() => ({ status: 404, headers: {}, text: "", json: { errors: [{ code: "NOT_FOUND", message: "Access token could not be found" }] } }));

  await assert.rejects(runGet(ctx, TOKEN_ID, JSON_OUTPUT), (error: unknown) => error instanceof CliError && /Access token could not be found/.test(error.message));
});

test("tokens create explains that tokens are created in Developer Center", async () => {
  const create = (tokensCommand.subCommands as Record<string, { run: () => void }>).create;

  assert.throws(() => create.run(), (error: unknown) => error instanceof CliError && error.next === CREATE_HINT);
});
