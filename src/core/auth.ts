// Credential resolution. Precedence: --token-stdin > DEEL_TOKEN > OS keychain (OAuth login, then a legacy PAT).
// stdin/env are pass-through (never persisted); the keychain holds the browser login.

import { readFileSync } from "node:fs";
import { CliError } from "./errors.ts";
import { HEADER } from "./constants.ts";
import { isSensitiveKey } from "./logging.ts";
import { credentialStore } from "./keychain.ts";
import type { CredentialStore } from "./keychain.ts";
import { ENVIRONMENTS, assertIssuerOverride, ownsLegacyPat } from "./config.ts";
import type { Config } from "./config.ts";
import { fetchTransport } from "./http.ts";
import type { TokenProvider, Transport } from "./http.ts";
import { createOAuthSource, readOAuthEntry } from "./oauth.ts";
import type { OAuthSource } from "./oauth.ts";

// "oauth" is the browser login; "keychain" is a PAT stored by an earlier release.
export type TokenSource = "stdin" | "env" | "keychain" | "oauth" | "none";

export type ResolvedToken = {
  token: string | null; // for oauth: the stored access token (possibly expired; send it through authFor)
  source: TokenSource;
  oauth?: OAuthSource;
};

export type ResolveOpts = {
  tokenStdin?: boolean;
  // Required: a stored login is only sent to the server of this config's environment.
  config: Config;
  store?: CredentialStore;
  transport?: Transport; // for OAuth refresh; tests inject a fake
  now?: () => number;
};

export function resolveToken(opts: ResolveOpts): ResolvedToken {
  if (opts.tokenStdin) {
    const token = readFileSync(0, "utf8").trim();
    return { token: token || null, source: "stdin" };
  }
  const envToken = process.env.DEEL_TOKEN;
  if (envToken) return { token: envToken.trim() || null, source: "env" };
  const { config } = opts;
  const store = opts.store ?? credentialStore();
  if (!store.available()) return { token: null, source: "none" };
  assertIssuerOverride(config);
  const entry = config.issuer ? readOAuthEntry(store, config.issuer) : null;
  if (entry && config.issuer) {
    // OAuth tokens only travel to the environment that issued them.
    if (!config.oauthBaseUrlOk) throw baseUrlRefused(config);
    const oauth = createOAuthSource({ store, issuer: config.issuer, clientId: config.clientId, entry, transport: opts.transport ?? fetchTransport, now: opts.now });
    return { token: entry.access_token, source: "oauth", oauth };
  }
  const token = ENVIRONMENTS[config.env] ? store.get(config.env) : null; // a PAT saved by an earlier release
  if (token) {
    if (!ownsLegacyPat(config)) throw baseUrlRefused(config);
    return { token, source: "keychain" };
  }
  return { token: null, source: "none" };
}

// Saved logins only travel to their own environment's server; say how to reach another one instead.
export function baseUrlRefused(config: Config): CliError {
  const known = ENVIRONMENTS[config.env];
  const host = new URL(config.baseUrl).host;
  const allowed = new URL(known ? known.baseUrl : (config.issuer ?? config.baseUrl)).host;
  if (known && host === allowed) {
    // Same host, so the cause is DEEL_OAUTH_ISSUER pointing the login at another server.
    return new CliError(
      "auth.base_url",
      `The "${config.env}" PAT saved by an earlier release is not sent while DEEL_OAUTH_ISSUER points at ${config.issuer ?? "another server"}.`,
      "Unset DEEL_OAUTH_ISSUER, or use DEEL_TOKEN or --token-stdin with a PAT.",
    );
  }
  const next = known
    ? `To use ${host} as its own environment, run without --env ${config.env} or DEEL_ENV. Otherwise use DEEL_TOKEN or --token-stdin with a PAT.`
    : `Use a --base-url on ${allowed}, or unset DEEL_OAUTH_ISSUER.`;
  return new CliError("auth.base_url", `The "${config.env}" login is only sent to ${allowed}, not to ${host}.`, next);
}

// What to hand to the HTTP layer: a provider for OAuth (refreshes on demand), the plain token otherwise.
export function authFor(resolved: ResolvedToken): string | TokenProvider {
  const oauth = resolved.oauth;
  if (oauth) return () => oauth.token();
  return requireToken(resolved);
}

export function requireToken(resolved: ResolvedToken): string {
  if (!resolved.token) {
    throw new CliError(
      "auth.missing",
      "No API token found.",
      "Run 'deel auth login', set DEEL_TOKEN, or pipe a PAT with --token-stdin.",
    );
  }
  return resolved.token;
}

// Never render a token: mask everything but the last 4 chars.
export function maskToken(token: string): string {
  return token.length <= 4 ? "****" : `****${token.slice(-4)}`;
}

export type Identity = {
  id?: number;
  email?: string;
  full_name?: string;
  profile_type?: string;
  organization_id?: number;
  organization_name?: string;
};

export function extractIdentity(json: unknown): Identity {
  const source = (json ?? {}) as Record<string, unknown>;
  return {
    id: source.id,
    email: source.email,
    full_name: source.full_name,
    profile_type: source.profile_type,
    organization_id: source.organization_id,
    organization_name: source.organization_name,
  } as Identity;
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    // Authorization keeps its scheme; any other header that names a credential (a cookie, an API key) is masked whole.
    redacted[name] = name.toLowerCase() === HEADER.authorization ? "Bearer ***" : isSensitiveKey(name) ? "***" : value;
  }
  return redacted;
}

// The scope claim of an access token, for display only (`deel auth status`). The payload is decoded without
// verifying the signature: the server verifies the token, the CLI never relies on this value.
export function accessTokenScope(token: string): string | null {
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { scope?: unknown };
    if (typeof claims.scope === "string") return claims.scope;
    if (Array.isArray(claims.scope) && claims.scope.every((item) => typeof item === "string")) return claims.scope.join(" ");
  } catch {
    /* not a JWT */
  }
  return null;
}
