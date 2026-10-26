import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { discover, entryFromTokenResponse, isFresh, withLock } from "../src/core/oauth.ts";
import type { HttpResponse, Transport } from "../src/core/http.ts";
import { tempDir } from "./stubs.ts";

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
