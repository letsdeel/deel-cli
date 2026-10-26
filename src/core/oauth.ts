// OAuth 2.0 client plumbing shared by `deel auth` and the token provider:
// server discovery, the stored credential, and refresh-token rotation under a cross-process lock.

import { mkdirSync, openSync, closeSync, unlinkSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { CliError } from "./errors.ts";
import { HEADER } from "./constants.ts";
import { logLocation } from "./logging.ts";
import type { CredentialStore } from "./keychain.ts";
import type { HttpResponse, Transport } from "./http.ts";

export const REFRESH_SKEW_MS = 60_000; // refresh when the access token has less than this left
export const LOCK_STALE_MS = 30_000; // a lock older than this belongs to a dead process
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

// The keychain account is derived from the issuer, which binds a login to its server: another configured
// issuer (for example through DEEL_OAUTH_ISSUER) simply finds no login.
export const oauthAccount = (issuer: string): string => `oauth:${new URL(issuer).origin}`;

function isEntry(value: unknown): value is OAuthEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    entry.v === 2 && ["access_token", "refresh_token", "expires_at"].every((key) => typeof entry[key] === "string" && entry[key] !== "")
  );
}

// The entry is stored in pieces: `security -i` truncates a command line at about 4 KB, and a login that
// carries every scope easily exceeds that. `oauth:<issuer>` holds a small manifest, the JSON text lives in
// `oauth:<issuer>#0..N-1`. Tokens are never passed in argv.
export const CHUNK_SIZE = 3000; // characters per item before quoting; keeps each `security -i` line well under 4 KB
const MAX_CHUNKS = 64;
const chunkAccount = (issuer: string, index: number): string => `${oauthAccount(issuer)}#${index}`;

function readManifest(store: CredentialStore, issuer: string): number | null {
  const raw = store.get(oauthAccount(issuer));
  if (!raw) return null;
  try {
    const manifest = JSON.parse(raw) as { v?: unknown; chunks?: unknown };
    const count = manifest.chunks;
    return manifest.v === 2 && Number.isInteger(count) && (count as number) >= 1 && (count as number) <= MAX_CHUNKS ? (count as number) : null;
  } catch {
    return null;
  }
}

// Returns null for anything that is not a complete v2 OAuth entry (missing, a missing chunk, invalid JSON).
export function readOAuthEntry(store: CredentialStore, issuer: string): OAuthEntry | null {
  if (!store.available()) return null;
  const count = readManifest(store, issuer);
  if (count === null) return null;
  let json = "";
  for (let index = 0; index < count; index++) {
    const part = store.get(chunkAccount(issuer, index));
    if (part === null) return null;
    json += part;
  }
  try {
    const parsed: unknown = JSON.parse(json);
    return isEntry(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Chunks first, manifest last, so a reader never sees a manifest for pieces that are not there yet.
export function writeOAuthEntry(store: CredentialStore, issuer: string, entry: OAuthEntry): boolean {
  const json = JSON.stringify(entry);
  const count = Math.ceil(json.length / CHUNK_SIZE);
  if (count > MAX_CHUNKS) return false;
  const previous = readManifest(store, issuer) ?? 0;
  for (let index = 0; index < count; index++) {
    if (!store.set(chunkAccount(issuer, index), json.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE))) return false;
  }
  if (!store.set(oauthAccount(issuer), JSON.stringify({ v: 2, chunks: count }))) return false;
  for (let index = count; index < previous; index++) store.remove(chunkAccount(issuer, index)); // left over from a larger entry
  return true;
}

// Removes the manifest and every chunk, including strays whose manifest is gone or unreadable.
export function removeOAuthEntry(store: CredentialStore, issuer: string): boolean {
  if (!store.available()) return false;
  let removed = store.remove(oauthAccount(issuer));
  for (let index = 0; index < MAX_CHUNKS; index++) {
    if (!store.remove(chunkAccount(issuer, index))) break;
    removed = true;
  }
  return removed;
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
  return join(dirname(logLocation()), `oauth-${new URL(issuer).host.replace(/[^A-Za-z0-9.-]/g, "_")}.lock`);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function withLock<T>(
  path: string,
  body: () => Promise<T>,
  opts: { now?: () => number; staleMs?: number; waitMs?: number } = {},
): Promise<T> {
  const now = opts.now ?? Date.now;
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  const deadline = now() + (opts.waitMs ?? LOCK_WAIT_MS);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      closeSync(openSync(path, "wx", 0o600));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    try {
      if (now() - statSync(path).mtimeMs > staleMs) {
        unlinkSync(path); // stale: its owner is gone
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
      unlinkSync(path);
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
