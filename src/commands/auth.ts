// `deel auth` — sign in, inspect and clear the stored login.
//   status  validate the current credential and report identity + where it came from
//   login   sign in through the browser (OAuth) and store the login in the OS keychain
//   logout  revoke the login (best effort) and remove it from the OS keychain

import { defineCommand } from "citty";
import type { ArgsDef } from "citty";
import { resolveToken, authFor, accessTokenScope, maskToken, extractIdentity, baseUrlRefused } from "../core/auth.ts";
import { credentialStore } from "../core/keychain.ts";
import type { CredentialStore } from "../core/keychain.ts";
import { browserLogin, logout } from "../core/oauth-login.ts";
import { fetchTransport } from "../core/http.ts";
import type { Transport } from "../core/http.ts";
import { createContext } from "../core/context.ts";
import { envelope, render } from "../core/output.ts";
import { setLoggingEnabled, setLogBodiesEnabled } from "../core/logging.ts";
import { CliError } from "../core/errors.ts";
import { HEADER } from "../core/constants.ts";
import { commonArgs, configFrom, outputOpts, refuseMissingGlobalValues } from "./shared.ts";
import type { Args } from "./shared.ts";
import { assertIssuerOverride } from "../core/config.ts";
import type { Config } from "../core/config.ts";
import type { Ctx } from "../core/context.ts";
import type { IOStreams } from "../core/io.ts";

function checkToken(ctx: Ctx, config: Config, command: string) {
  return ctx.http({
    method: "GET",
    url: `${config.baseUrl}/people/me`,
    headers: { [HEADER.accept]: "application/json" },
    retryable: true,
    meta: { command },
  });
}

// What the auth commands touch outside the process. The commands use the real ones; tests pass fakes.
export type AuthDeps = {
  store: CredentialStore;
  transport: Transport;
  io?: IOStreams;
  openUrl?: (url: string) => void; // stands in for the browser
};

const realDeps = (): AuthDeps => ({ store: credentialStore(), transport: fetchTransport });

export async function authStatus(args: Args, config: Config, deps: AuthDeps): Promise<void> {
  const resolved = resolveToken({ tokenStdin: Boolean(args["token-stdin"]), config, store: deps.store, transport: deps.transport });
  const ctx = createContext({ config, token: authFor(resolved), io: deps.io, baseTransport: deps.transport });
  const response = await checkToken(ctx, config, "auth status");
  if (response.status >= 400) throw new CliError("auth.invalid", `Token check failed (${response.status})`);
  const oauth = resolved.oauth?.current(); // read after the request: it may have refreshed the login
  await render(
    ctx.io,
    envelope({
      valid: true,
      auth: oauth ? "oauth" : "pat",
      source: resolved.source,
      token: maskToken(oauth?.access_token ?? (resolved.token as string)),
      ...(oauth ? { expires_at: oauth.expires_at, scope: accessTokenScope(oauth.access_token) } : {}),
      identity: extractIdentity(response.json),
    }),
    outputOpts(args),
  );
}

export async function authLogin(args: Args, config: Config, deps: AuthDeps): Promise<void> {
  if (args["token-stdin"]) {
    throw new CliError("usage.token_stdin", "deel auth login signs in through the browser and does not take a PAT.", "Pass a PAT to each command with --token-stdin or DEEL_TOKEN instead.");
  }
  const { store } = deps;
  if (!store.available()) {
    throw new CliError("auth.keychain", "No OS keychain available on this platform.", "Use DEEL_TOKEN or --token-stdin with a PAT instead.");
  }
  assertIssuerOverride(config);
  if (!config.oauthBaseUrlOk) throw baseUrlRefused(config);
  const ctx = createContext({ config, token: null, io: deps.io, baseTransport: deps.transport });
  const entry = await browserLogin({
    config,
    store,
    transport: deps.transport,
    say: (text) => ctx.io.err(text),
    open: args.browser !== false,
    openUrl: deps.openUrl,
    scopes: args.scopes as string | undefined,
    readOnly: Boolean(args["read-only"]),
  });
  const authed = createContext({ config, token: entry.access_token, io: deps.io, baseTransport: deps.transport });
  const response = await checkToken(authed, config, "auth login");
  if (response.status >= 400) throw new CliError("auth.invalid", `Signed in, but the identity check failed (${response.status}).`, "Run 'deel auth status' to retry.");
  await render(
    ctx.io,
    envelope({
      stored: true,
      env: config.env,
      auth: "oauth",
      token: maskToken(entry.access_token),
      identity: extractIdentity(response.json),
      scope: accessTokenScope(entry.access_token),
      expires_at: entry.expires_at,
    }),
    outputOpts(args),
  );
}

export async function authLogout(args: Args, config: Config, deps: AuthDeps): Promise<void> {
  const ctx = createContext({ config, token: null, io: deps.io, baseTransport: deps.transport });
  const { removed, revoked, hadLogin, reason } = await logout(deps.store, config, deps.transport);
  if (hadLogin && revoked === "unsupported") ctx.io.err("The server does not support revocation; the login was only removed from this machine.\n");
  else if (hadLogin && !revoked) {
    ctx.io.err(
      `Could not revoke the login on the server (${reason ?? "unknown error"}). It was removed from this machine, but its refresh token may stay valid until it expires.\n`,
    );
  }
  await render(ctx.io, envelope({ removed, env: config.env, revoked, ...(hadLogin && revoked === false ? { revoke_error: reason ?? "unknown error" } : {}) }), outputOpts(args));
}

const loginArgs: ArgsDef = {
  ...commonArgs,
  browser: { type: "boolean", default: true, description: "Open the browser (--no-browser to only print the sign-in URL)" },
  scopes: { type: "string", description: "Comma-separated scopes to request (default: the server's default set)" },
  "read-only": { type: "boolean", description: "Request read-only (*:read) scopes only" },
};

export const authCommand = defineCommand({
  meta: { name: "auth", description: "Authentication" },
  subCommands: {
    status: defineCommand({
      meta: { name: "status", description: "Validate the current token" },
      args: commonArgs,
      async run(cittyCtx) {
        const args = cittyCtx.args as Args;
        setLoggingEnabled(args.log !== false);
        setLogBodiesEnabled(args["log-bodies"] === true);
        await authStatus(args, configFrom(args, cittyCtx.rawArgs), realDeps());
      },
    }),
    login: defineCommand({
      meta: { name: "login", description: "Sign in through your browser and store the login in the OS keychain" },
      args: loginArgs,
      async run(cittyCtx) {
        const args = cittyCtx.args as Args;
        refuseMissingGlobalValues(cittyCtx.rawArgs, loginArgs); // a bare --scopes would otherwise be read as `true`
        setLoggingEnabled(args.log !== false);
        await authLogin(args, configFrom(args, cittyCtx.rawArgs), realDeps());
      },
    }),
    logout: defineCommand({
      meta: { name: "logout", description: "Revoke the login and remove it from the OS keychain" },
      args: commonArgs,
      async run(cittyCtx) {
        const args = cittyCtx.args as Args;
        setLoggingEnabled(args.log !== false);
        await authLogout(args, configFrom(args, cittyCtx.rawArgs), realDeps());
      },
    }),
  },
});
