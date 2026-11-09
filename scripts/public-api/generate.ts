import { bodyFrom, responseFrom } from "../../.claude/skills/deel-cli-extractor/extract.ts";
import type { CliParam, Descriptor, GeneratedManifest, ScalarType, VersionInfo } from "../../src/types.ts";
import { commonArgs } from "../../src/commands/shared.ts";
import type { Definition } from "./definitions.ts";
import { bindForm, parseCommand, pathParams } from "./command-map.ts";
import type { Api, MapEntry } from "./command-map.ts";
import { formUsage } from "../../src/public-api/commands.ts";

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
  map: MapEntry[]; // the reviewed command map: every endpoint's command
  previous?: GeneratedManifest;
  now?: Date;
};

// Flags every command already has. A query param with one of these names keeps
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
      ...(param.in !== "path" && GLOBAL_FLAG_KEYS.has(squash(param.name)) ? { flag: `${param.name}-param` } : {}),
    }));
  const flags = new Map<string, string>();
  for (const param of params) {
    if (param.in === "path") continue; // typed as an argument, not a flag
    const key = squash(param.flag ?? param.name);
    if (flags.has(key)) throw new Error(`${path}: parameters "${flags.get(key)}" and "${param.name}" would share one flag`);
    flags.set(key, param.name);
  }
  return params;
}

export function endpointKey(api: Api, method: string, path: string): string {
  return `${api === "scim" ? "scim " : ""}${method.toUpperCase()} ${path}`;
}

const keyOf = (descriptor: { api?: Api; method: string; path: string }) => endpointKey(descriptor.api ?? "rest", descriptor.method, descriptor.path);

// A route is the same when only its path params were renamed ({typeId} -> {type_id}); the map, the name lock and the summary match on this key.
const withoutParamNames = (key: string) => key.replace(/\{[^}]+\}/g, "{}");
const routeIdOf = (descriptor: { api?: Api; method: string; path: string }) => withoutParamNames(keyOf(descriptor));

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

function routeKey(entry: Definition): string {
  return `${entry.api} ${entry.method} ${entry.path.replace(/\{[^}]+\}/g, "{}")}`;
}

const usage = (descriptor: Descriptor) => formUsage(descriptor.command, descriptor.form!);

function compareDescriptors(a: Descriptor, b: Descriptor): number {
  const byCommand = usage(a).localeCompare(usage(b));
  if (byCommand !== 0) return byCommand;
  return keyOf(a).localeCompare(keyOf(b));
}

// Selector and scope flags are typed next to the endpoint's own flags, so they may not share a spelling with one.
function flagClash(descriptor: Descriptor): string | undefined {
  const own = new Map<string, string>();
  for (const name of GLOBAL_FLAGS) own.set(squash(name), `the global --${name}`);
  for (const param of descriptor.params) if (param.in !== "path") own.set(squash(param.flag ?? param.name), `its --${param.flag ?? param.name}`);
  const form = descriptor.form!;
  for (const flag of [...form.selectors.map((s) => s.flag), ...form.scopes.map((s) => s.flag)]) {
    if (own.has(squash(flag))) return `--${flag} clashes with ${own.get(squash(flag))}`;
  }
  return undefined;
}

export function generate(definitions: Definition[], options: GenerateOptions): GenerateResult {
  const now = options.now ?? new Date();
  const errors: string[] = [];
  const warnings: string[] = [];

  const mapByRoute = new Map<string, { entry: MapEntry; index: number }>();
  options.map.forEach((entry, index) => {
    const key = withoutParamNames(endpointKey(entry.api ?? "rest", entry.method, entry.path));
    if (mapByRoute.has(key)) errors.push(`The command map names ${key} twice`);
    mapByRoute.set(key, { entry, index });
  });

  // One descriptor per endpoint: the newest stable version, or the newest beta when nothing is stable yet.
  const byEndpoint = new Map<string, Definition[]>();
  for (const entry of definitions) {
    if (isSunset(entry, now)) continue;
    const key = routeKey(entry);
    byEndpoint.set(key, [...(byEndpoint.get(key) ?? []), entry]);
  }

  const previousByEndpoint = new Map((options.previous?.descriptors ?? []).map((descriptor) => [routeIdOf(descriptor), descriptor]));
  const usedMap = new Set<string>();
  const descriptors: Descriptor[] = [];
  const mapIndex = new Map<Descriptor, number>();
  const collapseOf = new Map<Descriptor, string>();
  for (const entries of byEndpoint.values()) {
    entries.sort((a, b) => a.version.localeCompare(b.version));
    const repeated = entries.find((entry, index) => index > 0 && entry.version === entries[index - 1].version);
    if (repeated) {
      errors.push(`Version ${repeated.version} of ${endpointKey(repeated.api, repeated.method, repeated.path)} is defined more than once`);
      continue;
    }
    const versions = entries.map((entry) => ({ version: entry.version, beta_until: entry.beta_until, sunset_at: entry.sunset_at }));
    const stable = entries.filter((entry) => !isBeta(entry, now));
    const primary = stable.length ? stable[stable.length - 1] : entries[entries.length - 1];
    const key = endpointKey(primary.api, primary.method, primary.path);
    const mapped = mapByRoute.get(withoutParamNames(key));
    if (!mapped) {
      errors.push(`${key} has no entry in src/public-api/commands.json. Name it with the rules in CONTRIBUTING.md.`);
      continue;
    }
    usedMap.add(withoutParamNames(key));
    let descriptor: Descriptor;
    try {
      const parsed = parseCommand(mapped.entry.command);
      if (options.reserved.topLevel.has(parsed.words[0])) {
        warnings.push(`${key} is served by the static "deel ${parsed.words[0]}" command, so "${mapped.entry.command}" is not generated`);
        continue;
      }
      descriptor = toDescriptor(parsed.words, primary, versions, stable.length === 0);
      const bound = bindForm(parsed, primary.path, descriptor.params.filter((p) => p.in === "query").map((p) => p.name));
      if (bound.error) throw new Error(`${mapped.entry.command}: ${bound.error}`);
      descriptor.form = bound.form;
    } catch (error) {
      errors.push((error as Error).message);
      continue;
    }
    const clash = flagClash(descriptor);
    if (clash) {
      errors.push(`"${usage(descriptor)}" (${key}): ${clash}`);
      continue;
    }
    const released = previousByEndpoint.get(withoutParamNames(key));
    if (released?.form && usage(released) !== usage(descriptor)) {
      errors.push(`Lock: ${key} was released as "${usage(released)}" and would become "${usage(descriptor)}". Released names never change.`);
      descriptor.command = released.command;
      descriptor.form = released.form;
    }
    mapIndex.set(descriptor, mapped.index);
    if (mapped.entry.collapse) collapseOf.set(descriptor, mapped.entry.collapse);
    descriptors.push(descriptor);
  }
  for (const [route] of mapByRoute) {
    if (!usedMap.has(route)) warnings.push(`The command map names ${route}, which isn't in the definitions; it is not generated`);
  }

  // Endpoints that share a whole command line: allowed only when the map collapses them, and the first in the map is called.
  const byUsage = new Map<string, Descriptor[]>();
  for (const descriptor of descriptors) byUsage.set(usage(descriptor), [...(byUsage.get(usage(descriptor)) ?? []), descriptor]);
  for (const [line, group] of byUsage) {
    if (group.length < 2) continue;
    const keys = new Set(group.map((d) => collapseOf.get(d)));
    if (keys.size !== 1 || keys.has(undefined)) {
      errors.push(`"${line}" names ${group.map(keyOf).join(" and ")}. Give them different words or flags in the command map.`);
      continue;
    }
    const [kept, ...rest] = [...group].sort((a, b) => mapIndex.get(a)! - mapIndex.get(b)!);
    for (const dropped of rest) {
      descriptors.splice(descriptors.indexOf(dropped), 1);
      warnings.push(`${keyOf(dropped)} is collapsed into ${keyOf(kept)}: "${line}" calls ${kept.path}`);
    }
  }

  const byCommand = new Map<string, Descriptor[]>();
  for (const descriptor of descriptors) {
    const name = descriptor.command.join(" ");
    byCommand.set(name, [...(byCommand.get(name) ?? []), descriptor]);
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

  const handPickedEndpoints = new Set(options.reserved.commands.map((entry) => endpointKey("rest", entry.method, entry.path)));
  errors.push(...reservedClashes(byCommand.keys(), options.reserved, (name) => ` (${byCommand.get(name)!.map(keyOf).join(", ")})`));
  for (const [name, group] of byCommand) {
    for (const descriptor of group) {
      if (handPickedEndpoints.has(keyOf(descriptor))) {
        warnings.push(`${keyOf(descriptor)} has a hand-picked command and a generated one ("deel ${name}")`);
      }
    }
  }

  descriptors.sort(compareDescriptors);
  const manifest: GeneratedManifest = { generator: GENERATOR, descriptors };
  return { manifest, errors, warnings, summary: summarize(options.previous?.descriptors ?? [], descriptors) };
}

// Generated command names that would shadow a static command, replace a hand-picked one, or turn one into
// (or out of) a command group. `via` adds the endpoints behind a name to the message.
export function reservedClashes(names: Iterable<string>, reserved: Reserved, via: (name: string) => string = () => ""): string[] {
  const errors: string[] = [];
  const handPicked = new Set(reserved.commands.map((entry) => entry.command.join(" ")));
  for (const name of names) {
    const words = name.split(" ");
    if (reserved.topLevel.has(words[0])) errors.push(`"deel ${name}" would shadow the static "deel ${words[0]}" command`);
    if (handPicked.has(name)) errors.push(`"deel ${name}"${via(name)} clashes with a hand-picked command. Give it other words in src/public-api/commands.json.`);
    for (let i = 1; i < words.length; i++) {
      const prefix = words.slice(0, i).join(" ");
      if (handPicked.has(prefix)) errors.push(`"deel ${name}" would turn the hand-picked "deel ${prefix}" into a group`);
    }
    for (const handName of handPicked) {
      if (handName.startsWith(`${name} `)) errors.push(`"deel ${name}" is a group of the hand-picked "deel ${handName}"`);
    }
  }
  return errors;
}

export function summarize(before: Descriptor[], after: Descriptor[]): Summary {
  const entry = (descriptor: Descriptor): SummaryEntry => ({ command: descriptor.form ? usage(descriptor).slice(5) : descriptor.command.join(" "), method: descriptor.method, path: descriptor.path });
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
