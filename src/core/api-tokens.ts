// API token management (list / get / invalidate) over the injected transport.
// The API never returns a token's secret value, and the CLI cannot create tokens: create them in
// Developer Center → API tokens.

import type { Ctx } from "./context.ts";
import { CliError } from "./errors.ts";
import { HEADER } from "./constants.ts";
import { errorFromResponse } from "./executor.ts";
import { deriveIdempotencyKey } from "./idempotency.ts";

export type TokenPerson = { profile_id: string; name: string | null; email: string | null; status: "active" | "left" };

// Shape of GET /v2/api-tokens items and GET /v2/api-tokens/{id} `data`.
export type ApiToken = {
  id: string;
  label: string;
  token_type: "personal" | "organization";
  status: "active" | "expiring" | "expired" | "invalidated";
  is_stale: boolean;
  scopes: string[];
  integration: string | null;
  group_ids: number[];
  hide_pii_data: boolean;
  hide_employment_data: boolean;
  created_at: string | null;
  last_used_at: string | null;
  expires_at: string | null;
  created_by: TokenPerson | null;
  invalidated_at: string | null;
  invalidated_by: TokenPerson | null;
  invalidation_reason: string | null;
};

export type ApiTokenPage = { data: ApiToken[]; cursor: string | null; total: number | null };

export type TokenListFlags = {
  limit?: string;
  cursor?: string;
  all?: boolean;
  type?: string;
  signal?: string;
  search?: string;
  owner?: string;
  sort?: string;
};

export const TOKENS_PAGE_SIZE = 100;
export const TOKENS_MIN_PAGE_SIZE = 4;
export const MAX_REASON_LENGTH = 200;
export const TOKEN_TYPES = ["personal", "organization"];
export const TOKEN_SIGNALS = ["active", "full_access", "stale", "expiring", "orphaned", "personal", "invalidated"];
export const TOKEN_SORTS = ["newest", "name", "recent", "scopes", "risk"];
export const CREATE_HINT = "Create tokens in Developer Center → API tokens; the CLI cannot create them.";
export const DASH_ID_HINT = "An id that starts with '-' must be passed as --id=<id>.";

const USAGE = "usage.tokens";
const BASE_PATH = "/v2/api-tokens";
const DIGITS = /^\d+$/;

function oneOf(flag: string, value: string, allowed: string[]): string {
  if (!allowed.includes(value)) throw new CliError(USAGE, `--${flag} must be one of: ${allowed.join(", ")}, got "${value}"`);
  return value;
}

function integerBetween(flag: string, value: string, min: number, max: number): number {
  const number = Number(value);
  if (!DIGITS.test(value) || number < min || number > max) {
    throw new CliError(USAGE, `--${flag} must be an integer between ${min} and ${max}, got "${value}"`);
  }
  return number;
}

// A token id comes from the positional argument or from --id=<id>, which wins: the argument parser reads an id that
// starts with '-' as a flag.
export function resolveTokenId(positional: unknown, flagValue: string | undefined, usage: string): string {
  const id = (flagValue ?? "").trim() || String(positional ?? "").trim();
  if (!id) throw new CliError(USAGE, `Usage: ${usage}`, DASH_ID_HINT);
  return id;
}

// `deel tokens list` flags -> query string. A cursor carries the filters of the page it came from, so filters sent
// with --cursor are ignored by the API; --all adds limit/cursor per page itself.
export function buildTokenListQuery(flags: TokenListFlags): URLSearchParams {
  const params = new URLSearchParams();
  const hasLimit = flags.limit !== undefined;
  const hasCursor = flags.cursor !== undefined;

  if (flags.all && (hasLimit || hasCursor)) {
    throw new CliError(USAGE, "--all cannot be combined with --limit or --cursor", "--all already walks every page.");
  }
  if (hasLimit) params.set("limit", String(integerBetween("limit", String(flags.limit), TOKENS_MIN_PAGE_SIZE, TOKENS_PAGE_SIZE)));
  if (hasCursor) {
    if (!flags.cursor) throw new CliError(USAGE, "--cursor needs a value", "Use the next page cursor printed by the previous call.");
    params.set("cursor", flags.cursor);
  }
  if (flags.type !== undefined) params.set("token_type", oneOf("type", flags.type, TOKEN_TYPES));
  if (flags.signal !== undefined) params.set("signal", oneOf("signal", flags.signal, TOKEN_SIGNALS));
  if (flags.search !== undefined) params.set("search", flags.search);
  if (flags.owner !== undefined) params.set("owner_profile_id", flags.owner);
  if (flags.sort !== undefined) params.set("sort", oneOf("sort", flags.sort, TOKEN_SORTS));
  return params;
}


export function validateReason(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined;
  const trimmed = reason.trim();
  if (trimmed.length > MAX_REASON_LENGTH) {
    throw new CliError(USAGE, `--reason must be at most ${MAX_REASON_LENGTH} characters, got ${trimmed.length}`);
  }
  return trimmed || undefined;
}

async function getJson(ctx: Ctx, path: string, command: string, params?: URLSearchParams): Promise<any> {
  // Generated here so it can be surfaced in the error envelope; the request-id middleware leaves an existing header untouched.
  const requestId = ctx.newRequestId();
  const query = params?.toString();
  const response = await ctx.http({
    method: "GET",
    url: `${ctx.config.baseUrl}${path}${query ? `?${query}` : ""}`,
    headers: { [HEADER.accept]: "application/json", [HEADER.requestId]: requestId },
    retryable: true,
    meta: { command },
  });
  if (response.status >= 400) throw errorFromResponse(response.status, response.json, requestId);
  return response.json;
}

const tokenPath = (id: string) => `${BASE_PATH}/${encodeURIComponent(id)}`;

export async function listApiTokens(ctx: Ctx, params: URLSearchParams): Promise<ApiTokenPage> {
  const json = await getJson(ctx, BASE_PATH, "tokens list", params);
  const cursor = typeof json?.cursor === "string" && json.cursor !== "" ? json.cursor : null;
  const total = typeof json?.total === "number" ? json.total : null;
  return { data: Array.isArray(json?.data) ? json.data : [], cursor, total };
}

// --all: pages of TOKENS_PAGE_SIZE following `cursor` until the API returns null.
export async function listAllApiTokens(ctx: Ctx, params: URLSearchParams): Promise<ApiToken[]> {
  const tokens: ApiToken[] = [];
  let cursor: string | null = null;
  do {
    const pageParams = new URLSearchParams(params);
    pageParams.set("limit", String(TOKENS_PAGE_SIZE));
    if (cursor !== null) pageParams.set("cursor", cursor);
    const page: ApiTokenPage = await listApiTokens(ctx, pageParams);
    tokens.push(...page.data);
    // Guard against a cursor that does not advance, which would loop forever.
    cursor = page.cursor === cursor ? null : page.cursor;
  } while (cursor !== null);
  return tokens;
}

export async function getApiToken(ctx: Ctx, id: string): Promise<ApiToken | null> {
  return (await getJson(ctx, tokenPath(id), "tokens get"))?.data ?? null;
}



export async function invalidateApiToken(ctx: Ctx, id: string, reason: string | undefined, idempotencyKey?: string): Promise<Record<string, unknown>> {
  const path = `${tokenPath(id)}/invalidate`;
  const body = reason === undefined ? undefined : { data: { reason } };
  const requestId = ctx.newRequestId();
  const key = idempotencyKey ?? deriveIdempotencyKey({ method: "POST", path, query: {}, body });
  const headers: Record<string, string> = {
    [HEADER.accept]: "application/json",
    [HEADER.requestId]: requestId,
    [HEADER.idempotencyKey]: key,
  };
  if (body !== undefined) headers[HEADER.contentType] = "application/json";
  const response = await ctx.http({
    method: "POST",
    url: `${ctx.config.baseUrl}${path}`,
    headers,
    body: body === undefined ? null : JSON.stringify(body),
    retryable: true,
    meta: { command: "tokens invalidate", idempotency_key: key },
  });
  if (response.status >= 400) throw errorFromResponse(response.status, response.json, requestId);
  const data = (response.json as any)?.data;
  return data && typeof data === "object" ? data : { id, status: "invalidated" };
}
