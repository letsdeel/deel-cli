// Browser sign-in: Authorization Code + PKCE (S256) with a one-shot loopback listener on 127.0.0.1.

import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { platform } from "node:os";
import { CliError } from "./errors.ts";
import { discover, entryFromTokenResponse, lockPath, postForm, printable, readOAuthEntry, removeOAuthEntry, withLock, writeOAuthEntry } from "./oauth.ts";
import type { OAuthEntry, ServerMetadata } from "./oauth.ts";
import { assertIssuerOverride, ownsLegacyPat, requireIssuer } from "./config.ts";
import type { Config } from "./config.ts";
import type { Transport } from "./http.ts";
import type { CredentialStore } from "./keychain.ts";

export const LOGIN_TIMEOUT_MS = 5 * 60_000;
export const CALLBACK_PATH = "/callback";

// ---------------- PKCE ----------------

export const newVerifier = (): string => randomBytes(32).toString("base64url");
export const newState = (): string => randomBytes(16).toString("base64url");
export const challengeFor = (verifier: string): string => createHash("sha256").update(verifier).digest("base64url");

// ---------------- loopback listener ----------------

const PAGE = (title: string, line: string) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font-family:system-ui,sans-serif;margin:4rem auto;max-width:28rem;text-align:center"><h1>${title}</h1><p>${line}</p></body></html>`;
const OK_PAGE = PAGE("Signed in", "You can close this window and return to the terminal.");
const FAILED_PAGE = PAGE("Sign-in failed", "You can close this window and check the terminal.");
const STALE_PAGE = PAGE("Sign-in not recognised", "This response does not belong to the sign-in in progress. Use the link from the latest 'deel auth login'.");

export type Loopback = {
  redirectUri: string;
  result: Promise<{ code: string }>;
  close: () => void;
};

// Listens on 127.0.0.1 (never "localhost") for exactly one GET /callback, then closes.
export async function startLoopback(opts: { state: string; issuer: string; timeoutMs?: number; onIgnored?: () => void }): Promise<Loopback> {
  let settle: { resolve: (value: { code: string }) => void; reject: (error: CliError) => void };
  const result = new Promise<{ code: string }>((resolve, reject) => {
    settle = { resolve, reject };
  });
  result.catch(() => {}); // surfaced to the caller; never an unhandled rejection
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const server = createServer((req, res) => {
    const reply = (status: number, body: string, after?: () => void) => {
      res.writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
        connection: "close",
      });
      res.end(body, after);
    };
    const address = server.address() as AddressInfo;
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://127.0.0.1:${address.port}`);
    } catch {
      reply(400, PAGE("Bad request", "Nothing here.")); // e.g. "//", which parses as a URL with an empty host
      return;
    }
    // Host check blocks DNS-rebinding pages from reaching the listener.
    if (finished || req.headers.host !== `127.0.0.1:${address.port}` || url.pathname !== CALLBACK_PATH) {
      reply(404, PAGE("Not found", "Nothing here."));
      return;
    }
    if (req.method !== "GET") {
      reply(405, PAGE("Not allowed", "Nothing here."));
      return;
    }
    const params = url.searchParams;
    // Any local page or process can reach the listener, so a wrong state is ignored rather than ending the login.
    if (params.get("state") !== opts.state) {
      reply(400, STALE_PAGE);
      opts.onIgnored?.();
      return;
    }
    finished = true; // the first callback with this attempt's state is the only one honoured
    let outcome: { code: string } | CliError;
    if (params.has("iss") && params.get("iss") !== opts.issuer) {
      outcome = new CliError("oauth.issuer", "The sign-in response came from an unexpected issuer.", "Refusing to continue.");
    } else if (params.has("error")) {
      const description = printable(params.get("error_description"));
      outcome = new CliError("oauth.denied", `Sign-in was not completed: ${printable(params.get("error"))}${description ? ` (${description})` : ""}.`, "Run 'deel auth login' to try again.");
    } else if (!params.get("code")) {
      outcome = new CliError("oauth.callback", "The sign-in response carried no authorization code.");
    } else {
      outcome = { code: params.get("code") as string };
    }
    reply(outcome instanceof CliError ? 400 : 200, outcome instanceof CliError ? FAILED_PAGE : OK_PAGE, () => close());
    if (outcome instanceof CliError) settle.reject(outcome);
    else settle.resolve(outcome);
  });

  function close() {
    finished = true;
    if (timer) clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  timer = setTimeout(() => {
    settle.reject(new CliError("oauth.timeout", "Timed out waiting for the browser sign-in.", "Run 'deel auth login' again."));
    close();
  }, opts.timeoutMs ?? LOGIN_TIMEOUT_MS);
  timer.unref();

  const { port } = server.address() as AddressInfo;
  return { redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`, result, close };
}

// ---------------- browser ----------------

// Best effort: the URL is always printed too. Arguments are passed as an argv array, never through a shell.
export function openBrowser(url: string): void {
  const os = platform();
  const [command, args]: [string, string[]] =
    os === "darwin" ? ["open", [url]] : os === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* the printed URL still works */
  }
}

// ---------------- the flow ----------------

export function chooseScopes(supported: string[], requested: string | undefined, readOnly: boolean): string[] {
  if (requested === undefined && !readOnly) return []; // no scope parameter: the server grants its default set
  let scopes = supported.filter((scope) => scope !== "openid" && !scope.startsWith("openid-")); // OIDC is not used by the CLI
  if (requested !== undefined) {
    scopes = requested.split(/[,\s]+/).filter(Boolean);
    const unknown = supported.length > 0 ? scopes.filter((scope) => !supported.includes(scope)) : [];
    if (unknown.length > 0) {
      throw new CliError("usage.scopes", `Unknown scope(s): ${unknown.join(", ")}.`, `Available: ${supported.join(", ")}`);
    }
  }
  if (readOnly) scopes = scopes.filter((scope) => scope.endsWith(":read"));
  if ((requested !== undefined || readOnly) && scopes.length === 0) {
    throw new CliError("usage.scopes", "No scopes left to request.", readOnly ? "--read-only keeps only the *:read scopes." : undefined);
  }
  return scopes;
}

export function authorizationUrl(
  metadata: ServerMetadata,
  p: { clientId: string; redirectUri: string; scopes: string[]; state: string; challenge: string },
): string {
  const url = new URL(metadata.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", p.clientId);
  url.searchParams.set("redirect_uri", p.redirectUri);
  if (p.scopes.length > 0) url.searchParams.set("scope", p.scopes.join(" "));
  url.searchParams.set("state", p.state);
  url.searchParams.set("code_challenge", p.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export type BrowserLoginOpts = {
  config: Config;
  store: CredentialStore;
  transport: Transport;
  say: (text: string) => void; // progress and the sign-in URL (stderr)
  open?: boolean;
  openUrl?: (url: string) => void;
  scopes?: string;
  readOnly?: boolean;
  timeoutMs?: number;
  now?: () => number;
};

export async function browserLogin(opts: BrowserLoginOpts): Promise<OAuthEntry> {
  const { config } = opts;
  const issuer = requireIssuer(config);
  const metadata = await discover(issuer, opts.transport);
  const scopes = chooseScopes(metadata.scopes_supported, opts.scopes, Boolean(opts.readOnly));
  const verifier = newVerifier();
  const state = newState();
  const loopback = await startLoopback({
    state,
    issuer,
    timeoutMs: opts.timeoutMs,
    onIgnored: () => opts.say("Ignored a sign-in response that does not match this login attempt.\n"),
  });
  try {
    const url = authorizationUrl(metadata, { clientId: config.clientId, redirectUri: loopback.redirectUri, scopes, state, challenge: challengeFor(verifier) });
    opts.say(`Open this URL in your browser to sign in:\n${url}\n`);
    if (opts.open !== false) (opts.openUrl ?? openBrowser)(url);
    const { code } = await loopback.result;
    const response = await postForm(opts.transport, metadata.token_endpoint, {
      grant_type: "authorization_code",
      code,
      redirect_uri: loopback.redirectUri,
      client_id: config.clientId,
      code_verifier: verifier,
    });
    if (response.status >= 400) {
      const body = (response.json ?? {}) as { error?: unknown; error_description?: unknown };
      const detail = [body.error, body.error_description].filter((part): part is string => typeof part === "string").map((part) => printable(part)).join(": ");
      throw new CliError("oauth.token", `The sign-in could not be completed (${response.status}${detail ? `: ${detail}` : ""}).`, "Run 'deel auth login' again.");
    }
    const entry = entryFromTokenResponse(response.json, (opts.now ?? Date.now)());
    // Under the refresh lock, so a refresh of the previous login in another process cannot overwrite or delete this one.
    await withLock(lockPath(issuer), async () => {
      if (!writeOAuthEntry(opts.store, issuer, entry)) throw new CliError("auth.keychain", "Failed to store the login in the keychain.");
      if (ownsLegacyPat(config)) opts.store.remove(config.env); // drop a PAT saved by an earlier release
    });
    return entry;
  } finally {
    loopback.close();
  }
}

// Remove the stored login, and the legacy PAT only when the active server is the environment's own.
export function removeStoredLogin(store: CredentialStore, config: Config): boolean {
  const oauthRemoved = config.issuer ? removeOAuthEntry(store, config.issuer) : false;
  const legacyRemoved = ownsLegacyPat(config) ? store.remove(config.env) : false;
  return oauthRemoved || legacyRemoved;
}

// `reason` says why a revocation failed (an HTTP status or an error code), never token material.
export type RevokeOutcome = { revoked: boolean | "unsupported"; reason?: string };
export type LogoutResult = RevokeOutcome & { removed: boolean; hadLogin: boolean };

// Revoke and remove under the refresh lock, re-reading the login inside it, so a refresh in another process can
// neither rotate the token being revoked nor store a replacement after the removal.
export async function logout(store: CredentialStore, config: Config, transport: Transport): Promise<LogoutResult> {
  if (!store.available()) return { removed: false, revoked: false, hadLogin: false };
  assertIssuerOverride(config);
  const issuer = config.issuer;
  if (!issuer) return { removed: removeStoredLogin(store, config), revoked: false, hadLogin: false };
  return withLock(lockPath(issuer), async () => {
    const entry = readOAuthEntry(store, issuer);
    const outcome: RevokeOutcome = entry ? await revokeLogin(entry, { issuer, clientId: config.clientId }, transport) : { revoked: false };
    return { ...outcome, removed: removeStoredLogin(store, config), hadLogin: entry !== null };
  });
}

// Best-effort RFC 7009 revocation of the refresh token (which also ends the access token's grant).
export async function revokeLogin(entry: OAuthEntry, server: { issuer: string; clientId: string }, transport: Transport): Promise<RevokeOutcome> {
  try {
    const metadata = await discover(server.issuer, transport);
    if (!metadata.revocation_endpoint) return { revoked: "unsupported" };
    const response = await postForm(transport, metadata.revocation_endpoint, {
      token: entry.refresh_token,
      token_type_hint: "refresh_token",
      client_id: server.clientId,
    });
    if (response.status >= 200 && response.status < 300) return { revoked: true };
    return { revoked: false, reason: `HTTP ${response.status}` };
  } catch (error) {
    return { revoked: false, reason: error instanceof CliError ? error.code : printable(`network error: ${(error as Error).message}`) };
  }
}
