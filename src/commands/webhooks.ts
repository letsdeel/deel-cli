// `deel webhooks list | get <id> | event-types` — read-only webhook commands.
// Every webhook goes through stripSigningKey before rendering, so the signing
// key never reaches stdout; the hint about where to reveal it goes to stderr.

import { defineCommand } from "citty";
import { resolveToken, requireToken } from "../core/auth.ts";
import { createContext } from "../core/context.ts";
import type { Ctx } from "../core/context.ts";
import { envelope, render } from "../core/output.ts";
import type { OutputOpts } from "../core/output.ts";
import { setLoggingEnabled, setLogBodiesEnabled } from "../core/logging.ts";
import { CliError } from "../core/errors.ts";
import {
  SIGNING_KEY_HINT,
  buildListQuery,
  getWebhook,
  listAllWebhooks,
  listWebhookEventTypes,
  listWebhooks,
  resolveWebhookId,
  stripSigningKey,
} from "../core/webhooks.ts";
import type { ListFlags } from "../core/webhooks.ts";
import { commonArgs, configFrom, outputOpts, readHidden } from "./shared.ts";
import type { Args } from "./shared.ts";

type CittyCtx = { args: unknown; rawArgs: string[] };

function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : String(value);
}

export function listFlagsFrom(args: Args): ListFlags {
  return {
    limit: optionalString(args.limit),
    cursor: optionalString(args.cursor),
    all: args.all === true,
    status: optionalString(args.status),
    search: optionalString(args.search),
    order: optionalString(args.order),
  };
}

function contextFor(cittyCtx: CittyCtx): Ctx {
  const args = cittyCtx.args as Args;
  setLoggingEnabled(args.log !== false);
  setLogBodiesEnabled(args["log-bodies"] === true);
  const config = configFrom(args, cittyCtx.rawArgs);
  const token = requireToken(resolveToken({ tokenStdin: Boolean(args["token-stdin"]), env: config.env }));
  return createContext({ config, token });
}

async function renderWebhooks(ctx: Ctx, payload: unknown, output: OutputOpts, meta?: Record<string, unknown>): Promise<void> {
  const { data, stripped } = stripSigningKey(payload);
  await render(ctx.io, envelope(data, meta), output);
  if (stripped) ctx.io.err(`signing_key omitted: ${SIGNING_KEY_HINT}\n`);
}

// `query` comes from buildListQuery; `all` walks every page instead of one call.
export async function runList(ctx: Ctx, query: URLSearchParams, all: boolean, output: OutputOpts): Promise<void> {
  if (all) {
    await renderWebhooks(ctx, await listAllWebhooks(ctx, query), output);
    return;
  }
  const page = await listWebhooks(ctx, query);
  const paged = query.has("limit") || query.has("cursor");
  await renderWebhooks(ctx, page.data, output, paged ? { next_cursor: page.cursor } : undefined);
  if (page.cursor !== null) ctx.io.err(`next page: --cursor ${page.cursor}\n`);
}

export async function runGet(ctx: Ctx, id: string, output: OutputOpts): Promise<void> {
  await renderWebhooks(ctx, await getWebhook(ctx, id), output);
}

export async function runEventTypes(ctx: Ctx, output: OutputOpts): Promise<void> {
  await render(ctx.io, envelope(await listWebhookEventTypes(ctx)), output);
}

// The id of `get <id>` (and, in later commands, update / delete / simulate): the positional, or --id=<id> for an id
// that starts with '-'.
export function requireId(args: Args, rawArgs: string[], usage: string): string {
  return resolveWebhookId(args.id, readHidden(rawArgs, "id"), usage);
}

export const webhooksCommand = defineCommand({
  meta: { name: "webhooks", description: "Webhook subscriptions (read-only)" },
  subCommands: {
    list: defineCommand({
      meta: { name: "list", description: "List webhooks (whole list by default; --limit/--cursor for one page, --all for every page)" },
      args: {
        limit: { type: "string", description: "Page size, 1-100 (opts into paging)" },
        cursor: { type: "string", description: "Next page cursor from a previous call" },
        all: { type: "boolean", description: "Fetch every page (100 per request)" },
        status: { type: "string", description: "Filter by status: enabled | disabled" },
        search: { type: "string", description: "Filter by name or URL" },
        order: { type: "string", description: "Sort: name|created_at|status[:asc|desc] (not with --limit/--cursor/--all)" },
        ...commonArgs,
      },
      async run(cittyCtx) {
        const args = cittyCtx.args as Args;
        const flags = listFlagsFrom(args);
        const query = buildListQuery(flags); // usage errors surface before any token lookup
        await runList(contextFor(cittyCtx), query, flags.all === true, outputOpts(args));
      },
    }),
    get: defineCommand({
      meta: { name: "get", description: "Show one webhook: deel webhooks get <id> (an id that starts with '-': --id=<id>)" },
      args: { id: { type: "positional", required: false, description: "Webhook id" }, ...commonArgs },
      async run(cittyCtx) {
        const args = cittyCtx.args as Args;
        const id = requireId(args, cittyCtx.rawArgs, "deel webhooks get <id>");
        await runGet(contextFor(cittyCtx), id, outputOpts(args));
      },
    }),
    "event-types": defineCommand({
      meta: { name: "event-types", description: "List the event types a webhook can subscribe to" },
      args: commonArgs,
      async run(cittyCtx) {
        const args = cittyCtx.args as Args;
        await runEventTypes(contextFor(cittyCtx), outputOpts(args));
      },
    }),
  },
});
