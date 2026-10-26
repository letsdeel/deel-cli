// `deel tokens list | get <id> | invalidate <id>` — manage API tokens.
// Tokens cannot be created from the CLI; `create` points to Developer Center instead.

import { createInterface } from "node:readline";
import { defineCommand } from "citty";
import { resolveToken, requireToken } from "../core/auth.ts";
import { createContext } from "../core/context.ts";
import type { Ctx } from "../core/context.ts";
import { envelope, render } from "../core/output.ts";
import type { OutputOpts } from "../core/output.ts";
import { setLoggingEnabled, setLogBodiesEnabled } from "../core/logging.ts";
import { CliError } from "../core/errors.ts";
import {
  CREATE_HINT,
  TOKEN_SIGNALS,
  TOKEN_SORTS,
  TOKEN_TYPES,
  buildTokenListQuery,
  getApiToken,
  listAllApiTokens,
  listApiTokens,
  resolveTokenId,
  invalidateApiToken,
  validateReason,
} from "../core/api-tokens.ts";
import type { TokenListFlags } from "../core/api-tokens.ts";
import { commonArgs, configFrom, outputOpts, readHidden } from "./shared.ts";
import type { Args } from "./shared.ts";

type CittyCtx = { args: unknown; rawArgs: string[] };

export type Confirm = (question: string) => Promise<boolean>;

const YES = /^y(es)?$/i;

function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : String(value);
}

export function listFlagsFrom(args: Args): TokenListFlags {
  return {
    limit: optionalString(args.limit),
    cursor: optionalString(args.cursor),
    all: args.all === true,
    type: optionalString(args.type),
    signal: optionalString(args.signal),
    search: optionalString(args.search),
    owner: optionalString(args.owner),
    sort: optionalString(args.sort),
  };
}

export function isYes(answer: string): boolean {
  return YES.test(answer.trim());
}

// Default invalidate confirmation: one line read from stdin, the question on stderr.
export function promptConfirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      resolve(isYes(answer));
    });
  });
}

function contextFor(cittyCtx: CittyCtx): Ctx {
  const args = cittyCtx.args as Args;
  setLoggingEnabled(args.log !== false);
  setLogBodiesEnabled(args["log-bodies"] === true);
  const config = configFrom(args, cittyCtx.rawArgs);
  const token = requireToken(resolveToken({ tokenStdin: Boolean(args["token-stdin"]), env: config.env }));
  return createContext({ config, token });
}

// The id of a single-token command: the positional, or --id=<id> for an id that starts with '-'.
export function requireId(args: Args, rawArgs: string[], usage: string): string {
  return resolveTokenId(args.id, readHidden(rawArgs, "id"), usage);
}

// `query` comes from buildTokenListQuery; `all` walks every page instead of one call.
export async function runList(ctx: Ctx, query: URLSearchParams, all: boolean, output: OutputOpts): Promise<void> {
  if (all) {
    await render(ctx.io, envelope(await listAllApiTokens(ctx, query)), output);
    return;
  }
  const page = await listApiTokens(ctx, query);
  await render(ctx.io, envelope(page.data, { next_cursor: page.next_cursor, has_more: page.has_more, total_count: page.total_count }), output);
  if (page.next_cursor !== null) ctx.io.err(`next page: --cursor ${page.next_cursor}\n`);
}

export async function runGet(ctx: Ctx, id: string, output: OutputOpts): Promise<void> {
  await render(ctx.io, envelope(await getApiToken(ctx, id)), output);
}



export type InvalidateOpts = { yes: boolean; reason?: string; idempotencyKey?: string; confirm?: Confirm };

// No invalidation is sent without --yes or an interactive yes: an invalidated token cannot be restored.
export async function runInvalidate(ctx: Ctx, id: string, opts: InvalidateOpts, output: OutputOpts): Promise<void> {
  if (!opts.yes) {
    if (!ctx.io.interactive) {
      throw new CliError("usage.tokens", `Refusing to invalidate token ${id} without confirmation`, "Pass --yes to invalidate non-interactively.");
    }
    const confirmed = await (opts.confirm ?? promptConfirm)(`Invalidate token ${id}? It stops working at once and cannot be restored. [y/N] `);
    if (!confirmed) throw new CliError("tokens.invalidate_aborted", `Aborted: token ${id} was not invalidated`);
  }
  await render(ctx.io, envelope(await invalidateApiToken(ctx, id, opts.reason, opts.idempotencyKey)), output);
}

export const tokensCommand = defineCommand({
  meta: { name: "tokens", description: "API tokens: list, inspect and invalidate (create them in Developer Center)" },
  subCommands: {
    list: defineCommand({
      meta: { name: "list", description: "List API tokens, newest first (one page; --all for every page)" },
      args: {
        limit: { type: "string", description: "Page size, 4-100 (default 100)" },
        cursor: { type: "string", description: "Next page cursor from a previous call (keeps that call's filters)" },
        all: { type: "boolean", description: "Fetch every page (100 per request)" },
        type: { type: "string", description: `Filter by type: ${TOKEN_TYPES.join(" | ")} (any case)` },
        signal: { type: "string", description: `Only tokens that need attention: ${TOKEN_SIGNALS.join(" | ")} (any case)` },
        search: { type: "string", description: "Match label, scope, or owner name or email" },
        owner: { type: "string", description: "Only tokens owned by this profile id" },
        sort: { type: "string", description: `Sort: ${TOKEN_SORTS.join(" | ")} (any case)` },
        ...commonArgs,
      },
      async run(cittyCtx) {
        const args = cittyCtx.args as Args;
        const flags = listFlagsFrom(args);
        const query = buildTokenListQuery(flags); // usage errors surface before any token lookup
        await runList(contextFor(cittyCtx), query, flags.all === true, outputOpts(args));
      },
    }),
    get: defineCommand({
      meta: { name: "get", description: "Show an API token: deel tokens get <id> (an id that starts with '-': --id=<id>)" },
      args: { id: { type: "positional", required: false, description: "Token id" }, ...commonArgs },
      async run(cittyCtx) {
        const args = cittyCtx.args as Args;
        const id = requireId(args, cittyCtx.rawArgs, "deel tokens get <id>");
        await runGet(contextFor(cittyCtx), id, outputOpts(args));
      },
    }),
    invalidate: defineCommand({
      meta: { name: "invalidate", description: "Invalidate an API token: deel tokens invalidate <id> (asks to confirm; --yes when non-interactive)" },
      args: {
        id: { type: "positional", required: false, description: "Token id" },
        reason: { type: "string", description: "Reason shown next to the invalidated token (max 200 characters)" },
        yes: { type: "boolean", description: "Invalidate without asking for confirmation" },
        ...commonArgs,
      },
      async run(cittyCtx) {
        const args = cittyCtx.args as Args;
        const id = requireId(args, cittyCtx.rawArgs, "deel tokens invalidate <id>");
        const reason = validateReason(optionalString(args.reason));
        const opts = { yes: args.yes === true, reason, idempotencyKey: optionalString(args["idempotency-key"]) };
        await runInvalidate(contextFor(cittyCtx), id, opts, outputOpts(args));
      },
    }),
    create: defineCommand({
      meta: { name: "create", description: "Not available: create tokens in Developer Center" },
      run() {
        throw new CliError("tokens.create_unsupported", "The CLI cannot create API tokens", CREATE_HINT);
      },
    }),
  },
});
