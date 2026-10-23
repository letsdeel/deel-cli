// Webhook reads (list / get / event types) over the injected transport, plus the
// signing_key strip that every rendered webhook must go through: the API returns
// the signing key on every webhook response, and the CLI never prints it.

import type { Ctx } from "./context.ts";
import { CliError } from "./errors.ts";
import { HEADER } from "./constants.ts";
import { errorFromResponse } from "./executor.ts";

// Shape of GET /webhooks items and GET /webhooks/{id} `data`.
export type Webhook = {
  id: string;
  name: string;
  description: string | null;
  status: "enabled" | "disabled";
  url: string;
  events: string[];
  api_version: string;
  signing_key?: string;
  hidden: boolean;
  internal: boolean;
  flatten_keys?: boolean;
  include_child_orgs?: boolean;
  created_by?: { id: number; name: string | null } | null;
  last_delivery_at?: string | null;
  last_delivery_status?: string | null;
  created_at: string;
  updated_at: string;
};

export type WebhookEventType = {
  id: string;
  module_name: string;
  module_label: string;
  name: string;
  description: string | null;
  payload_example: string;
  created_at: string;
  updated_at: string;
};

export type WebhookPage = { data: Webhook[]; cursor: string | null };

export type ListFlags = {
  limit?: string;
  cursor?: string;
  all?: boolean;
  status?: string;
  search?: string;
  order?: string;
};

export const SIGNING_KEY_HINT = "reveal the signing key in Developer Center → Webhooks";
export const WEBHOOKS_PAGE_SIZE = 100;
export const WEBHOOKS_MAX_PAGES = 1000;
const WEBHOOK_STATUSES = ["enabled", "disabled"];
const ORDER_PATTERN = /^(name|created_at|status)(:(asc|desc))?$/;
const USAGE = "usage.webhooks";

export const DASH_ID_HINT = "An id that starts with '-' must be passed as --id=<id>.";

// A webhook id comes from the positional argument or from --id=<id>, which wins. Ids can start with '-', which the
// argument parser reads as flags, so the positional never arrives; --id is read from the raw args (it is not a
// declared flag, as the positional already owns the name `id`).
export function resolveWebhookId(positional: unknown, flagValue: string | undefined, usage: string): string {
  const id = (flagValue ?? "").trim() || String(positional ?? "").trim();
  if (!id) throw new CliError(USAGE, `Usage: ${usage}`, DASH_ID_HINT);
  return id;
}

// Remove `signing_key` from one webhook or from each webhook of an array, without
// mutating the input. `stripped` tells the caller whether to print SIGNING_KEY_HINT.
export function stripSigningKey(payload: unknown): { data: unknown; stripped: boolean } {
  let stripped = false;
  const strip = (item: unknown): unknown => {
    if (!item || typeof item !== "object" || Array.isArray(item) || !Object.hasOwn(item, "signing_key")) return item;
    stripped = true;
    const { signing_key: _removed, ...rest } = item as Record<string, unknown>;
    return rest;
  };
  const data = Array.isArray(payload) ? payload.map(strip) : strip(payload);
  return { data, stripped };
}

// `deel webhooks list` flags -> query string. Paging is opt-in on the API: with no
// --limit/--cursor nothing paging-related is sent and the whole list comes back.
// --all sends no paging params here; listAllWebhooks adds limit/cursor per page.
export function buildListQuery(flags: ListFlags): URLSearchParams {
  const params = new URLSearchParams();
  const hasLimit = flags.limit !== undefined;
  const hasCursor = flags.cursor !== undefined;

  if (flags.all && (hasLimit || hasCursor)) {
    throw new CliError(USAGE, "--all cannot be combined with --limit or --cursor", "--all already walks every page.");
  }
  if (hasLimit) {
    const limit = Number(flags.limit);
    if (!/^\d+$/.test(String(flags.limit)) || limit < 1 || limit > 100) {
      throw new CliError(USAGE, `--limit must be an integer between 1 and 100, got "${flags.limit}"`);
    }
    params.set("limit", String(limit));
  }
  if (hasCursor) {
    if (!flags.cursor) throw new CliError(USAGE, "--cursor needs a value", "Use the next page cursor printed by the previous call.");
    params.set("cursor", flags.cursor);
  }
  if (flags.status !== undefined) {
    if (!WEBHOOK_STATUSES.includes(flags.status)) {
      throw new CliError(USAGE, `--status must be one of: ${WEBHOOK_STATUSES.join(", ")}, got "${flags.status}"`);
    }
    params.set("status", flags.status);
  }
  if (flags.search !== undefined) params.set("search", flags.search);
  if (flags.order !== undefined) {
    if (!ORDER_PATTERN.test(flags.order)) {
      throw new CliError(USAGE, `--order must be name|created_at|status, optionally followed by :asc or :desc, got "${flags.order}"`);
    }
    // The API honors _order only on the unpaginated call, so a paged sort would be silently wrong.
    if (hasLimit || hasCursor || flags.all) {
      throw new CliError(USAGE, "--order cannot be combined with --limit, --cursor or --all", "Drop the paging flags to sort the whole list.");
    }
    params.set("_order", flags.order);
  }
  return params;
}

async function getJson(ctx: Ctx, url: string, command: string): Promise<unknown> {
  // Generated here so it can be surfaced in the error envelope; the request-id
  // middleware leaves an existing header untouched.
  const requestId = ctx.newRequestId();
  const response = await ctx.http({
    method: "GET",
    url,
    headers: { [HEADER.accept]: "application/json", [HEADER.requestId]: requestId },
    retryable: true,
    meta: { command },
  });
  if (response.status >= 400) throw errorFromResponse(response.status, response.json, requestId);
  return response.json;
}

export async function listWebhooks(ctx: Ctx, params: URLSearchParams): Promise<WebhookPage> {
  const query = params.toString();
  const url = `${ctx.config.baseUrl}/webhooks${query ? `?${query}` : ""}`;
  const json = (await getJson(ctx, url, "webhooks list")) as any;
  const cursor = typeof json?.cursor === "string" && json.cursor !== "" ? json.cursor : null;
  return { data: Array.isArray(json?.data) ? json.data : [], cursor };
}

// --all: pages of WEBHOOKS_PAGE_SIZE following `cursor` until the API returns null. A cursor the API already
// returned (an A -> B -> A cycle, or the same one twice) or more than WEBHOOKS_MAX_PAGES pages is an error rather
// than a loop that grows without bound or a silently truncated list.
export async function listAllWebhooks(ctx: Ctx, params: URLSearchParams): Promise<Webhook[]> {
  const webhooks: Webhook[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let pages = 0; ; pages++) {
    if (pages >= WEBHOOKS_MAX_PAGES) {
      throw new CliError("webhooks.paging_limit", `Stopped after ${WEBHOOKS_MAX_PAGES} pages of webhooks`, "Narrow the list with --status or --search, or page manually with --limit and --cursor.");
    }
    const pageParams = new URLSearchParams(params);
    pageParams.set("limit", String(WEBHOOKS_PAGE_SIZE));
    if (cursor !== null) pageParams.set("cursor", cursor);
    const page: WebhookPage = await listWebhooks(ctx, pageParams);
    webhooks.push(...page.data);
    if (page.cursor === null) return webhooks;
    if (seen.has(page.cursor)) {
      throw new CliError("webhooks.paging_stuck", "The API returned the same cursor twice, so the list cannot be completed", "Retry, or page manually with --limit and --cursor.");
    }
    seen.add(page.cursor);
    cursor = page.cursor;
  }
}

export async function getWebhook(ctx: Ctx, id: string): Promise<Webhook | null> {
  const json = (await getJson(ctx, `${ctx.config.baseUrl}/webhooks/${encodeURIComponent(id)}`, "webhooks get")) as any;
  return json?.data ?? null;
}

export async function listWebhookEventTypes(ctx: Ctx): Promise<WebhookEventType[]> {
  const json = (await getJson(ctx, `${ctx.config.baseUrl}/webhooks/events/types`, "webhooks event-types")) as any;
  return Array.isArray(json?.data) ? json.data : [];
}
