// Helpers shared by the generated action handler (src/cli.ts) and the static,
// hand-written commands (init / auth / job). Kept in one place so the global
// flag set and the arg-parsing conventions never drift between them.

import type { ArgsDef } from "citty";
import type { OutputOpts } from "../core/output.ts";
import { resolveConfig } from "../core/config.ts";
import type { Config } from "../core/config.ts";
import { CliError } from "../core/errors.ts";
import { acceptsFlag, flagMissingValue } from "../core/flags.ts";
import { authFor, resolveToken } from "../core/auth.ts";
import type { TokenProvider } from "../core/http.ts";
import type { CredentialStore } from "../core/keychain.ts";

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
  beta: { type: "boolean", description: "Call beta endpoints: sends the X-Beta: true header" },
  "ca-cert": { type: "string", description: "Extra CA certificate (PEM) to trust, on top of the OS store — e.g. an internal/dev root" },
  "token-stdin": { type: "boolean", description: "Read the PAT from stdin" },
  "idempotency-key": { type: "string", description: "Override the auto-derived idempotency key" },
  log: { type: "boolean", default: true, description: "Local logging (--no-log to disable)" },
  "log-bodies": { type: "boolean", description: "Include full response bodies in the local log (off by default; also DEEL_LOG_BODIES=1)" },
  debug: { type: "boolean", description: "Print request diagnostics to stderr" },
  "generate-input": { type: "boolean", description: "Print a JSON body skeleton and exit" },
};

// --fields and --jq are text. A bare one reaches here as `true`; it is refused before the request (refuseMissingGlobalValues),
// and again here so that nothing renders a response with a filter that isn't one.
function textFlag(args: Args, name: "fields" | "jq"): string | undefined {
  const value = args[name];
  if (value === undefined || typeof value === "string") return value;
  throw new CliError("usage.flag_value", `--${name} needs a value.`, `Write --${name}=<value>.`);
}

export function outputOpts(args: Args): OutputOpts {
  return {
    json: Boolean(args.json),
    fields: textFlag(args, "fields"),
    jq: textFlag(args, "jq"),
    raw: Boolean(args.raw),
    quiet: Boolean(args.quiet),
  };
}

// --base-url is intentionally NOT a declared citty arg (kept out of --help,
// testing only). Read it from the raw args instead, in any spelling the parser
// accepts (--base-url, --baseUrl), so a respelled one can't be dropped and send the call to prod.
export function readHidden(rawArgs: string[], name: string): string | undefined {
  for (let index = 0; index < rawArgs.length; index++) {
    const token = rawArgs[index];
    if (token === "--") break;
    if (!token.startsWith("--")) continue;
    const equals = token.indexOf("=");
    if (!acceptsFlag(name, token.slice(2, equals === -1 ? undefined : equals))) continue;
    return equals === -1 ? rawArgs[index + 1] : token.slice(equals + 1);
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
    else continue;
    if (spec === undefined) throw new CliError("usage.file", "--file expects field=@path, but it is the last argument.", "Write --file field=@path.");
    const equalsIndex = spec.indexOf("=");
    if (equalsIndex < 0) throw new CliError("usage.file", `--file expects field=@path, got "${spec}"`);
    const field = spec.slice(0, equalsIndex);
    let path = spec.slice(equalsIndex + 1);
    if (path.startsWith("@")) path = path.slice(1);
    (files[field] ??= []).push(path);
  }
  return files;
}

// The flags of `defs` that take a value (declared string or enum), plus the hidden --base-url. Derived from the
// declarations, so a flag added later is covered without a second list to keep.
export function valuedFlags(defs: ArgsDef = commonArgs): string[] {
  const declared = Object.entries(defs).filter(([, def]) => def.type === "string" || def.type === "enum").map(([name]) => name);
  return [...declared, "base-url"];
}

// A flag that takes a value, typed with none (`--base-url=`, as the last word, or followed by another flag), must stop
// the command before anything is sent: citty reads it as `true` or as nothing, so the call would go to prod, carry a
// made-up key, or fail on `--fields`/`--jq` only after the request has been made (and a write has happened).
export function refuseMissingGlobalValues(rawArgs: string[], defs: ArgsDef = commonArgs): void {
  const missing = flagMissingValue(rawArgs, valuedFlags(defs));
  if (missing) throw new CliError("usage.flag_value", `--${missing} needs a value.`, `Write --${missing}=<value>. Nothing was sent.`);
}

export function configFrom(args: Args, rawArgs: string[]): Config {
  refuseMissingGlobalValues(rawArgs);
  return resolveConfig({ env: args.env as string | undefined, baseUrl: readHidden(rawArgs, "base-url"), beta: Boolean(args.beta) });
}

// The credential an API command sends: --token-stdin, then DEEL_TOKEN, then the stored login, which is refused
// for a --base-url outside its own environment. `store` is for tests; commands use the OS keychain.
export function commandToken(args: Args, config: Config, store?: CredentialStore): string | TokenProvider {
  return authFor(resolveToken({ tokenStdin: Boolean(args["token-stdin"]), config, store }));
}

// Collect every occurrence of a repeatable flag (`--name v1 --name v2` or `--name=v`), in any spelling the parser
// accepts. citty keeps only the last, so array-typed params read raw args.
export function gatherFlagValues(rawArgs: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < rawArgs.length; index++) {
    const token = rawArgs[index];
    if (!token.startsWith("--")) continue;
    const equals = token.indexOf("=");
    const flag = equals === -1 ? token : token.slice(0, equals);
    if (!acceptsFlag(name, flag.slice(2))) continue;
    if (equals !== -1) values.push(token.slice(equals + 1));
    else {
      const value = rawArgs[++index];
      if (value === undefined) throw new CliError("usage.flag_value", `${flag} needs a value, but it is the last argument.`, `Write ${flag}=<value>.`);
      // A flag in the value position means the value is missing; --name=--x still passes one that starts with --.
      if (value.startsWith("--")) throw new CliError("usage.flag_value", `${flag} needs a value, but the next argument is ${value}.`, `Write ${flag}=${value} if the value really starts with --.`);
      values.push(value);
    }
  }
  return values;
}
