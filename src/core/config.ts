// Environment selection. Default prod; --base-url is a hidden testing override.
// Precedence: --base-url > --env > DEEL_ENV > default (prod).

import { CliError } from "./errors.ts";

export const ENVIRONMENTS: Record<string, string> = {
  prod: "https://api.letsdeel.com/rest",
  demo: "https://api-staging.letsdeel.com/rest",
};

export type Config = {
  env: string;
  baseUrl: string;
  beta?: boolean; // --beta: send X-Beta: true so beta endpoints are reachable
};

export function resolveConfig(opts: { env?: string; baseUrl?: string; beta?: boolean }): Config {
  const env = opts.env ?? process.env.DEEL_ENV ?? "prod";
  let baseUrl = opts.baseUrl;
  if (!baseUrl) {
    baseUrl = ENVIRONMENTS[env];
    if (!baseUrl) {
      throw new CliError("config.env", `Unknown --env "${env}". Known: ${Object.keys(ENVIRONMENTS).join(", ")}`);
    }
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
  const config: Config = { env, baseUrl: baseUrl.replace(/\/$/, "") };
  if (opts.beta) config.beta = true;
  return config;
}

// The base URL for a command's API. REST uses the configured base as is; SCIM swaps a
// trailing /rest for /scim (or appends /scim to a --base-url without one).
export function apiBaseUrl(baseUrl: string, api: "rest" | "scim" | undefined): string {
  if (api !== "scim") return baseUrl;
  return `${baseUrl.replace(/\/rest$/, "")}/scim`;
}
