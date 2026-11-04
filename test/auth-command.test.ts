import { test } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { authLogin, authLogout, authStatus } from "../src/commands/auth.ts";
import { commandToken } from "../src/commands/shared.ts";
import type { AuthDeps } from "../src/commands/auth.ts";
import { resolveConfig } from "../src/core/config.ts";
import type { CliError } from "../src/core/errors.ts";
import type { HttpRequest, HttpResponse, Transport } from "../src/core/http.ts";
import type { IOStreams } from "../src/core/io.ts";
import type { CredentialStore } from "../src/core/keychain.ts";
import { readOAuthEntry, writeOAuthEntry } from "../src/core/oauth.ts";
import { tempDir } from "./stubs.ts";

const ISSUER = "https://api.letsdeel.com";
const METADATA = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/oauth/authorize`,
  token_endpoint: `${ISSUER}/oauth/tokens`,
  revocation_endpoint: `${ISSUER}/oauth/revoke`,
  scopes_supported: ["people:read"],
};
const ME = { id: "p1", email: "admin@example.test", full_name: "Ada Admin", profile_type: "client" };
const ARGS = { json: true };

// A private lock and log directory and no credentials from the caller's environment, restored after the test.
function isolated(t: TestContext) {
  const keys = ["DEEL_LOG_DIR", "DEEL_TOKEN", "DEEL_OAUTH_ISSUER", "DEEL_ENV"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.DEEL_LOG_DIR = tempDir(t);
  t.after(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

function memoryStore() {
  const items = new Map<string, string>();
  const store: CredentialStore = {
    available: () => true,
    get: (account) => items.get(account) ?? null,
    set: (account, value) => (items.set(account, value), true),
    remove: (account) => items.delete(account),
  };
  return { store, items };
}

function captureIO() {
  const out: string[] = [];
  const err: string[] = [];
  const io: IOStreams = { out: (text) => out.push(text), err: (text) => err.push(text), readStdin: () => "", isTTY: false, interactive: false };
  return { io, data: () => (JSON.parse(out.join("")) as { data: Record<string, unknown> }).data, err: () => err.join("") };
}

// The Deel API and OAuth server: discovery, the token and revocation endpoints and /people/me.
function server(over: { metadata?: object; revoke?: number; me?: number } = {}) {
  const requests: HttpRequest[] = [];
  const respond = (status: number, json: unknown): HttpResponse => ({ status, headers: {}, text: "", json });
  const transport: Transport = async (request) => {
    requests.push(request);
    if (request.url.endsWith("/.well-known/oauth-authorization-server")) return respond(200, over.metadata ?? METADATA);
    if (request.url === METADATA.token_endpoint) return respond(200, { access_token: "at_from_login", refresh_token: "rt", expires_in: 3600 });
    if (request.url === METADATA.revocation_endpoint) return respond(over.revoke ?? 200, undefined);
    if (request.url.endsWith("/people/me")) return respond(over.me ?? 200, over.me ? { errors: ["Unauthorized"] } : ME);
    return respond(404, {});
  };
  return { transport, requests };
}

// Stands in for the browser: follows the authorization URL straight back to the loopback listener.
const browser = (url: string) => {
  const parsed = new URL(url);
  void fetch(`${parsed.searchParams.get("redirect_uri")}?code=c&state=${parsed.searchParams.get("state")}&iss=${encodeURIComponent(ISSUER)}`);
};

const stored = { v: 2 as const, access_token: "at_stored", refresh_token: "rt_stored", expires_at: "2099-01-01T00:00:00.000Z" };

test("auth login signs in, stores the login and reports the identity", async (t) => {
  isolated(t);
  const { store } = memoryStore();
  const { transport, requests } = server();
  const { io, data } = captureIO();
  await authLogin(ARGS, resolveConfig({ env: "prod" }), { store, transport, io, openUrl: browser });
  assert.equal(readOAuthEntry(store, ISSUER)?.access_token, "at_from_login");
  const me = requests.find((request) => request.url.endsWith("/people/me"));
  assert.equal(me?.url, "https://api.letsdeel.com/rest/people/me");
  assert.deepEqual(data(), {
    stored: true,
    env: "prod",
    auth: "oauth",
    token: "****ogin",
    identity: ME,
    scope: null,
    expires_at: readOAuthEntry(store, ISSUER)?.expires_at,
  });
});

test("auth login reports a sign-in whose token the API rejects, instead of a successful login", async (t) => {
  isolated(t);
  const { store } = memoryStore();
  const { io } = captureIO();
  await assert.rejects(
    () => authLogin(ARGS, resolveConfig({ env: "prod" }), { store, transport: server({ me: 401 }).transport, io, openUrl: browser }),
    (error: CliError) => error.code === "auth.invalid" && /identity check failed \(401\)/.test(error.message),
  );
});

test("auth login refuses --token-stdin before reading stdin or opening anything", async (t) => {
  isolated(t);
  const untouched: AuthDeps = {
    store: { available: () => assert.fail("keychain"), get: () => assert.fail("keychain"), set: () => assert.fail("keychain"), remove: () => assert.fail("keychain") },
    transport: async () => assert.fail("no request expected"),
    openUrl: () => assert.fail("no browser expected"),
  };
  await assert.rejects(
    () => authLogin({ ...ARGS, "token-stdin": true }, resolveConfig({ env: "prod" }), untouched),
    (error: CliError) => error.code === "usage.token_stdin" && /--token-stdin or DEEL_TOKEN/.test(error.next ?? ""),
  );
});

test("auth login refuses a --base-url on another host before any request, so no token reaches it", async (t) => {
  isolated(t);
  const { store, items } = memoryStore();
  const deps: AuthDeps = { store, transport: async () => assert.fail("no request expected"), openUrl: () => assert.fail("no browser expected") };
  await assert.rejects(
    () => authLogin(ARGS, resolveConfig({ env: "prod", baseUrl: "https://other.example.test/rest" }), deps),
    (error: CliError) => error.code === "auth.base_url",
  );
  assert.equal(items.size, 0);
});

test("auth login without an OS keychain points at DEEL_TOKEN", async (t) => {
  isolated(t);
  const none: CredentialStore = { ...memoryStore().store, available: () => false };
  await assert.rejects(
    () => authLogin(ARGS, resolveConfig({ env: "prod" }), { store: none, transport: async () => assert.fail("no request expected") }),
    (error: CliError) => error.code === "auth.keychain",
  );
});

test("auth status reports a stored OAuth login with its expiry", async (t) => {
  isolated(t);
  const { store } = memoryStore();
  writeOAuthEntry(store, ISSUER, stored);
  const { transport, requests } = server();
  const { io, data } = captureIO();
  await authStatus(ARGS, resolveConfig({ env: "prod" }), { store, transport, io });
  const me = requests.find((request) => request.url.endsWith("/people/me"));
  assert.equal(me?.headers.Authorization ?? me?.headers.authorization, "Bearer at_stored");
  const result = data();
  assert.equal(result.auth, "oauth");
  assert.equal(result.source, "oauth");
  assert.equal(result.token, "****ored");
  assert.equal(result.expires_at, stored.expires_at);
  assert.equal((result.identity as { email: string }).email, ME.email);
});

test("auth status reports a token the API rejects as invalid, not valid", async (t) => {
  isolated(t);
  const { store } = memoryStore();
  writeOAuthEntry(store, ISSUER, stored);
  const { io } = captureIO();
  await assert.rejects(
    () => authStatus(ARGS, resolveConfig({ env: "prod" }), { store, transport: server({ me: 401 }).transport, io }),
    (error: CliError) => error.code === "auth.invalid" && error.message === "Token check failed (401)",
  );
});

test("auth status with DEEL_TOKEN reports a PAT and leaves the stored login alone", async (t) => {
  isolated(t);
  process.env.DEEL_TOKEN = "pat_from_env";
  const { store } = memoryStore();
  writeOAuthEntry(store, ISSUER, stored);
  const { transport } = server();
  const { io, data } = captureIO();
  await authStatus(ARGS, resolveConfig({ env: "prod" }), { store, transport, io });
  const result = data();
  assert.equal(result.auth, "pat");
  assert.equal(result.source, "env");
  assert.equal("expires_at" in result, false);
});

test("auth status without any credential asks the user to sign in", async (t) => {
  isolated(t);
  const { io } = captureIO();
  await assert.rejects(
    () => authStatus(ARGS, resolveConfig({ env: "prod" }), { store: memoryStore().store, transport: async () => assert.fail("no request expected"), io }),
    (error: CliError) => error.code.startsWith("auth."),
  );
});

test("auth logout revokes the refresh token and removes the login", async (t) => {
  isolated(t);
  const { store, items } = memoryStore();
  writeOAuthEntry(store, ISSUER, stored);
  const { transport, requests } = server();
  const { io, data, err } = captureIO();
  await authLogout(ARGS, resolveConfig({ env: "prod" }), { store, transport, io });
  const revoke = requests.find((request) => request.url === METADATA.revocation_endpoint);
  assert.equal(new URLSearchParams(String(revoke?.body)).get("token"), "rt_stored");
  assert.deepEqual(data(), { removed: true, env: "prod", revoked: true });
  assert.equal(items.size, 0);
  assert.equal(err(), "");
});

test("auth logout says when the server could not revoke the login, and still removes it", async (t) => {
  isolated(t);
  const { store, items } = memoryStore();
  writeOAuthEntry(store, ISSUER, stored);
  const { io, data, err } = captureIO();
  await authLogout(ARGS, resolveConfig({ env: "prod" }), { store, transport: server({ revoke: 500 }).transport, io });
  assert.deepEqual(data(), { removed: true, env: "prod", revoked: false, revoke_error: "HTTP 500" });
  assert.equal(err(), "Could not revoke the login on the server (HTTP 500). It was removed from this machine, but its refresh token may stay valid until it expires.\n");
  assert.equal(items.size, 0);
});

test("auth logout says when the server has no revocation endpoint", async (t) => {
  isolated(t);
  const { store } = memoryStore();
  writeOAuthEntry(store, ISSUER, stored);
  const { revocation_endpoint: _omit, ...withoutRevocation } = METADATA;
  const { io, data, err } = captureIO();
  await authLogout(ARGS, resolveConfig({ env: "prod" }), { store, transport: server({ metadata: withoutRevocation }).transport, io });
  assert.deepEqual(data(), { removed: true, env: "prod", revoked: "unsupported" });
  assert.match(err(), /does not support revocation/);
});

// ---------------- the credential every API command sends ----------------

test("API commands refuse to send a stored login to a --base-url outside its environment", (t) => {
  isolated(t);
  const { store } = memoryStore();
  writeOAuthEntry(store, ISSUER, stored);
  assert.throws(
    () => commandToken({}, resolveConfig({ env: "prod", baseUrl: "https://other.example.test/rest" }), store),
    (error: CliError) => error.code === "auth.base_url",
  );
});

test("API commands send a stored login to its own environment, and DEEL_TOKEN as given", async (t) => {
  isolated(t);
  const { store } = memoryStore();
  writeOAuthEntry(store, ISSUER, stored);
  const provider = commandToken({}, resolveConfig({ env: "prod" }), store);
  assert.equal(typeof provider, "function");
  assert.equal(await (provider as () => Promise<string>)(), "at_stored");
  process.env.DEEL_TOKEN = "pat_from_env";
  assert.equal(commandToken({}, resolveConfig({ env: "prod", baseUrl: "https://other.example.test/rest" }), store), "pat_from_env");
});
