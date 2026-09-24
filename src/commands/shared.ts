// Helpers shared by the generated action handler (src/cli.ts) and the static,
// hand-written commands (init / auth / job). Kept in one place so the global
// flag set and the arg-parsing conventions never drift between them.

import type { ArgsDef } from "citty";
import type { OutputOpts } from "../core/output.ts";
import { resolveConfig } from "../core/config.ts";
import type { Config } from "../core/config.ts";
import { CliError } from "../core/errors.ts";

export type Args = Record<string, unknown>;

// Global flags shared by every runnable command. `--no-log` comes for free as
// the negation of the boolean arg `log`.
export const commonArgs: ArgsDef = {
  input: { type: "string", description: "Request body: file://path | JSON | key=value shorthand" },
  file: { type: "string", description: "Multipart file part: field=@path (repeatable)" },
  json: { type: "boolean", default: true, description: "JSON output (--no-json for human-readable on a TTY)" },
  quiet: { type: "boolean", description: "Print ids only" },
  fields: { type: "string", description: "Comma-separated field projection" },
  jq: { type: "string", description: "Transform output with an embedded jq filter" },
  raw: { type: "boolean", description: "With --jq, print scalar string results unquoted (like jq -r)" },
  form: { type: "boolean", description: "Send as multipart/form-data (for endpoints that also accept a file upload)" },
  env: { type: "string", description: "Environment: prod | demo (default prod)" },
  "ca-cert": { type: "string", description: "Extra CA certificate (PEM) to trust, on top of the OS store — e.g. an internal/dev root" },
  "token-stdin": { type: "boolean", description: "Read the PAT from stdin" },
  "idempotency-key": { type: "string", description: "Override the auto-derived idempotency key" },
  log: { type: "boolean", default: true, description: "Local logging (--no-log to disable)" },
  "log-bodies": { type: "boolean", description: "Include full response bodies in the local log (off by default; also DEEL_LOG_BODIES=1)" },
  debug: { type: "boolean", description: "Print request diagnostics to stderr" },
  "generate-input": { type: "boolean", description: "Print a JSON body skeleton and exit" },
};

export function outputOpts(args: Args): OutputOpts {
  return {
    json: Boolean(args.json),
    fields: args.fields as string | undefined,
    jq: args.jq as string | undefined,
    raw: Boolean(args.raw),
    quiet: Boolean(args.quiet),
  };
}

// --base-url is intentionally NOT a declared citty arg (kept out of --help,
// internal testing only). Read it from the raw args instead.
export function readHidden(rawArgs: string[], name: string): string | undefined {
  const prefix = `--${name}`;
  for (let index = 0; index < rawArgs.length; index++) {
    const token = rawArgs[index];
    if (token === prefix) return rawArgs[index + 1];
    if (token.startsWith(prefix + "=")) return token.slice(prefix.length + 1);
  }
  return undefined;
}

// Collect every --file field=@path from the raw args. Repeatable both across
// fields and within one field: `--file cv=@a.pdf --file cv=@b.pdf` attaches both
// files under `cv`. citty keeps only the last occurrence, so we read raw args.
export function gatherFiles(rawArgs: string[]): Record<string, string[]> {
  const files: Record<string, string[]> = {};
  for (let index = 0; index < rawArgs.length; index++) {
    const token = rawArgs[index];
    let spec: string | undefined;
    if (token === "--file") spec = rawArgs[++index];
    else if (token.startsWith("--file=")) spec = token.slice("--file=".length);
    if (spec === undefined) continue;
    const equalsIndex = spec.indexOf("=");
    if (equalsIndex < 0) throw new CliError("usage.file", `--file expects field=@path, got "${spec}"`);
    const field = spec.slice(0, equalsIndex);
    let path = spec.slice(equalsIndex + 1);
    if (path.startsWith("@")) path = path.slice(1);
    (files[field] ??= []).push(path);
  }
  return files;
}

export function configFrom(args: Args, rawArgs: string[]): Config {
  return resolveConfig({ env: args.env as string | undefined, baseUrl: readHidden(rawArgs, "base-url") });
}

// Collect every occurrence of a repeatable flag (`--name v1 --name v2` or
// `--name=v`). citty keeps only the last, so array-typed params read raw args.
export function gatherFlagValues(rawArgs: string[], name: string): string[] {
  const values: string[] = [];
  const prefix = `--${name}`;
  for (let index = 0; index < rawArgs.length; index++) {
    const token = rawArgs[index];
    if (token === prefix && rawArgs[index + 1] !== undefined) values.push(rawArgs[++index]);
    else if (token.startsWith(prefix + "=")) values.push(token.slice(prefix.length + 1));
  }
  return values;
}
