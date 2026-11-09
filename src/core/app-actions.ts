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

export type JsonSchema = { type?: string; properties?: Record<string, JsonSchema>; required?: string[]; enum?: unknown[]; [key: string]: unknown };

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
  if (context.write && (code === undefined || NO_RESPONSE_CODES.has(code) || failure.statusCode >= 500)) {
    const sentence = /[.!?]$/.test(message) ? message : `${message}.`;
    return new CliError("app.outcome_unknown", `${sentence} The action may or may not have run.`, "Check the result with a read action before running it again.");
  }
  const suffix = code ? code.toLowerCase().replace(/[^a-z0-9_]/g, "_") : `http_${failure.statusCode}`;
  return new CliError(`app.${suffix}`, message);
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

// ---------------- operations ----------------

export async function searchActions(client: AppClient, query: string, limit?: number): Promise<{ actions: ActionSummary[]; requestId: string }> {
  if (!query.trim()) throw new CliError("usage.app", "Usage: deel app search <what the action does>");
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_MAX_LIMIT)) {
    throw new CliError("usage.app", `--limit must be a whole number from 1 to ${SEARCH_MAX_LIMIT}.`);
  }
  const result = await client.call(APP_TOOL.search, { query, ...(limit !== undefined ? { limit } : {}) }, { retryable: true });
  if (result.isError) failed(result, {});
  const payload = jsonText(result) as { actions?: unknown };
  return { actions: Array.isArray(payload.actions) ? (payload.actions as ActionSummary[]) : [], requestId: result.requestId };
}

export async function getAction(client: AppClient, name: string): Promise<{ action: ActionDetail; requestId: string }> {
  const result = await client.call(APP_TOOL.get, { name }, { retryable: true });
  if (result.isError) failed(result, { action: name });
  return { action: jsonText(result) as ActionDetail, requestId: result.requestId };
}

// --input for `run`: the whole {path_params, query, body} object.
export function actionInput(value: unknown): ActionInput {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CliError("usage.app_input", "--input must be an object with path_params, query and/or body.", "Try: --input 'path_params={id=123}'");
  }
  const extra = Object.keys(value).filter((key) => !(INPUT_KEYS as readonly string[]).includes(key));
  if (extra.length > 0) {
    throw new CliError("usage.app_input", `Unknown --input key(s): ${extra.join(", ")}. Use path_params, query and body.`, "See the input with 'deel app describe <name>'.");
  }
  return value as ActionInput;
}

// The CLI parses `id=123` as a number; path and query values the schema declares as strings are sent as strings,
// and numeric strings the schema declares as numbers are sent as numbers. Everything else is left to the server.
function coerceSection(values: Record<string, unknown> | undefined, schema: JsonSchema | undefined): Record<string, unknown> | undefined {
  if (!values || typeof values !== "object" || Array.isArray(values)) return values;
  const coerced: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    const type = schema?.properties?.[key]?.type;
    if (type === "string" && (typeof value === "number" || typeof value === "boolean")) coerced[key] = String(value);
    else if ((type === "integer" || type === "number") && typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) coerced[key] = Number(value);
    else coerced[key] = value;
  }
  return coerced;
}

export function coerceInput(input: ActionInput, schema: JsonSchema | undefined): ActionInput {
  const path = coerceSection(input.path_params, schema?.properties?.path_params);
  const query = coerceSection(input.query, schema?.properties?.query);
  return {
    ...(path !== undefined ? { path_params: path } : {}),
    ...(query !== undefined ? { query } : {}),
    ...(input.body !== undefined ? { body: input.body } : {}),
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

export async function runAction(client: AppClient, action: ActionDetail, input: ActionInput): Promise<RunOutcome> {
  let call = runCall(action, input);
  const context = (tool: string): FailureContext => ({ action: action.name, scopes: action.scopes, write: tool === APP_TOOL.runWrite });
  let result = await client.call(call.tool, call.arguments, { retryable: call.tool === APP_TOOL.runRead });
  if (result.isError && toolFailure(result).code === "WRONG_ACTION_KIND") {
    // The catalog changed between get_action and the run; the check runs before anything is called, so the
    // other tool is safe to try once.
    call = { ...call, tool: call.tool === APP_TOOL.runRead ? APP_TOOL.runWrite : APP_TOOL.runRead };
    result = await client.call(call.tool, call.arguments, { retryable: call.tool === APP_TOOL.runRead });
  }
  if (result.isError) failed(result, context(call.tool));
  return runOutcome(result);
}

// ---------------- describe --generate-input ----------------

function skeletonOf(schema: JsonSchema | undefined): unknown {
  if (!schema || typeof schema !== "object") return "";
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (Array.isArray(schema.allOf)) return skeletonOf({ ...(schema.allOf as JsonSchema[]).reduce((merged, part) => ({ ...merged, ...part }), {}) });
  switch (schema.type) {
    case "object": {
      const skeleton: Record<string, unknown> = {};
      for (const [key, property] of Object.entries(schema.properties ?? {})) skeleton[key] = skeletonOf(property);
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
