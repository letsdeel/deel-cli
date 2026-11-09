// The reviewed command map (src/public-api/commands.json): one entry per endpoint, naming its command.
// This module reads an entry's command line and binds its arguments to the endpoint's path params.

import type { CommandForm, FormSelector } from "../../src/types.ts";

export type Api = "rest" | "scim";

export type MapEntry = {
  method: string;
  path: string;
  command: string; // "deel <domain> <resources> <verb> <positionals> [flags]"
  api?: Api; // "rest" when absent
  collapse?: string; // entries with the same key are one command: the first in the map is called
};

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
