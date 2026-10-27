// `deel auth` — sign in, inspect and clear the stored login.
//   status  validate the current credential and report identity + where it came from
//   login   sign in through the browser (OAuth) and store the login in the OS keychain
//   logout  revoke the login (best effort) and remove it from the OS keychain

import { defineCommand } from "citty";
import { resolveToken, requireToken, authFor, accessTokenScope, maskToken, extractIdentity } from "../core/auth.ts";
import { credentialStore } from "../core/keychain.ts";
import { readOAuthEntry } from "../core/oauth.ts";
import { browserLogin, removeStoredLogin, revokeLogin } from "../core/oauth-login.ts";
import { fetchTransport } from "../core/http.ts";
import { createContext } from "../core/context.ts";
import { envelope, render } from "../core/output.ts";
import { setLoggingEnabled, setLogBodiesEnabled } from "../core/logging.ts";
import { CliError } from "../core/errors.ts";
import { HEADER } from "../core/constants.ts";
import { commonArgs, configFrom, outputOpts } from "./shared.ts";
import type { Args } from "./shared.ts";
import type { Config } from "../core/config.ts";
import type { Ctx } from "../core/context.ts";

function checkToken(ctx: Ctx, config: Config, command: string) {
  return ctx.http({
    method: "GET",
    url: `${config.baseUrl}/people/me`,
    headers: { [HEADER.accept]: "application/json" },
    retryable: true,
    meta: { command },
  });
}

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
        const config = configFrom(args, cittyCtx.rawArgs);
        const resolved = resolveToken({ tokenStdin: Boolean(args["token-stdin"]), config });
        requireToken(resolved);
        const ctx = createContext({ config, token: authFor(resolved) });
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
      },
    }),
    login: defineCommand({
      meta: { name: "login", description: "Sign in through your browser and store the login in the OS keychain" },
      args: {
        ...commonArgs,
        browser: { type: "boolean", default: true, description: "Open the browser (--no-browser to only print the sign-in URL)" },
        scopes: { type: "string", description: "Comma-separated scopes to request (default: all available)" },
        "read-only": { type: "boolean", description: "Request read-only (*:read) scopes only" },
      },
      async run(cittyCtx) {
        const args = cittyCtx.args as Args;
        setLoggingEnabled(args.log !== false);
        const config = configFrom(args, cittyCtx.rawArgs);
        const store = credentialStore();
        if (!store.available()) {
          throw new CliError("auth.keychain", "No OS keychain available on this platform.", "Use DEEL_TOKEN or --token-stdin with a PAT instead.");
        }
        if (!config.oauthBaseUrlOk) {
          throw new CliError("auth.base_url", "A browser login is only sent to its own environment's API host.", "Drop --base-url, or use DEEL_TOKEN or --token-stdin with a PAT.");
        }
        const ctx = createContext({ config, token: null });
        const entry = await browserLogin({
          config,
          store,
          transport: fetchTransport,
          say: (text) => ctx.io.err(text),
          open: args.browser !== false,
          scopes: args.scopes as string | undefined,
          readOnly: Boolean(args["read-only"]),
        });
        const authed = createContext({ config, token: entry.access_token });
        const response = await checkToken(authed, config, "auth login");
        if (response.status >= 400) throw new CliError("auth.invalid", `Signed in, but the identity check failed (${response.status}).`, "Run 'deel auth status' to retry.");
        await render(
          ctx.io,
          envelope({ stored: true, env: config.env, auth: "oauth", identity: extractIdentity(response.json), scope: accessTokenScope(entry.access_token), expires_at: entry.expires_at }),
          outputOpts(args),
        );
      },
    }),
    logout: defineCommand({
      meta: { name: "logout", description: "Revoke the login and remove it from the OS keychain" },
      args: commonArgs,
      async run(cittyCtx) {
        const args = cittyCtx.args as Args;
        setLoggingEnabled(args.log !== false);
        const config = configFrom(args, cittyCtx.rawArgs);
        const store = credentialStore();
        const ctx = createContext({ config, token: null });
        let revoked: boolean | "unsupported" = false;
        let removed = false;
        if (store.available()) {
          const entry = config.issuer ? readOAuthEntry(store, config.issuer) : null;
          if (entry && config.issuer) {
            revoked = await revokeLogin(entry, { issuer: config.issuer, clientId: config.clientId }, fetchTransport);
            if (revoked === "unsupported") ctx.io.err("The server does not support revocation; the login was only removed from this machine.\n");
            else if (!revoked) ctx.io.err("Could not revoke the login on the server; it was removed from this machine.\n");
          }
          removed = removeStoredLogin(store, config);
        }
        await render(ctx.io, envelope({ removed, env: config.env, revoked }), outputOpts(args));
      },
    }),
  },
});
