// `deel auth` — validate, store, and clear the API token.
//   status  validate the current token and report identity + where it came from
//   login   read a PAT from stdin, validate it, and store it in the OS keychain
//   logout  remove the stored token from the OS keychain

import { defineCommand } from "citty";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { resolveToken, requireToken, maskToken, extractIdentity } from "../core/auth.ts";
import { credentialStore } from "../core/keychain.ts";
import { createContext } from "../core/context.ts";
import { envelope, render } from "../core/output.ts";
import { setLoggingEnabled, setLogBodiesEnabled } from "../core/logging.ts";
import { CliError } from "../core/errors.ts";
import { HEADER } from "../core/constants.ts";
import { commonArgs, configFrom, outputOpts } from "./shared.ts";
import type { Args } from "./shared.ts";
import type { Config } from "../core/config.ts";
import type { Ctx } from "../core/context.ts";

function promptSecret(question: string): Promise<string> {
  return new Promise((resolve) => {
    let muted = false;
    const out = new Writable({
      write(chunk, encoding, callback) {
        if (!muted) process.stdout.write(chunk, encoding as BufferEncoding);
        callback();
      },
    });
    const rl = createInterface({ input: process.stdin, output: out, terminal: true });
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
    muted = true;
  });
}

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
        const resolved = resolveToken({ tokenStdin: Boolean(args["token-stdin"]), env: config.env });
        const token = requireToken(resolved);
        const ctx = createContext({ config, token });
        const response = await checkToken(ctx, config, "auth status");
        if (response.status >= 400) throw new CliError("auth.invalid", `Token check failed (${response.status})`);
        await render(
          ctx.io,
          envelope({ valid: true, source: resolved.source, token: maskToken(token), identity: extractIdentity(response.json) }),
          outputOpts(args),
        );
      },
    }),
    login: defineCommand({
      meta: { name: "login", description: "Validate a PAT from stdin and store it in the OS keychain" },
      args: commonArgs,
      async run(cittyCtx) {
        const args = cittyCtx.args as Args;
        setLoggingEnabled(args.log !== false);
        const config = configFrom(args, cittyCtx.rawArgs);
        const store = credentialStore();
        if (!store.available()) {
          throw new CliError("auth.keychain", "No OS keychain available on this platform.", "Use DEEL_TOKEN or --token-stdin instead.");
        }
        const token = process.stdin.isTTY
          ? await promptSecret("Paste your Deel PAT (input hidden): ")
          : readFileSync(0, "utf8").trim();
        if (!token) throw new CliError("auth.login", "No token provided.", 'Run `deel auth login` and paste your PAT, or pipe it: echo "$PAT" | deel auth login');
        const ctx = createContext({ config, token });
        const response = await checkToken(ctx, config, "auth login");
        if (response.status >= 400) throw new CliError("auth.invalid", `Token check failed (${response.status}) — not stored.`);
        if (!store.set(config.env, token)) throw new CliError("auth.keychain", "Failed to store the token in the keychain.");
        await render(
          ctx.io,
          envelope({ stored: true, env: config.env, token: maskToken(token), identity: extractIdentity(response.json) }),
          outputOpts(args),
        );
      },
    }),
    logout: defineCommand({
      meta: { name: "logout", description: "Remove the stored token from the OS keychain" },
      args: commonArgs,
      async run(cittyCtx) {
        const args = cittyCtx.args as Args;
        setLoggingEnabled(args.log !== false);
        const config = configFrom(args, cittyCtx.rawArgs);
        const store = credentialStore();
        const removed = store.available() ? store.remove(config.env) : false;
        const ctx = createContext({ config, token: null });
        await render(ctx.io, envelope({ removed, env: config.env }), outputOpts(args));
      },
    }),
  },
});
