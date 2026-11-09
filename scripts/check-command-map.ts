#!/usr/bin/env node
// Checks that every entry in the command map (src/public-api/commands.json) makes a command the CLI can call.
// Exit code 0 means no failures; warnings are information for a reviewer and don't fail the run.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bindForm, parseCommand } from "./public-api/command-map.ts";
import type { MapEntry, ParsedCommand } from "./public-api/command-map.ts";
import { GLOBAL_FLAGS, reservedClashes } from "./public-api/generate.ts";
import type { Reserved } from "./public-api/generate.ts";
import { formUsage } from "../src/public-api/commands.ts";
import type { Descriptor, GeneratedManifest } from "../src/types.ts";
import { manifest as handPicked } from "../src/manifest.generated.ts";
import { RESERVED_COMMANDS } from "../src/core/constants.ts";

const WORD = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// The map's path keys don't always keep the API's case ({roleid} for {roleId}), so names compare without it.
const squashed = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

export type Finding = { entry: string; message: string };

export type CheckOptions = {
  reserved?: Reserved; // hand-picked and static command names, which the map may not take
  released?: Descriptor[]; // the committed manifest: a released command line never changes
};

const routeOf = (method: string, path: string, api = "rest") => `${api === "scim" ? "scim " : ""}${method.toUpperCase()} ${path.replace(/\{[^}]+\}/g, "{}")}`;

// What tells two command lines apart: the words, the scope flags and each selector with its value.
const lineKey = (command: ParsedCommand) =>
  JSON.stringify([
    command.words,
    [...command.labels.filter((l) => l.flag).map((l) => `--${l.flag}`), ...command.selectors.map((s) => `--${s.flag}${s.value ? ` ${s.value}` : ""}`)].sort(),
  ]);

export function checkMap(entries: MapEntry[], options: CheckOptions = {}): { failures: Finding[]; warnings: Finding[] } {
  const failures: Finding[] = [];
  const warnings: Finding[] = [];
  const tagOf = (entry: MapEntry) => `${entry.method} ${entry.path}  ->  ${entry.command}`;
  const parsed: ParsedCommand[] = [];
  const lines = new Map<string, MapEntry>();
  const routes = new Map<string, MapEntry>();
  for (const entry of entries) {
    const fail = (message: string) => failures.push({ entry: tagOf(entry), message });
    let command: ParsedCommand;
    try {
      command = parseCommand(entry.command);
    } catch (error) {
      fail((error as Error).message);
      continue;
    }
    parsed.push(command);
    for (const word of command.words) if (!WORD.test(word)) fail(`'${word}' is not lowercase kebab-case`);

    // Every path ID needs an argument. A scope flag left over may name a query param, which only the definitions know.
    const bound = bindForm(command, entry.path, command.labels.filter((l) => l.flag).map((l) => l.flag!));
    if (bound.error) fail(bound.error);
    // An argument is named after the path param it fills, so help reads like the API reference.
    const sharesLine = entry.collapse !== undefined && lines.get(lineKey(command))?.collapse === entry.collapse;
    for (const { label, param } of sharesLine ? [] : [...(bound.form?.positionals ?? []), ...(bound.form?.scopes ?? []).filter((s) => !s.in)]) {
      if (squashed(label) !== squashed(param)) fail(`<${label}> fills {${param}}, so it is written <${param}>`);
    }
    const order = (bound.form?.positionals ?? []).map((p) => entry.path.indexOf(`{${p.param}}`));
    if (order.some((at, i) => i > 0 && at < order[i - 1])) fail("arguments must follow the path order of their IDs");

    for (const flag of [...command.labels.filter((l) => l.flag).map((l) => l.flag!), ...command.selectors.map((s) => s.flag)]) {
      if (GLOBAL_FLAGS.has(flag)) fail(`--${flag} is a global flag, so it can't pick an endpoint`);
    }

    const route = routeOf(entry.method, entry.path, entry.api);
    const twin = routes.get(route);
    if (twin) fail(`same endpoint as ${twin.path}`);
    else routes.set(route, entry);

    const key = lineKey(command);
    const before = lines.get(key);
    if (!before) lines.set(key, entry);
    else if (entry.collapse && entry.collapse === before.collapse) warnings.push({ entry: tagOf(entry), message: `collapsed with ${before.path}: one command, two endpoints` });
    else fail(`same command line as ${before.path}`);
  }

  // Hand-picked and static names stay theirs, and a released command line never changes.
  if (options.reserved) {
    const names = [...new Set(parsed.map((p) => p.words.join(" ")))];
    for (const message of reservedClashes(names, options.reserved)) failures.push({ entry: message.match(/"deel ([^"]+)"/)?.[1] ?? "", message });
  }
  if (options.released?.length) {
    const byRoute = new Map(entries.map((entry) => [routeOf(entry.method, entry.path, entry.api), entry]));
    for (const descriptor of options.released) {
      if (!descriptor.form) continue;
      const was = formUsage(descriptor.command, descriptor.form);
      const usage = usageOf(byRoute.get(routeOf(descriptor.method, descriptor.path, descriptor.api)), descriptor);
      if (usage !== was) failures.push({ entry: `${descriptor.method} ${descriptor.path}`, message: `released as "${was}"${usage ? `, the map now says "${usage}"` : " and removed from the map"}. Released names never change.` });
    }
  }
  return { failures, warnings };
}

function usageOf(entry: MapEntry | undefined, released: Descriptor): string | undefined {
  if (!entry) return undefined;
  try {
    const command = parseCommand(entry.command);
    const form = bindForm(command, entry.path, released.params.filter((param) => param.in === "query").map((param) => param.name)).form;
    return form && formUsage(command.words, form);
  } catch {
    return undefined;
  }
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = resolve(process.cwd(), process.argv[2] ?? resolve(REPO_ROOT, "src/public-api/commands.json"));
  const released = (JSON.parse(readFileSync(resolve(REPO_ROOT, "src/public-api/manifest.json"), "utf8")) as GeneratedManifest).descriptors;
  const reserved = { commands: handPicked.descriptors, topLevel: RESERVED_COMMANDS };
  const { failures, warnings } = checkMap(JSON.parse(readFileSync(file, "utf8")) as MapEntry[], { reserved, released });
  for (const f of failures) process.stderr.write(`FAIL  ${f.message}\n      ${f.entry}\n`);
  for (const w of warnings) process.stderr.write(`warn  ${w.message}\n      ${w.entry}\n`);
  process.stderr.write(`command map: ${failures.length} failure(s), ${warnings.length} warning(s)\n`);
  process.exitCode = failures.length ? 1 : 0;
}
