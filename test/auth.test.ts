import { test } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { resolveToken, requireToken, authFor, accessTokenScope, maskToken, redactHeaders } from "../src/core/auth.ts";
import { resolveConfig } from "../src/core/config.ts";
import { CliError } from "../src/core/errors.ts";
import type { HttpResponse, Transport } from "../src/core/http.ts";
import type { CredentialStore } from "../src/core/keychain.ts";
import { readOAuthEntry, writeOAuthEntry } from "../src/core/oauth.ts";
import type { OAuthEntry } from "../src/core/oauth.ts";
import { tempDir } from "./stubs.ts";

const fakeStore = (token: string | null): CredentialStore => ({
  available: () => true,
  get: () => token,
  set: () => true,
  remove: () => true,
});

function withEnv(vars: Record<string, string | undefined>, body: () => void) {
  const keys = ["DEEL_TOKEN"];
  const saved: Record<string, string | undefined> = {};
  for (const key of keys) saved[key] = process.env[key];
  for (const key of keys) delete process.env[key];
  for (const [key, value] of Object.entries(vars)) if (value !== undefined) process.env[key] = value;
  try {
    body();
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("maskToken keeps only the last four characters", () => {
  assert.equal(maskToken("pat_ABCD1234"), "****1234");
  assert.equal(maskToken("abcd"), "****");
});

test("redactHeaders masks Authorization case-insensitively", () => {
  assert.deepEqual(redactHeaders({ Authorization: "Bearer secret", accept: "application/json" }), {
    Authorization: "Bearer ***",
    accept: "application/json",
  });
});

test("resolveToken reads DEEL_TOKEN from the environment", () => {
  withEnv({ DEEL_TOKEN: "tok_env" }, () => {
    assert.deepEqual(resolveToken({}), { token: "tok_env", source: "env" });
  });
});

test("resolveToken trims the environment token", () => {
  withEnv({ DEEL_TOKEN: "  tok_env  " }, () => {
    assert.equal(resolveToken({}).token, "tok_env");
  });
});

test("resolveToken falls back to the keychain when stdin/env are absent", () => {
  withEnv({}, () => {
    assert.deepEqual(resolveToken({ env: "prod", store: fakeStore("tok_kc") }), { token: "tok_kc", source: "keychain" });
  });
});

test("DEEL_TOKEN takes precedence over the keychain", () => {
  withEnv({ DEEL_TOKEN: "tok_env" }, () => {
    assert.equal(resolveToken({ env: "prod", store: fakeStore("tok_kc") }).source, "env");
  });
});

test("resolveToken reports none when nothing is stored", () => {
  withEnv({}, () => {
    assert.deepEqual(resolveToken({ env: "prod", store: fakeStore(null) }), { token: null, source: "none" });
  });
});

test("requireToken throws a helpful auth error when absent", () => {
  assert.throws(() => requireToken({ token: null, source: "none" }), /No API token found/);
  assert.equal(requireToken({ token: "t", source: "env" }), "t");
});

// ---------------- OAuth login in the keychain ----------------

const NOW = Date.parse("2030-01-01T00:00:00.000Z");
const CONFIG = resolveConfig({ env: "prod" });
const ISSUER = "https://api.letsdeel.com";

function entryAt(expiresInMs: number, over: Partial<OAuthEntry> = {}): OAuthEntry {
  return {
    v: 2,
    access_token: "at_old",
    refresh_token: "rt_old",
    expires_at: new Date(NOW + expiresInMs).toISOString(),
    ...over,
  };
}

// An in-memory keychain keyed by account, like the real one.
function memoryStore(initial: { oauth?: OAuthEntry; pat?: string } = {}) {
  const items = new Map<string, string>();
  const store: CredentialStore = {
    available: () => true,
    get: (account) => items.get(account) ?? null,
    set: (account, value) => (items.set(account, value), true),
    remove: (account) => items.delete(account),
  };
  if (initial.oauth) writeOAuthEntry(store, ISSUER, initial.oauth);
  if (initial.pat) items.set("prod", initial.pat);
  return { store, items };
}

const METADATA = {
  issuer: "https://api.letsdeel.com",
  authorization_endpoint: "https://api.letsdeel.com/oauth/authorize",
  token_endpoint: "https://api.letsdeel.com/oauth/tokens",
  scopes_supported: ["people:read"],
};

function oauthTransport(onRefresh: (body: URLSearchParams) => HttpResponse) {
  const refreshes: URLSearchParams[] = [];
  const transport: Transport = async (request) => {
    if (request.url.endsWith("/.well-known/oauth-authorization-server")) return { status: 200, headers: {}, text: "", json: METADATA };
    assert.equal(request.url, METADATA.token_endpoint);
    const body = new URLSearchParams(String(request.body));
    refreshes.push(body);
    await new Promise((resolve) => setTimeout(resolve, 20)); // keep the refresh in flight a moment
    return onRefresh(body);
  };
  return { transport, refreshes };
}

const tokenResponse = (json: unknown, status = 200): HttpResponse => ({ status, headers: {}, text: "", json });

function withLockDir(t: TestContext) {
  const saved = process.env.DEEL_LOG_DIR;
  process.env.DEEL_LOG_DIR = tempDir(t);
  t.after(() => {
    if (saved === undefined) delete process.env.DEEL_LOG_DIR;
    else process.env.DEEL_LOG_DIR = saved;
  });
}

test("a JSON keychain entry is an OAuth login; a raw string stays a legacy PAT", () => {
  withEnv({}, () => {
    const oauth = resolveToken({ config: CONFIG, store: memoryStore({ oauth: entryAt(3_600_000) }).store });
    assert.equal(oauth.source, "oauth");
    assert.equal(oauth.token, "at_old");
    const legacy = resolveToken({ config: CONFIG, store: memoryStore({ pat: "pat_legacy" }).store });
    assert.deepEqual(legacy, { token: "pat_legacy", source: "keychain" });
  });
});

test("DEEL_TOKEN still beats an OAuth keychain entry", () => {
  withEnv({ DEEL_TOKEN: "tok_env" }, () => {
    const { store } = memoryStore({ oauth: entryAt(3_600_000) });
    assert.equal(resolveToken({ config: CONFIG, store }).source, "env");
  });
});

test("an OAuth login is refused for a base URL on another host", () => {
  withEnv({}, () => {
    const { store } = memoryStore({ oauth: entryAt(3_600_000) });
    const other = resolveConfig({ env: "prod", baseUrl: "https://other.example.test/rest" });
    assert.throws(() => resolveToken({ config: other, store }), (error: CliError) => error.code === "auth.base_url");
  });
});

test("a legacy PAT is still sent to a --base-url override (unchanged behaviour)", () => {
  withEnv({}, () => {
    const { store } = memoryStore({ pat: "pat_legacy" });
    const other = resolveConfig({ env: "prod", baseUrl: "https://other.example.test/rest" });
    assert.equal(resolveToken({ config: other, store }).source, "keychain");
  });
});

test("a login stored for another issuer is not found", () => {
  withEnv({ DEEL_OAUTH_ISSUER: "https://elsewhere.example.test" }, () => {
    const { store } = memoryStore({ oauth: entryAt(3_600_000) });
    assert.equal(resolveToken({ config: resolveConfig({ env: "prod" }), store }).source, "none");
  });
});

function jwt(claims: unknown): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256" })}.${part(claims)}.signature`;
}

test("accessTokenScope reads the scope claim without verifying the token", () => {
  assert.equal(accessTokenScope(jwt({ scope: "people:read contracts:read" })), "people:read contracts:read");
  assert.equal(accessTokenScope(jwt({ scope: ["a", "b"] })), "a b");
});

test("accessTokenScope gives null when the token cannot be decoded or has no scope", () => {
  assert.equal(accessTokenScope("opaque-token"), null);
  assert.equal(accessTokenScope("a.%%%.c"), null);
  assert.equal(accessTokenScope(jwt({ sub: "1" })), null);
  assert.equal(accessTokenScope(jwt({ scope: 5 })), null);
});

test("a fresh access token is used without any network call", async (t) => {
  withLockDir(t);
  const { store } = memoryStore({ oauth: entryAt(3_600_000) });
  const { transport, refreshes } = oauthTransport(() => assert.fail("should not refresh"));
  const resolved = resolveToken({ config: CONFIG, store, transport, now: () => NOW });
  assert.equal(await (authFor(resolved) as () => Promise<string>)(), "at_old");
  assert.equal(refreshes.length, 0);
});

test("an access token near expiry is refreshed and the rotated login is stored", async (t) => {
  withLockDir(t);
  const { store, items } = memoryStore({ oauth: entryAt(30_000) });
  const { transport, refreshes } = oauthTransport(() => tokenResponse({ access_token: "at_new", refresh_token: "rt_new", expires_in: 3600, scope: "people:read" }));
  const resolved = resolveToken({ config: CONFIG, store, transport, now: () => NOW });
  assert.equal(await (authFor(resolved) as () => Promise<string>)(), "at_new");
  assert.equal(refreshes.length, 1);
  assert.equal(refreshes[0].get("grant_type"), "refresh_token");
  assert.equal(refreshes[0].get("refresh_token"), "rt_old");
  assert.equal(refreshes[0].get("client_id"), CONFIG.clientId);
  const stored = readOAuthEntry(store, ISSUER) as OAuthEntry;
  assert.equal(stored.refresh_token, "rt_new");
  assert.equal(stored.expires_at, new Date(NOW + 3_600_000).toISOString());
  assert.equal(resolved.oauth?.current().access_token, "at_new");
});

test("two concurrent callers, in one process or two, cause exactly one network refresh", async (t) => {
  withLockDir(t);
  const { store } = memoryStore({ oauth: entryAt(10_000) });
  const { transport, refreshes } = oauthTransport(() => tokenResponse({ access_token: "at_new", refresh_token: "rt_new", expires_in: 3600 }));
  // Two resolutions over one keychain stand for two deel processes sharing the lock directory.
  const first = resolveToken({ config: CONFIG, store, transport, now: () => NOW });
  const second = resolveToken({ config: CONFIG, store, transport, now: () => NOW });
  const tokens = await Promise.all([
    (authFor(first) as () => Promise<string>)(),
    (authFor(first) as () => Promise<string>)(),
    (authFor(second) as () => Promise<string>)(),
  ]);
  assert.deepEqual(tokens, ["at_new", "at_new", "at_new"]);
  assert.equal(refreshes.length, 1);
});

test("invalid_grant on refresh removes the login and asks the user to sign in again", async (t) => {
  withLockDir(t);
  const { store, items } = memoryStore({ oauth: entryAt(0) });
  const { transport } = oauthTransport(() => tokenResponse({ error: "invalid_grant" }, 400));
  const resolved = resolveToken({ config: CONFIG, store, transport, now: () => NOW });
  await assert.rejects(
    () => (authFor(resolved) as () => Promise<string>)(),
    (error: CliError) => error.code === "auth.expired" && error.next === "deel auth login",
  );
  assert.equal(readOAuthEntry(store, ISSUER), null);
  assert.equal([...items.keys()].some((key) => key.startsWith("oauth:")), false);
});

test("a transient refresh failure keeps the login", async (t) => {
  withLockDir(t);
  const { store, items } = memoryStore({ oauth: entryAt(0) });
  const { transport } = oauthTransport(() => tokenResponse({ error: "server_error" }, 503));
  const resolved = resolveToken({ config: CONFIG, store, transport, now: () => NOW });
  await assert.rejects(() => (authFor(resolved) as () => Promise<string>)(), (error: CliError) => error.code === "auth.refresh");
  assert.notEqual(readOAuthEntry(store, ISSUER), null);
});

test("a login removed by another process while waiting is reported as expired", async (t) => {
  withLockDir(t);
  const { store, items } = memoryStore({ oauth: entryAt(0) });
  const { transport } = oauthTransport(() => assert.fail("must not refresh"));
  const resolved = resolveToken({ config: CONFIG, store, transport, now: () => NOW });
  for (const key of [...items.keys()]) items.delete(key);
  await assert.rejects(() => (authFor(resolved) as () => Promise<string>)(), (error: CliError) => error.code === "auth.expired");
});

test("a failed write of the rotated login drops the spent entry", async (t) => {
  withLockDir(t);
  const { store, items } = memoryStore({ oauth: entryAt(0) });
  const failing: CredentialStore = { ...store, set: () => false };
  const { transport } = oauthTransport(() => tokenResponse({ access_token: "a", refresh_token: "b", expires_in: 60 }));
  const resolved = resolveToken({ config: CONFIG, store: failing, transport, now: () => NOW });
  await assert.rejects(() => (authFor(resolved) as () => Promise<string>)(), (error: CliError) => error.code === "auth.keychain");
  assert.equal(readOAuthEntry(store, ISSUER), null);
  assert.equal([...items.keys()].some((key) => key.startsWith("oauth:")), false);
});
