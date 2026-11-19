import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHUNK_SIZE, DEFAULT_TOKEN_LIFETIME_MS, LOCK_MAX_AGE_MS, discover, entryFromTokenResponse, isFresh, postForm, readOAuthEntry, removeStaleLock, withLock, writeOAuthEntry } from "../src/core/oauth.ts";
import type { HttpRequest, HttpResponse, Transport } from "../src/core/http.ts";
import { tempDir } from "./stubs.ts";
import type { CliError } from "../src/core/errors.ts";
import type { CredentialStore } from "../src/core/keychain.ts";
import type { OAuthEntry } from "../src/core/oauth.ts";

const ISSUER = "https://api.letsdeel.com";
// Keep any lock or log file out of the real log directory.
process.env.DEEL_LOG_DIR = mkdtempSync(join(tmpdir(), "deel-oauth-test-"));
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

test("an issuer mismatch names the reported issuer only when it is an https URL", async () => {
  await assert.rejects(
    () => discover(ISSUER, serving({ ...METADATA, issuer: "https://idp.example.test" })),
    (error: CliError) => /reports issuer "https:\/\/idp\.example\.test"/.test(error.message) && /--base-url on https:\/\/idp\.example\.test/.test(error.next ?? ""),
  );
  await assert.rejects(
    () => discover(ISSUER, serving({ ...METADATA, issuer: "\u001b[31mevil" })),
    (error: CliError) => /an unexpected issuer/.test(error.message) && !error.message.includes("\u001b") && error.next === "Refusing to continue.",
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

test("entryFromTokenResponse without expires_in keeps the rotated refresh token", () => {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const jwt = `${part({ alg: "RS256" })}.${part({ exp: 5000 })}.sig`;
  const fromExp = entryFromTokenResponse({ access_token: jwt, refresh_token: "r2" }, 1000);
  assert.equal(fromExp.refresh_token, "r2");
  assert.equal(fromExp.expires_at, new Date(5_000_000).toISOString());
  // An opaque token with no lifetime gets a short default, so it is not refreshed (and rotated) on every command.
  const opaque = entryFromTokenResponse({ access_token: "opaque", refresh_token: "r3" }, 1000);
  assert.equal(opaque.refresh_token, "r3");
  assert.equal(opaque.expires_at, new Date(1000 + DEFAULT_TOKEN_LIFETIME_MS).toISOString());
  assert.equal(isFresh(opaque, 1000), true);
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

test("withLock records its owner and steals a lock whose process is gone", async (t) => {
  const path = join(tempDir(t), "x.lock");
  await withLock(path, async () => assert.match(readFileSync(path, "utf8"), new RegExp(`^${process.pid}:[0-9a-f]{16}$`)));
  const gone = spawnSync(process.execPath, ["-e", ""]).pid as number; // exited by the time spawnSync returns
  writeFileSync(path, `${gone}:0123456789abcdef`);
  assert.equal(await withLock(path, async () => "ran", { waitMs: 500 }), "ran");
});

test("withLock waits for a live owner even past the no-owner stale age", async (t) => {
  const path = join(tempDir(t), "x.lock");
  writeFileSync(path, `${process.pid}:0123456789abcdef`);
  const old = new Date(Date.now() - 120_000);
  utimesSync(path, old, old);
  await assert.rejects(
    () => withLock(path, async () => "never", { staleMs: 30_000, waitMs: 150 }),
    (error: Error & { code?: string }) => error.code === "auth.lock",
  );
});

test("withLock never removes a lock another process has taken over", async (t) => {
  const path = join(tempDir(t), "x.lock");
  await withLock(path, async () => writeFileSync(path, "424242:fedcba9876543210")); // as if our lock had been stolen
  assert.equal(readFileSync(path, "utf8"), "424242:fedcba9876543210");
});

test("withLock gives up when a live lock is held past the wait limit", async (t) => {
  const path = join(tempDir(t), "x.lock");
  writeFileSync(path, "");
  await assert.rejects(
    () => withLock(path, async () => "never", { staleMs: 60_000, waitMs: 150 }),
    (error: Error & { code?: string }) => error.code === "auth.lock",
  );
});

test("withLock takes over a lock past the maximum age even when its owner pid is alive (the pid may be reused)", async (t) => {
  const path = join(tempDir(t), "x.lock");
  writeFileSync(path, `${process.pid}:0123456789abcdef`); // a live pid
  const ancient = new Date(Date.now() - LOCK_MAX_AGE_MS - 60_000);
  utimesSync(path, ancient, ancient);
  assert.equal(await withLock(path, async () => "ran", { waitMs: 150 }), "ran");
});

test("removing a stale lock deletes only the stale owner's file", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "x.lock");
  writeFileSync(path, "111:stale");
  removeStaleLock(path, "111:stale", "222:me");
  assert.equal(existsSync(path), false);
  assert.deepEqual(readdirSync(dir), []);
});

test("removing a stale lock puts back a fresh lock taken after the stale one was read", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "x.lock");
  writeFileSync(path, "333:fresh"); // another process removed the stale file and took the lock meanwhile
  removeStaleLock(path, "111:stale", "222:me");
  assert.equal(readFileSync(path, "utf8"), "333:fresh");
  assert.deepEqual(readdirSync(dir), ["x.lock"]);
});

// root can unlink in a read-only directory, so the failure cannot be set up there.
const asRoot = process.getuid?.() === 0;

test("withLock gives up, naming the file, when a stale lock cannot be removed", { skip: asRoot }, (t) => {
  const dir = tempDir(t);
  const path = join(dir, "x.lock");
  const gone = spawnSync(process.execPath, ["-e", ""]).pid as number;
  writeFileSync(path, `${gone}:0123456789abcdef`); // stale: its owner has exited
  chmodSync(dir, 0o555); // unlinkSync now fails with EACCES
  try {
    // In a child process with a deadline: a regression here spins synchronously, which no in-process timeout can stop.
    const script = `import { withLock } from ${JSON.stringify(new URL("../src/core/oauth.ts", import.meta.url).href)};
      try { await withLock(${JSON.stringify(path)}, async () => "never", { waitMs: 150 }); console.log("acquired"); }
      catch (error) { console.log(JSON.stringify({ code: error.code, message: error.message, next: error.next })); }`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10_000 });
    assert.equal(child.signal, null, "withLock did not return within 10 s");
    const error = JSON.parse(child.stdout) as CliError;
    assert.equal(error.code, "auth.lock");
    assert.ok(error.message.includes(path));
    assert.equal(error.next, "Delete the file and try again.");
  } finally {
    chmodSync(dir, 0o755); // before tempDir's cleanup removes it
  }
});

// ---------------- token requests and keychain writes ----------------

test("token requests are never retried: a replayed rotated refresh token would revoke the login", async () => {
  const requests: HttpRequest[] = [];
  const transport: Transport = async (request) => (requests.push(request), { status: 200, headers: {}, text: "", json: {} });
  await postForm(transport, METADATA.token_endpoint, { grant_type: "refresh_token", refresh_token: "rt", client_id: "c" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].retryable, false);
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].body, "grant_type=refresh_token&refresh_token=rt&client_id=c");
});

const stored: OAuthEntry = { v: 2, access_token: "at", refresh_token: "rt", expires_at: "2030-01-01T00:00:00.000Z" };

function memoryStore(): CredentialStore & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    available: () => true,
    get: (account) => items.get(account) ?? null,
    set: (account, value) => (items.set(account, value), true),
    remove: (account) => items.delete(account),
  };
}

test("a failed manifest write removes the new pieces and keeps the previous login", () => {
  const store = memoryStore();
  writeOAuthEntry(store, ISSUER, stored);
  const before = new Map(store.items);
  const manifest = `oauth:${ISSUER}`;
  const failing: CredentialStore = { ...store, set: (account, value) => (account === manifest ? false : store.set(account, value)) };
  const larger = { ...stored, access_token: "a".repeat(CHUNK_SIZE * 2) }; // several new pieces before the manifest
  assert.equal(writeOAuthEntry(failing, ISSUER, larger), false);
  assert.deepEqual(store.items, before);
  assert.deepEqual(readOAuthEntry(store, ISSUER), stored);
});

test("a login too large for the keychain is not written at all", () => {
  const store = memoryStore();
  writeOAuthEntry(store, ISSUER, stored);
  const before = new Map(store.items);
  assert.equal(writeOAuthEntry(store, ISSUER, { ...stored, access_token: "a".repeat(CHUNK_SIZE * 65) }), false);
  assert.deepEqual(store.items, before);
});
