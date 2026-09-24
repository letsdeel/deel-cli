// Deterministic extractor: (OpenAPI spec, commandMap) -> manifest.generated.ts
// Driven by the hand-authored command map; only mapped endpoints are extracted.
// Extraction logic ported verbatim from the original scripts/codegen.ts.
//
// Usage: node .claude/skills/deel-cli-extractor/extract.ts <spec-path-or-url>
//
// Reads:  src/commands.map.ts  (from the repo root, derived from this file's location)
//         src/manifest.generated.ts  (existing, for drift detection)
// Writes: src/manifest.generated.ts  (updated)
// Prints: drift report to stdout; errors to stderr

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CliParam, Descriptor, Manifest, ScalarType } from "./types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");

// ---------------------------------------------------------------------------
// OpenAPI extraction helpers (ported from scripts/codegen.ts)
// ---------------------------------------------------------------------------

type AnyObj = Record<string, any>;

function mapType(schema: AnyObj | undefined): ScalarType {
  const t = schema?.type;
  if (t === "number" || t === "integer" || t === "boolean" || t === "array" || t === "object") return t;
  return "string";
}

function paramsFrom(op: AnyObj): CliParam[] {
  const raw: AnyObj[] = op.parameters ?? [];
  return raw
    .filter((p) => p.in === "path" || p.in === "query")
    .map((p) => ({
      name: p.name,
      in: p.in as "path" | "query",
      type: mapType(p.schema),
      required: Boolean(p.required),
      ...(p.schema?.enum ? { enum: (p.schema.enum as unknown[]).filter((v): v is string => v !== null) } : {}),
      ...(p.description ? { description: p.description } : {}),
    }));
}

function unwrapDataSchema(schema: AnyObj | undefined): { root: AnyObj | undefined; wrapped: boolean } {
  if (schema && schema.type === "object" && schema.properties?.data && Object.keys(schema.properties).length === 1) {
    return { root: schema.properties.data, wrapped: true };
  }
  return { root: schema, wrapped: false };
}

export function splitFields(objSchema: AnyObj | undefined): { textProps: CliParam[]; fileFields: string[] } {
  const props: AnyObj = objSchema?.properties ?? {};
  const required: string[] = objSchema?.required ?? [];
  const textProps: CliParam[] = [];
  const fileFields: string[] = [];
  for (const [name, schema] of Object.entries<AnyObj>(props)) {
    const isBinary = schema.format === "binary";
    const isBinaryArray = schema.type === "array" && schema.items?.format === "binary";
    if (isBinary || isBinaryArray) {
      fileFields.push(name);
    } else {
      const type = mapType(schema);
      // Recurse into nested objects so every field is visible in --help / --generate-input, not just the top level.
      const properties = type === "object" && schema.properties ? splitFields(schema).textProps : undefined;
      textProps.push({
        name,
        in: "body",
        type,
        required: required.includes(name),
        ...(schema.enum ? { enum: (schema.enum as unknown[]).filter((v): v is string => v !== null) } : {}),
        ...(schema.description ? { description: schema.description } : {}),
        ...(properties?.length ? { properties } : {}),
        ...(type === "array" && typeof schema.maxItems === "number" ? { maxItems: schema.maxItems } : {}),
      });
    }
  }
  return { textProps, fileFields };
}

export function bodyFrom(op: AnyObj): {
  bodyKind: Descriptor["bodyKind"];
  bodyProps: CliParam[];
  maxItems?: number;
  fileFields: string[];
  supportsMultipart: boolean;
  bodyWrapper: "data" | "none";
} {
  const content = op.requestBody?.content ?? {};
  const jsonSchema = content["application/json"]?.schema;
  const multipartSchema = content["multipart/form-data"]?.schema;
  const supportsMultipart = Boolean(multipartSchema);

  if (!jsonSchema && !multipartSchema) {
    return { bodyKind: "none", bodyProps: [], fileFields: [], supportsMultipart: false, bodyWrapper: "none" };
  }

  const { root, wrapped } = unwrapDataSchema(jsonSchema ?? multipartSchema);
  const bodyWrapper: "data" | "none" = wrapped ? "data" : "none";

  let bodyKind: Descriptor["bodyKind"];
  let bodyProps: CliParam[] = [];
  let maxItems: number | undefined;
  if (root?.type === "array") {
    bodyKind = "json-array";
    // bodyProps holds the *item* object's fields (each array element), for --help / --generate-input.
    bodyProps = splitFields(root.items).textProps;
    if (typeof root.maxItems === "number") maxItems = root.maxItems;
  } else {
    bodyProps = splitFields(root).textProps;
    bodyKind = jsonSchema ? "json" : "multipart";
  }

  const fileFields = multipartSchema ? splitFields(unwrapDataSchema(multipartSchema).root).fileFields : [];

  return { bodyKind, bodyProps, ...(maxItems !== undefined ? { maxItems } : {}), fileFields, supportsMultipart, bodyWrapper };
}

function propsToParams(props: AnyObj = {}, required: string[] = []): CliParam[] {
  return Object.entries<AnyObj>(props).map(([name, s]) => {
    const type = mapType(s);
    // Recurse into nested objects, and into array-of-object items, so every response
    // field is visible in --help / --help --json, however deep.
    const nested = type === "object" ? s.properties : type === "array" ? s.items?.properties : undefined;
    const properties = nested ? propsToParams(nested, (type === "object" ? s : s.items)?.required ?? []) : undefined;
    return {
      name,
      in: "body" as const,
      type,
      required: required.includes(name),
      ...(s.enum ? { enum: (s.enum as unknown[]).filter((v): v is string => v !== null) } : {}),
      ...(s.description ? { description: s.description } : {}),
      ...(properties?.length ? { properties } : {}),
    };
  });
}


export function responseFrom(op: AnyObj): { responseKind: Descriptor["responseKind"]; responseFields: CliParam[] } {
  const responses: AnyObj = op.responses ?? {};
  const code =
    ["200", "201", "202"].find((c) => responses[c]) ??
    Object.keys(responses).find((c) => /^2\d\d$/.test(c));
  const schema = code ? responses[code]?.content?.["application/json"]?.schema : undefined;
  if (!schema) return { responseKind: "none", responseFields: [] };
  const target = schema.type === "object" && schema.properties?.data ? schema.properties.data : schema;
  if (target.type === "array") {
    const items = target.items ?? {};
    return { responseKind: "array", responseFields: propsToParams(items.properties, items.required) };
  }
  if (target.type === "object" || target.properties) {
    return { responseKind: "object", responseFields: propsToParams(target.properties, target.required) };
  }
  return { responseKind: "none", responseFields: [] };
}

// ---------------------------------------------------------------------------
// CommandEntry (mirrors src/commands.map.ts shape)
// ---------------------------------------------------------------------------

type CommandEntry = {
  command: string;
  variant?: string;
  method: string;
  path: string;
};

// ---------------------------------------------------------------------------
// Core extraction
// ---------------------------------------------------------------------------

export type ExtractionResult = {
  manifest: Manifest;
  hardErrors: string[];
  warnings: string[];
};

export function extract(spec: AnyObj, entries: CommandEntry[]): ExtractionResult {
  const hardErrors: string[] = [];
  const warnings: string[] = [];
  const descriptors: Descriptor[] = [];

  for (const entry of entries) {
    const lowerMethod = entry.method.toLowerCase();
    const operation = spec.paths?.[entry.path]?.[lowerMethod];
    if (!operation) {
      hardErrors.push(`Missing operation: ${entry.method} ${entry.path} (needed by "${entry.command}"${entry.variant ? ` variant "${entry.variant}"` : ""})`);
      continue;
    }

    const params = paramsFrom(operation);
    const { bodyKind, bodyProps, maxItems, fileFields, supportsMultipart, bodyWrapper } = bodyFrom(operation);
    const { responseKind, responseFields } = responseFrom(operation);

    if (entry.variant) {
      const allParamNames = new Set([...params.map((p) => p.name), ...bodyProps.map((p) => p.name)]);
      if (allParamNames.has(entry.variant)) {
        hardErrors.push(`Variant name "${entry.variant}" collides with param flag in command "${entry.command}"`);
      }
    }

    const isAsync = Boolean(operation.responses?.["202"]);

    descriptors.push({
      command: entry.command.trim().split(/\s+/),
      ...(entry.variant ? { variant: entry.variant } : {}),
      method: entry.method.toUpperCase(),
      path: entry.path,
      ...(operation.summary ? { summary: operation.summary } : {}),
      ...(operation["x-version"] ? { version: operation["x-version"] } : {}),
      async: isAsync,
      bodyKind,
      supportsMultipart,
      bodyWrapper,
      params,
      bodyProps,
      ...(maxItems !== undefined ? { maxItems } : {}),
      fileFields,
      responseKind,
      responseFields,
    });
  }

  // Validate variant groups: distinct variants within each command
  const groups = new Map<string, Descriptor[]>();
  for (const d of descriptors) {
    const key = d.command.join(" ");
    const group = groups.get(key) ?? [];
    group.push(d);
    groups.set(key, group);
  }
  for (const [cmd, group] of groups) {
    const variants = group.map((d) => d.variant).filter(Boolean) as string[];
    if (variants.length > 0 && variants.length !== group.length) {
      hardErrors.push(`Mixed variant/non-variant descriptors for: ${cmd}`);
    }
    const seen = new Set<string>();
    for (const v of variants) {
      if (seen.has(v)) hardErrors.push(`Duplicate variant "${v}" in group: ${cmd}`);
      seen.add(v);
    }
  }

  descriptors.sort((a, b) => {
    const cmp = a.command.join(" ").localeCompare(b.command.join(" "));
    return cmp !== 0 ? cmp : (a.variant ?? "").localeCompare(b.variant ?? "");
  });

  const manifest: Manifest = {
    apiTitle: spec.info?.title ?? "Deel API",
    descriptors,
  };

  return { manifest, hardErrors, warnings };
}

// ---------------------------------------------------------------------------
// Drift detection
// ---------------------------------------------------------------------------

export type DriftReport = {
  lines: string[];
  hasBreaking: boolean;
};

function descriptorKey(d: Descriptor): string {
  return `${d.command.join(" ")}\0${d.method}\0${d.path}\0${d.variant ?? ""}`;
}

export function detectDrift(current: Manifest, next: Manifest): DriftReport {
  const lines: string[] = [];
  let hasBreaking = false;

  const currentMap = new Map(current.descriptors.map((d) => [descriptorKey(d), d]));
  const nextMap = new Map(next.descriptors.map((d) => [descriptorKey(d), d]));

  for (const newDesc of next.descriptors) {
    const key = descriptorKey(newDesc);
    const label = newDesc.command.join(" ") + (newDesc.variant ? ` [${newDesc.variant}]` : "");
    const old = currentMap.get(key);
    if (!old) {
      lines.push(`[new descriptor] ${label}`);
      continue;
    }

    // New params
    for (const p of newDesc.params) {
      if (!old.params.find((op) => op.name === p.name)) {
        lines.push(`[param+] ${label}: new path/query param --${p.name}`);
      }
    }
    // Removed required params (breaking)
    for (const p of old.params) {
      if (p.required && !newDesc.params.find((np) => np.name === p.name)) {
        lines.push(`[param- BREAKING] ${label}: required param --${p.name} removed`);
        hasBreaking = true;
      }
    }
    // New body props
    for (const p of newDesc.bodyProps) {
      if (!old.bodyProps.find((op) => op.name === p.name)) {
        lines.push(`[body+] ${label}: new body field --${p.name}`);
      }
    }
    // Removed required body props (breaking)
    for (const p of old.bodyProps) {
      if (p.required && !newDesc.bodyProps.find((np) => np.name === p.name)) {
        lines.push(`[body- BREAKING] ${label}: required body field --${p.name} removed`);
        hasBreaking = true;
      }
    }
    // New enum values
    for (const p of [...newDesc.params, ...newDesc.bodyProps]) {
      const oldP = [...old.params, ...old.bodyProps].find((op) => op.name === p.name);
      if (!oldP?.enum && p.enum) {
        lines.push(`[enum+] ${label} --${p.name}: enum added (${p.enum.join(", ")})`);
      } else if (oldP?.enum && p.enum) {
        const added = p.enum.filter((v) => !oldP.enum!.includes(v));
        if (added.length > 0) lines.push(`[enum+] ${label} --${p.name}: ${added.join(", ")}`);
        const removed = oldP.enum.filter((v) => !p.enum!.includes(v));
        if (removed.length > 0) {
          lines.push(`[enum- BREAKING] ${label} --${p.name}: removed values ${removed.join(", ")}`);
          hasBreaking = true;
        }
      }
    }
  }


  for (const oldDesc of current.descriptors) {
    const key = descriptorKey(oldDesc);
    if (!nextMap.has(key)) {
      const label = oldDesc.command.join(" ") + (oldDesc.variant ? ` [${oldDesc.variant}]` : "");
      lines.push(`[removed BREAKING] ${label}`);
      hasBreaking = true;
    }
  }

  return { lines, hasBreaking };
}

// ---------------------------------------------------------------------------
// Spec loader
// ---------------------------------------------------------------------------

async function loadSpec(source: string): Promise<AnyObj> {
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`Failed to fetch spec from ${source} (HTTP ${res.status})`);
    return (await res.json()) as AnyObj;
  }
  return JSON.parse(readFileSync(source, "utf8")) as AnyObj;
}

// ---------------------------------------------------------------------------
// Manifest serialiser
// ---------------------------------------------------------------------------

function renderManifest(manifest: Manifest, specSource: string): string {
  const displaySource = /^https?:\/\//i.test(specSource)
    ? specSource
    : relative(REPO_ROOT, specSource) || specSource;
  const banner = `// GENERATED FILE — DO NOT EDIT. Produced by the deel-cli-extractor skill from ${displaySource}.\n`;
  const body = `import type { Manifest } from "./types.ts";\n\nexport const manifest: Manifest = ${JSON.stringify(manifest, null, 2)} as const;\n`;
  return banner + body;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const specArg = process.argv[2];
  if (!specArg) {
    process.stderr.write("Usage: node extract.ts <spec-path-or-url>\n");
    process.exit(1);
  }

  const specSource = /^https?:\/\//i.test(specArg) ? specArg : resolve(process.cwd(), specArg);

  const commandMapPath = resolve(REPO_ROOT, "src/commands.map.ts");
  const manifestPath = resolve(REPO_ROOT, "src/manifest.generated.ts");

  process.stderr.write(`[extractor] loading spec from ${specSource}\n`);
  const spec = await loadSpec(specSource);

  process.stderr.write(`[extractor] importing command map from ${commandMapPath}\n`);
  const { commandMap } = await import(pathToFileURL(commandMapPath).href) as { commandMap: CommandEntry[] };

  process.stderr.write(`[extractor] extracting ${commandMap.length} command(s)...\n`);
  const { manifest, hardErrors, warnings } = extract(spec, commandMap);

  for (const w of warnings) process.stderr.write(`[warn] ${w}\n`);

  if (hardErrors.length > 0) {
    process.stderr.write(`\n[extractor] ${hardErrors.length} hard error(s):\n`);
    for (const e of hardErrors) process.stderr.write(`  ERROR: ${e}\n`);
    process.exit(1);
  }

  // Drift detection against the current committed manifest
  let driftReport: DriftReport = { lines: [], hasBreaking: false };
  try {
    const { manifest: current } = await import(pathToFileURL(manifestPath).href) as { manifest: Manifest };
    driftReport = detectDrift(current, manifest);
  } catch {
    process.stderr.write("[extractor] no existing manifest found; skipping drift detection\n");
  }

  // Print drift report
  if (driftReport.lines.length === 0) {
    process.stdout.write("drift: none — manifest is up to date\n");
  } else {
    process.stdout.write(`drift: ${driftReport.lines.length} change(s)${driftReport.hasBreaking ? " (includes BREAKING changes)" : ""}:\n`);
    for (const line of driftReport.lines) process.stdout.write(`  ${line}\n`);
  }

  // Write updated manifest
  writeFileSync(manifestPath, renderManifest(manifest, specSource));

  process.stderr.write(`\n[extractor] wrote ${relative(REPO_ROOT, manifestPath)}\n`);
  process.stderr.write(`[extractor] ${manifest.descriptors.length} descriptor(s) from ${commandMap.length} map entr${commandMap.length === 1 ? "y" : "ies"}\n`);
  for (const d of manifest.descriptors) {
    const tag = d.variant ? ` [${d.variant}]` : "";
    process.stderr.write(`  ${(d.command.join(" ") + tag).padEnd(40)} ${d.method} ${d.path}\n`);
  }
}
