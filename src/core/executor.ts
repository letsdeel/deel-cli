// Generic executor: descriptor + parsed flags -> HTTP request via the injected
// transport, error mapping, output. Auth/version/request-id/retry/logging are
// transport middlewares, so this stays focused on the request.

import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { Descriptor } from "../types.ts";
import type { Ctx } from "./context.ts";
import type { OutputOpts } from "./output.ts";
import { deriveIdempotencyKey } from "./idempotency.ts";
import { CliError } from "./errors.ts";
import { flagOf } from "./flags.ts";
import { apiBaseUrl } from "./config.ts";
import { maskUrlQuery } from "./logging.ts";
import { envelope, render } from "./output.ts";
import { CONFIRM_ROUTES, HEADER, OUTCOME_ROUTES, SEND_ONCE_ROUTES, WITHHELD_RESPONSE_FIELDS, withheldFieldFor } from "./constants.ts";
import type { VersionChoice, VersionFlags } from "./versions.ts";
import { API_VERSION_NONE, BETA_ACCESS_HINT, BETA_ACCESS_HINT_NONE, BETA_ERROR, betaFallback, chooseVersion } from "./versions.ts";

export type ParsedCall = {
  flags: Record<string, string | string[]>; // path + query values (arrays for repeatable query params)
  body?: unknown; // parsed --input
  files: Record<string, string[]>; // multipart field -> one or more file paths
  idempotencyKey?: string; // explicit override
};

export type ExecOpts = { output: OutputOpts; debug: boolean; form: boolean; version?: VersionFlags };

// Wrap the user's body under `data` when the operation expects that envelope,
// unless they already provided it.
function wrapBody(descriptor: Descriptor, userBody: unknown): unknown {
  if (descriptor.bodyWrapper !== "data") return userBody;
  if (userBody && typeof userBody === "object" && !Array.isArray(userBody)) {
    const keys = Object.keys(userBody as object);
    if (keys.length === 1 && keys[0] === "data") return userBody; // already wrapped
  }
  return { data: userBody };
}

// Enforces the API's batch-size caps: a "json-array" body (each item is the whole
// request) checks descriptor.maxItems directly; a "json" body checks any array-typed
// field that carries its own maxItems (e.g. a nested `items` batch field).
function validateMaxItems(descriptor: Descriptor, userBody: unknown): void {
  if (descriptor.bodyKind === "json-array" && descriptor.maxItems !== undefined && Array.isArray(userBody)) {
    if (userBody.length > descriptor.maxItems) {
      throw new CliError(
        "usage.max_items",
        `--input has ${userBody.length} items; this operation accepts at most ${descriptor.maxItems} per request.`,
        `Split the input into batches of ${descriptor.maxItems} or fewer.`,
      );
    }
    return;
  }
  if (userBody && typeof userBody === "object" && !Array.isArray(userBody)) {
    for (const field of descriptor.bodyProps) {
      if (field.type !== "array" || field.maxItems === undefined) continue;
      const value = (userBody as Record<string, unknown>)[field.name];
      if (Array.isArray(value) && value.length > field.maxItems) {
        throw new CliError(
          "usage.max_items",
          `--input.${field.name} has ${value.length} items; this operation accepts at most ${field.maxItems} per request.`,
          `Split the input into batches of ${field.maxItems} or fewer.`,
        );
      }
    }
  }
}

function buildPath(descriptor: Descriptor, flags: ParsedCall["flags"]): string {
  // How the user typed this path param: an argument (<label>), a scope flag, or a flag of a hand-picked command.
  const flagFor = (name: string) => {
    const positional = descriptor.form?.positionals.find((p) => p.param === name);
    if (positional) return `<${positional.label}>`;
    const scope = descriptor.form?.scopes.find((s) => s.param === name);
    if (scope) return `--${scope.flag}`;
    const param = descriptor.params.find((p) => p.in === "path" && p.name === name);
    return `--${param ? flagOf(param) : name}`;
  };
  return descriptor.path
    .split("/")
    .map((segment) =>
      segment.replace(/\{([^}]+)\}/g, (_, name: string) => {
        const value = flags[name];
        if (value == null) throw new CliError("usage.path_param", `Missing required path parameter ${flagFor(name)}`);
        const text = String(value); // path params are always scalar
        // An empty value, a dot segment or a swallowed flag would send the request to another endpoint (the collection, or a parent path).
        const dots = segment === `{${name}}` && (text === "." || text === "..");
        // A flag's value that starts with -- is a flag that lost its value; an argument can only start with -- after a -- terminator, on purpose.
        const swallowed = text.startsWith("--") && !descriptor.form?.positionals.some((p) => p.param === name);
        if (text.trim() === "" || dots || swallowed) {
          throw new CliError("usage.path_param", `Invalid value for path parameter ${flagFor(name)}: "${text}"`, `Pass the id the endpoint expects; a value that starts with -- is taken for a flag that lost its value.`);
        }
        return encodeURIComponent(text);
      }),
    )
    .join("/");
}

// Query values may be a single string or, for array-typed params, several values
// (sent as repeated query keys: ?job_ids=a&job_ids=b).
function buildQuery(descriptor: Descriptor, flags: ParsedCall["flags"]): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const param of descriptor.params) {
    if (param.in !== "query") continue;
    if (flags[param.name] != null) query[param.name] = flags[param.name];
    else if (param.required) throw new CliError("usage.query_param", `Missing required --${param.flag ?? param.name}`);
  }
  return query;
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  pdf: "application/pdf", txt: "text/plain", csv: "text/csv",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
function guessContentType(path: string): string {
  return MIME_BY_EXT[path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

// Multipart is sent as FLAT form fields (first_name, cv, …), even when the JSON
// variant wraps the body in `data`. Deel's gateway maps the flat multipart fields
// back to `data` server-side; a `data` object or `data[...]` brackets are rejected.
async function multipartBody(descriptor: Descriptor, call: ParsedCall): Promise<FormData> {
  const form = new FormData();
  const inner = (call.body ?? {}) as Record<string, unknown>;

  for (const field of descriptor.bodyProps) {
    if (field.nullable && inner[field.name] === null) {
      throw new CliError("usage.body", `--form cannot send null for ${field.name}: a multipart form has no null value.`, "Send JSON instead (omit --form) to clear the field.");
    }
    if (inner[field.name] != null) form.append(field.name, String(inner[field.name]));
    else if (field.required) throw new CliError("usage.body", `Missing required field --input ${field.name}=...`);
  }
  for (const fileField of descriptor.fileFields) {
    const paths = call.files[fileField] ?? [];
    if (paths.length === 0) throw new CliError("usage.file", `Missing --file ${fileField}=@<path>`);
    // Repeated --file <field>=@path appends multiple files under the same part name.
    for (const path of paths) form.append(fileField, new File([await readFile(path)], basename(path), { type: guessContentType(path) }));
  }
  return form;
}

export async function execute(descriptor: Descriptor, call: ParsedCall, ctx: Ctx, opts: ExecOpts): Promise<void> {
  const path = buildPath(descriptor, call.flags);
  const query = buildQuery(descriptor, call.flags);
  const url = new URL(apiBaseUrl(ctx.config.baseUrl, descriptor.api) + path);
  for (const [name, value] of Object.entries(query)) {
    if (Array.isArray(value)) for (const item of value) url.searchParams.append(name, item);
    else url.searchParams.set(name, value);
  }

  const mutating = descriptor.method !== "GET";
  // --form switches a dual JSON/multipart operation to multipart.
  const effectiveKind = opts.form && descriptor.supportsMultipart ? "multipart" : descriptor.bodyKind;
  // Generate the request id here so we can surface it (error envelope / meta / debug);
  // the transport's request-id middleware leaves an existing header untouched.
  let requestId = ctx.newRequestId();
  const headers: Record<string, string> = { [HEADER.accept]: "application/json", [HEADER.requestId]: requestId };
  const prod = ctx.config.env === "prod";
  let choice = chooseVersion(descriptor, opts.version ?? {}, ctx.clock(), (line) => {
    if (!opts.output.quiet) ctx.io.err(line);
  }, !prod);
  setVersionHeaders(headers, choice);

  let body: BodyInit | null = null;
  if (effectiveKind === "multipart") {
    body = await multipartBody(descriptor, call);
  } else if (effectiveKind === "json" || effectiveKind === "json-array") {
    if (call.body === undefined && (effectiveKind === "json-array" || descriptor.bodyProps.some((field) => field.required))) {
      throw new CliError("usage.body", "This operation requires --input (a body).", "Try --generate-input for a skeleton.");
    }
    validateMaxItems(descriptor, call.body);
    if (call.body !== undefined) {
      headers[HEADER.contentType] = "application/json";
      body = JSON.stringify(wrapBody(descriptor, call.body));
    }
  }

  // A send-once call acts again every time, so a key derived from the request would make the API replay the first.
  const route = routeOf(descriptor);
  const sendOnce = SEND_ONCE_ROUTES.has(route);
  let idempotencyKey: string | undefined;
  if (mutating) {
    idempotencyKey =
      call.idempotencyKey ??
      (sendOnce ? undefined : deriveIdempotencyKey({ method: descriptor.method, path, query, body: effectiveKind === "multipart" ? await multipartFingerprint(descriptor, call) : wrapBody(descriptor, call.body) }));
    if (idempotencyKey !== undefined) headers[HEADER.idempotencyKey] = idempotencyKey;
    if (opts.debug && idempotencyKey !== undefined) ctx.io.err(`[debug] idempotency-key: ${idempotencyKey}${call.idempotencyKey ? " (override)" : " (derived)"}\n`);
  }

  const send = (requestHeaders: Record<string, string>) =>
    ctx.http({
      method: descriptor.method,
      url: url.toString(),
      headers: requestHeaders,
      body,
      retryable: !sendOnce && (!mutating || Boolean(idempotencyKey)),
      meta: { command: descriptor.command.join(" "), idempotency_key: idempotencyKey },
    });
  const debugSent = (status: number) => {
    if (!opts.debug) return;
    const version = `x-version=${choice.version ?? "(none)"}${choice.beta ? " x-beta=true" : ""}`;
    ctx.io.err(`[debug] ${descriptor.method} ${maskUrlQuery(String(url))} -> ${status}  ${version}  x-request-id=${requestId}\n`);
  };

  let response = await send(headers);
  debugSent(response.status);

  // A beta that graduated (or vanished) since the manifest was generated: the API rejects the request
  // before any service runs, so one retry is safe even for a POST. It keeps the idempotency key. A send-once route
  // (SEND_ONCE_ROUTES) is never sent twice, so its error is surfaced instead.
  const code = response.status >= 400 ? errorCode(response.json) : undefined;
  const fallback = sendOnce ? undefined : betaFallback(choice, code, prod ? descriptor.versions : undefined, ctx.clock(), opts.version?.apiVersion !== undefined, firstError(response.json)?.details?.latest_stable_version);
  if (fallback) {
    if (opts.debug) ctx.io.err(`[debug] ${code}: ${fallback.reason}; retrying once without x-beta\n`);
    choice = fallback.choice;
    requestId = ctx.newRequestId();
    const retryHeaders = { ...headers, [HEADER.requestId]: requestId };
    setVersionHeaders(retryHeaders, choice);
    response = await send(retryHeaders);
    debugSent(response.status);
  }

  if (response.status >= 400) {
    const error = errorFromResponse(response.status, response.json, requestId);
    if (error.code === BETA_ERROR.required && !choice.beta) error.next ??= opts.version?.apiVersion?.trim() === API_VERSION_NONE ? BETA_ACCESS_HINT_NONE : BETA_ACCESS_HINT;
    throw error;
  }

  const payload = response.json as any;
  const hasDataEnvelope = isPlainObject(payload) && "data" in payload;
  const data = hasDataEnvelope ? (payload.data ?? null) : (payload ?? null);
  // Paginated list responses carry `page: { cursor, has_next_page }` next to `data`. Surface it in
  // the envelope (only when `data` was unwrapped from one) so the caller can page with --cursor.
  // A list can instead carry the next-page cursor at the top level (`{ data, cursor }`); it is reported as the same `page`.
  const topLevelCursor = hasDataEnvelope && typeof payload.cursor === "string" && payload.cursor !== "" ? payload.cursor : undefined;
  const page = hasDataEnvelope && isPlainObject(payload.page)
    ? (payload.page as Record<string, unknown>)
    : topLevelCursor ? { cursor: topLevelCursor, has_next_page: true } : undefined;
  // --jq, --fields and --quiet print only `data`, so the way to the next page is also told on stderr.
  if (typeof page?.cursor === "string" && page.cursor !== "") ctx.io.err(`next page: --cursor ${page.cursor}\n`);
  const { kept, withheld } = withholdSecrets(data);
  for (const field of withheld) ctx.io.err(`[note] ${field} is not printed: ${WITHHELD_RESPONSE_FIELDS[field]}.\n`);
  await render(ctx.io, envelope(kept, { request_id: requestId }, page), opts.output);
  // A 2xx can still report that the call didn't work (a test delivery that failed): print it, then fail.
  const outcome = Object.hasOwn(OUTCOME_ROUTES, route) ? OUTCOME_ROUTES[route] : undefined;
  if (outcome && isPlainObject(kept) && kept[outcome.field] === false) {
    const error = new CliError("api.unsuccessful", `The response reports ${outcome.field}: false.`, outcome.hint);
    error.requestId = requestId;
    throw error;
  }
}

// The key SEND_ONCE_ROUTES and OUTCOME_ROUTES use: "METHOD /path" with the path params as {}.
export function routeOf(descriptor: Descriptor): string {
  return `${descriptor.method.toUpperCase()} ${descriptor.path.replace(/\{[^}]+\}/g, "{}")}`;
}

/** The question a command asks before it sends anything, or undefined when it asks none. */
export function confirmMessage(descriptor: Descriptor): string | undefined {
  const route = routeOf(descriptor);
  return Object.hasOwn(CONFIRM_ROUTES, route) ? CONFIRM_ROUTES[route] : undefined;
}

// Drop the secret response fields from one record or from each record of a list, without mutating the response.
export function withholdSecrets(data: unknown): { kept: unknown; withheld: string[] } {
  const withheld = new Set<string>();
  const strip = (item: unknown): unknown => {
    if (!isPlainObject(item)) return item;
    const secrets = Object.keys(item).filter((key) => withheldFieldFor(key) !== undefined);
    if (!secrets.length) return item;
    for (const key of secrets) withheld.add(withheldFieldFor(key)!);
    return Object.fromEntries(Object.entries(item).filter(([key]) => !secrets.includes(key)));
  };
  return { kept: Array.isArray(data) ? data.map(strip) : strip(data), withheld: [...withheld] };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function setVersionHeaders(headers: Record<string, string>, choice: VersionChoice): void {
  if (choice.version) headers[HEADER.apiVersion] = choice.version;
  else delete headers[HEADER.apiVersion];
  if (choice.beta) headers[HEADER.beta] = "true";
  else delete headers[HEADER.beta];
}

async function multipartFingerprint(descriptor: Descriptor, call: ParsedCall): Promise<unknown> {
  // Bytes are not hashed for multipart; use text fields + filename + size.
  const fingerprint: Record<string, unknown> = { ...(call.body as object) };
  for (const fileField of descriptor.fileFields) {
    const paths = call.files[fileField];
    if (paths?.length) {
      fingerprint[`${fileField}__files`] = await Promise.all(paths.map(async (path) => {
        try {
          return { name: basename(path), size: (await stat(path)).size };
        } catch {
          return { name: basename(path) };
        }
      }));
    }
  }
  return fingerprint;
}

// `code`, or the older `error_code` some endpoints document, when `code` is absent.
function errorCodeOf(item: any): string | undefined {
  const code = item?.code ?? item?.error_code;
  return typeof code === "string" && code ? code : undefined;
}

// The list of an error response: `{ errors: [...] }`, or the nested `{ errors: { errors: [...] } }` some services answer.
function errorList(body: any): any[] | undefined {
  return Array.isArray(body?.errors) ? body.errors : Array.isArray(body?.errors?.errors) ? body.errors.errors : undefined;
}
// The error that names the failure: the first of the list, else the `error` object, else the body itself.
function firstError(json: unknown): any {
  const body = json as any;
  const list = errorList(body);
  return list ? list[0] : (body?.error ?? body);
}
function errorCode(json: unknown): string | undefined {
  return errorCodeOf(firstError(json));
}

// Map an error response to a CliError. Deel returns errors in one of two shapes:
// a single `{ error: { code, message, next } }` object, or the compliant
// `{ errors: [{ code, message, field }] }` array (per the API style guide). We
// surface the field-level messages from the array so validation failures are
// actionable instead of a generic "Request failed with status 400".
export function errorFromResponse(status: number, json: unknown, requestId: string): CliError {
  const body = json as any;
  // Most services answer { errors: [...] } or { error: {...} }; some nest the list ({ errors: { errors: [...] } })
  // or the message ({ responseMessage: { message } }), and those messages are still the user's best hint.
  const list = errorList(body);

  let code: string;
  let message: string;
  let next: string | undefined;
  if (list && list.length > 0) {
    code = errorCodeOf(list[0]) ?? `http.${status}`;
    message =
      list
        .map((item) => (item?.field ? `${item.field}: ${item.message ?? item.code ?? "invalid"}` : item?.message ?? item?.code))
        .filter(Boolean)
        .join("; ") || `Request failed with status ${status}`;
    next = list[0]?.next;
  } else {
    const payload = body?.error ?? body ?? {};
    code = errorCodeOf(payload) ?? `http.${status}`;
    message = payload.message ?? payload.responseMessage?.message ?? `Request failed with status ${status}`;
    next = payload.next;
  }

  const error = new CliError(code, message, next);
  error.requestId = requestId;
  return error;
}
