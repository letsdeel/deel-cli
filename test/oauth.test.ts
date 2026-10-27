import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { discover, entryFromTokenResponse, isFresh, readOAuthEntry, withLock, writeOAuthEntry } from "../src/core/oauth.ts";
import type { HttpResponse, Transport } from "../src/core/http.ts";
import { tempDir } from "./stubs.ts";
import { authorizationUrl, browserLogin, ownsLegacyPat, removeStoredLogin, challengeFor, chooseScopes, newState, newVerifier, revokeLogin, startLoopback } from "../src/core/oauth-login.ts";
import { resolveConfig } from "../src/core/config.ts";
import type { CredentialStore } from "../src/core/keychain.ts";
import type { OAuthEntry } from "../src/core/oauth.ts";

const ISSUER = "https://api.letsdeel.com";
const METADATA = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/oauth/authorize`,
  token_endpoint: `${ISSUER}/oauth/tokens`,
  revocation_endpoint: `${ISSUER}/oauth/revoke`,
  scopes_supported: ["people:read", "contracts:read"],
};

const serving = (json: unknown, status = 200): Transport => async () => ({ status, headers: {}, text: "", json }) as HttpResponse;

test("discovery returns the endpoints when the issuer matches", async () => {
  const metadata = await discover(ISSUER, serving(METADATA));
  assert.equal(metadata.token_endpoint, `${ISSUER}/oauth/tokens`);
  assert.equal(metadata.revocation_endpoint, `${ISSUER}/oauth/revoke`);
  assert.deepEqual(metadata.scopes_supported, ["people:read", "contracts:read"]);
});

test("discovery requests the well-known document of the configured issuer", async () => {
  const urls: string[] = [];
  await discover(ISSUER, async (request) => (urls.push(request.url), { status: 200, headers: {}, text: "", json: METADATA }));
  assert.deepEqual(urls, [`${ISSUER}/.well-known/oauth-authorization-server`]);
});

test("discovery rejects metadata whose issuer differs from the configured one", async () => {
  await assert.rejects(
    () => discover(ISSUER, serving({ ...METADATA, issuer: "https://evil.example.test" })),
    (error: Error & { code?: string }) => error.code === "oauth.issuer",
  );
});

test("discovery rejects a failed response and insecure endpoints", async () => {
  await assert.rejects(() => discover(ISSUER, serving({}, 500)), /Could not read/);
  await assert.rejects(() => discover(ISSUER, serving({ ...METADATA, token_endpoint: "http://api.letsdeel.com/oauth/tokens" })), /usable https/);
});

test("discovery treats the revocation endpoint as optional", async () => {
  const { revocation_endpoint: _omit, ...without } = METADATA;
  assert.equal((await discover(ISSUER, serving(without))).revocation_endpoint, undefined);
});

test("entryFromTokenResponse computes the expiry and keeps the old refresh token when none is returned", () => {
  const fresh = entryFromTokenResponse({ access_token: "a", refresh_token: "r", expires_in: 60, scope: "x y" }, 1000);
  assert.deepEqual(fresh, { v: 2, access_token: "a", refresh_token: "r", expires_at: new Date(61_000).toISOString() });
  const kept = entryFromTokenResponse({ access_token: "a2", expires_in: 60 }, 1000, fresh);
  assert.equal(kept.refresh_token, "r");
  assert.throws(() => entryFromTokenResponse({ access_token: "a" }, 0), /missing/);
});

test("isFresh uses a 60 second skew", () => {
  const entry = entryFromTokenResponse({ access_token: "a", refresh_token: "r", expires_in: 100 }, 0);
  assert.equal(isFresh(entry, 39_000), true);
  assert.equal(isFresh(entry, 41_000), false);
});

test("withLock removes the lock afterwards, even when the body throws", async (t) => {
  const path = join(tempDir(t), "x.lock");
  await withLock(path, async () => assert.equal(existsSync(path), true));
  assert.equal(existsSync(path), false);
  await assert.rejects(() => withLock(path, async () => Promise.reject(new Error("boom"))), /boom/);
  assert.equal(existsSync(path), false);
});

test("withLock steals a stale lock", async (t) => {
  const path = join(tempDir(t), "x.lock");
  writeFileSync(path, "");
  const old = new Date(Date.now() - 120_000);
  utimesSync(path, old, old);
  assert.equal(await withLock(path, async () => "ran", { staleMs: 30_000 }), "ran");
});

test("withLock gives up when a live lock is held past the wait limit", async (t) => {
  const path = join(tempDir(t), "x.lock");
  writeFileSync(path, "");
  await assert.rejects(
    () => withLock(path, async () => "never", { staleMs: 60_000, waitMs: 150 }),
    (error: Error & { code?: string }) => error.code === "auth.lock",
  );
});

// ---------------- PKCE and the loopback listener ----------------


test("S256 challenge matches the RFC 7636 Appendix B vector", () => {
  assert.equal(challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("verifiers are 43 base64url characters and never repeat", () => {
  const verifier = newVerifier();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(verifier, newVerifier());
  assert.notEqual(newState(), newState());
});

const get = (url: string, headers?: Record<string, string>) => fetch(url, { headers });

test("the listener accepts one callback, returns the code and then closes", async () => {
  const loopback = await startLoopback({ state: "s1", issuer: ISSUER });
  assert.match(loopback.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  const response = await get(`${loopback.redirectUri}?code=abc&state=s1&iss=${encodeURIComponent(ISSUER)}`);
  assert.equal(response.status, 200);
  const page = await response.text();
  assert.match(page, /You can close this window/);
  assert.deepEqual(await loopback.result, { code: "abc" });
  // The server is closed after the first callback: a second request is refused outright.
  await assert.rejects(() => get(`${loopback.redirectUri}?code=other&state=s1`));
});

test("the callback page never reflects input", async () => {
  const loopback = await startLoopback({ state: "s1", issuer: ISSUER });
  const page = await (await get(`${loopback.redirectUri}?code=%3Cscript%3E&state=s1`)).text();
  assert.doesNotMatch(page, /script/);
  await loopback.result;
});

test("a wrong path is a 404 and does not consume the callback", async () => {
  const loopback = await startLoopback({ state: "s1", issuer: ISSUER });
  const base = loopback.redirectUri.replace("/callback", "");
  assert.equal((await get(`${base}/other?code=x&state=s1`)).status, 404);
  assert.equal((await get(`${base}/`)).status, 404);
  assert.equal((await fetch(loopback.redirectUri, { method: "POST" })).status, 405);
  assert.equal((await get(`${loopback.redirectUri}?code=ok&state=s1`)).status, 200);
  assert.deepEqual(await loopback.result, { code: "ok" });
});

test("a request with a foreign Host header is refused", async () => {
  const loopback = await startLoopback({ state: "s1", issuer: ISSUER });
  const { request } = await import("node:http");
  const status = await new Promise<number>((resolve, reject) => {
    const url = new URL(loopback.redirectUri);
    const req = request({ host: "127.0.0.1", port: url.port, path: "/callback?code=x&state=s1", headers: { host: "evil.example.test" } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 404);
  assert.equal((await get(`${loopback.redirectUri}?code=ok&state=s1`)).status, 200);
  await loopback.result;
});

test("a state mismatch is rejected", async () => {
  const loopback = await startLoopback({ state: "expected", issuer: ISSUER });
  const outcome = assert.rejects(loopback.result, (error: Error & { code?: string }) => error.code === "oauth.state");
  assert.equal((await get(`${loopback.redirectUri}?code=abc&state=forged`)).status, 400);
  await outcome;
});

test("a missing state is rejected", async () => {
  const loopback = await startLoopback({ state: "expected", issuer: ISSUER });
  const outcome = assert.rejects(loopback.result, (error: Error & { code?: string }) => error.code === "oauth.state");
  await get(`${loopback.redirectUri}?code=abc`);
  await outcome;
});

test("an iss mismatch is rejected", async () => {
  const loopback = await startLoopback({ state: "s1", issuer: ISSUER });
  const outcome = assert.rejects(loopback.result, (error: Error & { code?: string }) => error.code === "oauth.issuer");
  await get(`${loopback.redirectUri}?code=abc&state=s1&iss=${encodeURIComponent("https://evil.example.test")}`);
  await outcome;
});

test("an error parameter is reported with printable text only", async () => {
  const loopback = await startLoopback({ state: "s1", issuer: ISSUER });
  const outcome = assert.rejects(loopback.result, (error: Error & { code?: string }) => {
    assert.equal(error.code, "oauth.denied");
    assert.match(error.message, /access_denied \(user said no/);
    assert.doesNotMatch(error.message, /\u001b/);
    return true;
  });
  await get(`${loopback.redirectUri}?error=access_denied&error_description=${encodeURIComponent("user said no\u001b[31m")}&state=s1`);
  await outcome;
});

test("a callback without a code is rejected", async () => {
  const loopback = await startLoopback({ state: "s1", issuer: ISSUER });
  const outcome = assert.rejects(loopback.result, (error: Error & { code?: string }) => error.code === "oauth.callback");
  await get(`${loopback.redirectUri}?state=s1`);
  await outcome;
});

test("the listener gives up after the timeout and frees the port", async () => {
  const loopback = await startLoopback({ state: "s1", issuer: ISSUER, timeoutMs: 40 });
  await assert.rejects(loopback.result, (error: Error & { code?: string }) => error.code === "oauth.timeout");
  await assert.rejects(() => get(`${loopback.redirectUri}?code=late&state=s1`));
});

// ---------------- scopes and the full flow ----------------

test("scope selection: all by default, narrowed by --scopes, read-only by --read-only", () => {
  const supported = ["people:read", "people:write", "contracts:read"];
  assert.deepEqual(chooseScopes(supported, undefined, false), supported);
  assert.deepEqual(chooseScopes(supported, "people:read, contracts:read", false), ["people:read", "contracts:read"]);
  assert.deepEqual(chooseScopes(supported, undefined, true), ["people:read", "contracts:read"]);
  assert.deepEqual(chooseScopes(supported, "people:write,people:read", true), ["people:read"]);
  assert.throws(() => chooseScopes(supported, "nope:read", false), /Unknown scope/);
  assert.throws(() => chooseScopes(["a:write"], undefined, true), /No scopes left/);
  assert.deepEqual(chooseScopes([], undefined, false), []);
});

test("the default and --read-only scopes leave out the OIDC scopes", () => {
  const supported = ["openid", "openid-profile:read", "openid-email:read", "people:read", "people:write", "contracts:read"];
  assert.deepEqual(chooseScopes(supported, undefined, false), ["people:read", "people:write", "contracts:read"]);
  assert.deepEqual(chooseScopes(supported, undefined, true), ["people:read", "contracts:read"]);
  assert.deepEqual(chooseScopes(supported, "openid,people:read", false), ["openid", "people:read"]);
});

test("the authorization URL carries PKCE S256 and the loopback redirect", () => {
  const url = new URL(
    authorizationUrl(
      { ...METADATA, token_endpoint: "https://x/t", scopes_supported: [] },
      { clientId: "cid", redirectUri: "http://127.0.0.1:5000/callback", scopes: ["a", "b"], state: "st", challenge: "ch" },
    ),
  );
  assert.equal(url.origin + url.pathname, METADATA.authorization_endpoint);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:5000/callback");
  assert.equal(url.searchParams.get("scope"), "a b");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), "ch");
});

function memoryStore(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  const store: CredentialStore = {
    available: () => true,
    get: (account) => items.get(account) ?? null,
    set: (account, value) => (items.set(account, value), true),
    remove: (account) => items.delete(account),
  };
  return { store, items };
}

function loginTransport(tokenResponse: (form: URLSearchParams) => HttpResponse) {
  const forms: URLSearchParams[] = [];
  const transport: Transport = async (request) => {
    if (request.url.endsWith("/.well-known/oauth-authorization-server")) return { status: 200, headers: {}, text: "", json: METADATA };
    forms.push(new URLSearchParams(String(request.body)));
    return tokenResponse(forms[forms.length - 1]);
  };
  return { transport, forms };
}

const config = resolveConfig({ env: "prod" });

test("browserLogin runs the whole flow, stores the login and drops a legacy PAT", async () => {
  const { store, items } = memoryStore({ prod: "pat_legacy" });
  const { transport, forms } = loginTransport(() => ({
    status: 200,
    headers: {},
    text: "",
    json: { access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "people:read contracts:read" },
  }));
  let authorizeUrl = "";
  const said: string[] = [];
  const entry = await browserLogin({
    config,
    store,
    transport,
    say: (text) => said.push(text),
    now: () => 0,
    openUrl: (url) => {
      authorizeUrl = url;
      const parsed = new URL(url);
      // Stand in for the browser: follow the redirect back to the listener.
      void get(`${parsed.searchParams.get("redirect_uri")}?code=the-code&state=${parsed.searchParams.get("state")}&iss=${encodeURIComponent(ISSUER)}`);
    },
  });
  const challenge = new URL(authorizeUrl).searchParams.get("code_challenge");
  assert.equal(new URL(authorizeUrl).searchParams.get("scope"), "people:read contracts:read");
  assert.equal(forms.length, 1);
  assert.equal(forms[0].get("grant_type"), "authorization_code");
  assert.equal(forms[0].get("code"), "the-code");
  assert.equal(forms[0].get("client_id"), config.clientId);
  assert.equal(forms[0].get("redirect_uri"), new URL(authorizeUrl).searchParams.get("redirect_uri"));
  assert.equal(challengeFor(forms[0].get("code_verifier") as string), challenge);
  assert.equal(entry.refresh_token, "rt");
  assert.equal(readOAuthEntry(store, ISSUER)?.access_token, "at");
  assert.equal(items.has("prod"), false);
  assert.match(said.join(""), /Open this URL/);
});

test("browserLogin with --no-browser only prints the URL", async () => {
  const { store } = memoryStore();
  const { transport } = loginTransport(() => ({ status: 200, headers: {}, text: "", json: { access_token: "at", refresh_token: "rt", expires_in: 60 } }));
  let opened = false;
  const entry = await browserLogin({
    config,
    store,
    transport,
    open: false,
    openUrl: () => (opened = true),
    say: (text) => {
      const match = /(https:\/\/\S+)/.exec(text);
      if (!match) return;
      const parsed = new URL(match[1]);
      void get(`${parsed.searchParams.get("redirect_uri")}?code=c&state=${parsed.searchParams.get("state")}`);
    },
  });
  assert.equal(opened, false);
  assert.equal(entry.access_token, "at");
});

test("browserLogin surfaces a token endpoint error and stores nothing", async () => {
  const { store, items } = memoryStore();
  const { transport } = loginTransport(() => ({ status: 400, headers: {}, text: "", json: { error: "invalid_grant", error_description: "bad code" } }));
  await assert.rejects(
    () =>
      browserLogin({
        config,
        store,
        transport,
        say: () => {},
        openUrl: (url) => {
          const parsed = new URL(url);
          void get(`${parsed.searchParams.get("redirect_uri")}?code=c&state=${parsed.searchParams.get("state")}`);
        },
      }),
    /invalid_grant: bad code/,
  );
  assert.equal(items.size, 0);
});

test("browserLogin rejects discovery whose issuer differs, before opening anything", async () => {
  const { store } = memoryStore();
  let opened = false;
  await assert.rejects(
    () =>
      browserLogin({
        config,
        store,
        transport: serving({ ...METADATA, issuer: "https://evil.example.test" }),
        say: () => {},
        openUrl: () => (opened = true),
      }),
    (error: Error & { code?: string }) => error.code === "oauth.issuer",
  );
  assert.equal(opened, false);
});

test("browserLogin needs an issuer", async () => {
  const unknown = { ...config, issuer: null };
  await assert.rejects(() => browserLogin({ config: unknown, store: memoryStore().store, transport: serving(METADATA), say: () => {} }), /No OAuth issuer/);
});

const SERVER = { issuer: ISSUER, clientId: "c" };
const sample: OAuthEntry = {
  v: 2,
  access_token: "at",
  refresh_token: "rt",
  expires_at: "2030-01-01T00:00:00.000Z",
};

test("revokeLogin posts the refresh token to the revocation endpoint", async () => {
  const forms: URLSearchParams[] = [];
  const transport: Transport = async (request) => {
    if (request.url.endsWith("/.well-known/oauth-authorization-server")) return { status: 200, headers: {}, text: "", json: METADATA };
    assert.equal(request.url, METADATA.revocation_endpoint);
    forms.push(new URLSearchParams(String(request.body)));
    return { status: 200, headers: {}, text: "", json: undefined };
  };
  assert.equal(await revokeLogin(sample, SERVER, transport), true);
  assert.equal(forms[0].get("token"), "rt");
  assert.equal(forms[0].get("token_type_hint"), "refresh_token");
  assert.equal(forms[0].get("client_id"), "c");
});

test("revokeLogin reports unsupported, failed and unreachable servers", async () => {
  const { revocation_endpoint: _omit, ...without } = METADATA;
  assert.equal(await revokeLogin(sample, SERVER, serving(without)), "unsupported");
  const failing: Transport = async (request) =>
    request.url.endsWith("/.well-known/oauth-authorization-server")
      ? { status: 200, headers: {}, text: "", json: METADATA }
      : { status: 500, headers: {}, text: "", json: {} };
  assert.equal(await revokeLogin(sample, SERVER, failing), false);
  assert.equal(await revokeLogin(sample, SERVER, async () => Promise.reject(new Error("offline"))), false);
});

// ---------------- the legacy PAT belongs to the environment's own server ----------------

function withEnvVar(name: string, value: string, body: () => Promise<void> | void) {
  return async () => {
    const saved = process.env[name];
    process.env[name] = value;
    try {
      await body();
    } finally {
      if (saved === undefined) delete process.env[name];
      else process.env[name] = saved;
    }
  };
}

test("ownsLegacyPat is true only for the built-in issuer on its own API host", () => {
  assert.equal(ownsLegacyPat(resolveConfig({ env: "prod" })), true);
  assert.equal(ownsLegacyPat(resolveConfig({ env: "prod", baseUrl: "https://other.example.test/rest" })), false);
});

test("logout on the built-in issuer removes the login and the legacy PAT", () => {
  const { store, items } = memoryStore({ prod: "pat_legacy" });
  writeOAuthEntry(store, ISSUER, { v: 2, access_token: "a", refresh_token: "r", expires_at: "2030-01-01T00:00:00.000Z" });
  assert.equal(removeStoredLogin(store, resolveConfig({ env: "prod" })), true);
  assert.equal(items.size, 0);
});

test(
  "with an issuer override, logout keeps the legacy PAT and does not count it as removed",
  withEnvVar("DEEL_OAUTH_ISSUER", "https://idp.example.test", () => {
    const { store, items } = memoryStore({ prod: "pat_legacy" });
    assert.equal(removeStoredLogin(store, resolveConfig({ env: "prod" })), false);
    assert.equal(items.get("prod"), "pat_legacy");
    writeOAuthEntry(store, "https://idp.example.test", { v: 2, access_token: "a", refresh_token: "r", expires_at: "2030-01-01T00:00:00.000Z" });
    assert.equal(removeStoredLogin(store, resolveConfig({ env: "prod" })), true);
    assert.equal(items.get("prod"), "pat_legacy");
  }),
);

test(
  "with an issuer override, login keeps the legacy PAT",
  withEnvVar("DEEL_OAUTH_ISSUER", "https://idp.example.test", async () => {
    const { store, items } = memoryStore({ prod: "pat_legacy" });
    const meta = { ...METADATA, issuer: "https://idp.example.test", authorization_endpoint: "https://idp.example.test/oauth/authorize", token_endpoint: "https://idp.example.test/oauth/tokens" };
    const transport: Transport = async (request) =>
      request.url.endsWith("/.well-known/oauth-authorization-server")
        ? { status: 200, headers: {}, text: "", json: meta }
        : { status: 200, headers: {}, text: "", json: { access_token: "at", refresh_token: "rt", expires_in: 60 } };
    await browserLogin({
      config: resolveConfig({ env: "prod" }),
      store,
      transport,
      say: () => {},
      openUrl: (url) => {
        const parsed = new URL(url);
        void get(`${parsed.searchParams.get("redirect_uri")}?code=c&state=${parsed.searchParams.get("state")}`);
      },
    });
    assert.equal(items.get("prod"), "pat_legacy");
    assert.equal(readOAuthEntry(store, "https://idp.example.test")?.access_token, "at");
  }),
);
