// Help, usage, and discovery rendering. The generated `--help` (from citty) only
// shows declared flags; these renderers add what it can't: the request-body and
// response contract (body arrives via --input, responses aren't citty args), a
// machine-readable JSON contract, the global-flag reference, and `--generate-input`.

import type { CliParam, Descriptor } from "./types.ts";
import { CLI_VERSION } from "./version.ts";
import { commonArgs } from "./commands/shared.ts";
import { flagOf } from "./core/flags.ts";
import { usageOf } from "./public-api/commands.ts";

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

// The --help --json for a generated command whose words several endpoints share: each endpoint's full contract.
export function printFormsJson(descriptors: Descriptor[]): void {
  const forms = descriptors.map((d) => ({ ...contractOf(d), ...(d.summary ? { summary: d.summary } : {}) }));
  process.stdout.write(JSON.stringify({ command: descriptors[0].command.join(" "), forms }, null, 2) + "\n");
}

// Help for a generated command whose words several endpoints share: one line per endpoint. The flags before
// --help narrow it to one endpoint's full help; for the line without flags, its arguments do.
export function printFormsHelp(descriptors: Descriptor[]): void {
  const out = process.stdout.write.bind(process.stdout);
  const cmd = descriptors[0].command.join(" ");
  out(`\n${cmd} — the flags pick the endpoint:\n\n`);
  for (const d of descriptors) out(`  ${usageOf(d)}\n      ${d.method} ${d.path}${d.summary ? `  — ${d.summary}` : ""}\n`);
  // The selectors alone narrow it, so the example needs no argument a shell could misread.
  const picked = descriptors.find((d) => d.form!.selectors.length);
  const flags = picked?.form!.selectors.map((s) => (s.value === undefined ? `--${s.flag}` : `--${s.flag} ${s.value}`)) ?? [];
  const bare = descriptors.some((d) => !d.form!.selectors.length && !d.form!.scopes.length && d.form!.positionals.length);
  out(`\nOne endpoint's arguments, options and fields: add its flags before --help${picked ? ` (deel ${[cmd, ...flags, "--help"].join(" ")})` : ""}`);
  out(`${bare ? "; for the line without flags, put its ID before --help" : ""}.\n\n`);
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
  process.stdout.write(JSON.stringify(contractOf(descriptor), null, 2) + "\n");
}

function contractOf(descriptor: Descriptor) {
  const form = descriptor.form;
  return {
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
}

// Action-level help: only the action-specific options + the full contract.
// Global flags are declared (so citty parses them) but documented once at `deel --help`.
export function printActionHelp(descriptor: Descriptor): void {
  const out = process.stdout.write.bind(process.stdout);
  out(`\n`);
  printFormSection(descriptor);
  out(`Global options (--json, --jq, --fields, --quiet, --env, ...) — run 'deel --help'.\n`);
  out(`Machine-readable contract: 'deel ${descriptor.command.join(" ")} --help --json'.\n`);
}

// One endpoint's help: what it does, how to call it, its arguments and options, its request and response.
function printFormSection(descriptor: Descriptor): void {
  const out = process.stdout.write.bind(process.stdout);

  out(`${descriptor.summary ?? descriptor.command.join(" ")}\n`);
  if (descriptor.form) out(`${descriptor.method} ${descriptor.path}\n`);
  out(`\n`);
  out(`USAGE  ${buildUsage(descriptor)}\n`);

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

