// --input parser: one body value in four interchangeable forms, plus schema coercion.
//   file://path | -(stdin) | inline JSON ({ or [) | shorthand (k=v,...)
// Shorthand follows an AWS-style grammar: nested {..} objects, [..] lists, and
// space-separated scalar lists, with backslash escaping for , = and space.

import { readFileSync } from "node:fs";
import type { CliParam } from "../types.ts";
import { CliError } from "./errors.ts";

export type ParsedInput = unknown;

export function parseInput(raw: string, bodyProps: CliParam[]): ParsedInput {
  const value = readRawValue(raw);
  const trimmed = value.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return coerceTopLevel(parseJson(value), bodyProps);
  }
  if (value.includes("=")) {
    return coerceTopLevel(parseShorthandObject(value), bodyProps);
  }
  throw new CliError(
    "input.unrecognized",
    `Unrecognized --input value. Use file://path, JSON ({...} / [...]), or key=value shorthand.`,
    "Try: --input contract_id=AC1,amount=5000  or  --input file://payload.json",
  );
}

function readRawValue(raw: string): string {
  if (raw === "-") return readStdin();
  if (raw.startsWith("file://")) return readFileSync(raw.slice("file://".length), "utf8");
  return raw;
}

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    throw new CliError("input.stdin", "Could not read --input from stdin.");
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CliError("input.json", `Invalid JSON in --input: ${(error as Error).message}`);
  }
}

// ---------------- shorthand ----------------

// Split on a separator at the top nesting level, honoring {} [] and backslash escapes.
function splitTopLevel(text: string, separator: string): string[] {
  const segments: string[] = [];
  let depth = 0;
  let current = "";
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "\\" && index + 1 < text.length) {
      current += char + text[index + 1];
      index++;
      continue;
    }
    if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") depth--;
    if (char === separator && depth === 0) {
      segments.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  segments.push(current);
  return segments;
}

function unescape(text: string): string {
  return text.replace(/\\(.)/g, "$1");
}

function parseShorthandObject(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const pair of splitTopLevel(text, ",")) {
    if (pair.trim() === "") continue;
    const equalsIndex = firstTopLevelEquals(pair);
    if (equalsIndex < 0) {
      throw new CliError("input.shorthand", `Malformed shorthand segment (expected key=value): "${pair}"`);
    }
    const key = unescape(pair.slice(0, equalsIndex).trim());
    result[key] = parseValue(pair.slice(equalsIndex + 1));
  }
  return result;
}

function firstTopLevelEquals(text: string): number {
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "\\") {
      index++;
      continue;
    }
    if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") depth--;
    else if (char === "=" && depth === 0) return index;
  }
  return -1;
}

function parseValue(raw: string): unknown {
  const value = raw.trim();
  if (value.startsWith("{") && value.endsWith("}")) return parseShorthandObject(value.slice(1, -1));
  if (value.startsWith("[") && value.endsWith("]")) {
    return splitTopLevel(value.slice(1, -1), ",")
      .filter((item) => item.trim() !== "")
      .map((item) => parseValue(item));
  }
  // Space-separated scalar list (e.g. tags=a b c) — spaces not inside braces/brackets.
  const parts = splitTopLevel(value, " ").filter((part) => part.trim() !== "");
  if (parts.length > 1) return parts.map((part) => parseScalar(unescape(part.trim())));
  return parseScalar(unescape(value));
}

// Heuristic scalar coercion for nested values (top-level is re-coerced against the schema).
function parseScalar(text: string): unknown {
  if (text === "true") return true;
  if (text === "false") return false;
  if (text !== "" && !Number.isNaN(Number(text)) && /^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text;
}

// ---------------- schema coercion ----------------

function coerceTopLevel(value: unknown, bodyProps: CliParam[]): unknown {
  if (bodyProps.length === 0 || value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const paramsByName = new Map(bodyProps.map((param) => [param.name, param]));
  for (const [key, fieldValue] of Object.entries(record)) {
    const param = paramsByName.get(key);
    if (!param) continue;
    record[key] = coerceScalar(fieldValue, param);
  }
  return record;
}

function coerceScalar(value: unknown, param: CliParam): unknown {
  if (typeof value !== "string") return value;
  let coerced: unknown = value;
  if (param.type === "number" || param.type === "integer") {
    const asNumber = Number(value);
    if (Number.isNaN(asNumber)) throw new CliError("input.type", `--${param.name} expects a number, got "${value}"`);
    coerced = asNumber;
  } else if (param.type === "boolean") {
    coerced = value === "true" || value === "1";
  }
  if (param.enum && !param.enum.includes(String(coerced))) {
    throw new CliError("input.enum", `--${param.name} must be one of: ${param.enum.join(", ")}`);
  }
  return coerced;
}
