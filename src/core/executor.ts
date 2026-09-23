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
import { envelope, render } from "./output.ts";
import { HEADER } from "./constants.ts";

export type ParsedCall = {
  flags: Record<string, string | string[]>; // path + query values (arrays for repeatable query params)
  body?: unknown; // parsed --input
  files: Record<string, string[]>; // multipart field -> one or more file paths
  idempotencyKey?: string; // explicit override
};

export type ExecOpts = { output: OutputOpts; debug: boolean; form: boolean };

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
  return descriptor.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = flags[name];
    if (value == null) throw new CliError("usage.path_param", `Missing required path parameter --${name}`);
    return encodeURIComponent(String(value)); // path params are always scalar
  });
}

// Query values may be a single string or, for array-typed params, several values
// (sent as repeated query keys: ?job_ids=a&job_ids=b).
function buildQuery(descriptor: Descriptor, flags: ParsedCall["flags"]): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const param of descriptor.params) {
    if (param.in !== "query") continue;
    if (flags[param.name] != null) query[param.name] = flags[param.name];
    else if (param.required) throw new CliError("usage.query_param", `Missing required --${param.name}`);
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
  const url = new URL(ctx.config.baseUrl + path);
  for (const [name, value] of Object.entries(query)) {
    if (Array.isArray(value)) for (const item of value) url.searchParams.append(name, item);
    else url.searchParams.set(name, value);
  }

  const mutating = descriptor.method !== "GET";
  // --form switches a dual JSON/multipart operation to multipart.
  const effectiveKind = opts.form && descriptor.supportsMultipart ? "multipart" : descriptor.bodyKind;
  // Generate the request id here so we can surface it (error envelope / meta / debug);
  // the transport's request-id middleware leaves an existing header untouched.
  const requestId = ctx.newRequestId();
  const headers: Record<string, string> = { [HEADER.accept]: "application/json", [HEADER.requestId]: requestId };
  if (descriptor.version) headers[HEADER.apiVersion] = descriptor.version;

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

  let idempotencyKey: string | undefined;
  if (mutating) {
    idempotencyKey =
      call.idempotencyKey ??
      deriveIdempotencyKey({ method: descriptor.method, path, query, body: effectiveKind === "multipart" ? await multipartFingerprint(descriptor, call) : wrapBody(descriptor, call.body) });
    headers[HEADER.idempotencyKey] = idempotencyKey;
    if (opts.debug) ctx.io.err(`[debug] idempotency-key: ${idempotencyKey}${call.idempotencyKey ? " (override)" : " (derived)"}\n`);
  }

  const response = await ctx.http({
    method: descriptor.method,
    url: url.toString(),
    headers,
    body,
    retryable: !mutating || Boolean(idempotencyKey),
    meta: { command: descriptor.command.join(" "), idempotency_key: idempotencyKey },
  });

  if (opts.debug) ctx.io.err(`[debug] ${descriptor.method} ${url} -> ${response.status}  x-request-id=${requestId}\n`);

  if (response.status >= 400) throw errorFromResponse(response.status, response.json, requestId);

  const data = (response.json as any)?.data ?? response.json ?? null;
  await render(ctx.io, envelope(data, { request_id: requestId }), opts.output);
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

// Map an error response to a CliError. Deel returns errors in one of two shapes:
// a single `{ error: { code, message, next } }` object, or the compliant
// `{ errors: [{ code, message, field }] }` array (per the API style guide). We
// surface the field-level messages from the array so validation failures are
// actionable instead of a generic "Request failed with status 400".
function errorFromResponse(status: number, json: unknown, requestId: string): CliError {
  const body = json as any;
  const list: any[] | undefined = Array.isArray(body?.errors) ? body.errors : undefined;

  let code: string;
  let message: string;
  let next: string | undefined;
  if (list && list.length > 0) {
    code = list[0]?.code ?? `http.${status}`;
    message =
      list
        .map((item) => (item?.field ? `${item.field}: ${item.message ?? item.code ?? "invalid"}` : item?.message ?? item?.code))
        .filter(Boolean)
        .join("; ") || `Request failed with status ${status}`;
    next = list[0]?.next;
  } else {
    const payload = body?.error ?? body ?? {};
    code = payload.code ?? `http.${status}`;
    message = payload.message ?? `Request failed with status ${status}`;
    next = payload.next;
  }

  const error = new CliError(code, message, next);
  error.requestId = requestId;
  return error;
}
