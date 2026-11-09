// `deel app search | describe | run` — Deel web-app actions through Deel's /mcp, as the signed-in user.
// Web-app actions carry no stability promise: they change with the web app. Nothing here is
// interactive, and a write runs without a confirmation step: the agent host's permission settings decide.

import { defineCommand } from "citty";
import { createContext } from "../core/context.ts";
import type { Ctx } from "../core/context.ts";
import { envelope, render } from "../core/output.ts";
import { setLoggingEnabled, setLogBodiesEnabled } from "../core/logging.ts";
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
  setLogBodiesEnabled(args["log-bodies"] === true);
  const config = configFrom(args, rawArgs);
  const resolved: ResolvedToken = resolveToken({ tokenStdin: Boolean(args["token-stdin"]), config, store: deps.store, transport: deps.baseTransport });
  assertEligible(resolved);
  const url = resolveMcpUrl(config);
  const ctx = createContext({ config, token: authFor(resolved), io: deps.io, baseTransport: deps.baseTransport });
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

export async function runSearch(args: Args, rawArgs: string[], deps?: AppDeps): Promise<void> {
  const query = positionals(args, rawArgs).join(" ");
  const limit = args.limit === undefined ? undefined : Number(args.limit);
  if (!query.trim()) throw new CliError("usage.app", "Usage: deel app search <what the action does> [--limit 1-20]");
  const { ctx, client } = prepare(args, rawArgs, deps);
  const { actions, requestId } = await searchActions(client, query, limit);
  await render(ctx.io, envelope({ actions }, { request_id: requestId }), outputOpts(args));
}

export async function runDescribe(args: Args, rawArgs: string[], deps?: AppDeps): Promise<void> {
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
  await render(ctx.io, envelope({ actions }, { request_id: found[found.length - 1].requestId }), outputOpts(args));
}

export async function runRun(args: Args, rawArgs: string[], deps?: AppDeps): Promise<void> {
  const [name, ...extra] = positionals(args, rawArgs);
  if (!name || extra.length > 0) throw new CliError("usage.app", "Usage: deel app run <name> [--input ...] [--dry-run]");
  const input = actionInput(args.input === undefined ? undefined : parseInput(String(args.input), []));
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

const appArgs = { ...commonArgs };

export const appCommand = defineCommand({
  meta: { name: "app", description: "Deel web-app actions through /mcp, as the signed-in user" },
  subCommands: {
    search: defineCommand({
      meta: { name: "search", description: "Find actions the signed-in user can run: deel app search <words>" },
      args: { query: { type: "positional", required: false, description: "What the action does" }, limit: { type: "string", description: `Maximum results, 1-${SEARCH_MAX_LIMIT} (default 10)` }, ...appArgs },
      run: (cittyCtx) => runSearch(cittyCtx.args as Args, cittyCtx.rawArgs),
    }),
    describe: defineCommand({
      meta: { name: "describe", description: "Show an action's input schema, scopes and run tool: deel app describe <name>..." },
      args: { name: { type: "positional", required: false, description: "Action name(s), as search returns them" }, ...appArgs },
      run: (cittyCtx) => runDescribe(cittyCtx.args as Args, cittyCtx.rawArgs),
    }),
    run: defineCommand({
      meta: { name: "run", description: "Run an action: deel app run <name> --input '{path_params, query, body}'" },
      args: {
        name: { type: "positional", required: false, description: "Action name, as search returns it" },
        "dry-run": { type: "boolean", description: "Print the tools/call that would be sent, without running it" },
        ...appArgs,
      },
      run: (cittyCtx) => runRun(cittyCtx.args as Args, cittyCtx.rawArgs),
    }),
  },
});
