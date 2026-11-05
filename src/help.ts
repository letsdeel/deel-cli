// Help, usage, and discovery rendering. The generated `--help` (from citty) only
// shows declared flags; these renderers add what it can't: the request-body and
// response contract (body arrives via --input, responses aren't citty args), a
// machine-readable JSON contract, the global-flag reference, and `--generate-input`.

import type { CommandDef } from "citty";
import type { CliParam, Descriptor } from "./types.ts";
import { CLI_VERSION } from "./version.ts";
import { commonArgs } from "./commands/shared.ts";
import { flagOf } from "./core/flags.ts";
import { isBetaAt } from "./core/versions.ts";

// Flattens nested object fields into dotted paths (request.amount, ...) so every
// field is visible, however deep, without changing the CliParam shape callers rely on.
function flattenFields(fields: CliParam[], prefix = ""): CliParam[] {
  return fields.flatMap((field) => {
    const name = prefix ? `${prefix}.${field.name}` : field.name;
    const flat = { ...field, name };
    return field.properties?.length ? [flat, ...flattenFields(field.properties, name)] : [flat];
  });
}

export function printVersion(): void {
  process.stdout.write(`deel ${CLI_VERSION}\n`);
}

// Full contract: request body fields + response fields (what --help alone can't show,
// since the body arrives via --input and responses aren't citty args).
export function printContract(descriptor: Descriptor): void {
  const out = process.stdout.write.bind(process.stdout);
  const line = (name: string, type: string, required: boolean, options?: string[], description?: string) =>
    `  ${name.padEnd(22)} ${type.padEnd(8)} ${(required ? "required" : "").padEnd(9)}${options ? `[${options.join(" | ")}]  ` : ""}${description ? `— ${description}` : ""}\n`;

  if (descriptor.bodyKind === "multipart") {
    out(`\nREQUEST — multipart upload (POST)\n`);
    for (const fileField of descriptor.fileFields) out(`  --file ${fileField}=@<path>   (required)\n`);
    for (const field of flattenFields(descriptor.bodyProps)) out(line(`--input ${field.name}`, field.type, field.required, field.enum, field.description));
  } else if (descriptor.bodyKind === "json-array") {
    out(`\nREQUEST BODY (--input) — a JSON array, each item:\n`);
    if (descriptor.bodyProps.length === 0) out(`  (free-form JSON object)\n`);
    for (const field of flattenFields(descriptor.bodyProps)) out(line(field.name, field.type, field.required, field.enum, field.description));
  } else if (descriptor.bodyKind === "json") {
    out(`\nREQUEST BODY (--input)\n`);
    if (descriptor.bodyProps.length === 0) out(`  (free-form JSON object)\n`);
    for (const field of flattenFields(descriptor.bodyProps)) out(line(field.name, field.type, field.required, field.enum, field.description));
  }

  if (descriptor.supportsMultipart && descriptor.bodyKind !== "multipart" && descriptor.fileFields.length) {
    out(`\nALSO ACCEPTS multipart — add --form and attach files:\n`);
    for (const fileField of descriptor.fileFields) out(`  --file ${fileField}=@<path>\n`);
  }

  if (descriptor.responseKind === "none") {
    out(`\nRESPONSE\n  ${descriptor.async ? "{ job_id }  — poll with 'deel job status <id>'" : "(no documented fields)"}\n`);
  } else {
    out(`\nRESPONSE — data${descriptor.responseKind === "array" ? "[]" : ""}\n`);
    for (const field of flattenFields(descriptor.responseFields)) out(line(field.name, field.type, false, undefined, field.description));
  }
  out(`\n`);
}

// Variant group help: shown when `--help` is requested without a variant selector.
export function printVariantGroupHelp(descriptors: Descriptor[]): void {
  const out = process.stdout.write.bind(process.stdout);
  const cmd = descriptors[0].command.join(" ");
  out(`\n${cmd} — select a variant:\n\n`);
  for (const d of descriptors) {
    out(`  --${d.variant!.padEnd(12)}  ${d.method} ${d.path}${d.summary ? `  — ${d.summary}` : ""}\n`);
  }
  out(`\nUsage: deel ${cmd} --<variant> [OPTIONS]\n`);
  out(`Help:  deel ${cmd} --<variant> --help\n\n`);
}

export function printAlternativesHelp(descriptors: Descriptor[]): void {
  const out = process.stdout.write.bind(process.stdout);
  const cmd = descriptors[0].command.join(" ");
  out(`\n${cmd} — the path-param flags pick the endpoint:\n\n`);
  for (const d of descriptors) {
    const pathFlags = d.params.filter((param) => param.in === "path").map((param) => `--${flagOf(param)}`).join(" ");
    out(`  ${(pathFlags || "(no path params)").padEnd(28)}  ${d.method} ${d.path}${d.summary ? `  — ${d.summary}` : ""}\n`);
  }
  out(`\nHelp:  deel ${cmd} [--<path-param> ...] --help\n\n`);
}

// The exact command line a caller should type — shared by the human --help USAGE
// line and the --json contract's `usage` field, so both stay in sync by construction.
function buildUsage(descriptor: Descriptor): string {
  const required = descriptor.params.filter((param) => param.required).map((param) => `--${flagOf(param)}=<${param.type}>`).join(" ");
  const bodyHint =
    descriptor.bodyKind === "multipart"
      ? " [--input k=v] [--file f=@path]"
      : descriptor.supportsMultipart
        ? " [--input <body>] [--form --file f=@path]"
        : descriptor.bodyKind !== "none"
          ? " [--input <body>]"
          : "";
  const variantFlag = descriptor.variant ? ` --${descriptor.variant}` : "";
  return `deel ${descriptor.command.join(" ")}${variantFlag} [GLOBAL OPTIONS]${required ? " " + required : ""}${bodyHint}`;
}

// Machine-readable form of the action contract (same content as `--help`, as JSON)
// so an agent can parse inputs + selectable response fields without scraping text.
function fieldsToJson(fields: CliParam[]): unknown[] {
  return fields.map((field) => ({
    name: field.name,
    type: field.type,
    required: field.required,
    enum: field.enum,
    description: field.description,
    ...(field.properties?.length ? { properties: fieldsToJson(field.properties) } : {}),
  }));
}

export function printContractJson(descriptor: Descriptor): void {
  const contract = {
    command: descriptor.command.join(" "),
    ...(descriptor.variant ? { variant: descriptor.variant } : {}),
    usage: buildUsage(descriptor),
    version: descriptor.version,
    beta: Boolean(descriptor.beta),
    versions: descriptor.versions ?? null,
    params: descriptor.params.map((param) => ({ name: param.name, ...(param.flag ? { flag: param.flag } : {}), in: param.in, type: param.type, required: param.required, enum: param.enum, description: param.description })),
    body: {
      kind: descriptor.bodyKind,
      fields: fieldsToJson(descriptor.bodyProps),
      fileFields: descriptor.fileFields,
    },
    response: {
      kind: descriptor.responseKind,
      fields: fieldsToJson(descriptor.responseFields),
    },
  };
  process.stdout.write(JSON.stringify(contract, null, 2) + "\n");
}

// Action-level help: only the action-specific options + the full contract.
// Global flags are declared (so citty parses them) but documented once at `deel --help`.
export function printActionHelp(descriptor: Descriptor): void {
  const out = process.stdout.write.bind(process.stdout);

  out(`\n${descriptor.summary ?? descriptor.command.join(" ")}\n\n`);
  out(`USAGE  ${buildUsage(descriptor)}\n`);
  printVersionHelp(descriptor);

  if (descriptor.params.length) {
    out(`\nOPTIONS\n`);
    for (const param of descriptor.params) {
      const options = param.enum ? `  [${param.enum.join(" | ")}]` : "";
      const requiredTag = param.required ? "  (required)" : "";
      out(`  --${flagOf(param)}=<${param.type}>${requiredTag}${options}${param.description ? `   ${param.description}` : ""}\n`);
    }
  }

  printContract(descriptor);
  out(`Global options (--json, --jq, --fields, --quiet, --env, ...) — run 'deel --help'.\n`);
  out(`Machine-readable contract: 'deel ${descriptor.command.join(" ")} --help --json'.\n`);
}

// ---------------- root and group help ----------------
// A group lists every command reachable through single-child groups by its relative path
// ("invitations create"), and a child with a bigger subtree as a count ("amendments  3 commands").

type HelpRow = { name: string; description: string; kind: "leaf" | "chain" | "group" };

function subCommandsOf(cmd: CommandDef): Record<string, CommandDef> {
  return (cmd.subCommands as Record<string, CommandDef> | undefined) ?? {};
}

export function isGroupCommand(cmd: CommandDef): boolean {
  return typeof cmd.run !== "function" && Object.keys(subCommandsOf(cmd)).length > 0;
}

function descriptionOf(cmd: CommandDef): string {
  return (cmd.meta as { description?: string } | undefined)?.description ?? "";
}

function countCommands(cmd: CommandDef): number {
  if (!isGroupCommand(cmd)) return 1;
  let count = 0;
  for (const child of Object.values(subCommandsOf(cmd))) count += countCommands(child);
  return count;
}

const ACTION_ORDER = ["list", "get", "create", "update", "replace", "delete"];

export const byName = (a: string, b: string): number => a.localeCompare(b, "en");

function byAction(a: HelpRow, b: HelpRow): number {
  const rank = (row: HelpRow) => (ACTION_ORDER.includes(row.name) ? ACTION_ORDER.indexOf(row.name) : ACTION_ORDER.length);
  return rank(a) - rank(b) || byName(a.name, b.name);
}

function groupRows(cmd: CommandDef): HelpRow[] {
  const rows: HelpRow[] = [];
  for (const [name, child] of Object.entries(subCommandsOf(cmd))) {
    const path = [name];
    let node = child;
    while (isGroupCommand(node)) {
      const entries = Object.entries(subCommandsOf(node));
      if (entries.length !== 1) break;
      path.push(entries[0][0]);
      node = entries[0][1];
    }
    if (isGroupCommand(node)) {
      const count = `${countCommands(node)} commands`;
      const own = descriptionOf(node);
      rows.push({ name: path.join(" "), description: own ? `${own} (${count})` : count, kind: "group" });
    } else {
      rows.push({ name: path.join(" "), description: descriptionOf(node), kind: path.length === 1 ? "leaf" : "chain" });
    }
  }
  const of = (kind: HelpRow["kind"]) => rows.filter((row) => row.kind === kind);
  return [...of("leaf").sort(byAction), ...of("chain").sort((a, b) => byName(a.name, b.name)), ...of("group").sort((a, b) => byName(a.name, b.name))];
}

// Names longer than this overflow the column instead of pushing every description right.
const NAME_COLUMN_MAX = 32;

function nameWidth(rows: { name: string }[]): number {
  return Math.min(NAME_COLUMN_MAX, Math.max(0, ...rows.map((row) => row.name.length)));
}

function rowLines(rows: { name: string; description: string }[], indent = "  "): string {
  const width = nameWidth(rows);
  return rows.map((row) => `${indent}${row.name.padEnd(width)}   ${row.description}`.trimEnd() + "\n").join("");
}

const sectionKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// The documentation section of a top-level group: SCIM for the SCIM API; otherwise the
// tag that names the group, else the most common tag of its commands (ties: alphabetical).
export function sectionOf(word: string, descriptors: Descriptor[]): string | undefined {
  if (descriptors.some((descriptor) => descriptor.api === "scim")) return "SCIM";
  const counts = new Map<string, number>();
  for (const descriptor of descriptors) if (descriptor.group) counts.set(descriptor.group, (counts.get(descriptor.group) ?? 0) + 1);
  const tags = [...counts.keys()];
  return tags.find((tag) => sectionKey(tag) === word) ?? tags.sort((a, b) => counts.get(b)! - counts.get(a)! || byName(a, b))[0];
}

// The section a top-level group's help is titled with: only when it names the group or
// covers every tagged command in it (`deel it` spans eight IT sections, so it isn't one).
export function titleSectionOf(word: string, descriptors: Descriptor[]): string | undefined {
  const section = sectionOf(word, descriptors);
  if (!section) return undefined;
  const covers = descriptors.every((descriptor) => !descriptor.group || descriptor.group === section || descriptor.api === "scim");
  return sectionKey(section) === word || covers ? section : undefined;
}

export function sectionsByWord(descriptors: Descriptor[]): Map<string, string> {
  const byWord = new Map<string, Descriptor[]>();
  for (const descriptor of descriptors) {
    const word = descriptor.command[0];
    const list = byWord.get(word);
    if (list) list.push(descriptor);
    else byWord.set(word, [descriptor]);
  }
  const sections = new Map<string, string>();
  for (const [word, list] of byWord) {
    const section = sectionOf(word, list);
    if (section) sections.set(word, section);
  }
  return sections;
}

const CLI_SECTION = "CLI";
const OTHER_SECTION = "Other";

export function printRootHelp(root: CommandDef, sections: Map<string, string>, staticNames: Set<string>): void {
  const out = process.stdout.write.bind(process.stdout);
  const sectionFor = (row: HelpRow) => {
    const word = row.name.split(" ")[0];
    return staticNames.has(word) ? CLI_SECTION : (sections.get(word) ?? OTHER_SECTION);
  };
  const grouped = new Map<string, HelpRow[]>();
  for (const row of groupRows(root)) {
    const section = sectionFor(row);
    const list = grouped.get(section);
    if (list) list.push(row);
    else grouped.set(section, [row]);
  }
  const rank = (section: string) => (section === CLI_SECTION ? 0 : section === OTHER_SECTION ? 2 : 1);
  const ordered = [...grouped.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, "en", { sensitivity: "base" }));
  const sectionWidth = Math.max(...ordered.map((section) => section.length));
  const width = nameWidth([...grouped.values()].flat());

  out(`\n${descriptionOf(root)} (deel ${CLI_VERSION})\n\n`);
  out(`USAGE  deel <command> [<subcommand> ...] [OPTIONS]\n\n`);
  out(`Commands:\n`);
  for (const section of ordered) {
    const rows = grouped.get(section)!.sort((a, b) => byName(a.name, b.name));
    rows.forEach((row, index) => {
      const label = index === 0 ? section : "";
      out(`  ${label.padEnd(sectionWidth)}   ${row.name.padEnd(width)}   ${row.description}`.trimEnd() + "\n");
    });
  }
  out(`\nRun deel <command> --help to see its commands. Search every command: deel commands --filter <text>.\n`);
}

// `apiCommands` is false for a static group (auth, job), whose commands send no request body.
export function printGroupHelp(cmd: CommandDef, path: string[], title: string, apiCommands = true): void {
  const out = process.stdout.write.bind(process.stdout);
  out(`\n${title}\n\nCommands:\n`);
  out(rowLines(groupRows(cmd)));
  out(`\nRun deel ${path.join(" ")} <command> --help for ${apiCommands ? "flags and the request body" : "its flags"}.\n`);
}

// Edit distance where swapping two adjacent letters ("lsit") counts as one edit.
function editDistance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
    }
  }
  return rows[a.length][b.length];
}

// "Did you mean" for an unknown command word: the children of the deepest matched node
// that start with it or are within a small edit distance of it.
export function suggestions(word: string, candidates: string[], limit = 5): string[] {
  const target = word.toLowerCase();
  if (!target) return [];
  const allowed = Math.max(1, Math.floor(target.length / 3));
  return candidates
    .map((candidate) => ({ candidate, distance: candidate.startsWith(target) ? 0 : editDistance(target, candidate) }))
    .filter((entry) => entry.distance <= allowed)
    .sort((a, b) => a.distance - b.distance || byName(a.candidate, b.candidate))
    .slice(0, limit)
    .map((entry) => entry.candidate);
}

export function printUnknownCommand(word: string, path: string[], node: CommandDef): void {
  const where = path.length ? ` under 'deel ${path.join(" ")}'` : "";
  const similar = suggestions(word, Object.keys(subCommandsOf(node)));
  const hint = similar.length ? ` Did you mean: ${similar.join(", ")}?` : "";
  process.stderr.write(`Unknown command '${word}'${where}.${hint}\n`);
  process.stderr.write(`Run 'deel ${path.length ? `${path.join(" ")} ` : ""}--help' to see available commands.\n`);
}

function printVersionHelp(descriptor: Descriptor): void {
  const out = process.stdout.write.bind(process.stdout);
  if (!descriptor.version && !descriptor.versions) return;
  out(`\nAPI VERSION  ${descriptor.version ?? "(none)"}${descriptor.beta ? " (beta)" : ""}   — change with --version <YYYY-MM-DD> | none, or --beta\n`);
  if (!descriptor.versions?.length) return;
  const now = Date.now();
  out(`\nVERSIONS\n`);
  for (const entry of descriptor.versions) {
    const notes = [isBetaAt(entry, now) ? `beta until ${entry.beta_until}` : "stable"];
    if (entry.sunset_at) notes.push(`sunset ${entry.sunset_at}`);
    if (entry.version === descriptor.version) notes.push("default");
    out(`  ${entry.version}  ${notes.join(", ")}\n`);
  }
}

// Global flags documented once, at the root.
export function printGlobalOptions(): void {
  const out = process.stdout.write.bind(process.stdout);
  out(`\nGLOBAL OPTIONS (available on every action)\n`);
  for (const [name, argDef] of Object.entries(commonArgs)) {
    const def = argDef as { type?: string; description?: string };
    const hint = def.type === "string" ? `=<${name.replace(/-/g, "_")}>` : "";
    out(`  ${`--${name}${hint}`.padEnd(24)}  ${def.description ?? ""}\n`);
  }
  out(`\n`);
}

// `--generate-input`: print a JSON body skeleton the user can fill in and pipe
// back. File parts can't live in a JSON body, so any required --file uploads are
// noted on stderr — keeping stdout clean for `--generate-input > body.json`.
function fieldsToSkeleton(fields: CliParam[]): Record<string, unknown> {
  const skeleton: Record<string, unknown> = {};
  for (const field of fields) {
    skeleton[field.name] = field.enum
      ? field.enum[0]
      : field.properties?.length
        ? fieldsToSkeleton(field.properties)
        : field.type === "number" || field.type === "integer"
          ? 0
          : field.type === "boolean"
            ? false
            : field.type === "array"
              ? []
              : field.type === "object"
                ? {}
                : "";
  }
  return skeleton;
}

export function printSkeleton(descriptor: Descriptor): void {
  if (descriptor.bodyKind === "json-array") {
    const item = descriptor.bodyProps.length > 0 ? fieldsToSkeleton(descriptor.bodyProps) : { "// each item": "see 'deel <cmd> --help'" };
    process.stdout.write(JSON.stringify([item], null, 2) + "\n");
  } else {
    process.stdout.write(JSON.stringify(fieldsToSkeleton(descriptor.bodyProps), null, 2) + "\n");
  }

  if (descriptor.fileFields.length) {
    const parts = descriptor.fileFields.map((field) => `--file ${field}=@<path>`).join("  ");
    const how = descriptor.bodyKind === "multipart" ? "" : " (add --form)";
    process.stderr.write(`# This operation also requires file upload(s)${how}: ${parts}\n`);
  }
}

