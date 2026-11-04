// Environment selection. Default prod; --base-url is a hidden testing override.
// Precedence: --base-url > --env > DEEL_ENV > default (prod). --base-url alone names its own environment after its host.

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
  issuer: string | null; // OAuth issuer; null only when DEEL_OAUTH_ISSUER is invalid (see issuerError)
  clientId: string;
  // True when baseUrl is the API of the environment that issues OAuth tokens, so they may be sent to it.
  oauthBaseUrlOk: boolean;
  // Set when DEEL_OAUTH_ISSUER is invalid; only the OAuth paths fail on it (requireIssuer), so PATs keep working.
  issuerError?: string;
};

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// The host of a --base-url, used as the environment name. An unparsable --base-url is reported by resolveConfig
// itself, so any placeholder name will do here.
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "custom";
  }
}

// The override, undefined when unset, or an error message when it is not an https URL.
function httpsOverride(name: string): { value?: string; error?: string } {
  const value = process.env[name]?.trim().replace(/\/$/, "");
  if (!value) return {};
  if (originOf(value) === null || !value.startsWith("https://")) return { error: `${name} must be an https URL (got "${value}").` };
  return { value };
}

// Called on the OAuth paths only, so an invalid DEEL_OAUTH_ISSUER never blocks a PAT.
export function assertIssuerOverride(config: Config): void {
  if (config.issuerError) throw new CliError("config.oauth", config.issuerError);
}

export function requireIssuer(config: Config): string {
  assertIssuerOverride(config);
  if (!config.issuer) throw new CliError("config.oauth", `No OAuth issuer is configured for "${config.env}".`, "Use --env prod or --env demo.");
  return config.issuer;
}

export function resolveConfig(opts: { env?: string; baseUrl?: string }): Config {
  // --base-url without --env is its own environment, so nothing saved for prod or demo is sent to it.
  const env = opts.env ?? process.env.DEEL_ENV ?? (opts.baseUrl ? hostOf(opts.baseUrl) : "prod");
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
  const override = httpsOverride("DEEL_OAUTH_ISSUER");
  // An unknown environment is only reachable with --base-url; its origin is the issuer, which discovery verifies.
  const issuer = override.error ? null : (override.value ?? known?.issuer ?? parsed.origin);
  const clientId = process.env.DEEL_OAUTH_CLIENT_ID?.trim() || known?.clientId || CLI_OAUTH_CLIENT_ID;
  const trustedOrigins = [known ? originOf(known.baseUrl) : null, issuer ? originOf(issuer) : null];
  return {
    env,
    baseUrl: baseUrl.replace(/\/$/, ""),
    issuer,
    clientId,
    oauthBaseUrlOk: trustedOrigins.includes(parsed.origin),
    ...(override.error ? { issuerError: override.error } : {}),
  };
}

// The legacy PAT stored under the bare env name belongs to the environment's own server. Talking to another
// server (an issuer override or a different API host) must never read or touch it.
export function ownsLegacyPat(config: Config): boolean {
  const known = ENVIRONMENTS[config.env];
  if (!known || config.issuer !== known.issuer) return false;
  return originOf(config.baseUrl) === originOf(known.baseUrl);
}
