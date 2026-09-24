// Output contract: JSON envelope by default, --fields projection, --jq
// (embedded WASM jq), --quiet. Human (TTY) format only with --no-json.
// All writes go through the injected IOStreams.

import type { IOStreams } from "./io.ts";
import { CliError } from "./errors.ts";

export type OutputOpts = {
  json: boolean;
  fields?: string;
  jq?: string;
  raw: boolean;
  quiet: boolean;
};

// Embedded jq (pure WASM, no external binary). Lazy-loaded so it never costs
// cold-start when --jq is unused.
async function runJq(data: unknown, filter: string): Promise<unknown[]> {
  try {
    const { json } = await import("jq-wasm");
    return await json(data as any, filter);
  } catch (error) {
    throw new CliError("jq.error", `--jq filter failed: ${(error as Error).message}`);
  }
}

export type Envelope = {
  data: unknown;
  meta?: Record<string, unknown>;
};

export function envelope(data: unknown, meta?: Record<string, unknown>): Envelope {
  return { data, meta };
}

function valueAtPath(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (current && typeof current === "object" && key in (current as object)) return (current as Record<string, unknown>)[key];
    return undefined;
  }, source);
}

function projectFields(item: unknown, fieldNames: string[]): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const name of fieldNames) projected[name] = valueAtPath(item, name);
  return projected;
}

export function applyFields(data: unknown, fieldsCsv: string): unknown {
  const fieldNames = fieldsCsv.split(",").map((name) => name.trim()).filter(Boolean);
  if (Array.isArray(data)) return data.map((item) => projectFields(item, fieldNames));
  return projectFields(data, fieldNames);
}

function findId(data: unknown): string {
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    for (const key of ["id", "job_id", "oid"]) if (record[key] != null) return String(record[key]);
  }
  return "";
}

export async function render(io: IOStreams, envelope: Envelope, opts: OutputOpts): Promise<void> {
  // --jq transforms the data payload and prints results directly (like jq),
  // bypassing the envelope. Takes precedence over --fields.
  if (opts.jq) {
    const results = await runJq(envelope.data, opts.jq);
    for (const result of results) {
      // --raw prints scalar strings unquoted (like jq -r); everything else stays JSON.
      if (opts.raw && typeof result === "string") io.out(result + "\n");
      else io.out(JSON.stringify(result, null, 2) + "\n");
    }
    return;
  }

  let data = envelope.data;
  if (opts.fields) data = applyFields(data, opts.fields);

  if (opts.quiet) {
    if (Array.isArray(data)) io.out(data.map(findId).filter(Boolean).join("\n") + "\n");
    else {
      const id = findId(data);
      if (id) io.out(id + "\n");
    }
    return;
  }

  if (opts.json || !io.interactive) {
    const payload = opts.fields ? { ...envelope, data } : envelope;
    io.out(JSON.stringify(payload, null, 2) + "\n");
    return;
  }

  // Human (TTY): pretty data.
  io.out(JSON.stringify(data, null, 2) + "\n");
}
