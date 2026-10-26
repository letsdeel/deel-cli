// Credential resolution. Precedence: --token-stdin > DEEL_TOKEN > OS keychain (OAuth login, then a legacy PAT).
// stdin/env are pass-through (never persisted); the keychain holds the browser login.

import { readFileSync } from "node:fs";
import { CliError } from "./errors.ts";
import { HEADER } from "./constants.ts";
import { credentialStore } from "./keychain.ts";
import type { CredentialStore } from "./keychain.ts";
import { resolveConfig } from "./config.ts";
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
  env?: string;
  config?: Config;
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
  const env = opts.config?.env ?? opts.env;
  if (env) {
    const store = opts.store ?? credentialStore();
    if (store.available()) {
      const config = opts.config ?? resolveConfig({ env });
      const entry = config.issuer ? readOAuthEntry(store, config.issuer) : null;
      if (entry && config.issuer) {
        // OAuth tokens only travel to the environment that issued them.
        if (!config.oauthBaseUrlOk) {
          throw new CliError(
            "auth.base_url",
            `The stored login for "${env}" is only sent to its own API host, not to ${new URL(config.baseUrl).host}.`,
            "Use DEEL_TOKEN or --token-stdin with this --base-url, or drop --base-url.",
          );
        }
        const oauth = createOAuthSource({ store, issuer: config.issuer, clientId: config.clientId, entry, transport: opts.transport ?? fetchTransport, now: opts.now });
        return { token: entry.access_token, source: "oauth", oauth };
      }
      const token = store.get(env); // a PAT saved by an earlier release
      if (token) return { token, source: "keychain" };
    }
  }
  return { token: null, source: "none" };
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
    redacted[name] = name.toLowerCase() === HEADER.authorization ? "Bearer ***" : value;
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
