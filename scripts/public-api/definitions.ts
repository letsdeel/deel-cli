// Generator input: the public definitions route's shape, read from a file or an https URL.

import { readFileSync } from "node:fs";
import type { Api } from "./command-map.ts";

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

const OPERATION_FIELDS = ["operationId", "summary", "description", "tags", "parameters", "requestBody", "responses", "deprecated"] as const;

export function pickOperation(operation: AnyObj): AnyObj {
  const picked: AnyObj = {};
  for (const field of OPERATION_FIELDS) if (operation[field] !== undefined) picked[field] = operation[field];
  return picked;
}

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

// The path and version end up in request URLs and headers.
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
    if (!entry.operation || typeof entry.operation !== "object" || Array.isArray(entry.operation)) throw new Error(`Definition #${index} has no operation object`);
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
