// Environment selection. Default prod; --base-url is a hidden testing override.
// Precedence: --base-url > --env > DEEL_ENV > default (prod).

import { CliError } from "./errors.ts";

// Public OAuth client id of the Deel CLI (a public client: no secret). The same in every environment.
export const CLI_OAUTH_CLIENT_ID = "b035545c-ee8a-4884-a51f-e416447e6d62";

export type Environment = { baseUrl: string; issuer: string; clientId: string };

export const ENVIRONMENTS: Record<string, Environment> = {
  prod: { baseUrl: "https://api.letsdeel.com/rest", issuer: "https://api.letsdeel.com", clientId: CLI_OAUTH_CLIENT_ID },
  demo: { baseUrl: "https://api-staging.letsdeel.com/rest", issuer: "https://api-staging.letsdeel.com", clientId: CLI_OAUTH_CLIENT_ID },
};

export type Config = {
  env: string;
  baseUrl: string;
  issuer: string | null; // OAuth issuer; null when the environment is unknown (only reachable with --base-url)
  clientId: string;
  // True when baseUrl is the API of the environment that issues OAuth tokens, so they may be sent to it.
  oauthBaseUrlOk: boolean;
};

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function httpsOverride(name: string): string | undefined {
  const value = process.env[name]?.trim().replace(/\/$/, "");
  if (!value) return undefined;
  if (originOf(value) === null || !value.startsWith("https://")) {
    throw new CliError("config.oauth", `${name} must be an https URL (got "${value}").`);
  }
  return value;
}

export function resolveConfig(opts: { env?: string; baseUrl?: string }): Config {
  const env = opts.env ?? process.env.DEEL_ENV ?? "prod";
  const known = ENVIRONMENTS[env];
  let baseUrl = opts.baseUrl;
  if (!baseUrl) {
    if (!known) {
      throw new CliError("config.env", `Unknown --env "${env}". Known: ${Object.keys(ENVIRONMENTS).join(", ")}`);
    }
    baseUrl = known.baseUrl;
  }
  // Require https so the token is never sent in cleartext.
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new CliError("config.baseurl", `Invalid --base-url "${baseUrl}".`);
  }
  if (parsed.protocol !== "https:") {
    throw new CliError("config.baseurl", `--base-url must use https (got "${baseUrl}").`, "The API token is only sent over https.");
  }
  const issuer = httpsOverride("DEEL_OAUTH_ISSUER") ?? known?.issuer ?? null;
  const clientId = process.env.DEEL_OAUTH_CLIENT_ID?.trim() || known?.clientId || CLI_OAUTH_CLIENT_ID;
  const trustedOrigins = [known ? originOf(known.baseUrl) : null, issuer ? originOf(issuer) : null];
  return {
    env,
    baseUrl: baseUrl.replace(/\/$/, ""),
    issuer,
    clientId,
    oauthBaseUrlOk: trustedOrigins.includes(parsed.origin),
  };
}
