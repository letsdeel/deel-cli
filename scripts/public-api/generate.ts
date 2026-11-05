import { bodyFrom, responseFrom } from "../../.claude/skills/deel-cli-extractor/extract.ts";
import type { CliParam, Descriptor, GeneratedManifest, ScalarType, VersionInfo } from "../../src/types.ts";
import { commonArgs } from "../../src/commands/shared.ts";
import type { Definition } from "./definitions.ts";
import { API_GROUP } from "../../src/core/constants.ts";
import { deriveCommand, isParamSegment, kebab, pathParams } from "./naming.ts";
import type { Api } from "./naming.ts";

type AnyObj = Record<string, any>;

export const GENERATOR = "scripts/generate-public-api.ts";

export type Reserved = {
  commands: { command: string[]; method: string; path: string }[];
  topLevel: Set<string>;
};

export type Summary = {
  added: SummaryEntry[];
  changed: SummaryEntry[];
  removed: SummaryEntry[];
  bump: "none" | "patch" | "minor" | "major";
};

export type SummaryEntry = { command: string; method: string; path: string };

export type GenerateResult = {
  manifest: GeneratedManifest;
  errors: string[];
  warnings: string[];
  summary: Summary;
};

export type GenerateOptions = {
  reserved: Reserved;
  overrides: Record<string, string>; // "METHOD /path" (or "scim METHOD /path") -> command words
  previous?: GeneratedManifest;
  now?: Date;
};

// Flags every command already has. A path or query param with one of these names keeps
// its API name but gets the flag "<name>-param" (e.g. a `fields` query param).
export const GLOBAL_FLAGS = new Set([...Object.keys(commonArgs), "help", "h", "version", "v", "base-url", "beta", "versions"]);

function mapType(schema: AnyObj | undefined): ScalarType {
  const type = schema?.type;
  if (type === "number" || type === "integer" || type === "boolean" || type === "array" || type === "object") return type;
  return "string";
}

const squash = (name: string) => name.toLowerCase().replace(/[-_]/g, "");
const GLOBAL_FLAG_KEYS = new Set([...GLOBAL_FLAGS].map(squash));

// citty also accepts the camelCase and kebab-case spelling of every flag, so names collide when they squash alike.
function paramsFrom(operation: AnyObj, path: string): CliParam[] {
  const declared = ((operation.parameters ?? []) as AnyObj[]).filter((param) => param.in === "path" || param.in === "query");
  const inPath = pathParams(path);
  // The URL is filled from the path's own spelling, so a declared name that differs only in case or separators follows it.
  const renamed = declared.map((param) => {
    if (param.in !== "path" || inPath.includes(param.name)) return param;
    const matches = inPath.filter((name) => squash(name) === squash(param.name));
    if (matches.length !== 1) throw new Error(`${path}: path parameter "${param.name}" is not in the path`);
    return { ...param, name: matches[0] };
  });
  const missing = inPath
    .filter((name) => !renamed.some((param) => param.in === "path" && param.name === name))
    .map((name) => ({ name, in: "path", schema: { type: "string" } }));
  const params = ([...renamed, ...missing] as AnyObj[])
    .map((param) => ({
      name: param.name,
      in: param.in as "path" | "query",
      type: mapType(param.schema),
      required: param.in === "path" ? true : Boolean(param.required),
      ...(param.schema?.enum ? { enum: (param.schema.enum as unknown[]).filter((value): value is string => value !== null).map(String) } : {}),
      ...(param.description ? { description: param.description } : {}),
      ...(GLOBAL_FLAG_KEYS.has(squash(param.name)) ? { flag: `${param.name}-param` } : {}),
    }));
  const flags = new Map<string, string>();
  for (const param of params) {
    const key = squash(param.flag ?? param.name);
    if (flags.has(key)) throw new Error(`${path}: parameters "${flags.get(key)}" and "${param.name}" would share one flag`);
    flags.set(key, param.name);
  }
  return params;
}

export function overrideKey(api: Api, method: string, path: string): string {
  return `${api === "scim" ? "scim " : ""}${method.toUpperCase()} ${path}`;
}

function endpointKey(descriptor: { api?: Api; method: string; path: string }): string {
  return overrideKey(descriptor.api ?? "rest", descriptor.method, descriptor.path);
}

// A route is the same when only its path params were renamed ({typeId} -> {type_id}); overrides, the name lock and the summary match on this key.
const withoutParamNames = (key: string) => key.replace(/\{[^}]+\}/g, "{}");
const routeIdOf = (descriptor: { api?: Api; method: string; path: string }) => withoutParamNames(endpointKey(descriptor));

function isBeta(entry: Definition, now: Date): boolean {
  return entry.beta_until !== null && new Date(entry.beta_until).getTime() > now.getTime();
}

function isSunset(entry: Definition, now: Date): boolean {
  return entry.sunset_at !== null && new Date(entry.sunset_at).getTime() <= now.getTime();
}

function toDescriptor(command: string[], primary: Definition, versions: VersionInfo[], beta: boolean): Descriptor {
  const operation = primary.operation;
  const { bodyKind, bodyProps, maxItems, fileFields, supportsMultipart, bodyWrapper } = bodyFrom(operation);
  const { responseKind, responseFields } = responseFrom(operation);
  return {
    command,
    method: primary.method,
    path: primary.path,
    ...(operation.summary ? { summary: operation.summary } : {}),
    version: primary.version,
    async: Boolean(operation.responses?.["202"]),
    bodyKind,
    supportsMultipart,
    bodyWrapper,
    params: paramsFrom(operation, primary.path),
    bodyProps,
    ...(maxItems !== undefined ? { maxItems } : {}),
    fileFields,
    responseKind,
    responseFields,
    api: primary.api,
    ...(beta ? { beta: true } : {}),
    versions,
  };
}

// A group of same-named GET descriptors merges only when every endpoint differs by path
// params alone and those sets nest (e.g. {} and {contract_id}), so the flags given
// always pick exactly one endpoint.
function mergeable(group: Descriptor[]): boolean {
  // Only reads merge: a mistyped flag must never turn a delete or create on one endpoint into the other.
  if (group.some((descriptor) => descriptor.method !== "GET")) return false;
  const sets = group.map((descriptor) => pathParams(descriptor.path)).sort((a, b) => a.length - b.length);
  for (let i = 1; i < sets.length; i++) {
    if (sets[i].length === sets[i - 1].length) return false;
    if (!sets[i - 1].every((name) => sets[i].includes(name))) return false;
  }
  return true;
}

function routeKey(entry: Definition): string {
  return `${entry.api} ${entry.method} ${entry.path.replace(/\{[^}]+\}/g, "{}")}`;
}

function baseOperationId(entry: Definition | undefined): string | undefined {
  return entry?.operation.operationId?.replace(/-v\d{4}-\d{2}-\d{2}$/, "");
}

function isKebabPath(path: string): boolean {
  return path.split("/").filter((segment) => segment && !isParamSegment(segment)).every((segment) => kebab(segment) === segment);
}

function compareDescriptors(a: Descriptor, b: Descriptor): number {
  const byCommand = a.command.join(" ").localeCompare(b.command.join(" "));
  if (byCommand !== 0) return byCommand;
  return endpointKey(a).localeCompare(endpointKey(b));
}

export function generate(definitions: Definition[], options: GenerateOptions): GenerateResult {
  const now = options.now ?? new Date();
  const errors: string[] = [];
  const warnings: string[] = [];

  // One descriptor per endpoint: the newest stable version, or the newest beta when nothing is stable yet.
  const byEndpoint = new Map<string, Definition[]>();
  for (const entry of definitions) {
    if (isSunset(entry, now)) continue;
    const key = routeKey(entry);
    byEndpoint.set(key, [...(byEndpoint.get(key) ?? []), entry]);
  }

  const previousByEndpoint = new Map((options.previous?.descriptors ?? []).map((descriptor) => [routeIdOf(descriptor), descriptor]));
  const overridesByRoute = new Map(Object.entries(options.overrides).map(([key, words]) => [withoutParamNames(key), { key, words }]));
  const usedOverrides = new Set<string>();
  const descriptors: Descriptor[] = [];
  const operationOf = new Map<Descriptor, Definition>();
  for (const entries of byEndpoint.values()) {
    entries.sort((a, b) => a.version.localeCompare(b.version));
    const repeated = entries.find((entry, index) => index > 0 && entry.version === entries[index - 1].version);
    if (repeated) {
      errors.push(`Version ${repeated.version} of ${endpointKey(repeated)} is defined more than once`);
      continue;
    }
    const versions = entries.map((entry) => ({ version: entry.version, beta_until: entry.beta_until, sunset_at: entry.sunset_at }));
    const stable = entries.filter((entry) => !isBeta(entry, now));
    const primary = stable.length ? stable[stable.length - 1] : entries[entries.length - 1];
    const key = overrideKey(primary.api, primary.method, primary.path);
    let command: string[];
    try {
      command = deriveCommand(primary.api, primary.method, primary.path);
    } catch (error) {
      errors.push((error as Error).message);
      continue;
    }
    const override = overridesByRoute.get(withoutParamNames(key));
    if (override) {
      command = override.words.trim().split(/\s+/);
      usedOverrides.add(override.key);
    }
    command = [API_GROUP, ...command];
    const released = previousByEndpoint.get(withoutParamNames(key));
    if (released && released.command.join(" ") !== command.join(" ")) {
      errors.push(`Lock: ${key} was released as "deel ${released.command.join(" ")}" and would become "deel ${command.join(" ")}". Released names never change.`);
      command = released.command;
    }
    let descriptor: Descriptor;
    try {
      descriptor = toDescriptor(command, primary, versions, stable.length === 0);
    } catch (error) {
      errors.push((error as Error).message);
      continue;
    }
    operationOf.set(descriptor, primary);
    descriptors.push(descriptor);
  }
  for (const key of Object.keys(options.overrides)) {
    if (!usedOverrides.has(key)) warnings.push(`Override for ${key} matches no endpoint`);
  }

  // One operation registered under two spellings of its path (email_drafts / email-drafts): keep the kebab-case one.
  const aliasGroups = new Map<string, Descriptor[]>();
  for (const descriptor of descriptors) {
    const operationId = baseOperationId(operationOf.get(descriptor));
    if (!operationId) continue;
    const aliasKey = `${descriptor.command.join(" ")}\0${descriptor.method}\0${operationId}`;
    aliasGroups.set(aliasKey, [...(aliasGroups.get(aliasKey) ?? []), descriptor]);
  }
  for (const group of aliasGroups.values()) {
    if (group.length < 2) continue;
    const [kept, ...dropped] = [...group].sort((a, b) => Number(isKebabPath(b.path)) - Number(isKebabPath(a.path)) || a.path.localeCompare(b.path));
    for (const alias of dropped) {
      descriptors.splice(descriptors.indexOf(alias), 1);
      warnings.push(`${endpointKey(alias)} is an alias of ${endpointKey(kept)} (same operation); "deel ${kept.command.join(" ")}" calls ${kept.path}`);
    }
  }

  const byCommand = new Map<string, Descriptor[]>();
  for (const descriptor of descriptors) {
    const name = descriptor.command.join(" ");
    byCommand.set(name, [...(byCommand.get(name) ?? []), descriptor]);
  }
  for (const [name, group] of byCommand) {
    if (group.length > 1 && !mergeable(group)) {
      errors.push(`Ambiguous command "deel ${name}": ${group.map(endpointKey).join(", ")}. Add an override in src/public-api/overrides.ts.`);
    }
  }

  // A word can't be both a command and a group.
  const leaves = new Set(byCommand.keys());
  for (const name of leaves) {
    const words = name.split(" ");
    for (let i = 1; i < words.length; i++) {
      const prefix = words.slice(0, i).join(" ");
      if (leaves.has(prefix)) errors.push(`"deel ${prefix}" is a command and also a group of "deel ${name}"`);
    }
  }

  if (options.reserved.topLevel.has(API_GROUP) || options.reserved.commands.some((entry) => entry.command[0] === API_GROUP)) {
    errors.push(`"deel ${API_GROUP}" is reserved for the generated commands; no static or hand-picked command may use it`);
  }
  const handPicked = new Map(options.reserved.commands.map((entry) => [entry.command.join(" "), entry]));
  const handPickedEndpoints = new Set(options.reserved.commands.map((entry) => overrideKey("rest", entry.method, entry.path)));
  for (const [name, group] of byCommand) {
    const words = name.split(" ");
    if (options.reserved.topLevel.has(words[0])) errors.push(`"deel ${name}" would shadow the static "deel ${words[0]}" command`);
    if (handPicked.has(name)) {
      errors.push(`"deel ${name}" (${group.map(endpointKey).join(", ")}) clashes with a hand-picked command. Add an override in src/public-api/overrides.ts.`);
    }
    for (let i = 1; i < words.length; i++) {
      const prefix = words.slice(0, i).join(" ");
      if (handPicked.has(prefix)) errors.push(`"deel ${name}" would turn the hand-picked "deel ${prefix}" into a group`);
    }
    for (const handName of handPicked.keys()) {
      if (handName.startsWith(`${name} `)) errors.push(`"deel ${name}" is a group of the hand-picked "deel ${handName}"`);
    }
    for (const descriptor of group) {
      if (handPickedEndpoints.has(endpointKey(descriptor))) {
        warnings.push(`${endpointKey(descriptor)} has a hand-picked command and a generated one ("deel ${name}")`);
      }
    }
  }

  descriptors.sort(compareDescriptors);
  const manifest: GeneratedManifest = { generator: GENERATOR, descriptors };
  return { manifest, errors, warnings, summary: summarize(options.previous?.descriptors ?? [], descriptors) };
}

export function summarize(before: Descriptor[], after: Descriptor[]): Summary {
  const entry = (descriptor: Descriptor): SummaryEntry => ({ command: descriptor.command.join(" "), method: descriptor.method, path: descriptor.path });
  const beforeMap = new Map(before.map((descriptor) => [routeIdOf(descriptor), descriptor]));
  const afterMap = new Map(after.map((descriptor) => [routeIdOf(descriptor), descriptor]));
  const added = after.filter((descriptor) => !beforeMap.has(routeIdOf(descriptor))).map(entry);
  const removed = before.filter((descriptor) => !afterMap.has(routeIdOf(descriptor))).map(entry);
  const changed = after
    .filter((descriptor) => {
      const old = beforeMap.get(routeIdOf(descriptor));
      return old !== undefined && JSON.stringify(old) !== JSON.stringify(descriptor);
    })
    .map(entry);
  const bump = removed.length ? "major" : added.length ? "minor" : changed.length ? "patch" : "none";
  return { added, changed, removed, bump };
}

export function renderManifest(manifest: GeneratedManifest): string {
  return JSON.stringify(manifest, null, 1) + "\n";
}
