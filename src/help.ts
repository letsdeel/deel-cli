// Help, usage, and discovery rendering. The generated `--help` (from citty) only
// shows declared flags; these renderers add what it can't: the request-body and
// response contract (body arrives via --input, responses aren't citty args), a
// machine-readable JSON contract, the global-flag reference, and `--generate-input`.

import type { CliParam, Descriptor } from "./types.ts";
import { CLI_VERSION } from "./version.ts";
import { commonArgs } from "./commands/shared.ts";
import { flagOf } from "./core/flags.ts";
import type { CommandDef } from "citty";
import { domainOf, STAGE_ORDER, usageOf } from "./public-api/commands.ts";
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
  // Widen the flag column only when a field is nullable, so other contracts print as before.
  const flagWidth = flattenFields(descriptor.bodyProps).some((field) => field.nullable) ? 18 : 9;
  const line = (name: string, type: string, required: boolean, options?: string[], description?: string, nullable?: boolean) =>
    `  ${name.padEnd(22)} ${type.padEnd(8)} ${[required ? "required" : "", nullable ? "nullable" : ""].filter(Boolean).join(", ").padEnd(flagWidth)}${options ? `[${options.join(" | ")}]  ` : ""}${description ? `— ${description}` : ""}\n`;

  if (descriptor.bodyKind === "multipart") {
    out(`\nREQUEST — multipart upload (POST)\n`);
    for (const fileField of descriptor.fileFields) out(`  --file ${fileField}=@<path>   (required)\n`);
    for (const field of flattenFields(descriptor.bodyProps)) out(line(`--input ${field.name}`, field.type, field.required, field.enum, field.description, field.nullable));
  } else if (descriptor.bodyKind === "json-array") {
    out(`\nREQUEST BODY (--input) — a JSON array, each item:\n`);
    if (descriptor.bodyProps.length === 0) out(`  (free-form JSON object)\n`);
    for (const field of flattenFields(descriptor.bodyProps)) out(line(field.name, field.type, field.required, field.enum, field.description, field.nullable));
  } else if (descriptor.bodyKind === "json") {
    out(`\nREQUEST BODY (--input)\n`);
    if (descriptor.bodyProps.length === 0) out(`  (free-form JSON object)\n`);
    for (const field of flattenFields(descriptor.bodyProps)) out(line(field.name, field.type, field.required, field.enum, field.description, field.nullable));
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

// The --help --json for a generated command whose words several endpoints share: each endpoint's command line.
export function printFormsJson(descriptors: Descriptor[]): void {
  const forms = descriptors.map((d) => ({ usage: usageOf(d), method: d.method, path: d.path, ...(d.summary ? { summary: d.summary } : {}) }));
  process.stdout.write(JSON.stringify({ command: descriptors[0].command.join(" "), forms }, null, 2) + "\n");
}

// Help for a generated command whose words several endpoints share: one line per endpoint.
export function printFormsHelp(descriptors: Descriptor[]): void {
  const out = process.stdout.write.bind(process.stdout);
  const cmd = descriptors[0].command.join(" ");
  out(`\n${cmd} — the flags pick the endpoint:\n\n`);
  for (const d of descriptors) out(`  ${usageOf(d)}\n      ${d.method} ${d.path}${d.summary ? `  — ${d.summary}` : ""}\n`);
  const example = [cmd, ...descriptors[0].form!.positionals.map((p) => p.label.toUpperCase()), "--help"].join(" ");
  out(`\nHelp:  type one of the lines above with your values in place of <…>, then --help (e.g. deel ${example})\n\n`);
}

// The exact command line a caller should type — shared by the human --help USAGE
// line and the --json contract's `usage` field, so both stay in sync by construction.
function buildUsage(descriptor: Descriptor): string {
  const required = flagParams(descriptor).filter((param) => param.required).map((param) => `--${flagOf(param)}=<${param.type}>`).join(" ");
  const bodyHint =
    descriptor.bodyKind === "multipart"
      ? " [--input k=v] [--file f=@path]"
      : descriptor.supportsMultipart
        ? " [--input <body>] [--form --file f=@path]"
        : descriptor.bodyKind !== "none"
          ? " [--input <body>]"
          : "";
  const variantFlag = descriptor.variant ? ` --${descriptor.variant}` : "";
  if (descriptor.form) return `${usageOf(descriptor)} [GLOBAL OPTIONS]${required ? " " + required : ""}${bodyHint}`;
  return `deel ${descriptor.command.join(" ")}${variantFlag} [GLOBAL OPTIONS]${required ? " " + required : ""}${bodyHint}`;
}

// Machine-readable form of the action contract (same content as `--help`, as JSON)
// so an agent can parse inputs + selectable response fields without scraping text.
function fieldsToJson(fields: CliParam[]): unknown[] {
  return fields.map((field) => ({
    name: field.name,
    type: field.type,
    required: field.required,
    ...(field.nullable ? { nullable: true } : {}),
    enum: field.enum,
    description: field.description,
    ...(field.properties?.length ? { properties: fieldsToJson(field.properties) } : {}),
  }));
}

// The flags a command takes: for a command-map form, its path params and scope-bound params are arguments instead.
const flagParams = (descriptor: Descriptor) =>
  descriptor.params.filter((param) => !(descriptor.form && (param.in === "path" || descriptor.form.scopes.some((s) => s.param === param.name))));

export function printContractJson(descriptor: Descriptor): void {
  const form = descriptor.form;
  const contract = {
    command: descriptor.command.join(" "),
    ...(descriptor.variant ? { variant: descriptor.variant } : {}),
    usage: buildUsage(descriptor),
    version: descriptor.version,
    ...(form
      ? {
          method: descriptor.method,
          path: descriptor.path,
          arguments: form.positionals.map((p) => ({ name: p.label, param: p.param })),
          scopes: form.scopes.map((s) => ({ flag: s.flag, name: s.label, param: s.param, in: s.in ?? "path" })),
          selectors: form.selectors,
        }
      : {}),
    beta: Boolean(descriptor.beta),
    versions: descriptor.versions ?? null,
    params: flagParams(descriptor).map((param) => ({ name: param.name, ...(param.flag ? { flag: param.flag } : {}), in: param.in, type: param.type, required: param.required, enum: param.enum, description: param.description })),
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

  if (descriptor.form?.positionals.length || descriptor.form?.scopes.length) {
    out(`\nARGUMENTS\n`);
    for (const p of descriptor.form.positionals) out(`  <${p.label}>   the {${p.param}} in ${descriptor.path}\n`);
    for (const s of descriptor.form.scopes) out(`  --${s.flag} <${s.label}>   ${s.in === "query" ? `the ${s.param} query parameter` : `the {${s.param}} in ${descriptor.path}`}\n`);
  }

  const options = flagParams(descriptor);
  if (options.length) {
    out(`\nOPTIONS\n`);
    for (const param of options) {
      const options = param.enum ? `  [${param.enum.join(" | ")}]` : "";
      const requiredTag = param.required ? "  (required)" : "";
      out(`  --${flagOf(param)}=<${param.type}>${requiredTag}${options}${param.description ? `   ${param.description}` : ""}\n`);
    }
  }

  printContract(descriptor);
  out(`Global options (--json, --jq, --fields, --quiet, --env, ...) — run 'deel --help'.\n`);
  out(`Machine-readable contract: 'deel ${descriptor.command.join(" ")} --help --json'.\n`);
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


// ---------------- root and group help ----------------
// A group lists every command reachable through single-child groups by its relative path ("invite send <contract>"),
// one line per endpoint when several share the words, and a child with a bigger subtree as a count.

type HelpRow = { name: string; description: string; kind: "leaf" | "chain" | "group" };
// The descriptors at a command path (a leaf with several endpoints has several).
export type DescriptorsAt = (words: string[]) => Descriptor[];

function subCommandsOf(cmd: CommandDef): Record<string, CommandDef> {
  return (cmd.subCommands as Record<string, CommandDef> | undefined) ?? {};
}

export function isGroupCommand(cmd: CommandDef): boolean {
  return typeof cmd.run !== "function" && Object.keys(subCommandsOf(cmd)).length > 0;
}

function descriptionOf(cmd: CommandDef): string {
  return (cmd.meta as { description?: string } | undefined)?.description ?? "";
}

const ACTION_ORDER = ["list", "get", "create", "update", "delete"];

export const byName = (a: string, b: string): number => a.localeCompare(b, "en");

const rank = (row: HelpRow) => {
  const verb = row.name.split(" ")[0];
  return ACTION_ORDER.includes(verb) ? ACTION_ORDER.indexOf(verb) : ACTION_ORDER.length;
};

// The lines a leaf contributes: one per endpoint of a generated command, one per variant of a hand-picked one.
function leafRows(name: string, words: string[], node: CommandDef, at: DescriptorsAt, kind: HelpRow["kind"]): HelpRow[] {
  const descriptors = at(words);
  if (descriptors.length && descriptors[0].form) {
    const prefix = `deel ${words.join(" ")}`;
    return descriptors.map((d) => ({ name: `${name}${usageOf(d).slice(prefix.length)}`, description: d.summary ?? "", kind }));
  }
  if (descriptors.length > 1 && descriptors[0].variant) return descriptors.map((d) => ({ name: `${name} --${d.variant}`, description: d.summary ?? "", kind }));
  return [{ name, description: descriptors[0]?.summary ?? descriptionOf(node), kind }];
}

function countCommands(cmd: CommandDef, words: string[], at: DescriptorsAt): number {
  if (!isGroupCommand(cmd)) return Math.max(1, at(words).length);
  let count = 0;
  for (const [name, child] of Object.entries(subCommandsOf(cmd))) count += countCommands(child, [...words, name], at);
  return count;
}

function groupRows(cmd: CommandDef, path: string[], at: DescriptorsAt): HelpRow[] {
  const rows: HelpRow[] = [];
  for (const [name, child] of Object.entries(subCommandsOf(cmd))) {
    const rel = [name];
    let node = child;
    while (isGroupCommand(node)) {
      const entries = Object.entries(subCommandsOf(node));
      if (entries.length !== 1) break;
      rel.push(entries[0][0]);
      node = entries[0][1];
    }
    const words = [...path, ...rel];
    if (isGroupCommand(node)) {
      const count = `${countCommands(node, words, at)} commands`;
      const own = path.length === 0 ? domainOf(rel[0])?.description : undefined;
      rows.push({ name: rel.join(" "), description: own ? `${own} (${count})` : count, kind: "group" });
    } else rows.push(...leafRows(rel.join(" "), words, node, at, rel.length === 1 ? "leaf" : "chain"));
  }
  const of = (kind: HelpRow["kind"]) => rows.filter((row) => row.kind === kind);
  return [
    ...of("leaf").sort((a, b) => rank(a) - rank(b) || byName(a.name, b.name)),
    ...of("chain").sort((a, b) => byName(a.name, b.name)),
    ...of("group").sort((a, b) => byName(a.name, b.name)),
  ];
}

// Names longer than this overflow the column instead of pushing every description right.
const NAME_COLUMN_MAX = 44;

function nameWidth(rows: { name: string }[]): number {
  return Math.min(NAME_COLUMN_MAX, Math.max(0, ...rows.map((row) => row.name.length)));
}

function rowLines(rows: { name: string; description: string }[], indent = "  "): string {
  const width = nameWidth(rows);
  return rows.map((row) => `${indent}${row.name.padEnd(width)}   ${row.description}`.trimEnd() + "\n").join("");
}

const CLI_SECTION = "CLI";
const OTHER_SECTION = "Other";

// `deel --help`: the top-level words under the command map's lifecycle stages, the static commands under CLI.
export function printRootHelp(root: CommandDef, staticNames: Set<string>, at: DescriptorsAt): void {
  const out = process.stdout.write.bind(process.stdout);
  const sectionOf = (word: string) => (staticNames.has(word) ? CLI_SECTION : (domainOf(word)?.stage ?? OTHER_SECTION));
  const grouped = new Map<string, HelpRow[]>();
  for (const row of groupRows(root, [], at)) {
    const section = sectionOf(row.name.split(" ")[0]);
    grouped.set(section, [...(grouped.get(section) ?? []), row]);
  }
  const order = (section: string) => (section === CLI_SECTION ? -1 : section === OTHER_SECTION ? STAGE_ORDER.length : STAGE_ORDER.indexOf(section));
  const sections = [...grouped.keys()].sort((a, b) => order(a) - order(b));
  const sectionWidth = Math.max(...sections.map((section) => section.length));
  const width = nameWidth([...grouped.values()].flat());

  out(`\n${descriptionOf(root)} (deel ${CLI_VERSION})\n\n`);
  out(`USAGE  deel <command> [<subcommand> ...] [arguments] [OPTIONS]\n\n`);
  out(`Commands:\n`);
  for (const section of sections) {
    grouped.get(section)!.sort((a, b) => byName(a.name, b.name)).forEach((row, index) => {
      out(`  ${(index === 0 ? section : "").padEnd(sectionWidth)}   ${row.name.padEnd(width)}   ${row.description}`.trimEnd() + "\n");
    });
  }
  const first = sections.flatMap((section) => grouped.get(section)!).find((row) => !staticNames.has(row.name.split(" ")[0]));
  out(`\nAdd --help to a command to see its commands${first ? ` (e.g. ${exampleLine([], first.name)})` : ""}. Search every command: deel commands --filter TEXT.\n`);
}

// A line a reader can paste: the row's <label>s become LABEL, so a shell doesn't read them as redirections,
// and its optional [--flags] are left out.
function exampleLine(path: string[], row: string): string {
  const tokens = row.replace(/\[[^\]]*\]/g, "").split(/\s+/).filter(Boolean).map((t) => (/^<.+>$/.test(t) ? t.slice(1, -1).toUpperCase() : t));
  return ["deel", ...path, ...tokens, "--help"].join(" ");
}

// What the flags that pick an endpoint mean, shown under a group whose lines use them.
const PICKING_LEGEND: Record<string, string> = {
  "worker-type": "--worker-type <type>   the contract or worker type (eor, gp, daas, contractor, employee); a line without it calls the endpoint whose path names no type",
  as: "--as worker            signed in as the worker, not the client",
  "file-format": "--file-format <format> the document as a file (pdf, csv)",
  bulk: "--bulk                 many at once",
  status: "--status <value>       sets the record's own state",
};

// `apiCommands` is false for a static group (auth, job), whose commands send no request body.
export function printGroupHelp(cmd: CommandDef, path: string[], title: string, at: DescriptorsAt, apiCommands = true): void {
  const out = process.stdout.write.bind(process.stdout);
  const rows = groupRows(cmd, path, at);
  out(`\n${title}\n\nCommands:\n`);
  out(rowLines(rows));
  const used = Object.keys(PICKING_LEGEND).filter((flag) => rows.some((row) => row.name.includes(`--${flag} `) || row.name.endsWith(`--${flag}`)));
  if (used.length) out(`\nFlags that pick the endpoint:\n${used.map((flag) => `  ${PICKING_LEGEND[flag]}\n`).join("")}`);
  const what = apiCommands ? "its arguments, flags and request body" : "its flags";
  const example = rows[0] ? ` (e.g. ${exampleLine(path, rows[0].name)})` : "";
  out(`\nFor one line's ${what.replace(/^its /, "")}, type it with your values in place of <…> and add --help${example}.\n`);
}

// The title of a group's help: a top-level domain's description, else its path.
export function groupTitle(path: string[]): string {
  const domain = path.length === 1 ? domainOf(path[0]) : undefined;
  return domain ? `deel ${path[0]} — ${domain.description}` : `deel ${path.join(" ")}`;
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

