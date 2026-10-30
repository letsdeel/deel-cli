// OAuth 2.0 client plumbing shared by `deel auth` and the token provider:
// server discovery, the stored credential, and refresh-token rotation under a cross-process lock.

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, openSync, closeSync, writeSync, readFileSync, unlinkSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { CliError } from "./errors.ts";
import { HEADER } from "./constants.ts";
import { logLocation } from "./logging.ts";
import type { CredentialStore } from "./keychain.ts";
import type { HttpResponse, Transport } from "./http.ts";

export const REFRESH_SKEW_MS = 60_000; // refresh when the access token has less than this left
export const LOCK_STALE_MS = 30_000; // a lock file with no owner recorded and older than this was left by a crash
export const LOCK_MAX_AGE_MS = 5 * 60_000; // past this a lock is stale even if its pid is alive (the pid may have been reused)
export const LOCK_WAIT_MS = 35_000; // how long to wait for another process's refresh
const LOCK_POLL_MS = 100;
const OAUTH_REQUEST_TIMEOUT_MS = 15_000;

// ---------------- stored credential ----------------

// What is stored is only what the token endpoint returns that cannot be recomputed. The issuer is the key
// (see oauthAccount), the client id comes from config, and the scope is read from the access token.
export type OAuthEntry = {
  v: 2;
  access_token: string;
  refresh_token: string;
  expires_at: string; // ISO-8601
};

// The keychain account is derived from the full issuer, which binds a login to its server: another configured
// issuer (for example through DEEL_OAUTH_ISSUER, including another path on the same host) simply finds no login.
const issuerKey = (issuer: string): string => new URL(issuer).href.replace(/\/+$/, "");
export const oauthAccount = (issuer: string): string => `oauth:${issuerKey(issuer)}`;

function isEntry(value: unknown): value is OAuthEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    entry.v === 2 && ["access_token", "refresh_token", "expires_at"].every((key) => typeof entry[key] === "string" && entry[key] !== "")
  );
}

// The entry is stored in pieces: `security -i` truncates a command line at about 4 KB, and a login that
// carries every scope easily exceeds that. `oauth:<issuer>` holds a small manifest naming a generation; the JSON
// text lives in `oauth:<issuer>#<generation>.0..N-1`. Every write uses a new generation and switches the manifest
// last, so a reader that runs without the lock never combines pieces of two logins. Tokens are never passed in argv.
export const CHUNK_SIZE = 3000; // characters per item before quoting; keeps each `security -i` line well under 4 KB
const MAX_CHUNKS = 64;
type Manifest = { chunks: number; gen: string };
const chunkAccount = (issuer: string, manifest: Manifest, index: number): string => `${oauthAccount(issuer)}#${manifest.gen}.${index}`;

function readManifest(store: CredentialStore, issuer: string): Manifest | null {
  const raw = store.get(oauthAccount(issuer));
  if (!raw) return null;
  try {
    const { v, chunks, gen } = JSON.parse(raw) as { v?: unknown; chunks?: unknown; gen?: unknown };
    const valid = v === 2 && Number.isInteger(chunks) && (chunks as number) >= 1 && (chunks as number) <= MAX_CHUNKS && typeof gen === "string" && /^[0-9a-f]{12}$/.test(gen);
    return valid ? { chunks: chunks as number, gen: gen as string } : null;
  } catch {
    return null;
  }
}

function readChunks(store: CredentialStore, issuer: string, manifest: Manifest): string | null {
  let json = "";
  for (let index = 0; index < manifest.chunks; index++) {
    const part = store.get(chunkAccount(issuer, manifest, index));
    if (part === null) return null;
    json += part;
  }
  return json;
}

function removeChunks(store: CredentialStore, issuer: string, manifest: Manifest, from = 0): boolean {
  let removed = false;
  for (let index = from; index < manifest.chunks; index++) removed = store.remove(chunkAccount(issuer, manifest, index)) || removed;
  return removed;
}

// Returns null for anything that is not a complete v2 OAuth entry (missing, a missing chunk, invalid JSON).
export function readOAuthEntry(store: CredentialStore, issuer: string): OAuthEntry | null {
  if (!store.available()) return null;
  let manifest = readManifest(store, issuer);
  if (manifest === null) return null;
  let json = readChunks(store, issuer, manifest);
  if (json === null) {
    // A writer may have switched generations and removed the old pieces while we read: read the new ones once.
    const latest = readManifest(store, issuer);
    if (latest === null || latest.gen === manifest.gen) return null;
    manifest = latest;
    json = readChunks(store, issuer, manifest);
    if (json === null) return null;
  }
  try {
    const parsed: unknown = JSON.parse(json);
    return isEntry(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// New generation's pieces first, then the manifest switch, then the previous generation's pieces.
export function writeOAuthEntry(store: CredentialStore, issuer: string, entry: OAuthEntry): boolean {
  const json = JSON.stringify(entry);
  const next: Manifest = { chunks: Math.ceil(json.length / CHUNK_SIZE), gen: randomBytes(6).toString("hex") };
  if (next.chunks > MAX_CHUNKS) return false;
  const previous = readManifest(store, issuer);
  for (let index = 0; index < next.chunks; index++) {
    if (!store.set(chunkAccount(issuer, next, index), json.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE))) {
      removeChunks(store, issuer, { ...next, chunks: index });
      return false;
    }
  }
  if (!store.set(oauthAccount(issuer), JSON.stringify({ v: 2, ...next }))) {
    removeChunks(store, issuer, next);
    return false;
  }
  if (previous) removeChunks(store, issuer, previous);
  return true;
}

// Removes the manifest and every piece it names, carrying on past any that are already gone.
export function removeOAuthEntry(store: CredentialStore, issuer: string): boolean {
  if (!store.available()) return false;
  const manifest = readManifest(store, issuer);
  const removedManifest = store.remove(oauthAccount(issuer));
  const removedChunks = manifest ? removeChunks(store, issuer, manifest) : false;
  return removedManifest || removedChunks;
}

export function isFresh(entry: OAuthEntry, now: number): boolean {
  const expiresAt = Date.parse(entry.expires_at);
  return Number.isFinite(expiresAt) && expiresAt - now > REFRESH_SKEW_MS;
}

// ---------------- HTTP helpers ----------------

export function postForm(transport: Transport, url: string, params: Record<string, string>): Promise<HttpResponse> {
  return transport({
    method: "POST",
    url,
    headers: { [HEADER.contentType]: "application/x-www-form-urlencoded", [HEADER.accept]: "application/json" },
    body: new URLSearchParams(params).toString(),
    timeoutMs: OAUTH_REQUEST_TIMEOUT_MS,
    retryable: false, // never replay a token request: a replayed rotated refresh token revokes the login
    meta: { command: "oauth" },
  });
}

export type ServerMetadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
  scopes_supported: string[];
};

function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

// RFC 8414 discovery. The metadata's issuer must equal the configured one (mix-up protection).
export async function discover(issuer: string, transport: Transport): Promise<ServerMetadata> {
  const response = await transport({
    method: "GET",
    url: `${issuer}/.well-known/oauth-authorization-server`,
    headers: { [HEADER.accept]: "application/json" },
    timeoutMs: OAUTH_REQUEST_TIMEOUT_MS,
    retryable: true,
    meta: { command: "oauth" },
  });
  if (response.status !== 200 || !response.json || typeof response.json !== "object") {
    throw new CliError("oauth.discovery", `Could not read the OAuth server metadata from ${issuer} (${response.status}).`);
  }
  const metadata = response.json as Record<string, unknown>;
  if (metadata.issuer !== issuer) {
    throw new CliError("oauth.issuer", `The OAuth server reported issuer "${String(metadata.issuer)}", expected "${issuer}".`, "Refusing to continue.");
  }
  const authorization = httpsUrl(metadata.authorization_endpoint);
  const token = httpsUrl(metadata.token_endpoint);
  if (!authorization || !token) {
    throw new CliError("oauth.discovery", "The OAuth server metadata has no usable https authorization or token endpoint.");
  }
  const revocation = httpsUrl(metadata.revocation_endpoint) ?? undefined;
  const scopes = Array.isArray(metadata.scopes_supported) ? metadata.scopes_supported.filter((scope): scope is string => typeof scope === "string") : [];
  return { issuer, authorization_endpoint: authorization, token_endpoint: token, revocation_endpoint: revocation, scopes_supported: scopes };
}

// Turn a token-endpoint response into a stored entry. `previous` supplies the refresh token when the server
// omits it on a refresh.
export function entryFromTokenResponse(json: unknown, now: number, previous?: OAuthEntry): OAuthEntry {
  const body = (json ?? {}) as Record<string, unknown>;
  const accessToken = body.access_token;
  const refreshToken = typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : previous?.refresh_token;
  const expiresIn = Number(body.expires_in);
  if (typeof accessToken !== "string" || !accessToken || !refreshToken || !Number.isFinite(expiresIn)) {
    throw new CliError("oauth.token", "The token response is missing an access token, refresh token or lifetime.");
  }
  return { v: 2, access_token: accessToken, refresh_token: refreshToken, expires_at: new Date(now + expiresIn * 1000).toISOString() };
}

// ---------------- cross-process lock ----------------

export function lockPath(issuer: string): string {
  const host = new URL(issuer).host.replace(/[^A-Za-z0-9.-]/g, "_");
  const digest = createHash("sha256").update(issuerKey(issuer)).digest("hex").slice(0, 12);
  return join(dirname(logLocation()), `oauth-${host}-${digest}.lock`);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function readLock(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"; // exists, owned by another user
  }
}

// The lock file holds "<pid>:<nonce>". It is stale when that process is gone, when it is implausibly old, or,
// with no owner recorded (a crash between create and write), when it is older than staleMs.
function isStale(owner: string, ageMs: number, staleMs: number): boolean {
  const pid = Number(owner.split(":")[0]);
  if (!Number.isInteger(pid) || pid <= 0) return ageMs > staleMs;
  return !isAlive(pid) || ageMs > LOCK_MAX_AGE_MS;
}

export async function withLock<T>(
  path: string,
  body: () => Promise<T>,
  opts: { now?: () => number; staleMs?: number; waitMs?: number } = {},
): Promise<T> {
  const now = opts.now ?? Date.now;
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  const deadline = now() + (opts.waitMs ?? LOCK_WAIT_MS);
  const owner = `${process.pid}:${randomBytes(8).toString("hex")}`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeSync(fd, owner);
      } finally {
        closeSync(fd);
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    try {
      const held = readLock(path);
      if (held !== null && isStale(held, now() - statSync(path).mtimeMs, staleMs)) {
        if (readLock(path) === held) unlinkSync(path); // still the stale owner's file, not a fresh lock taken meanwhile
        continue;
      }
    } catch {
      continue; // released between our open and stat
    }
    if (now() > deadline) throw new CliError("auth.lock", "Timed out waiting for another deel process to refresh the login.", "Try again.");
    await sleep(LOCK_POLL_MS);
  }
  try {
    return await body();
  } finally {
    try {
      if (readLock(path) === owner) unlinkSync(path); // never remove a lock another process took over
    } catch {
      /* already gone */
    }
  }
}

// ---------------- token source ----------------

export type OAuthSourceOpts = {
  store: CredentialStore;
  issuer: string;
  clientId: string;
  entry: OAuthEntry;
  transport: Transport;
  now?: () => number;
  lockOpts?: { staleMs?: number; waitMs?: number };
};

export type OAuthSource = {
  // A valid access token, refreshed first when it is close to expiry.
  token: () => Promise<string>;
  current: () => OAuthEntry;
};

function expired(): CliError {
  return new CliError("auth.expired", "Your Deel login has expired or was revoked.", "deel auth login");
}

export function createOAuthSource(opts: OAuthSourceOpts): OAuthSource {
  const now = opts.now ?? Date.now;
  let entry = opts.entry;
  let inflight: Promise<OAuthEntry> | null = null;

  async function refresh(): Promise<OAuthEntry> {
    return withLock(
      lockPath(opts.issuer),
      async () => {
        // Another process may have rotated the refresh token while we waited: replaying the old one
        // would make the server revoke the whole login, so always re-read before refreshing.
        const latest = readOAuthEntry(opts.store, opts.issuer);
        if (!latest) throw expired();
        if (isFresh(latest, now())) return latest;
        const metadata = await discover(opts.issuer, opts.transport);
        const response = await postForm(opts.transport, metadata.token_endpoint, {
          grant_type: "refresh_token",
          refresh_token: latest.refresh_token,
          client_id: opts.clientId,
        });
        if (response.status >= 400) {
          const error = (response.json as { error?: string } | undefined)?.error;
          if (error === "invalid_grant") {
            removeOAuthEntry(opts.store, opts.issuer);
            throw expired();
          }
          throw new CliError("auth.refresh", `Refreshing the login failed (${response.status}${error ? `: ${error}` : ""}).`, "Try again, or run 'deel auth login'.");
        }
        const next = entryFromTokenResponse(response.json, now(), latest);
        if (!writeOAuthEntry(opts.store, opts.issuer, next)) {
          // The old refresh token is spent; keeping it would only trigger a replay.
          removeOAuthEntry(opts.store, opts.issuer);
          throw new CliError("auth.keychain", "Failed to store the refreshed login in the keychain.", "deel auth login");
        }
        return next;
      },
      opts.lockOpts,
    );
  }

  return {
    current: () => entry,
    async token() {
      if (isFresh(entry, now())) return entry.access_token;
      inflight ??= refresh().finally(() => {
        inflight = null;
      });
      entry = await inflight;
      return entry.access_token;
    },
  };
}
