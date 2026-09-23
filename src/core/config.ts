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
};

export function resolveConfig(opts: { env?: string; baseUrl?: string }): Config {
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
  return { env, baseUrl: baseUrl.replace(/\/$/, "") };
}
