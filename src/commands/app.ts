// `deel app search | describe | run` — Deel web-app actions through Deel's /mcp, as the signed-in user.
// Web-app actions carry no stability promise: they change with the web app. Nothing here is
// interactive, and a write runs without a confirmation step: the agent host's permission settings decide.

import { defineCommand } from "citty";
import { createContext } from "../core/context.ts";
import type { Ctx } from "../core/context.ts";
import { envelope, render } from "../core/output.ts";
import { setLoggingEnabled } from "../core/logging.ts";
import { resolveMcpUrl } from "../core/config.ts";
import { authFor, resolveToken } from "../core/auth.ts";
import type { ResolvedToken } from "../core/auth.ts";
import { parseInput } from "../core/input.ts";
import { CliError } from "../core/errors.ts";
import type { IOStreams } from "../core/io.ts";
import type { Transport } from "../core/http.ts";
import type { CredentialStore } from "../core/keychain.ts";
import {
  SEARCH_MAX_LIMIT,
  actionInput,
  assertEligible,
  beforeRequest,
  createAppClient,
  getAction,
  inputSkeleton,
  runAction,
  runCall,
  searchActions,
} from "../core/app-actions.ts";
import type { AppClient } from "../core/app-actions.ts";
import { commonArgs, configFrom, outputOpts } from "./shared.ts";
import type { Args } from "./shared.ts";

// Test seams: a fake transport, keychain or IO; the real ones otherwise.
export type AppDeps = { baseTransport?: Transport; store?: CredentialStore; io?: IOStreams; sleep?: (ms: number) => Promise<void> };

type Session = { ctx: Ctx; client: AppClient };

function prepare(args: Args, rawArgs: string[], deps: AppDeps = {}): Session {
  setLoggingEnabled(args.log !== false);
  const config = configFrom(args, rawArgs);
  const resolved: ResolvedToken = resolveToken({ tokenStdin: Boolean(args["token-stdin"]), config, store: deps.store, transport: deps.baseTransport });
  assertEligible(resolved);
  const url = resolveMcpUrl(config, { oauth: resolved.source === "oauth" });
  // A failed login refresh must not read as "the action may have run": it fails before the request is sent.
  const token = authFor(resolved);
  const ctx = createContext({ config, token: typeof token === "function" ? () => beforeRequest(token) : token, io: deps.io, baseTransport: deps.baseTransport });
  const oauth = resolved.oauth;
  const client = createAppClient({
    http: ctx.http,
    url,
    newRequestId: ctx.newRequestId,
    sleep: deps.sleep,
    renew: oauth
      ? async () => {
          await oauth.renew(oauth.current().access_token);
          return true;
        }
      : undefined,
  });
  return { ctx, client };
}

// Global flags the app commands honour; the rest of commonArgs (--file, --form, --idempotency-key, --debug ...)
// would be accepted and ignored, which is worse than an error for a write.
const HONOURED_FLAGS = ["json", "quiet", "fields", "jq", "raw", "env", "beta", "ca-cert", "token-stdin", "log"] as const;
const FLAG_HELP: Record<string, string> = {
  "token-stdin": "Read the OAuth access token from stdin",
  quiet: "Print ids only (the action names for search and describe)",
};
const appArgs = Object.fromEntries(HONOURED_FLAGS.map((flag) => [flag, flag in FLAG_HELP ? { ...commonArgs[flag], description: FLAG_HELP[flag] } : commonArgs[flag]]));
const UNSUPPORTED_FLAGS = ["file", "form", "idempotency-key", "debug", "log-bodies"];

function refuseUnsupported(rawArgs: string[], extra: string[]): void {
  for (const flag of [...UNSUPPORTED_FLAGS, ...extra]) {
    if (rawArgs.some((token) => token === `--${flag}` || token.startsWith(`--${flag}=`))) {
      throw new CliError("usage.app", `--${flag} isn't supported by this 'deel app' command.`, "See 'deel app --help'.");
    }
  }
}

// citty ignores a flag it doesn't know, so a mistyped `--dryrun` would run the write. Every `--flag` must be one this
// command declares, a `--no-` form of one, or the hidden `--base-url`.
function refuseUnknownFlags(rawArgs: string[], own: string[]): void {
  const known = new Set<string>([...HONOURED_FLAGS, ...own, ...HIDDEN_VALUE_FLAGS, "help"]);
  for (const token of rawArgs) {
    if (token === "--") return;
    if (!token.startsWith("--")) continue;
    const name = token.slice(2).split("=")[0];
    if (!known.has(name) && !known.has(name.replace(/^no-/, ""))) {
      throw new CliError("usage.app", `Unknown flag --${name}.`, "See 'deel app --help'. Nothing was run.");
    }
  }
}

// Hidden flags citty doesn't declare, so `--flag value` would leave the value among the positionals.
const HIDDEN_VALUE_FLAGS = ["base-url"];

// Every positional word (citty's positional arg keeps only the first), without the values of hidden flags.
export function positionals(args: Args, rawArgs: string[]): string[] {
  const words = Array.isArray(args._) ? args._.map(String) : [];
  for (const flag of HIDDEN_VALUE_FLAGS) {
    const at = rawArgs.indexOf(`--${flag}`);
    if (at === -1 || at + 1 >= rawArgs.length) continue;
    const index = words.indexOf(rawArgs[at + 1]);
    if (index !== -1) words.splice(index, 1);
  }
  return words;
}

// The actions as the `data` list. --quiet prints their names, one per line: the shared one looks for ids.
async function renderActions(io: IOStreams, actions: Array<{ name: string }>, requestId: string, args: Args): Promise<void> {
  const opts = outputOpts(args);
  if (opts.quiet && !opts.jq) io.out(actions.map((action) => action.name).join("\n") + "\n");
  else await render(io, envelope(actions, { request_id: requestId }), opts);
}

export async function runSearch(args: Args, rawArgs: string[], deps?: AppDeps): Promise<void> {
  refuseUnsupported(rawArgs, ["input", "generate-input", "dry-run"]);
  refuseUnknownFlags(rawArgs, ["limit"]);
  const query = positionals(args, rawArgs).join(" ");
  const limit = args.limit === undefined ? undefined : Number(args.limit);
  if (!query.trim()) throw new CliError("usage.app", "Usage: deel app search <what the action does> [--limit 1-20]");
  const { ctx, client } = prepare(args, rawArgs, deps);
  const { actions, requestId } = await searchActions(client, query, limit);
  await renderActions(ctx.io, actions, requestId, args);
}

export async function runDescribe(args: Args, rawArgs: string[], deps?: AppDeps): Promise<void> {
  refuseUnsupported(rawArgs, ["input", "dry-run"]);
  refuseUnknownFlags(rawArgs, ["generate-input"]);
  const names = positionals(args, rawArgs);
  if (names.length === 0) throw new CliError("usage.app", "Usage: deel app describe <name>... [--generate-input]");
  if (args["generate-input"] && names.length > 1) throw new CliError("usage.app", "--generate-input takes one action name.");
  const { ctx, client } = prepare(args, rawArgs, deps);
  const found = [];
  for (const name of names) found.push(await getAction(client, name));
  if (args["generate-input"]) {
    ctx.io.out(JSON.stringify(inputSkeleton(found[0].action), null, 2) + "\n");
    return;
  }
  const actions = found.map((item) => item.action);
  await renderActions(ctx.io, actions, found[found.length - 1].requestId, args);
}

export async function runRun(args: Args, rawArgs: string[], deps?: AppDeps): Promise<void> {
  refuseUnsupported(rawArgs, ["generate-input"]);
  refuseUnknownFlags(rawArgs, ["input", "dry-run"]);
  const [name, ...extra] = positionals(args, rawArgs);
  if (!name || extra.length > 0) throw new CliError("usage.app", "Usage: deel app run <name> [--input ...] [--dry-run]");
  const input = actionInput(args.input === undefined ? undefined : parseInput(String(args.input), [], { exactScalars: true }));
  const { ctx, client } = prepare(args, rawArgs, deps);
  const { action, requestId } = await getAction(client, name);
  if (args["dry-run"]) {
    const call = runCall(action, input);
    await render(ctx.io, envelope({ method: "tools/call", params: { name: call.tool, arguments: call.arguments } }, { request_id: requestId, dry_run: true }), outputOpts(args));
    return;
  }
  const outcome = await runAction(client, action, input);
  const meta: Record<string, unknown> = { request_id: outcome.requestId };
  if (outcome.truncated) {
    meta.truncated = outcome.truncated;
    ctx.io.err(`warning: the response was cut at ${outcome.truncated.shown_bytes} of ${outcome.truncated.total_bytes} bytes, so it is returned as text. Narrow the query to get all of it.\n`);
  }
  await render(ctx.io, envelope(outcome.data, meta), outputOpts(args));
}

// `deps` are the test seams of the run functions; the real transport, keychain and IO otherwise.
export function createAppCommand(deps?: AppDeps) {
  return defineCommand({
    meta: { name: "app", description: "Deel web-app actions through /mcp, as the signed-in user" },
    subCommands: {
      search: defineCommand({
        meta: { name: "search", description: "Find actions the signed-in user can run: deel app search <words>" },
        args: { query: { type: "positional", required: false, description: "What the action does" }, limit: { type: "string", description: `Maximum results, 1-${SEARCH_MAX_LIMIT} (default 10)` }, ...appArgs },
        run: (cittyCtx) => runSearch(cittyCtx.args as Args, cittyCtx.rawArgs, deps),
      }),
      describe: defineCommand({
        meta: { name: "describe", description: "Show an action's input schema, scopes and run tool: deel app describe <name>..." },
        args: {
          name: { type: "positional", required: false, description: "Action name(s), as search returns them" },
          "generate-input": commonArgs["generate-input"],
          ...appArgs,
        },
        run: (cittyCtx) => runDescribe(cittyCtx.args as Args, cittyCtx.rawArgs, deps),
      }),
      run: defineCommand({
        meta: { name: "run", description: "Run an action: deel app run <name> --input '{path_params, query, body}'" },
        args: {
          name: { type: "positional", required: false, description: "Action name, as search returns it" },
          input: { ...commonArgs.input, description: "The call's input: one object with path_params, query and body" },
          "dry-run": { type: "boolean", description: "Print the tools/call that would be sent, without running it" },
          ...appArgs,
        },
        run: (cittyCtx) => runRun(cittyCtx.args as Args, cittyCtx.rawArgs, deps),
      }),
    },
  });
}

export const appCommand = createAppCommand();
