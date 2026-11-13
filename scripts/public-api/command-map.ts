// The reviewed command map (src/public-api/commands.json): one entry per endpoint, naming its command.
// This module reads an entry's command line and binds its arguments to the endpoint's path params.

import { readFileSync } from "node:fs";
import type { Api, CommandForm, FormSelector } from "../../src/types.ts";

export type { Api };

// Typed as a record over Api, so adding an API there fails to compile until it is listed here.
const APIS: Record<Api, true> = { rest: true, scim: true };
export const isApi = (value: unknown): value is Api => typeof value === "string" && Object.hasOwn(APIS, value);

export type MapEntry = {
  method: string;
  path: string;
  command: string; // "deel <domain> <resources> <verb> <positionals> [flags]"
  api?: Api; // "rest" when absent
  collapse?: string; // entries with the same key are one command: the first in the map is called
};

const ENTRY_FIELDS = new Set(["method", "path", "command", "api", "collapse"]);

// Why one parsed map entry can't be used, or undefined: the fields MapEntry types, each as the generator reads it.
export function entryShapeError(item: unknown): string | undefined {
  if (!item || typeof item !== "object" || Array.isArray(item)) return "must be an object";
  const entry = item as Record<string, unknown>;
  for (const field of ["method", "path", "command"]) if (typeof entry[field] !== "string" || !entry[field]) return `needs a non-empty string ${field}`;
  if (!/^[A-Za-z]+$/.test(entry.method as string)) return "has a method that is not an HTTP method name";
  if (!(entry.path as string).startsWith("/")) return "has a path that does not start with /";
  if (entry.api !== undefined && !isApi(entry.api)) return `has an api that is neither ${Object.keys(APIS).map((api) => `"${api}"`).join(" nor ")}`;
  if (entry.collapse !== undefined && (typeof entry.collapse !== "string" || !entry.collapse)) return "has a collapse that is not a non-empty string";
  const unknown = Object.keys(entry).filter((field) => !ENTRY_FIELDS.has(field));
  return unknown.length > 0 ? `has unknown field(s) ${unknown.join(", ")} (a mistyped name would be ignored)` : undefined;
}

// Why a parsed map file can't be used: it must be an array of entries MapEntry describes.
export function mapShapeError(value: unknown): string | undefined {
  if (!Array.isArray(value)) return "the command map must be a JSON array of entries";
  for (const [index, item] of value.entries()) {
    const problem = entryShapeError(item);
    if (problem) return `entry ${index} ${problem}: ${JSON.stringify(item)?.slice(0, 120)}`;
  }
  return undefined;
}

// The one way a script reads the command map: parsed and checked against MapEntry before anything uses it, so a
// bad file fails with its name and the entry at fault, never with a TypeError further on.
export function readCommandMap(file: string): MapEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file}: ${(error as Error).message}`);
  }
  const problem = mapShapeError(parsed);
  if (problem) throw new Error(`${file}: ${problem}`);
  return parsed as MapEntry[];
}

export type ParsedCommand = {
  words: string[]; // domain, resources and verb
  labels: { label: string; flag?: string }[]; // positionals and scope flags, in the order they are written
  selectors: FormSelector[];
};

const isLabel = (token: string) => /^<[A-Za-z0-9_-]+>$/.test(token);

export function parseCommand(command: string): ParsedCommand {
  const tokens = command.trim().split(/\s+/);
  if (tokens[0] !== "deel") throw new Error(`"${command}" does not start with deel`);
  const words: string[] = [];
  let index = 1;
  while (index < tokens.length && !/^[<\[-]/.test(tokens[index])) words.push(tokens[index++]);
  const stray = words.find((word) => /[<>\[\]]/.test(word));
  if (stray) throw new Error(`"${command}": "${stray}" is not a command word`);
  if (words.length < 2) throw new Error(`"${command}" needs a domain and a verb`);
  const labels: ParsedCommand["labels"] = [];
  const selectors: FormSelector[] = [];
  while (index < tokens.length) {
    const token = tokens[index++];
    if (isLabel(token)) {
      labels.push({ label: token.slice(1, -1) });
      continue;
    }
    const optional = token.startsWith("[");
    let flag = token.replace(/^\[/, "");
    let closed = flag.endsWith("]");
    flag = flag.replace(/\]$/, "");
    if (!/^--[a-z][a-z0-9-]*$/.test(flag)) throw new Error(`"${command}": "${token}" is not a positional or a flag`);
    const next = tokens[index];
    const nextText = next?.replace(/\]$/, "");
    if (!closed && next !== undefined && isLabel(nextText!)) {
      if (optional) throw new Error(`"${command}": a scope flag can't be optional (${flag})`);
      if (next.endsWith("]")) throw new Error(`"${command}": "${next}" closes a bracket it never opened`);
      labels.push({ label: nextText!.slice(1, -1), flag: flag.slice(2) });
      index++;
      continue;
    }
    let value: string | undefined;
    if (!closed && next !== undefined && !/^[<\[-]/.test(next)) {
      value = nextText;
      if (/[\[\]]/.test(value!)) throw new Error(`"${command}": "${next}" is not a selector value`);
      closed = next.endsWith("]");
      index++;
    }
    if (optional !== closed) throw new Error(`"${command}": "${token}" ${optional ? "opens a bracket it never closes" : "closes a bracket it never opened"}`);
    selectors.push({ flag: flag.slice(2), ...(value !== undefined ? { value } : {}), ...(optional ? { optional: true } : {}) });
  }
  return { words, labels, selectors };
}

export function pathParams(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
}

const letters = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

// A label binds to the one path param whose name contains it (<contract> → contract_id, <id> → attachable_id);
// labels that match none or several take the remaining params in path order. A scope flag left over names the
// one query param whose name contains it (--country → country_code).
export function bindForm(parsed: ParsedCommand, path: string, queryParams: string[]): { form?: CommandForm; error?: string } {
  const remaining = pathParams(path);
  const bound = new Map<number, string>();
  parsed.labels.forEach(({ label }, index) => {
    const hits = remaining.filter((param) => letters(param).includes(letters(label)) || letters(param).replace(/id$/, "") === letters(label));
    if (hits.length === 1) {
      bound.set(index, hits[0]);
      remaining.splice(remaining.indexOf(hits[0]), 1);
    }
  });
  const inQuery = new Set<number>();
  parsed.labels.forEach(({ flag }, index) => {
    if (bound.has(index)) return;
    const next = remaining.shift();
    if (next !== undefined) return bound.set(index, next);
    const hits = flag ? queryParams.filter((name) => letters(name).includes(letters(flag))) : [];
    bound.set(index, hits.length === 1 ? hits[0] : "");
    if (hits.length === 1) inQuery.add(index);
  });
  const unbound = parsed.labels.find((_, index) => bound.get(index) === "");
  if (unbound) return { error: `<${unbound.label}> matches no path param of ${path}` };
  if (remaining.length) return { error: `path param {${remaining[0]}} of ${path} has no argument in the command` };
  const positionals: CommandForm["positionals"] = [];
  const scopes: CommandForm["scopes"] = [];
  parsed.labels.forEach(({ label, flag }, index) => {
    const param = bound.get(index)!;
    if (flag) scopes.push({ flag, label, param, ...(inQuery.has(index) ? { in: "query" as const } : {}) });
    else positionals.push({ label, param });
  });
  return { form: { positionals, scopes, selectors: parsed.selectors } };
}
