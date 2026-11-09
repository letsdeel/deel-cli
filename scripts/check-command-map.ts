#!/usr/bin/env node
// Checks the command map (src/public-api/commands.json) against the naming rules R1 to R9 in CONTRIBUTING.md.
// Exit code 0 means no failures; warnings are information for a reviewer and don't fail the run.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { MapEntry } from "./public-api/command-map.ts";
import { GLOBAL_FLAGS } from "./public-api/generate.ts";

const CORE = new Set(["list", "get", "create", "update", "delete"]);
// R3: registry verbs, with the domains each is scoped to ("*" is every domain) and the last path segments that select it.
export const REGISTRY: Record<string, { scope: "*" | string[]; triggers: string[] }> = {
  sign: { scope: "*", triggers: ["sign", "signatures"] },
  accept: { scope: "*", triggers: ["accept", "acknowledge"] },
  cancel: { scope: "*", triggers: ["cancel"] },
  send: { scope: ["ats", "contracts"], triggers: ["invitations", "email-draft-sends"] },
  approve: { scope: ["immigration", "it"], triggers: ["approve"] },
  reject: { scope: ["contracts", "it"], triggers: ["reject", "decline"] },
  test: { scope: ["webhooks"], triggers: ["simulate"] },
  assign: { scope: ["it"], triggers: ["assign"] },
  unassign: { scope: ["it"], triggers: ["unassign"] },
};
const METHOD_DEFAULT: Record<string, string[]> = { GET: ["get", "list"], POST: ["create"], PUT: ["update"], PATCH: ["update"], DELETE: ["delete"] };
const CASES = new Set(["read", "removal", "overwrite", "state", "action"]);
// R8: the worker type comes from the path only, through this table.
const ALIAS: Record<string, string> = { eor: "eor", gp: "gp", "global-payroll": "gp", daas: "daas", contractors: "contractor", employees: "employee" };
// R4: mass nouns with no plural, which a list command may end on.
const MASS = new Set(["payroll"]);
// R5: words that name one thing per parent keep their natural form.
export const SINGLETONS = new Set([
  "access", "activation", "additional-cost", "additional-info", "aml", "auto-withdrawal-setting", "benefits", "billing", "by-client",
  "by-employee", "compensation", "current", "daily", "edd", "employee-info", "employment-cost", "employment-type", "end-date", "equity",
  "feedback", "form-definition", "gross-to-net", "guide", "holder", "hr-manager", "invite", "job-title", "kyb", "kyc", "learning",
  "location", "ledger", "mailbox", "me", "off-cycle", "offboarding", "on-demand", "onboarding", "password", "payroll", "personal",
  "platform-fee", "preview", "required", "resignation-letter", "right-to-work", "start-date", "status", "summary", "talent", "terms",
  "time-off", "timeline", "transcript", "vault",
]);
const WORD = /^[a-z0-9]+(-[a-z0-9]+)*$/;

type Parsed = { domain: string; words: string[]; verb: string; args: string[]; flags: string[]; wt?: string; wtRequired?: boolean };

// Mark-up as the map writes it: a scope flag's <label> counts as an argument, a flag's fixed value goes with the flag.
function parse(command: string): Parsed {
  const tokens = command.trim().split(/\s+/);
  if (tokens[0] !== "deel") throw new Error(`"${command}" does not start with deel`);
  const words: string[] = [];
  let index = 2;
  while (index < tokens.length && !/^[<\[-]/.test(tokens[index])) words.push(tokens[index++]);
  const parsed: Parsed = { domain: tokens[1], words, verb: words[words.length - 1] ?? "", args: [], flags: [] };
  while (index < tokens.length) {
    const token = tokens[index++];
    if (token.startsWith("<")) {
      parsed.args.push(token);
      continue;
    }
    const name = token.replace(/^\[|\]$/g, "");
    const next = tokens[index];
    const value = next !== undefined && !/^[<\[-]/.test(next) ? tokens[index++].replace(/^\[|\]$/g, "") : undefined;
    if (name === "--worker-type") {
      parsed.wt = value;
      parsed.wtRequired = !token.startsWith("[");
    } else parsed.flags.push(value ? `${name} ${value}` : name);
  }
  return parsed;
}

function pathWorkerType(path: string): string | undefined {
  const segments = path.split("/").filter(Boolean).map((s) => s.toLowerCase().replace(/_/g, "-"));
  for (const [index, segment] of segments.entries()) {
    // An alias names a namespace: the first segment, or the second after a domain word (/forms/eor, /payouts/contractors).
    if (segment in ALIAS && index <= 1) return ALIAS[segment];
    if (segment === "ic" || segment.startsWith("ic-")) return "contractor"; // independent contractor paths, matched anywhere
  }
  return undefined;
}

function lastLiteral(path: string): string {
  const segments = path.split("/").filter((s) => s && !s.startsWith("{")).map((s) => s.toLowerCase().replace(/_/g, "-"));
  return segments[segments.length - 1] ?? "";
}

function triggerVerb(domain: string, segment: string): string | undefined {
  return Object.entries(REGISTRY).find(([, verb]) => verb.triggers.includes(segment) && (verb.scope === "*" || verb.scope.includes(domain)))?.[0];
}

export type Finding = { rule: string; entry: string; message: string };

export function checkMap(entries: MapEntry[]): { failures: Finding[]; warnings: Finding[] } {
  const failures: Finding[] = [];
  const warnings: Finding[] = [];
  const parsed = entries.map((entry) => parse(entry.command));
  const tagOf = (entry: MapEntry) => `${entry.method} ${entry.path}  ->  ${entry.command}`;
  const groups = new Map<string, number[]>();
  const seen = new Map<string, { path: string; collapse: string }>();
  entries.forEach((entry, index) => {
    const p = parsed[index];
    const tag = tagOf(entry);
    const fail = (rule: string, message: string) => failures.push({ rule, entry: tag, message });
    const groupKey = JSON.stringify([p.domain, p.words, [...p.flags].sort()]);
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), index]);

    // R1: one grammar, lowercase kebab-case.
    for (const word of [p.domain, ...p.words]) if (!WORD.test(word)) fail("R1", `'${word}' is not lowercase kebab-case`);

    // R2 and R3, in order: a core case, then a registry path trigger, then noun + create.
    const trigger = ["POST", "PUT", "PATCH"].includes(entry.method) ? triggerVerb(p.domain, lastLiteral(entry.path)) : undefined;
    if (trigger && p.verb !== trigger) fail("R3", `path ends in '${lastLiteral(entry.path)}', which selects registry verb '${trigger}'`);
    const registered = REGISTRY[p.verb];
    if (registered) {
      if (registered.scope !== "*" && !registered.scope.includes(p.domain)) fail("R3", `verb '${p.verb}' is not registered for domain '${p.domain}'`);
      else if (trigger !== p.verb) fail("R3", `registry verb '${p.verb}' needs a path trigger (${registered.triggers.join(", ")})`);
    } else if (!CORE.has(p.verb)) {
      fail("R2", `verb '${p.verb}' is neither a core verb nor in the registry`);
    } else if (!METHOD_DEFAULT[entry.method].includes(p.verb)) {
      const why = entry.case ?? "";
      if (!CASES.has(why)) fail("R2", `verb differs from ${entry.method} and names no override case`);
      else if (why === "read" && !(entry.method === "POST" && ["get", "list"].includes(p.verb))) fail("R2", "case 'read' needs a POST that returns get/list");
      else if (why === "removal" && !(entry.method === "POST" && p.verb === "delete")) fail("R2", "case 'removal' needs a POST that deletes");
      else if (why === "overwrite" && p.verb !== "update") fail("R2", "case 'overwrite' needs verb update");
      else if (why === "state" && !(p.verb === "update" && p.flags.some((flag) => flag.startsWith("--status")))) fail("R2", "case 'state' needs update with --status");
      else if (why === "action" && !["create", "delete"].includes(p.verb)) fail("R2", "case 'action' needs noun + create (or delete for the reverse action)");
    }

    // R4 and R5: the last noun of a list is plural, and every resource word is plural or a declared singleton.
    if (p.verb === "list" && p.words.length > 1) {
      const last = p.words[p.words.length - 2].split("-of-")[0];
      if (!(last.endsWith("s") || ["children", "people"].includes(last) || MASS.has(last))) fail("R5", `list returns a collection, so '${last}' must be plural`);
    }
    for (const word of p.words.slice(0, -1)) {
      if (["children", "people"].includes(word)) continue;
      const last = (word.includes("-of-") ? word.split("-of-")[0] : word).split("-").pop()!;
      if (!(last.endsWith("s") || SINGLETONS.has(word) || entry.literals?.includes(word))) fail("R5", `'${word}' is not plural and is not a declared singleton`);
    }

    // R7: every path ID is an argument.
    const ids = (entry.path.match(/\{[^}]+\}/g) ?? []).length;
    if (p.args.length < ids) fail("R7", `${ids} IDs in the path but only ${p.args.length} arguments: the command can't be called`);
    else if (p.args.length !== ids) warnings.push({ rule: "R7", entry: tag, message: `${p.args.length} arguments, ${ids} IDs in the path` });

    // R8: no global flag names, and the worker type comes from the path.
    for (const flag of p.flags) {
      const name = flag.split(" ")[0].replace(/^--/, "");
      if (GLOBAL_FLAGS.has(name)) fail("R8", `--${name} is a global flag, so it can't pick an endpoint`);
    }
    const pathType = entry.worker_type ?? pathWorkerType(entry.path);
    if (pathType && p.wt !== pathType) fail("R8", `path names worker type '${pathType}' but the command has ${p.wt ? `'${p.wt}'` : "none"}`);
    if (!pathType && p.wt) fail("R8", `command has --worker-type ${p.wt} but the path names no worker type`);

    // R9: words, flags and selector values are unique together.
    const key = JSON.stringify([p.domain, p.words, [...p.flags].sort(), p.wt ?? null]);
    const before = seen.get(key);
    if (before) {
      if (entry.collapse && entry.collapse === before.collapse) warnings.push({ rule: "R9", entry: tag, message: `collapsed with ${before.path}: one command, two endpoints` });
      else fail("R9", `same words and flags as ${before.path}`);
    }
    seen.set(key, { path: entry.path, collapse: entry.collapse ?? "" });
  });

  // R8 and R7b, per set of endpoints sharing words and flags.
  for (const members of groups.values()) {
    const ids = (list: number[]) => new Set(list.map((index) => entries[index].collapse || `#${index}`)).size;
    const bare = members.filter((index) => !parsed[index].wt);
    if (ids(bare) > 1) failures.push({ rule: "R8", entry: entries[members[0]].command, message: "more than one endpoint with no worker type" });
    for (const index of members.filter((i) => parsed[i].wt)) {
      const need = ids(members) > 1 || Boolean(entries[index].required_exception);
      if (need && !parsed[index].wtRequired) failures.push({ rule: "R8", entry: tagOf(entries[index]), message: "shared words, so --worker-type must be required" });
      if (!need && parsed[index].wtRequired) failures.push({ rule: "R8", entry: tagOf(entries[index]), message: "only endpoint with these words, so --worker-type should be optional" });
    }
    const shapes = new Set(members.map((index) => parsed[index].args.join(" ")));
    if (shapes.size > 1 && members.some((index) => parsed[index].wt && !parsed[index].wtRequired)) {
      failures.push({ rule: "R7b", entry: entries[members[0]].command, message: "arguments differ across worker types but --worker-type is optional" });
    }
  }
  return { failures, warnings };
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = resolve(process.cwd(), process.argv[2] ?? resolve(REPO_ROOT, "src/public-api/commands.json"));
  const { failures, warnings } = checkMap(JSON.parse(readFileSync(file, "utf8")) as MapEntry[]);
  for (const f of failures) process.stderr.write(`FAIL ${f.rule}  ${f.message}\n     ${f.entry}\n`);
  for (const w of warnings) process.stderr.write(`warn ${w.rule}  ${w.message}\n     ${w.entry}\n`);
  process.stderr.write(`command map: ${failures.length} failure(s), ${warnings.length} warning(s)\n`);
  process.exit(failures.length ? 1 : 0);
}
