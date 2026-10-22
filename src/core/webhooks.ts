// Webhook reads (list / get / event types), writes (create / update / delete) and
// simulate over the injected transport, plus the signing_key strip that every rendered
// webhook must go through: the API returns the signing key on every webhook
// response, and the CLI never prints it.

import type { Ctx } from "./context.ts";
import { CliError } from "./errors.ts";
import { HEADER } from "./constants.ts";
import { errorFromResponse } from "./executor.ts";
import { deriveIdempotencyKey } from "./idempotency.ts";

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

// `deel webhooks create` / `update` flags. `events` holds every --event occurrence.
export type WriteFlags = {
  name?: string;
  url?: string;
  description?: string;
  status?: string;
  events: string[];
  includeChildOrgs?: boolean;
};

// POST /webhooks body. api_version is always "v2" (the only version the API accepts).
export type CreateWebhookBody = {
  name: string;
  url: string;
  events: string[];
  status: "enabled" | "disabled";
  api_version: "v2";
  description?: string;
  include_child_orgs?: boolean;
};

// PATCH /webhooks/{id} body: only the fields the user passed.
export type UpdateWebhookBody = {
  name?: string;
  url?: string;
  description?: string;
  events?: string[];
  status?: "enabled" | "disabled";
  include_child_orgs?: boolean;
};

// POST /webhooks/{id}/simulate body and its 200 `data`; `delivery` is null when no delivery was made.
export type SimulateWebhookBody = { data: { event_type: string } };

export type WebhookSimulation = {
  is_success: boolean;
  delivery: {
    attempt_id: number | null;
    status: "success" | "failed" | string;
    response_status_code: number | null;
    duration_ms: number | null;
  } | null;
};

export const SIGNING_KEY_HINT = "reveal the signing key in Developer Center → Webhooks";
export const SIMULATE_USAGE = "deel webhooks simulate <id> --event <type>";
export const SIMULATE_RATE_LIMIT_HINT = "Simulations are limited to 10 simulations per hour per event type; wait before trying again.";
export const SIMULATE_NOT_FOUND_HINT =
  "No webhook with this id in your organization, or the event type has no sample payload; check `deel webhooks list` and `deel webhooks event-types`.";
export const WEBHOOKS_PAGE_SIZE = 100;
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

function checkStatus(status: string): "enabled" | "disabled" {
  if (!WEBHOOK_STATUSES.includes(status)) {
    throw new CliError(USAGE, `--status must be one of: ${WEBHOOK_STATUSES.join(", ")}, got "${status}"`);
  }
  return status as "enabled" | "disabled";
}

// `deel webhooks create` flags -> POST body. --name, --url and one --event are
// required; --status defaults to enabled.
export function buildCreateBody(flags: WriteFlags): CreateWebhookBody {
  const missing = [!flags.name && "--name", !flags.url && "--url", flags.events.length === 0 && "--event"].filter(Boolean);
  if (missing.length > 0) {
    throw new CliError(
      USAGE,
      `deel webhooks create requires ${missing.join(", ")}`,
      "Usage: deel webhooks create --name <name> --url <https-url> --event <type> [--event <type> ...]",
    );
  }
  const body: CreateWebhookBody = {
    name: flags.name as string,
    url: flags.url as string,
    events: flags.events,
    status: checkStatus(flags.status ?? "enabled"),
    api_version: "v2",
  };
  if (flags.description !== undefined) body.description = flags.description;
  if (flags.includeChildOrgs !== undefined) body.include_child_orgs = flags.includeChildOrgs;
  return body;
}

// `deel webhooks update` flags -> PATCH body holding only the given fields; at
// least one is required (the API rejects an empty PATCH).
export function buildUpdateBody(flags: WriteFlags): UpdateWebhookBody {
  const body: UpdateWebhookBody = {};
  if (flags.name !== undefined) body.name = flags.name;
  if (flags.url !== undefined) body.url = flags.url;
  if (flags.description !== undefined) body.description = flags.description;
  if (flags.events.length > 0) body.events = flags.events;
  if (flags.status !== undefined) body.status = checkStatus(flags.status);
  if (flags.includeChildOrgs !== undefined) body.include_child_orgs = flags.includeChildOrgs;
  if (Object.keys(body).length === 0) {
    throw new CliError(
      USAGE,
      "deel webhooks update needs at least one field to change",
      "Pass one or more of --name, --url, --description, --event, --status, --include-child-orgs/--no-include-child-orgs.",
    );
  }
  return body;
}

// `deel webhooks simulate` flag -> POST body. --event is required.
export function buildSimulateBody(eventType: string | undefined): SimulateWebhookBody {
  const value = eventType?.trim();
  if (!value) throw new CliError(USAGE, "deel webhooks simulate requires --event", `Usage: ${SIMULATE_USAGE}`);
  return { data: { event_type: value } };
}

function appendNext(error: CliError, hint: string): void {
  error.next = error.next ? `${error.next} ${hint}` : hint;
}

// Simulate error -> CliError. Hints are chosen on the HTTP status, never on the
// code string (the gateway mostly sends a generic code per status). Also accepts
// the pre-gateway flat `{ error_code, message }` body.
export function simulateErrorFromResponse(status: number, json: unknown, requestId: string): CliError {
  const error = errorFromResponse(status, json, requestId);
  const body = json as any;
  if (!Array.isArray(body?.errors) && body?.error == null && body?.code == null && typeof body?.error_code === "string") {
    error.code = body.error_code;
  }
  if (status === 429) appendNext(error, SIMULATE_RATE_LIMIT_HINT);
  if (status === 404) appendNext(error, SIMULATE_NOT_FOUND_HINT);
  return error;
}

// `retryable: false` sends the request once; `deriveKey: false` sends an
// Idempotency-Key only when the caller passes one. `toError` replaces the shared
// errorFromResponse mapping.
type SendOpts = {
  idempotencyKey?: string;
  retryable?: boolean;
  deriveKey?: boolean;
  toError?: (status: number, json: unknown, requestId: string) => CliError;
};

// Mutating call, sent like the generic executor by default: JSON body, an
// Idempotency-Key (the --idempotency-key override or one derived from the request) and retries.
async function sendJson(ctx: Ctx, method: string, path: string, body: unknown, command: string, opts: SendOpts = {}): Promise<unknown> {
  const requestId = ctx.newRequestId();
  const key = opts.idempotencyKey ?? (opts.deriveKey === false ? undefined : deriveIdempotencyKey({ method, path, query: {}, body }));
  const headers: Record<string, string> = {
    [HEADER.accept]: "application/json",
    [HEADER.requestId]: requestId,
  };
  if (key !== undefined) headers[HEADER.idempotencyKey] = key;
  if (body !== undefined) headers[HEADER.contentType] = "application/json";
  const response = await ctx.http({
    method,
    url: `${ctx.config.baseUrl}${path}`,
    headers,
    body: body === undefined ? null : JSON.stringify(body),
    retryable: opts.retryable ?? true,
    meta: key === undefined ? { command } : { command, idempotency_key: key },
  });
  if (response.status >= 400) throw (opts.toError ?? errorFromResponse)(response.status, response.json, requestId);
  return response.json;
}

export async function createWebhook(ctx: Ctx, body: CreateWebhookBody, idempotencyKey?: string): Promise<Webhook | null> {
  const json = (await sendJson(ctx, "POST", "/webhooks", body, "webhooks create", { idempotencyKey })) as any;
  return json?.data ?? null;
}

export async function updateWebhook(ctx: Ctx, id: string, body: UpdateWebhookBody, idempotencyKey?: string): Promise<Webhook | null> {
  const json = (await sendJson(ctx, "PATCH", `/webhooks/${encodeURIComponent(id)}`, body, "webhooks update", { idempotencyKey })) as any;
  return json?.data ?? null;
}

export async function deleteWebhook(ctx: Ctx, id: string, idempotencyKey?: string): Promise<Record<string, unknown>> {
  const json = (await sendJson(ctx, "DELETE", `/webhooks/${encodeURIComponent(id)}`, undefined, "webhooks delete", { idempotencyKey })) as any;
  return json?.data && typeof json.data === "object" ? json.data : { deleted: true };
}

// Each simulation is meant to be a new delivery: no retry (a 429 retry would burn
// the hourly quota) and no derived Idempotency-Key (a gateway could replay the
// previous response for the same {id, event_type}).
export async function simulateWebhook(ctx: Ctx, id: string, body: SimulateWebhookBody, idempotencyKey?: string): Promise<WebhookSimulation | null> {
  const json = (await sendJson(ctx, "POST", `/webhooks/${encodeURIComponent(id)}/simulate`, body, "webhooks simulate", {
    idempotencyKey,
    retryable: false,
    deriveKey: false,
    toError: simulateErrorFromResponse,
  })) as any;
  return json?.data ?? null;
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

// --all: pages of WEBHOOKS_PAGE_SIZE following `cursor` until the API returns null.
export async function listAllWebhooks(ctx: Ctx, params: URLSearchParams): Promise<Webhook[]> {
  const webhooks: Webhook[] = [];
  let cursor: string | null = null;
  do {
    const pageParams = new URLSearchParams(params);
    pageParams.set("limit", String(WEBHOOKS_PAGE_SIZE));
    if (cursor !== null) pageParams.set("cursor", cursor);
    const page: WebhookPage = await listWebhooks(ctx, pageParams);
    webhooks.push(...page.data);
    // Guard against a cursor that does not advance, which would loop forever.
    cursor = page.cursor === cursor ? null : page.cursor;
  } while (cursor !== null);
  return webhooks;
}

export async function getWebhook(ctx: Ctx, id: string): Promise<Webhook | null> {
  const json = (await getJson(ctx, `${ctx.config.baseUrl}/webhooks/${encodeURIComponent(id)}`, "webhooks get")) as any;
  return json?.data ?? null;
}

export async function listWebhookEventTypes(ctx: Ctx): Promise<WebhookEventType[]> {
  const json = (await getJson(ctx, `${ctx.config.baseUrl}/webhooks/events/types`, "webhooks event-types")) as any;
  return Array.isArray(json?.data) ? json.data : [];
}
