// Generator input: the public definitions shape, and a bridge that builds it from the public OpenAPI documents.

import { readFileSync } from "node:fs";
import type { Api } from "./naming.ts";

type AnyObj = Record<string, any>;

export type Definition = {
  api: Api;
  method: string;
  path: string; // without the /rest or /scim base path
  version: string;
  beta_until: string | null;
  sunset_at: string | null;
  operation: AnyObj;
};

// Only standard OpenAPI Operation fields are kept; x- extensions and anything else are dropped.
const OPERATION_FIELDS = ["operationId", "summary", "description", "tags", "parameters", "requestBody", "responses", "deprecated"] as const;

export function pickOperation(operation: AnyObj): AnyObj {
  const picked: AnyObj = {};
  for (const field of OPERATION_FIELDS) if (operation[field] !== undefined) picked[field] = operation[field];
  return picked;
}

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

export function isUrl(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

const MAX_BYTES = 64 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 60_000;

export async function loadJson(source: string): Promise<unknown> {
  if (isUrl(source)) {
    if (!/^https:\/\//i.test(source)) throw new Error("A definitions URL must use https");
    const response = await fetch(source, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`Failed to fetch ${source} (HTTP ${response.status})`);
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body?.getReader();
    if (!reader) throw new Error(`${source} sent no body`);
    for (let part = await reader.read(); !part.done; part = await reader.read()) {
      size += part.value.length;
      if (size > MAX_BYTES) throw new Error(`${source} is larger than ${MAX_BYTES / 1024 / 1024} MB`);
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  return JSON.parse(readFileSync(source, "utf8"));
}

const PATH_SEGMENT = /^(?:[A-Za-z0-9_~-]+(?:\.[A-Za-z0-9_~-]+)*|\{[A-Za-z0-9_-]+\})$/;

function isValidPath(path: string): boolean {
  return path === "/" || (path.startsWith("/") && path.slice(1).split("/").every((segment) => PATH_SEGMENT.test(segment)));
}

function isValidTimestamp(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && !Number.isNaN(Date.parse(value)));
}

// The same checks run on every definition, whichever input produced it: the path and version end up in
// request URLs and headers, so a hostile or malformed value must never reach the manifest.
function assertValidDefinition(entry: AnyObj, label: string): void {
  if (entry.api !== "rest" && entry.api !== "scim") throw new Error(`${label} has unknown api "${entry.api}"`);
  if (typeof entry.path !== "string" || !isValidPath(entry.path)) throw new Error(`${label} has an invalid path ${JSON.stringify(entry.path)}`);
  if (typeof entry.version !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(entry.version)) {
    throw new Error(`${label} has an invalid version ${JSON.stringify(entry.version)} (expected YYYY-MM-DD)`);
  }
  for (const field of ["beta_until", "sunset_at"]) {
    if (!isValidTimestamp(entry[field])) throw new Error(`${label} has an invalid ${field} ${JSON.stringify(entry[field])}`);
  }
}

export function parseDefinitions(json: unknown): Definition[] {
  const list = Array.isArray(json) ? json : (json as AnyObj)?.data;
  if (!Array.isArray(list)) throw new Error("Definitions must be a JSON array (or { data: [...] })");
  const parsed = list.map((entry: AnyObj, index) => {
    for (const field of ["api", "method", "path", "version", "operation"]) {
      if (entry?.[field] === undefined) throw new Error(`Definition #${index} is missing "${field}"`);
    }
    assertValidDefinition(entry, `Definition #${index}`);
    return {
      api: entry.api,
      method: String(entry.method).toUpperCase(),
      path: String(entry.path),
      version: String(entry.version),
      beta_until: entry.beta_until ?? null,
      sunset_at: entry.sunset_at ?? null,
      operation: pickOperation(entry.operation),
    };
  });
  const seen = new Set<string>();
  for (const entry of parsed) {
    const key = `${entry.api} ${entry.method} ${entry.path} ${entry.version}`;
    if (seen.has(key)) throw new Error(`Duplicate definition ${key}`);
    seen.add(key);
  }
  return parsed;
}

// A schema that references the next one twice expands to 2^n nodes, and a spec under the size cap can
// reach that, so one operation may not expand past this many nodes.
const MAX_EXPANDED_NODES = 200_000;

type CachedRef = { value: any; size: number };

export type DerefState = {
  cache: Map<string, CachedRef>; // a ref whose expansion hit no ref still being expanded: the same wherever it is reached
  open: Set<string>; // refs the current expansion cut short as a cycle
  size: number; // nodes expanded for the current operation, shared subtrees counted every time they are used
};

export const newDerefState = (cache: Map<string, CachedRef> = new Map()): DerefState => ({ cache, open: new Set(), size: 0 });

function resolveRef(ref: string, root: AnyObj): any {
  if (!ref.startsWith("#/")) throw new Error(`Only local $ref values are supported (got ${ref})`);
  const target = ref
    .slice(2)
    .split("/")
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce<any>((current, token) => current?.[token], root);
  if (target === undefined) throw new Error(`Unresolved $ref ${ref}`);
  return target;
}

function count(state: DerefState, nodes: number): void {
  state.size += nodes;
  if (state.size > MAX_EXPANDED_NODES) throw new Error(`The definitions expand to more than ${MAX_EXPANDED_NODES} nodes in one operation (a $ref chain that fans out)`);
}

// Inline every local `$ref` (#/...). A reference back into a schema that is already
// being expanded becomes `{ type: "object" }`, which is all the CLI needs from it.
export function deref(node: unknown, root: AnyObj, state: DerefState = newDerefState(), stack: string[] = []): any {
  if (Array.isArray(node)) {
    count(state, 1);
    return node.map((item) => deref(item, root, state, stack));
  }
  if (!node || typeof node !== "object") {
    count(state, 1);
    return node;
  }
  const ref = (node as AnyObj).$ref;
  if (typeof ref === "string") {
    const target = resolveRef(ref, root);
    if (stack.includes(ref)) {
      state.open.add(ref);
      count(state, 1);
      return { type: "object" };
    }
    const cached = state.cache.get(ref);
    if (cached) {
      count(state, cached.size);
      return cached.value;
    }
    const outer = state.open;
    state.open = new Set();
    const before = state.size;
    const value = deref(target, root, state, [...stack, ref]);
    const hits = state.open;
    hits.delete(ref);
    if (hits.size === 0) state.cache.set(ref, { value, size: state.size - before });
    for (const hit of hits) outer.add(hit);
    state.open = outer;
    return value;
  }
  count(state, 1);
  const out: AnyObj = {};
  for (const [key, value] of Object.entries(node)) out[key] = deref(value, root, state, stack);
  return out;
}

// Follows a chain of top-level `$ref`s (a component response or request body) without expanding the contents.
function resolveTop(node: any, root: AnyObj): any {
  let current = node;
  for (let hops = 0; current && typeof current.$ref === "string"; hops++) {
    if (hops > 32) throw new Error(`Too many chained $ref values at ${current.$ref}`);
    current = resolveRef(current.$ref, root);
  }
  return current;
}

const BODY_TYPES = ["application/json", "multipart/form-data"];

// The generator reads the parameters, the JSON and multipart request schemas and the JSON schema of
// the success response, so only those are expanded (error responses and other media types are not).
function slimOperation(operation: AnyObj, parameters: AnyObj[], root: AnyObj, state: DerefState): AnyObj {
  const slim: AnyObj = {};
  for (const field of ["operationId", "summary", "description", "tags", "deprecated"]) if (operation[field] !== undefined) slim[field] = operation[field];
  if (parameters.length) slim.parameters = parameters;
  const body = resolveTop(operation.requestBody, root);
  if (body) {
    const content: AnyObj = {};
    for (const type of BODY_TYPES) if (body.content?.[type]) content[type] = { schema: deref(body.content[type].schema, root, state) };
    slim.requestBody = { ...(body.required !== undefined ? { required: body.required } : {}), content };
  }
  const responses: AnyObj = {};
  for (const [code, raw] of Object.entries<any>(operation.responses ?? {})) {
    if (!/^2\d\d$/.test(code)) continue;
    const response = resolveTop(raw, root);
    const schema = response?.content?.["application/json"]?.schema;
    responses[code] = { ...(response?.description !== undefined ? { description: response.description } : {}), ...(schema ? { content: { "application/json": { schema: deref(schema, root, state) } } } : {}) };
  }
  if (Object.keys(responses).length) slim.responses = responses;
  return slim;
}

function versionOf(operation: AnyObj): string | undefined {
  if (typeof operation["x-version"] === "string") return operation["x-version"];
  return /-v(\d{4}-\d{2}-\d{2})$/.exec(operation.operationId ?? "")?.[1];
}

// One definition per method and path: the public documents carry only the latest stable version.
export function definitionsFromOpenApi(doc: AnyObj, api: Api): Definition[] {
  const definitions: Definition[] = [];
  const cache = new Map<string, CachedRef>();
  for (const [rawPath, pathItem] of Object.entries<AnyObj>(doc.paths ?? {})) {
    const path = rawPath.replace(/^\/(rest|scim)(?=\/)/, "");
    for (const method of METHODS) {
      const operation = pathItem[method];
      if (!operation) continue;
      const state = newDerefState(cache);
      const shared = deref(pathItem.parameters ?? [], doc, state) as AnyObj[];
      const own = deref(operation.parameters ?? [], doc, state) as AnyObj[];
      const parameters = [...shared.filter((p) => !own.some((o) => o.name === p.name && o.in === p.in)), ...own];
      const version = versionOf(operation);
      if (!version) throw new Error(`No version for ${method.toUpperCase()} ${rawPath} (x-version or a -vYYYY-MM-DD operationId)`);
      const definition: Definition = {
        api,
        method: method.toUpperCase(),
        path,
        version,
        beta_until: null,
        sunset_at: null,
        operation: pickOperation(slimOperation(operation, parameters, doc, state)),
      };
      assertValidDefinition(definition, `${definition.method} ${rawPath}`);
      definitions.push(definition);
    }
  }
  return definitions;
}
