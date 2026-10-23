// `deel webhooks list | get <id> | event-types | create | update <id> | delete <id> | simulate <id>`.
// Every webhook goes through stripSigningKey before rendering, so the signing
// key never reaches stdout; the hint about where to reveal it goes to stderr.

import { defineCommand } from "citty";
import type { ArgsDef } from "citty";
import { createInterface } from "node:readline";
import { resolveToken, requireToken } from "../core/auth.ts";
import { createContext } from "../core/context.ts";
import type { Ctx } from "../core/context.ts";
import { envelope, render } from "../core/output.ts";
import type { OutputOpts } from "../core/output.ts";
import { setLoggingEnabled, setLogBodiesEnabled } from "../core/logging.ts";
import { CliError } from "../core/errors.ts";
import {
  SIGNING_KEY_HINT,
  SIMULATE_USAGE,
  buildCreateBody,
  buildListQuery,
  buildSimulateBody,
  buildUpdateBody,
  createWebhook,
  deleteWebhook,
  getWebhook,
  listAllWebhooks,
  listWebhookEventTypes,
  listWebhooks,
  resolveWebhookId,
  simulateWebhook,
  stripSigningKey,
  updateWebhook,
} from "../core/webhooks.ts";
import type { CreateWebhookBody, ListFlags, SimulateWebhookBody, UpdateWebhookBody, WebhookSimulation, WriteFlags } from "../core/webhooks.ts";
import { commonArgs, configFrom, gatherFlagValues, outputOpts, readHidden } from "./shared.ts";
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

// Last occurrence of `--<name>` (true), `--no-<name>` (false) or `--<name>=true|false`;
// undefined when absent, so an absent boolean is never sent.
export function readBooleanFlag(rawArgs: string[], name: string): boolean | undefined {
  let value: boolean | undefined;
  for (const token of rawArgs) {
    if (token === `--${name}`) value = true;
    else if (token === `--no-${name}`) value = false;
    else if (token.startsWith(`--${name}=`)) {
      const raw = token.slice(name.length + 3);
      if (raw !== "true" && raw !== "false") throw new CliError("usage.webhooks", `--${name} must be true or false, got "${raw}"`);
      value = raw === "true";
    }
  }
  return value;
}

// create / update flags. --event is repeatable, so it is read from the raw args.
export function writeFlagsFrom(args: Args, rawArgs: string[]): WriteFlags {
  return {
    name: optionalString(args.name),
    url: optionalString(args.url),
    description: optionalString(args.description),
    status: optionalString(args.status),
    events: gatherFlagValues(rawArgs, "event"),
    includeChildOrgs: readBooleanFlag(rawArgs, "include-child-orgs"),
  };
}

export type Confirm = (question: string) => Promise<boolean>;

export function isYes(answer: string): boolean {
  return /^y(es)?$/i.test(answer.trim());
}

// Default delete confirmation: one line read from stdin, the question on stderr. Closing the input without an answer
// (EOF after --token-stdin consumed stdin, Ctrl-D, Ctrl-C) counts as "no", so the promise always settles.
export function promptConfirm(question: string, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stderr): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input, output });
    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    rl.once("close", () => settle(false));
    rl.question(question, (answer) => {
      settle(isYes(answer));
      rl.close();
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

export async function runCreate(ctx: Ctx, body: CreateWebhookBody, output: OutputOpts, idempotencyKey?: string): Promise<void> {
  await renderWebhooks(ctx, await createWebhook(ctx, body, idempotencyKey), output);
}

export async function runUpdate(ctx: Ctx, id: string, body: UpdateWebhookBody, output: OutputOpts, idempotencyKey?: string): Promise<void> {
  await renderWebhooks(ctx, await updateWebhook(ctx, id, body, idempotencyKey), output);
}

export type DeleteOpts = { yes: boolean; idempotencyKey?: string; confirm?: Confirm };

// No DELETE is sent without --yes or an interactive yes.
export async function runDelete(ctx: Ctx, id: string, opts: DeleteOpts, output: OutputOpts): Promise<void> {
  if (!opts.yes) {
    if (!ctx.io.interactive) {
      throw new CliError("usage.webhooks", `Refusing to delete webhook ${id} without confirmation`, "Pass --yes to delete non-interactively.");
    }
    const confirmed = await (opts.confirm ?? promptConfirm)(`Delete webhook ${id}? [y/N] `);
    if (!confirmed) throw new CliError("webhooks.delete_aborted", `Aborted: webhook ${id} was not deleted`);
  }
  const result = await deleteWebhook(ctx, id, opts.idempotencyKey);
  await renderWebhooks(ctx, { id, ...result }, output);
}

// Same condition as render()'s human branch (--no-json on an interactive terminal).
function humanView(ctx: Ctx, output: OutputOpts): boolean {
  return !output.json && !output.jq && !output.fields && !output.quiet && ctx.io.interactive;
}

export function formatSimulation(result: WebhookSimulation | null): string {
  const delivery = result?.delivery;
  return [
    `success: ${result?.is_success === true}`,
    `receiver status code: ${delivery?.response_status_code ?? "-"}`,
    `duration: ${delivery?.duration_ms ?? "-"} ms`,
    `attempt id: ${delivery?.attempt_id ?? "-"}`,
    `delivery status: ${delivery?.status ?? "-"}`,
  ].join("\n") + "\n";
}

// Prints the delivery first, then fails (exit 1) when the receiver did not accept it.
export async function runSimulate(ctx: Ctx, id: string, body: SimulateWebhookBody, output: OutputOpts, idempotencyKey?: string): Promise<void> {
  const result = await simulateWebhook(ctx, id, body, idempotencyKey);
  if (humanView(ctx, output)) ctx.io.out(formatSimulation(result));
  else await renderWebhooks(ctx, result, output);
  if (result?.is_success !== true) {
    const statusCode = result?.delivery?.response_status_code;
    throw new CliError(
      "webhooks.simulate_failed",
      `Simulated ${body.data.event_type} delivery to webhook ${id} failed: receiver answered ${statusCode ?? "with no status code"}`,
      "Check that the receiver URL is publicly reachable from Deel's servers and returns a 2xx status.",
    );
  }
}

// The id of a single-webhook command (get / update / delete / simulate): the positional, or --id=<id> for an id that
// starts with '-'.
export function requireId(args: Args, rawArgs: string[], usage: string): string {
  return resolveWebhookId(args.id, readHidden(rawArgs, "id"), usage);
}

const writeArgs: ArgsDef = {
  name: { type: "string", description: "Webhook name" },
  url: { type: "string", description: "HTTPS endpoint that receives the events" },
  event: { type: "string", description: "Event type to subscribe to (repeatable; see deel webhooks event-types)" },
  description: { type: "string", description: "Description" },
  "include-child-orgs": { type: "boolean", description: "Also deliver events of child organizations (--no-include-child-orgs to turn off)" },
};

export const webhooksCommand = defineCommand({
  meta: { name: "webhooks", description: "Webhook subscriptions" },
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
    create: defineCommand({
      meta: { name: "create", description: "Create a webhook: deel webhooks create --name <name> --url <https-url> --event <type> [--event <type> ...]" },
      args: {
        ...writeArgs,
        status: { type: "string", description: "enabled | disabled (default enabled)" },
        ...commonArgs,
      },
      async run(cittyCtx) {
        const args = cittyCtx.args as Args;
        const body = buildCreateBody(writeFlagsFrom(args, cittyCtx.rawArgs)); // usage errors before any token lookup
        await runCreate(contextFor(cittyCtx), body, outputOpts(args), optionalString(args["idempotency-key"]));
      },
    }),
    update: defineCommand({
      meta: { name: "update", description: "Change a webhook (only the given fields): deel webhooks update <id> --status disabled (an id that starts with '-': --id=<id>)" },
      args: {
        id: { type: "positional", required: false, description: "Webhook id" },
        ...writeArgs,
        status: { type: "string", description: "enabled | disabled" },
        ...commonArgs,
      },
      async run(cittyCtx) {
        const args = cittyCtx.args as Args;
        const id = requireId(args, cittyCtx.rawArgs, "deel webhooks update <id> [--name ...] [--url ...] [--event ...] [--status ...]");
        const body = buildUpdateBody(writeFlagsFrom(args, cittyCtx.rawArgs)); // usage errors before any token lookup
        await runUpdate(contextFor(cittyCtx), id, body, outputOpts(args), optionalString(args["idempotency-key"]));
      },
    }),
    delete: defineCommand({
      meta: { name: "delete", description: "Delete a webhook: deel webhooks delete <id> (asks to confirm; --yes when non-interactive; an id that starts with '-': --id=<id>)" },
      args: {
        id: { type: "positional", required: false, description: "Webhook id" },
        yes: { type: "boolean", description: "Delete without asking for confirmation" },
        ...commonArgs,
      },
      async run(cittyCtx) {
        const args = cittyCtx.args as Args;
        const id = requireId(args, cittyCtx.rawArgs, "deel webhooks delete <id> [--yes]");
        const opts = { yes: args.yes === true, idempotencyKey: optionalString(args["idempotency-key"]) };
        await runDelete(contextFor(cittyCtx), id, opts, outputOpts(args));
      },
    }),
    simulate: defineCommand({
      meta: {
        name: "simulate",
        description:
          "Have Deel deliver a test event to a webhook: deel webhooks simulate <id> --event <type>. Delivery runs from Deel's servers, so the receiver URL must be publicly reachable; the CLI does not sign or send payloads itself. Limit: 10 simulations per hour per event type. Exits 1 when the receiver does not answer 2xx. An id that starts with '-': --id=<id>.",
      },
      args: {
        id: { type: "positional", required: false, description: "Webhook id" },
        event: { type: "string", description: "Event type to simulate (see deel webhooks event-types)" },
        ...commonArgs,
      },
      async run(cittyCtx) {
        const args = cittyCtx.args as Args;
        const id = requireId(args, cittyCtx.rawArgs, SIMULATE_USAGE);
        const body = buildSimulateBody(optionalString(args.event)); // usage errors before any token lookup
        await runSimulate(contextFor(cittyCtx), id, body, outputOpts(args), optionalString(args["idempotency-key"]));
      },
    }),
  },
});
