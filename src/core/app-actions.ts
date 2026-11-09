// Deel web-app actions over Deel's /mcp: `search_actions`, `get_action`, `run_read_action` and
// `run_write_action`. The CLI only consumes them: the server decides who may use them, checks scopes and
// validates input. This module adds what a CLI needs on top: a check before any call that the login can
// work at all, the read or write choice from `run_with`, retries for reads only, and errors mapped to
// the CLI's envelope with a next step.

import { CliError } from "./errors.ts";
import { accessTokenClaims } from "./auth.ts";
import type { ResolvedToken } from "./auth.ts";
import { RETRY_BASE_DELAY_MS, RETRY_MAX_ATTEMPTS } from "./constants.ts";
import { callTool, toolFailure } from "./mcp.ts";
import type { ToolFailure, ToolResult } from "./mcp.ts";
import type { Transport } from "./http.ts";

export const APP_TOOL = {
  search: "search_actions",
  get: "get_action",
  runRead: "run_read_action",
  runWrite: "run_write_action",
} as const;

export const SEARCH_MAX_LIMIT = 20;
const INPUT_KEYS = ["path_params", "query", "body"] as const;
const TRUNCATION_NOTICE = /^\[Response truncated: the action returned (\d+) bytes; only the first (\d+) bytes are shown\.\]$/;
// Failures that happen before an action runs, or on a read, so another attempt is safe.
const TRANSIENT_CODES = new Set(["UPSTREAM_UNAVAILABLE", "UPSTREAM_TIMEOUT", "UPSTREAM_SERVER_ERROR"]);
const NO_RESPONSE_CODES = new Set(["UPSTREAM_TIMEOUT", "UPSTREAM_UNAVAILABLE"]);

export type JsonSchema = { type?: string | string[]; properties?: Record<string, JsonSchema>; required?: string[]; enum?: unknown[]; [key: string]: unknown };

export type ActionSummary = { name: string; title?: string; description?: string; method?: string; scopes?: string[] };
export type ActionDetail = ActionSummary & { run_with?: string; input_schema?: JsonSchema };
export type ActionInput = { path_params?: Record<string, unknown>; query?: Record<string, unknown>; body?: unknown };

export type AppClient = {
  call: (tool: string, args: Record<string, unknown>, opts: { retryable: boolean }) => Promise<ToolResult>;
};

export type AppClientOpts = {
  http: Transport;
  url: string;
  newRequestId: () => string;
  renew?: () => Promise<boolean>; // refresh the OAuth login after a 401; false when there is nothing to renew
  sleep?: (ms: number) => Promise<void>;
};

function oauthRequired(message: string): CliError {
  return new CliError("auth.oauth_required", message, "Run 'deel auth login' (a PAT can't run web-app actions).");
}

function sensitiveDataHidden(): CliError {
  return new CliError(
    "app.sensitive_data_hidden",
    "This login hides sensitive data, and web-app actions aren't available to such a login.",
    "Run 'deel auth login' again without hiding sensitive data.",
  );
}

// Fails before any call when the login can't run web-app actions: no login, a PAT, or a token that hides PII
// or employment data. Claims are read unverified, only to pick the error; the server decides for real.
export function assertEligible(resolved: ResolvedToken): void {
  if (resolved.source === "none" || !resolved.token) throw oauthRequired("'deel app' needs a Deel OAuth login.");
  if (resolved.source === "keychain") throw oauthRequired("'deel app' needs a Deel OAuth login, and the saved login is a PAT.");
  const token = resolved.oauth?.current().access_token ?? resolved.token;
  const claims = accessTokenClaims(token);
  if (!claims) {
    if (resolved.source === "oauth") return;
    throw oauthRequired("'deel app' needs a Deel OAuth access token, and this token isn't one.");
  }
  if (typeof claims.client_id !== "string" || !claims.client_id) throw oauthRequired("'deel app' needs a Deel OAuth login, and this token is a PAT.");
  if (claims.hide_pii_data === true || claims.hide_employment_data === true) throw sensitiveDataHidden();
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createAppClient(opts: AppClientOpts): AppClient {
  const sleep = opts.sleep ?? defaultSleep;
  return {
    async call(tool, args, { retryable }) {
      const attempts = retryable ? RETRY_MAX_ATTEMPTS : 1;
      let renewed = false;
      for (let attempt = 1; ; attempt++) {
        const result = await callTool({
          http: opts.http,
          url: opts.url,
          requestId: opts.newRequestId(),
          name: tool,
          args,
          retryable,
          command: `app ${tool}`,
          onUnauthorized: async () => {
            if (renewed || !opts.renew) return false;
            renewed = true;
            return opts.renew();
          },
        });
        if (!result.isError) return result;
        const failure = toolFailure(result);
        // A token introspection rejected: answered before anything runs, so a renewed login may retry once.
        if (failure.code === "AUTHENTICATION_REQUIRED" && !renewed && opts.renew) {
          renewed = true;
          if (await opts.renew()) {
            attempt--;
            continue;
          }
        }
        const transient = failure.statusCode === 429 || (failure.code !== undefined && TRANSIENT_CODES.has(failure.code));
        if (!transient || attempt >= attempts) return result;
        await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      }
    },
  };
}

// ---------------- errors ----------------

export type FailureContext = { action?: string; scopes?: string[]; write?: boolean };

export function appError(failure: ToolFailure, requestId: string, context: FailureContext = {}): CliError {
  const error = mapFailure(failure, context);
  error.requestId = requestId;
  return error;
}

function mapFailure(failure: ToolFailure, context: FailureContext): CliError {
  const { code, message } = failure;
  if (failure.statusCode === 429) {
    return new CliError("app.rate_limited", message, context.write ? "Wait a moment, then check whether the action ran before running it again." : "Wait a moment and try again.");
  }
  switch (code) {
    case "AUTHENTICATION_REQUIRED":
      return new CliError("auth.expired", message, "deel auth login");
    case "TOKEN_TYPE_NOT_ALLOWED":
      return /pii|employment|sensitive/i.test(message) ? sensitiveDataHidden() : oauthRequired(message);
    case "APP_ACTIONS_NOT_ALLOWED":
    case "APP_ACTIONS_NOT_CONFIGURED":
      return new CliError("app.unavailable", message, "Web-app actions are rolled out per organization.");
    case "ACTION_NOT_FOUND":
      return new CliError(
        "app.action_not_found",
        context.action ? `No action named "${context.action}" is available to this login.` : message,
        "Find one with 'deel app search <what it does>'.",
      );
    case "INSUFFICIENT_SCOPES": {
      // Without get_action's scopes (describe of an action the login can't use), take the ones the server names.
      const named = /needs one of these scopes: ([\w:.,\s-]+)$/.exec(message)?.[1].split(",").map((scope) => scope.trim()).filter(Boolean);
      const scopes = context.scopes?.length ? context.scopes.join(",") : (named ?? []).join(",");
      return new CliError("auth.insufficient_scope", message, scopes ? `Run 'deel auth login --scopes ${scopes}' to add a scope it needs.` : "Run 'deel auth login --scopes <scope>' with the scope it needs.");
    }
    case "INVALID_ARGUMENTS":
      return new CliError("app.invalid_input", message, context.action ? `See the input with 'deel app describe ${context.action}'.` : undefined);
    case "WRONG_ACTION_KIND":
      return new CliError("app.wrong_kind", message);
  }
  if (context.write && ((code !== undefined && NO_RESPONSE_CODES.has(code)) || failure.statusCode >= 500)) return outcomeUnknown(message);
  const suffix = code ? code.toLowerCase().replace(/[^a-z0-9_]/g, "_") : `http_${failure.statusCode}`;
  return new CliError(`app.${suffix}`, message);
}

function outcomeUnknown(message: string): CliError {
  const sentence = /[.!?]$/.test(message) ? message : `${message}.`;
  return new CliError("app.outcome_unknown", `${sentence} The action may or may not have run.`, "Check the result with a read action before running it again.");
}

function failed(result: ToolResult, context: FailureContext): never {
  throw appError(toolFailure(result), result.requestId, context);
}

function jsonText(result: ToolResult): unknown {
  try {
    return JSON.parse(result.texts[0] ?? "");
  } catch {
    const error = new CliError("mcp.response", "The MCP endpoint sent a tool result that is not JSON.");
    error.requestId = result.requestId;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function malformed(result: ToolResult, what: string): CliError {
  const error = new CliError("mcp.response", `The MCP endpoint sent ${what} in an unexpected shape.`);
  error.requestId = result.requestId;
  return error;
}

function asActionSummary(value: unknown, result: ToolResult): ActionSummary {
  if (!isRecord(value) || typeof value.name !== "string" || !value.name) throw malformed(result, "an action");
  return value as ActionSummary;
}

function asActionDetail(value: unknown, result: ToolResult): ActionDetail {
  const action = asActionSummary(value, result) as ActionDetail & Record<string, unknown>;
  const scopes = action.scopes as unknown;
  if (scopes !== undefined && !(Array.isArray(scopes) && scopes.every((scope) => typeof scope === "string"))) throw malformed(result, "an action");
  if (action.run_with !== undefined && typeof action.run_with !== "string") throw malformed(result, "an action");
  if (action.input_schema !== undefined && !isRecord(action.input_schema)) throw malformed(result, "an action");
  return action;
}

// ---------------- operations ----------------

export async function searchActions(client: AppClient, query: string, limit?: number): Promise<{ actions: ActionSummary[]; requestId: string }> {
  if (!query.trim()) throw new CliError("usage.app", "Usage: deel app search <what the action does>");
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_MAX_LIMIT)) {
    throw new CliError("usage.app", `--limit must be a whole number from 1 to ${SEARCH_MAX_LIMIT}.`);
  }
  const result = await client.call(APP_TOOL.search, { query, ...(limit !== undefined ? { limit } : {}) }, { retryable: true });
  if (result.isError) failed(result, {});
  const payload = jsonText(result);
  if (!isRecord(payload) || (payload.actions !== undefined && !Array.isArray(payload.actions))) throw malformed(result, "the action list");
  return { actions: (payload.actions ?? []).map((item) => asActionSummary(item, result)), requestId: result.requestId };
}

export async function getAction(client: AppClient, name: string): Promise<{ action: ActionDetail; requestId: string }> {
  const result = await client.call(APP_TOOL.get, { name }, { retryable: true });
  if (result.isError) failed(result, { action: name });
  return { action: asActionDetail(jsonText(result), result), requestId: result.requestId };
}

// --input for `run`: the whole {path_params, query, body} object.
export function actionInput(value: unknown): ActionInput {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new CliError("usage.app_input", "--input must be an object with path_params, query and/or body.", "Try: --input 'path_params={id=123}'");
  }
  const extra = Object.keys(value).filter((key) => !(INPUT_KEYS as readonly string[]).includes(key));
  if (extra.length > 0) {
    throw new CliError("usage.app_input", `Unknown --input key(s): ${extra.join(", ")}. Use path_params, query and body.`, "See the input with 'deel app describe <name>'.");
  }
  for (const key of ["path_params", "query"] as const) {
    if (value[key] !== undefined && !isRecord(value[key])) throw new CliError("usage.app_input", `--input ${key} must be an object.`, "Try: --input 'path_params={id=123}'");
  }
  return value as ActionInput;
}

const DECIMAL = /^-?\d+(\.\d+)?$/;

// The schema's type, with OpenAPI 3.1's `["integer", "null"]` read as its first non-null entry.
function typeOf(schema: JsonSchema | undefined): string | undefined {
  const type: unknown = schema?.type;
  return Array.isArray(type) ? type.find((item): item is string => typeof item === "string" && item !== "null") : typeof type === "string" ? type : undefined;
}

// `--input` shorthand arrives as text (so `00123`, `1.10` and ids past 2^53 survive); this types it by the
// action's schema: text the schema declares a number becomes one when that is exact, through objects and lists.
// With `stringify`, numbers and booleans the schema declares a string are sent as strings. What the schema doesn't
// describe is left to the server.
function coerceValue(value: unknown, schema: JsonSchema | undefined, stringify: boolean): unknown {
  if (Array.isArray(value)) return value.map((item) => coerceValue(item, isRecord(schema?.items) ? (schema.items as JsonSchema) : undefined, stringify));
  if (isRecord(value)) {
    const properties = isRecord(schema?.properties) ? (schema.properties as Record<string, JsonSchema>) : {};
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, coerceValue(nested, properties[key], stringify)]));
  }
  const type = typeOf(schema);
  if (stringify && type === "string" && (typeof value === "number" || typeof value === "boolean")) return String(value);
  if ((type === "number" || type === "integer") && typeof value === "string" && DECIMAL.test(value.trim())) {
    const number = Number(value);
    if (type === "number" ? Number.isFinite(number) : Number.isSafeInteger(number)) return number;
  }
  return value;
}

export function coerceInput(input: ActionInput, schema: JsonSchema | undefined): ActionInput {
  const section = (name: "path_params" | "query") => (input[name] === undefined ? undefined : coerceValue(input[name], schema?.properties?.[name], true));
  const path = section("path_params");
  const query = section("query");
  return {
    ...(path !== undefined ? { path_params: path as Record<string, unknown> } : {}),
    ...(query !== undefined ? { query: query as Record<string, unknown> } : {}),
    ...(input.body !== undefined ? { body: coerceValue(input.body, schema?.properties?.body, false) } : {}),
  };
}

export type RunCall = { tool: string; arguments: Record<string, unknown> };

export function runCall(action: ActionDetail, input: ActionInput): RunCall {
  const tool = action.run_with === APP_TOOL.runRead || action.run_with === APP_TOOL.runWrite ? action.run_with : APP_TOOL.runWrite;
  return { tool, arguments: { name: action.name, ...coerceInput(input, action.input_schema) } };
}

export type RunOutcome = { data: unknown; requestId: string; truncated?: { total_bytes: number; shown_bytes: number } };

// The backend body as it came: JSON when it parses, otherwise the text. A body over the server's cap is cut and
// followed by a notice item; cut JSON doesn't parse, so it stays text.
export function runOutcome(result: ToolResult): RunOutcome {
  const body = result.texts[0] ?? "";
  const notice = result.texts.slice(1).map((text) => TRUNCATION_NOTICE.exec(text)).find(Boolean);
  if (notice) return { data: body, requestId: result.requestId, truncated: { total_bytes: Number(notice[1]), shown_bytes: Number(notice[2]) } };
  let data: unknown = body;
  try {
    data = JSON.parse(body);
  } catch {
    /* not JSON: keep the text */
  }
  return { data, requestId: result.requestId };
}

// Errors that can happen after a write request left the machine: the action may have run all the same.
const SENT_UNKNOWN = /^(network\.(timeout|error)|http\.5\d\d|mcp\.response)$/;
// A JSON-RPC internal or server error (-32603, -32000..-32099) may come after the action started; invalid params
// and an unknown method are answered before it.
const RPC_SERVER_ERROR = /\(JSON-RPC -(32603|320\d\d)\)$/;
const sentWithoutAnswer = (error: CliError) => SENT_UNKNOWN.test(error.code) || (error.code === "mcp.rpc" && RPC_SERVER_ERROR.test(error.message));

async function send(client: AppClient, call: RunCall): Promise<ToolResult> {
  const write = call.tool === APP_TOOL.runWrite;
  try {
    return await client.call(call.tool, call.arguments, { retryable: !write });
  } catch (error) {
    if (write && error instanceof CliError && sentWithoutAnswer(error)) {
      const unknown = outcomeUnknown(error.message);
      unknown.requestId = error.requestId;
      throw unknown;
    }
    throw error;
  }
}

export async function runAction(client: AppClient, action: ActionDetail, input: ActionInput): Promise<RunOutcome> {
  let call = runCall(action, input);
  const context = (tool: string): FailureContext => ({ action: action.name, scopes: action.scopes, write: tool === APP_TOOL.runWrite });
  let result = await send(client, call);
  if (result.isError && toolFailure(result).code === "WRONG_ACTION_KIND") {
    // The catalog changed between get_action and the run; the check runs before anything is called, so the
    // other tool is safe to try once.
    call = { ...call, tool: call.tool === APP_TOOL.runRead ? APP_TOOL.runWrite : APP_TOOL.runRead };
    result = await send(client, call);
  }
  if (result.isError) failed(result, context(call.tool));
  return runOutcome(result);
}

// ---------------- describe --generate-input ----------------

// One schema from `allOf`: the parent's own keywords and every part, with `properties` and `required` combined.
function mergeAllOf(schema: JsonSchema): JsonSchema {
  const { allOf, ...own } = schema;
  const parts = [own as JsonSchema, ...(allOf as unknown[]).filter(isRecord).map((part) => (Array.isArray(part.allOf) ? mergeAllOf(part as JsonSchema) : (part as JsonSchema)))];
  const merged: JsonSchema = {};
  for (const { properties, required, ...rest } of parts) {
    Object.assign(merged, rest);
    if (isRecord(properties)) {
      merged.properties = { ...merged.properties };
      for (const [key, next] of Object.entries(properties as Record<string, JsonSchema>)) {
        const previous = merged.properties[key];
        merged.properties[key] = previous && isRecord(next) ? mergeAllOf({ allOf: [previous, next] }) : next;
      }
    }
    if (Array.isArray(required)) merged.required = [...new Set([...(merged.required ?? []), ...required])];
  }
  return merged;
}

function skeletonOf(schema: JsonSchema | undefined): unknown {
  if (!isRecord(schema)) return "";
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (Array.isArray(schema.allOf)) return skeletonOf(mergeAllOf(schema));
  const properties = isRecord(schema.properties) ? (schema.properties as Record<string, JsonSchema>) : undefined;
  switch (typeOf(schema) ?? (properties ? "object" : undefined)) {
    case "object": {
      const skeleton: Record<string, unknown> = {};
      for (const [key, property] of Object.entries(properties ?? {})) skeleton[key] = skeletonOf(property);
      return skeleton;
    }
    case "array":
      return [];
    case "integer":
    case "number":
      return 0;
    case "boolean":
      return false;
    default:
      return "";
  }
}

// An --input skeleton for `deel app run`, from the action's input schema.
export function inputSkeleton(action: ActionDetail): Record<string, unknown> {
  const skeleton = skeletonOf(action.input_schema);
  return skeleton && typeof skeleton === "object" && !Array.isArray(skeleton) ? (skeleton as Record<string, unknown>) : {};
}
