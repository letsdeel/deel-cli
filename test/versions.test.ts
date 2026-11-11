import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execute } from "../src/core/executor.ts";
import type { ExecOpts } from "../src/core/executor.ts";
import { createContext } from "../src/core/context.ts";
import { captureIO } from "../src/core/io.ts";
import type { HttpRequest, HttpResponse } from "../src/core/http.ts";
import { AGENT_ENV_SIGNALS } from "../src/core/constants.ts";
import { betaFallback, chooseVersion, newestBeta, newestStable, versionListing, versionTable } from "../src/core/versions.ts";
import type { Descriptor, VersionInfo } from "../src/types.ts";
import { run } from "../src/cli.ts";
import { EXIT } from "../src/core/errors.ts";
import { setGeneratedDescriptorsForTests } from "../src/public-api/commands.ts";
import { parseDefinitions } from "../scripts/public-api/definitions.ts";
import { generate } from "../scripts/public-api/generate.ts";

const NOW = Date.parse("2026-10-30T00:00:00Z");

// Oldest first, as the generator writes them: one stable, one beta that ends in the
// future, one that graduated (beta_until in the past, so it is stable now).
const VERSIONS: VersionInfo[] = [
  { version: "2026-01-01", beta_until: null, sunset_at: "2027-06-01" },
  { version: "2026-04-01", beta_until: "2026-09-01", sunset_at: null },
  { version: "2026-09-15", beta_until: "2027-01-01", sunset_at: null },
];

function descriptor(over: Partial<Descriptor> = {}): Descriptor {
  return {
    command: ["widgets", "create"],
    method: "POST",
    path: "/widgets",
    version: "2026-04-01",
    async: false,
    bodyKind: "json",
    supportsMultipart: false,
    bodyWrapper: "none",
    params: [],
    bodyProps: [],
    fileFields: [],
    responseKind: "object",
    responseFields: [],
    versions: VERSIONS,
    ...over,
  };
}

const ok = (): HttpResponse => ({ status: 200, headers: {}, text: "", json: { data: { id: "w1" } } });
const fail = (status: number, json: unknown): HttpResponse => ({ status, headers: {}, text: "", json });

function harness(responses: HttpResponse[], env = "prod") {
  const io = captureIO({});
  const seen: HttpRequest[] = [];
  let ids = 0;
  const ctx = createContext({
    config: { env, baseUrl: "https://example.test/rest", issuer: null, clientId: "test-client", oauthBaseUrlOk: false },
    token: "tok",
    io,
    clock: () => NOW,
    rng: () => `req-${++ids}`,
    logger: () => {},
    baseTransport: async (request) => {
      seen.push({ ...request, headers: { ...request.headers } });
      return responses[Math.min(seen.length - 1, responses.length - 1)];
    },
  });
  return { ctx, io, seen };
}

const opts = (version: ExecOpts["version"] = {}, debug = false, quiet = false): ExecOpts => ({ output: { json: true, quiet, raw: false }, debug, form: false, version });

async function call(desc: Descriptor, responses: HttpResponse[], version: ExecOpts["version"] = {}, debug = false, quiet = false, env = "prod") {
  const h = harness(responses, env);
  let error: any;
  try {
    await execute(desc, { flags: {}, body: { name: "w" }, files: {} }, h.ctx, opts(version, debug, quiet));
  } catch (caught) {
    error = caught;
  }
  return { ...h, error, stderr: h.io.stderr.join("") };
}

test("newest beta / newest stable are judged against now, not the generation date", () => {
  assert.equal(newestBeta(VERSIONS, NOW), "2026-09-15");
  assert.equal(newestStable(VERSIONS, NOW), "2026-04-01");
  assert.equal(newestBeta(VERSIONS.slice(0, 2), NOW), undefined);
});

test("chooseVersion validates --version as a real date", () => {
  for (const bad of ["2026-1-01", "latest", "2026-02-30", "2026-13-01"]) {
    assert.throws(() => chooseVersion(descriptor(), { apiVersion: bad }, NOW, () => {}), (error: any) => error.code === "usage.version");
  }
});

test("chooseVersion refuses --beta with --version none", () => {
  assert.throws(() => chooseVersion(descriptor(), { apiVersion: "none", beta: true }, NOW, () => {}), (error: any) => error.code === "usage.version");
});

test("chooseVersion sends X-Beta for a known beta version picked with --version", () => {
  assert.deepEqual(chooseVersion(descriptor(), { apiVersion: "2026-09-15" }, NOW, () => {}), { version: "2026-09-15", beta: true });
  assert.deepEqual(chooseVersion(descriptor(), { apiVersion: "2026-01-01" }, NOW, () => {}), { version: "2026-01-01", beta: false });
});

test("chooseVersion: --version works without a version list, and --beta adds X-Beta to it", () => {
  const handPicked = descriptor({ versions: undefined, version: "2025-01-01" });
  const warnings: string[] = [];
  assert.deepEqual(chooseVersion(handPicked, { apiVersion: "2026-02-02" }, NOW, (line) => warnings.push(line)), { version: "2026-02-02", beta: false });
  assert.deepEqual(chooseVersion(handPicked, { apiVersion: "2026-02-02", beta: true }, NOW, () => {}), { version: "2026-02-02", beta: true });
  assert.deepEqual(warnings, []);
});

test("betaFallback only acts on a request that sent X-Beta", () => {
  assert.equal(betaFallback({ version: "2026-09-15", beta: false }, "INVALID_VERSION_BETA", VERSIONS, NOW, false), undefined);
  assert.equal(betaFallback({ version: "2026-09-15", beta: true }, "SOMETHING_ELSE", VERSIONS, NOW, false), undefined);
  assert.equal(betaFallback({ version: "2026-09-15", beta: true }, "NO_BETA_VERSION", undefined, NOW, false), undefined);
  assert.deepEqual(betaFallback({ beta: true }, "INVALID_VERSION_BETA", VERSIONS, NOW, false)?.choice, { version: undefined, beta: false });
});

test("no flag: sends the descriptor's version and no X-Beta", async () => {
  const { seen, error } = await call(descriptor(), [ok()]);
  assert.equal(error, undefined);
  assert.equal(seen[0].headers["x-version"], "2026-04-01");
  assert.equal(seen[0].headers["x-beta"], undefined);
});

test("no flag on a beta-only descriptor: sends X-Beta by default", async () => {
  const { seen } = await call(descriptor({ version: "2026-09-15", beta: true }), [ok()]);
  assert.equal(seen[0].headers["x-version"], "2026-09-15");
  assert.equal(seen[0].headers["x-beta"], "true");
});

test("chooseVersion: outside prod no version is chosen from the manifest, and a beta is not picked from its list", () => {
  assert.deepEqual(chooseVersion(descriptor(), {}, NOW, () => {}, true), { beta: false });
  assert.deepEqual(chooseVersion(descriptor({ version: "2026-09-15", beta: true }), {}, NOW, () => {}, true), { beta: true });
  assert.deepEqual(chooseVersion(descriptor(), { beta: true }, NOW, () => {}, true), { beta: true });
  assert.deepEqual(chooseVersion(descriptor({ versions: VERSIONS.slice(0, 1) }), { beta: true }, NOW, () => {}, true), { beta: true });
  assert.deepEqual(chooseVersion(descriptor({ version: undefined, versions: undefined }), { beta: true }, NOW, () => {}, true), { beta: true });
});

test("chooseVersion: outside prod a version the user names is still sent", () => {
  assert.deepEqual(chooseVersion(descriptor(), { apiVersion: "2026-01-01" }, NOW, () => {}, true), { version: "2026-01-01", beta: false });
  assert.deepEqual(chooseVersion(descriptor(), { apiVersion: "2026-09-15" }, NOW, () => {}, true), { version: "2026-09-15", beta: false });
  assert.deepEqual(chooseVersion(descriptor(), { apiVersion: "2026-09-15", beta: true }, NOW, () => {}, true), { version: "2026-09-15", beta: true });
  const warnings: string[] = [];
  assert.deepEqual(chooseVersion(descriptor(), { apiVersion: "2026-12-12" }, NOW, (line) => warnings.push(line), true), { version: "2026-12-12", beta: false });
  assert.deepEqual(warnings, []);
  assert.deepEqual(chooseVersion(descriptor(), { apiVersion: "none" }, NOW, () => {}, true), { beta: false });
});

test("outside prod (demo, or any other environment) no X-Version is sent and the gateway picks it", async () => {
  for (const env of ["demo", "example.test"]) {
    const { seen, error } = await call(descriptor(), [ok()], {}, false, false, env);
    assert.equal(error, undefined);
    assert.equal("x-version" in seen[0].headers, false, env);
    assert.equal("x-beta" in seen[0].headers, false, env);
  }
});

test("outside prod a beta-only command and --beta still send X-Beta, without a version", async () => {
  const betaOnly = await call(descriptor({ version: "2026-09-15", beta: true }), [ok()], {}, false, false, "demo");
  assert.equal("x-version" in betaOnly.seen[0].headers, false);
  assert.equal(betaOnly.seen[0].headers["x-beta"], "true");
  const flagged = await call(descriptor(), [ok()], { beta: true }, false, false, "demo");
  assert.equal("x-version" in flagged.seen[0].headers, false);
  assert.equal(flagged.seen[0].headers["x-beta"], "true");
});

test("outside prod --beta works on a command whose manifest lists no beta", async () => {
  const { seen, error } = await call(descriptor({ versions: VERSIONS.slice(0, 1) }), [ok()], { beta: true }, false, false, "demo");
  assert.equal(error, undefined);
  assert.equal(seen[0].headers["x-beta"], "true");
});

test("outside prod --version still sends the version the user names", async () => {
  const { seen } = await call(descriptor(), [ok()], { apiVersion: "2026-01-01" }, false, false, "demo");
  assert.equal(seen[0].headers["x-version"], "2026-01-01");
  assert.equal("x-beta" in seen[0].headers, false);
});

test("deel --env demo sends no X-Version, and --version still reaches the request", async () => {
  const seen: Headers[] = [];
  const plain = await cli(["widgets", "reports", "list", "--env", "demo", "--no-log"], recordingFetch(seen));
  assert.equal(plain.code, EXIT.OK);
  const pinned = await cli(["widgets", "reports", "list", "--env", "demo", "--version", "2026-01-01", "--no-log"], recordingFetch(seen));
  assert.equal(pinned.code, EXIT.OK);
  assert.deepEqual(seen.map((headers) => [headers.get("x-version"), headers.get("x-beta")]), [[null, null], ["2026-01-01", null]]);
});

test("outside prod the retry of a rejected beta does not fall back to the manifest's stable version", async () => {
  const noBeta = fail(400, { errors: [{ code: "NO_BETA_VERSION", message: "no beta" }] });
  const { seen, error } = await call(descriptor(), [noBeta, ok()], { beta: true }, false, false, "demo");
  assert.equal(seen.length, 1);
  assert.equal(error.code, "NO_BETA_VERSION");
  const advised = fail(400, { errors: [{ code: "NO_BETA_VERSION", message: "no beta", details: { latest_stable_version: "2026-05-05" } }] });
  const retried = await call(descriptor(), [advised, ok()], { beta: true }, false, false, "demo");
  assert.equal(retried.error, undefined);
  assert.equal(retried.seen[1].headers["x-version"], "2026-05-05");
  assert.equal("x-beta" in retried.seen[1].headers, false);
});

test("a hand-picked descriptor without a version sends no X-Version", async () => {
  const { seen } = await call(descriptor({ version: undefined, versions: undefined }), [ok()]);
  assert.equal("x-version" in seen[0].headers, false);
});

test("--version <date> sends that version", async () => {
  const { seen, stderr } = await call(descriptor(), [ok()], { apiVersion: "2026-01-01" });
  assert.equal(seen[0].headers["x-version"], "2026-01-01");
  assert.equal(seen[0].headers["x-beta"], undefined);
  assert.equal(stderr, "");
});

test("--version with an unknown date warns on stderr but still sends it", async () => {
  const { seen, stderr } = await call(descriptor(), [ok()], { apiVersion: "2025-05-05" });
  assert.equal(seen[0].headers["x-version"], "2025-05-05");
  assert.match(stderr, /warning: 2025-05-05 is not a known version of 'deel widgets create' \(known: 2026-01-01, 2026-04-01, 2026-09-15\)/);
});

test("--quiet silences the unknown-version warning", async () => {
  const { seen, stderr } = await call(descriptor(), [ok()], { apiVersion: "2025-05-05" }, false, true);
  assert.equal(seen[0].headers["x-version"], "2025-05-05");
  assert.equal(stderr, "");
});

test("--version with a malformed date fails before any request", async () => {
  const { seen, error } = await call(descriptor(), [ok()], { apiVersion: "2026/01/01" });
  assert.equal(error.code, "usage.version");
  assert.equal(seen.length, 0);
});

test("--version none sends no X-Version header, even on a beta-only descriptor", async () => {
  const { seen } = await call(descriptor({ version: "2026-09-15", beta: true }), [ok()], { apiVersion: "none" });
  assert.equal("x-version" in seen[0].headers, false);
  assert.equal("x-beta" in seen[0].headers, false);
});

test("--beta sends the newest beta version and X-Beta", async () => {
  const { seen } = await call(descriptor(), [ok()], { beta: true });
  assert.equal(seen[0].headers["x-version"], "2026-09-15");
  assert.equal(seen[0].headers["x-beta"], "true");
});

test("--beta without a beta version is a usage error", async () => {
  const { seen, error } = await call(descriptor({ versions: VERSIONS.slice(0, 2) }), [ok()], { beta: true });
  assert.equal(error.code, "usage.beta");
  assert.match(error.next, /--versions/);
  assert.equal(seen.length, 0);
});

test("--beta on a command without a version list adds X-Beta to its own version, as it always did", async () => {
  const { seen, error } = await call(descriptor({ versions: undefined, version: "2025-01-01" }), [ok()], { beta: true });
  assert.equal(error, undefined);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers["x-version"], "2025-01-01");
  assert.equal(seen[0].headers["x-beta"], "true");
});

test("INVALID_VERSION_BETA: retries once with the same version, without X-Beta, same idempotency key", async () => {
  const { seen, error, io } = await call(
    descriptor({ version: "2026-09-15", beta: true }),
    [fail(400, { error: { code: "INVALID_VERSION_BETA", message: "Version is not in beta" } }), ok()],
  );
  assert.equal(error, undefined);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].headers["x-version"], "2026-09-15");
  assert.equal("x-beta" in seen[1].headers, false);
  assert.ok(seen[0].headers["idempotency-key"]);
  assert.equal(seen[1].headers["idempotency-key"], seen[0].headers["idempotency-key"]);
  assert.notEqual(seen[1].headers["x-request-id"], seen[0].headers["x-request-id"]);
  assert.equal(seen[1].body, seen[0].body);
  assert.equal(JSON.parse(io.stdout.join("")).meta.request_id, seen[1].headers["x-request-id"]);
});

test("NO_BETA_VERSION ({ errors: [...] } shape): retries once with the newest stable version", async () => {
  const { seen, error } = await call(descriptor(), [fail(404, { errors: [{ code: "NO_BETA_VERSION", message: "No beta version" }] }), ok()], { beta: true });
  assert.equal(error, undefined);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].headers["x-version"], "2026-09-15");
  assert.equal(seen[1].headers["x-version"], "2026-04-01");
  assert.equal("x-beta" in seen[1].headers, false);
  assert.equal(seen[1].headers["idempotency-key"], seen[0].headers["idempotency-key"]);
});

test("NO_BETA_VERSION retries with the stable version the gateway names, not the manifest's older one", async () => {
  const body = { errors: [{ code: "NO_BETA_VERSION", message: "No beta version", details: { latest_stable_version: "2026-06-01", available_versions: ["2026-06-01"] } }] };
  const { seen, error } = await call(descriptor(), [fail(404, body), ok()], { beta: true });
  assert.equal(error, undefined);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].headers["x-version"], "2026-06-01");
  assert.equal("x-beta" in seen[1].headers, false);
});

test("NO_BETA_VERSION on a beta-only manifest retries with the version the gateway names", async () => {
  const onlyBeta = [{ version: "2026-09-15", beta_until: "2027-01-01", sunset_at: null }];
  const body = { error: { code: "NO_BETA_VERSION", message: "No beta version", details: { latest_stable_version: "2026-01-01" } } };
  const { seen, error } = await call(descriptor({ version: "2026-09-15", beta: true, versions: onlyBeta }), [fail(404, body), ok()]);
  assert.equal(error, undefined);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].headers["x-version"], "2026-01-01");
});

test("NO_BETA_VERSION ignores a version the gateway names that is not a date", async () => {
  const body = { errors: [{ code: "NO_BETA_VERSION", message: "No beta version", details: { latest_stable_version: "latest" } }] };
  const { seen, error } = await call(descriptor(), [fail(404, body), ok()], { beta: true });
  assert.equal(error, undefined);
  assert.equal(seen[1].headers["x-version"], "2026-04-01");
});

test("NO_BETA_VERSION never swaps a pinned --version for another one", async () => {
  const { seen, error } = await call(descriptor(), [fail(404, { errors: [{ code: "NO_BETA_VERSION", message: "No beta version" }] }), ok()], { apiVersion: "2026-09-15", beta: true });
  assert.equal(seen.length, 1);
  assert.equal(error.code, "NO_BETA_VERSION");
});

test("NO_BETA_VERSION with no stable version known surfaces the error", async () => {
  const onlyBeta = [{ version: "2026-09-15", beta_until: "2027-01-01", sunset_at: null }];
  const { seen, error } = await call(descriptor({ version: "2026-09-15", beta: true, versions: onlyBeta }), [fail(404, { error: { code: "NO_BETA_VERSION", message: "No beta version" } })]);
  assert.equal(seen.length, 1);
  assert.equal(error.code, "NO_BETA_VERSION");
});

test("the fallback retries only once", async () => {
  const graduated = fail(400, { errors: [{ code: "INVALID_VERSION_BETA", message: "Version is not in beta" }] });
  const { seen, error } = await call(descriptor({ version: "2026-09-15", beta: true }), [graduated, graduated, ok()]);
  assert.equal(seen.length, 2);
  assert.equal(error.code, "INVALID_VERSION_BETA");
});

test("a beta error on a request without X-Beta is not retried", async () => {
  const { seen, error } = await call(descriptor(), [fail(400, { error: { code: "INVALID_VERSION_BETA", message: "x" } }), ok()]);
  assert.equal(seen.length, 1);
  assert.equal(error.code, "INVALID_VERSION_BETA");
});

test("the retry is logged in --debug output", async () => {
  const { stderr } = await call(descriptor({ version: "2026-09-15", beta: true }), [fail(400, { error: { code: "INVALID_VERSION_BETA" } }), ok()], {}, true);
  assert.match(stderr, /POST https:\/\/example\.test\/rest\/widgets -> 400 {2}x-version=2026-09-15 x-beta=true/);
  assert.match(stderr, /INVALID_VERSION_BETA: 2026-09-15 is no longer in beta; retrying once without x-beta/);
  assert.match(stderr, /-> 200 {2}x-version=2026-09-15 {2}x-request-id=req-2/);
});

test("BETA_ACCESS_REQUIRED surfaces the error with a --beta hint (both error shapes)", async () => {
  for (const json of [
    { error: { code: "BETA_ACCESS_REQUIRED", message: "Beta access required" } },
    { errors: [{ code: "BETA_ACCESS_REQUIRED", message: "Beta access required" }] },
  ]) {
    const { seen, error } = await call(descriptor(), [fail(400, json), ok()], { apiVersion: "2027-01-01" });
    assert.equal(seen.length, 1);
    assert.equal(error.code, "BETA_ACCESS_REQUIRED");
    assert.equal(error.message, "Beta access required");
    assert.match(error.next, /add --beta/);
  }
});

test("BETA_ACCESS_REQUIRED keeps the hint the API gives, and after --version none names a date instead of --beta alone", async () => {
  const given = await call(descriptor(), [fail(400, { error: { code: "BETA_ACCESS_REQUIRED", message: "Beta access required", next: "Ask your admin for beta access." } })], { apiVersion: "2027-01-01" });
  assert.equal(given.error.next, "Ask your admin for beta access.");
  const none = await call(descriptor(), [fail(400, { error: { code: "BETA_ACCESS_REQUIRED", message: "Beta access required" } })], { apiVersion: "none" });
  assert.match(none.error.next, /--version <YYYY-MM-DD> --beta/);
  assert.doesNotMatch(none.error.next, /add --beta/);
});

test("--version \" none \" is read as none, here and in the hint after BETA_ACCESS_REQUIRED", async () => {
  const { error } = await call(descriptor(), [fail(400, { error: { code: "BETA_ACCESS_REQUIRED", message: "Beta access required" } })], { apiVersion: " none " });
  assert.match(error.next, /--version <YYYY-MM-DD> --beta/);
});

test("a static command refuses --version, --versions and --beta instead of ignoring them", async () => {
  const seen: Headers[] = [];
  for (const [argv, flag] of [[["job", "status", "abc", "--version", "2026-01-01"], "version"], [["auth", "status", "--beta"], "beta"], [["commands", "--versions"], "versions"]] as const) {
    const { error } = await cli([...argv, ...BASE], recordingFetch(seen));
    assert.equal(error?.code, "usage.flag", argv.join(" "));
    assert.match(error.message, new RegExp(`has no --${flag}\\.`), argv.join(" "));
  }
  assert.equal(seen.length, 0);
  // A bare --version still prints the CLI's own.
  assert.match((await cli(["--version"])).out, /^deel \d+\.\d+\.\d+/);
});

test("BETA_ACCESS_REQUIRED after X-Beta was sent gets no hint to add --beta, and keeps the API's own", async () => {
  const body = { error: { code: "BETA_ACCESS_REQUIRED", message: "Beta access required" } };
  const sent = await call(descriptor({ version: "2026-09-15", beta: true }), [fail(400, body)]);
  assert.equal(sent.seen[0].headers["x-beta"], "true");
  assert.equal(sent.error.code, "BETA_ACCESS_REQUIRED");
  assert.equal(sent.error.next, undefined);
  const given = await call(descriptor({ version: "2026-09-15", beta: true }), [fail(400, { error: { ...body.error, next: "Ask your admin." } })]);
  assert.equal(given.error.next, "Ask your admin.");
});

test("--versions on a hand-picked command with several variants asks for a variant flag, and names them", async () => {
  const { error } = await cli(["adjustments", "create", "--versions"]);
  assert.equal(error.code, "usage.versions");
  assert.match(error.message, /^'deel adjustments create' has several endpoints; pick one with --invoice, --payroll$/);
});

test("--help wins over --versions: it prints the help, even where --versions alone would be refused", async () => {
  const help = await cli(["widgets", "reports", "list", "--versions", "--help"]);
  assert.equal(help.code, EXIT.OK);
  assert.match(help.out, /USAGE/);
  assert.doesNotMatch(help.out, /"default": true/, "not the versions listing");
  // A hand-picked command has no versions to list (usage.versions), a variant group needs a variant first.
  const handPicked = await cli(["adjustments", "create", "--invoice", "--versions", "--help"]);
  assert.equal(handPicked.code, EXIT.OK);
  assert.match(handPicked.out, /USAGE/);
  const group = await cli(["adjustments", "create", "--versions", "--help"]);
  assert.equal(group.code, EXIT.OK, group.error?.message);
  assert.doesNotMatch(group.out, /"default": true/);
});

test("a beta error in the nested { errors: { errors: [...] } } shape is retried like the others", async () => {
  const nested = fail(400, { errors: { errors: [{ code: "INVALID_VERSION_BETA", message: "Version is not in beta" }] } });
  const { seen, error } = await call(descriptor({ version: "2026-09-15", beta: true }), [nested, ok()]);
  assert.equal(error, undefined);
  assert.equal(seen.length, 2);
  assert.equal("x-beta" in seen[1].headers, false);
});

test("a send-once route is never sent twice by the beta fallback; its error is surfaced", async () => {
  const simulate = descriptor({ method: "POST", path: "/webhooks/{}/simulate", version: "2026-09-15", beta: true });
  const { seen, error } = await call(simulate, [fail(400, { errors: [{ code: "INVALID_VERSION_BETA", message: "Version is not in beta" }] }), ok()]);
  assert.equal(seen.length, 1);
  assert.equal(error.code, "INVALID_VERSION_BETA");
});

test("versionListing marks beta (as of now) and the default version", () => {
  const listing = versionListing(descriptor(), NOW);
  assert.equal(listing.version, "2026-04-01");
  assert.deepEqual(listing.versions.map((row) => [row.version, row.beta, row.default]), [
    ["2026-01-01", false, false],
    ["2026-04-01", false, true],
    ["2026-09-15", true, false],
  ]);
  const table = versionTable(listing);
  assert.match(table, /VERSION\s+STATUS\s+BETA UNTIL\s+SUNSET/);
  assert.match(table, /2026-01-01\s+stable\s+-\s+2027-06-01/);
  assert.match(table, /2026-09-15\s+beta\s+2027-01-01\s+-/);
  assert.match(table, /2026-04-01\s+stable\s+2026-09-01\s+-\s+\(default\)/);
});

const definitions = parseDefinitions(JSON.parse(readFileSync(new URL("./fixtures/definitions/widgets.json", import.meta.url), "utf8")));
const { manifest } = generate(definitions, {
  reserved: { commands: [], topLevel: new Set(["auth", "job"]) },
  map: JSON.parse(readFileSync(new URL("./fixtures/definitions/widgets-map.json", import.meta.url), "utf8")),
  now: new Date("2026-10-30T00:00:00Z"),
});

async function cli(argv: string[], fetchStub?: typeof fetch): Promise<{ code?: number; out: string; err: string; error?: any }> {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  const origFetch = globalThis.fetch;
  const origToken = process.env.DEEL_TOKEN;
  // The test runner reports over stdout in binary chunks; only the CLI's text is captured.
  process.stdout.write = ((chunk: any, ...rest: any[]) => (typeof chunk === "string" ? (out.push(chunk), true) : origOut.call(process.stdout, chunk, ...rest))) as typeof process.stdout.write;
  process.stderr.write = ((chunk: any, ...rest: any[]) => (typeof chunk === "string" ? (err.push(chunk), true) : origErr.call(process.stderr, chunk, ...rest))) as typeof process.stderr.write;
  if (fetchStub) globalThis.fetch = fetchStub;
  process.env.DEEL_TOKEN = "tok_test";
  setGeneratedDescriptorsForTests(manifest.descriptors);
  try {
    const code = await run(argv);
    return { code, out: out.join(""), err: err.join("") };
  } catch (error) {
    return { error, out: out.join(""), err: err.join("") };
  } finally {
    setGeneratedDescriptorsForTests(undefined);
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    globalThis.fetch = origFetch;
    if (origToken === undefined) delete process.env.DEEL_TOKEN;
    else process.env.DEEL_TOKEN = origToken;
  }
}

function recordingFetch(seen: Headers[]): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    seen.push(new Headers(init?.headers));
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }) as typeof fetch;
}

// Runs `fn` as if stdout were a terminal in a plain shell (no CI or agent signal in the environment).
async function onTerminal<T>(fn: () => Promise<T>): Promise<T> {
  const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const saved = AGENT_ENV_SIGNALS.map((name) => [name, process.env[name]] as const);
  for (const name of AGENT_ENV_SIGNALS) delete process.env[name];
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  try {
    return await fn();
  } finally {
    if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
    for (const [name, value] of saved) if (value !== undefined) process.env[name] = value;
  }
}

const BASE = ["--env", "prod", "--base-url", "https://example.test/rest", "--no-log"];

test("deel <beta-only command> sends X-Beta; --version and --beta reach the request", async () => {
  const seen: Headers[] = [];
  await cli(["gizmos", "list", ...BASE], recordingFetch(seen));
  await cli(["widgets", "reports", "list", "--beta", ...BASE], recordingFetch(seen));
  await cli(["widgets", "reports", "list", "--version", "none", ...BASE], recordingFetch(seen));
  assert.deepEqual(seen.map((headers) => [headers.get("x-version"), headers.get("x-beta")]), [
    ["2026-03-01", "true"],
    ["2026-06-01", "true"],
    [null, null],
  ]);
});

test("--version names the API version after the command words; before them it is refused, not read as the CLI's", async () => {
  const seen: Headers[] = [];
  const result = await cli(["widgets", "reports", "list", "--version", "2026-01-01", ...BASE], recordingFetch(seen));
  assert.equal(result.code, EXIT.OK);
  assert.equal(seen[0].get("x-version"), "2026-01-01");
  const before = await cli(["--version", "2026-01-01", "widgets", "reports", "list", ...BASE], recordingFetch(seen));
  assert.equal(before.error?.code, "usage.command");
  assert.match(before.error?.message, /^Options go after the command/);
  assert.match((await cli(["--env", "demo", "--version"])).out, /^deel \d+\.\d+\.\d+/);
});

test("--versions prints the version list without a request (JSON, --jq, table)", async () => {
  const seen: Headers[] = [];
  const json = await cli(["widgets", "reports", "list", "--versions"], recordingFetch(seen));
  assert.equal(json.code, EXIT.OK);
  const listing = JSON.parse(json.out).data;
  assert.equal(listing.version, "2026-01-01");
  assert.deepEqual(listing.versions.map((row: { version: string; beta: boolean }) => [row.version, row.beta]), [["2026-01-01", false], ["2026-06-01", true]]);

  const jq = await cli(["widgets", "reports", "list", "--versions", "--jq", ".versions[].version", "--raw"]);
  assert.equal(jq.out, "2026-01-01\n2026-06-01\n");

  const projected = await cli(["widgets", "reports", "list", "--versions", "--fields", "version,beta"]);
  assert.deepEqual(JSON.parse(projected.out).data, { version: "2026-01-01", beta: false });

  // The table is the human form: on a terminal with --no-json. Piped, or shaped by --jq/--fields, it stays data.
  const table = await onTerminal(() => cli(["widgets", "reports", "list", "--versions", "--no-json"]));
  assert.match(table.out, /2026-06-01\s+beta\s+2099-01-01/);
  const piped = await cli(["widgets", "reports", "list", "--versions", "--no-json"]);
  assert.equal(JSON.parse(piped.out).data.version, "2026-01-01");
  const shaped = await onTerminal(() => cli(["widgets", "reports", "list", "--versions", "--no-json", "--jq", ".version"]));
  assert.equal(shaped.out, JSON.stringify("2026-01-01") + "\n");
  const fields = await onTerminal(() => cli(["widgets", "reports", "list", "--versions", "--no-json", "--fields", "version,beta"]));
  assert.doesNotMatch(fields.out, /STATUS/);
  assert.deepEqual(JSON.parse(fields.out), { version: "2026-01-01", beta: false });
  const quiet = await onTerminal(() => cli(["widgets", "reports", "list", "--versions", "--no-json", "--quiet"]));
  assert.doesNotMatch(quiet.out, /STATUS|2026-06-01\s+beta/);
  const plain = await onTerminal(() => cli(["widgets", "reports", "list", "--versions"]));
  assert.equal(JSON.parse(plain.out).data.version, "2026-01-01");

  const get = await cli(["widgets", "get", "--versions"]);
  assert.equal(get.code, EXIT.OK);
  assert.equal(seen.length, 0);
});

test("--versions on a hand-picked command (no version list) is a usage error", async () => {
  const { error } = await cli(["adjustments", "create", "--invoice", "--versions"]);
  assert.equal(error.code, "usage.versions");
});

test("--versions on words several endpoints share needs one picked first", async () => {
  const { error } = await cli(["widgets", "notes", "list", "--versions"]);
  assert.equal(error.code, "usage.versions");
  assert.match(error.message, /has several endpoints; pick one with the flags of one of:\n {2}deel widgets notes list\n {2}deel widgets notes list --widget <widget>/);
  const picked = await cli(["widgets", "notes", "list", "--widget", "w1", "--versions"]);
  assert.equal(picked.code, EXIT.OK);
});

test("action help shows the default version and every version", async () => {
  const { out } = await cli(["widgets", "reports", "list", "--help"]);
  assert.match(out, /API VERSION {2}2026-01-01 {3}— change with --version/);
  assert.match(out, /2026-01-01 {2}stable, default/);
  assert.match(out, /2026-06-01 {2}beta until 2099-01-01/);
  const beta = await cli(["gizmos", "list", "--help"]);
  assert.match(beta.out, /API VERSION {2}2026-03-01 \(beta\)/);
});

test("--help --json carries beta and versions", async () => {
  const gizmos = JSON.parse((await cli(["gizmos", "list", "--help", "--json"])).out);
  assert.equal(gizmos.beta, true);
  assert.deepEqual(gizmos.versions, [{ version: "2026-03-01", beta_until: "2099-01-01", sunset_at: null }]);
  const handPicked = JSON.parse((await cli(["adjustments", "create", "--invoice", "--help", "--json"])).out);
  assert.equal(handPicked.beta, false);
  assert.equal(handPicked.versions, null);
});

test("the version flags are global options", async () => {
  const { out } = await cli(["--help"]);
  assert.match(out, /--version=<version>/);
  assert.match(out, /--beta\s/);
  assert.match(out, /--versions\s/);
});

test("deel <cmd> --beta: the retry after INVALID_VERSION_BETA goes out without X-Beta, as the transport adds none", async () => {
  const seen: Headers[] = [];
  const answers = [
    () => new Response(JSON.stringify({ errors: [{ code: "INVALID_VERSION_BETA", message: "Version is not in beta" }] }), { status: 400 }),
    () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
  ];
  const stub = (async (_url: unknown, init?: RequestInit) => (seen.push(new Headers(init?.headers)), answers[seen.length - 1]())) as typeof fetch;
  const result = await cli(["widgets", "reports", "list", "--beta", ...BASE], stub);
  assert.equal(result.code, EXIT.OK, result.err);
  assert.deepEqual(seen.map((headers) => headers.get("x-beta")), ["true", null]);
  assert.equal(seen[1].get("x-version"), seen[0].get("x-version"));
});
