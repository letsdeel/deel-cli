// PAT resolution. Precedence: --token-stdin > DEEL_TOKEN > OS keychain.
// stdin/env are pass-through (never persisted); the keychain is the persisted store.

import { readFileSync } from "node:fs";
import { CliError } from "./errors.ts";
import { HEADER } from "./constants.ts";
import { credentialStore } from "./keychain.ts";
import type { CredentialStore } from "./keychain.ts";

export type TokenSource = "stdin" | "env" | "keychain" | "none";

export type ResolvedToken = { token: string | null; source: TokenSource };

export function resolveToken(opts: { tokenStdin?: boolean; env?: string; store?: CredentialStore }): ResolvedToken {
  if (opts.tokenStdin) {
    const token = readFileSync(0, "utf8").trim();
    return { token: token || null, source: "stdin" };
  }
  const envToken = process.env.DEEL_TOKEN;
  if (envToken) return { token: envToken.trim() || null, source: "env" };
  if (opts.env) {
    const store = opts.store ?? credentialStore();
    if (store.available()) {
      const token = store.get(opts.env);
      if (token) return { token, source: "keychain" };
    }
  }
  return { token: null, source: "none" };
}

export function requireToken(resolved: ResolvedToken): string {
  if (!resolved.token) {
    throw new CliError(
      "auth.missing",
      "No API token found.",
      "Run 'deel auth login', set DEEL_TOKEN, or pipe one with --token-stdin.",
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
