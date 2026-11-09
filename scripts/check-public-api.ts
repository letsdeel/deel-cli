// Keeps the public repository from showing more than the public docs do:
// - src/public-api/manifest.json holds only fields the CLI reads, only public rest/scim endpoints, no `x-` keys;
// - every endpoint src/public-api/commands.json names is in the manifest, so the map can't publish a hidden path;
// - no tracked file names a definitions URL (the release process passes it with --from);
// - no workflow requests `id-token: write`, so no job here can read a shared Vault role's secrets.
//
// Usage: node scripts/check-public-api.ts [--root <dir>]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { CliParam, CommandForm, Descriptor, GeneratedManifest, VersionInfo } from "../src/types.ts";

// Spelled out rather than imported from the generator, so a change there can't move the check.
export const GENERATOR = "scripts/generate-public-api.ts";
export const MANIFEST_FILE = "src/public-api/manifest.json";

// `satisfies` makes the typechecker fail when src/types.ts and these allowlists drift apart.
const MANIFEST_KEYS = { generator: true, descriptors: true } satisfies Record<keyof GeneratedManifest, true>;
const DESCRIPTOR_KEYS = {
  command: true, variant: true, method: true, path: true, summary: true, version: true, async: true,
  bodyKind: true, supportsMultipart: true, bodyWrapper: true, params: true, bodyProps: true, maxItems: true,
  fileFields: true, responseKind: true, responseFields: true, api: true, beta: true, versions: true, form: true,
} satisfies Record<keyof Descriptor, true>;
const PARAM_KEYS = {
  name: true, in: true, type: true, required: true, nullable: true, enum: true, description: true, properties: true,
  maxItems: true, flag: true,
} satisfies Record<keyof CliParam, true>;
const FORM_KEYS = { positionals: true, scopes: true, selectors: true } satisfies Record<keyof CommandForm, true>;
const VERSION_KEYS = { version: true, beta_until: true, sunset_at: true } satisfies Record<keyof VersionInfo, true>;

const APIS = new Set(["rest", "scim"]);
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isObject(value: unknown): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownKeys(value: Record<string, Json>, allowed: Record<string, true>, where: string, errors: string[]): void {
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(allowed, key)) errors.push(`[manifest] ${where}: unexpected key "${key}"`);
  }
}

function checkParams(value: Json | undefined, where: string, errors: string[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push(`[manifest] ${where} must be an array`);
    return;
  }
  value.forEach((param, i) => {
    const at = `${where}[${i}]`;
    if (!isObject(param)) {
      errors.push(`[manifest] ${at} must be an object`);
      return;
    }
    unknownKeys(param, PARAM_KEYS, at, errors);
    checkParams(param.properties, `${at}.properties`, errors);
  });
}

function extensionKeys(value: Json, where: string, found: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => extensionKeys(item, `${where}[${i}]`, found));
  } else if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (/^x-/i.test(key)) found.push(`${where}.${key}`);
      extensionKeys(child, `${where}.${key}`, found);
    }
  }
}

export function checkManifest(text: string): string[] {
  let manifest: Json;
  try {
    manifest = JSON.parse(text) as Json;
  } catch {
    return [`[manifest] ${MANIFEST_FILE} is not valid JSON`];
  }
  if (!isObject(manifest)) return [`[manifest] ${MANIFEST_FILE} must be a JSON object`];

  const errors: string[] = [];
  unknownKeys(manifest, MANIFEST_KEYS, "top level", errors);

  const found: string[] = [];
  extensionKeys(manifest, "$", found);
  for (const at of found) errors.push(`[public-data] ${at}: extension (x-) keys must not reach the public manifest`);

  if (manifest.generator !== GENERATOR) {
    errors.push(`[manifest] "generator" is ${JSON.stringify(manifest.generator ?? null)}, expected "${GENERATOR}"`);
  }

  if (!Array.isArray(manifest.descriptors)) {
    errors.push('[manifest] "descriptors" must be an array');
    return errors;
  }
  manifest.descriptors.forEach((descriptor, i) => {
    if (!isObject(descriptor)) {
      errors.push(`[manifest] descriptors[${i}] must be an object`);
      return;
    }
    const name = Array.isArray(descriptor.command) ? descriptor.command.join(" ") : "?";
    const at = `descriptors[${i}] (${name})`;
    unknownKeys(descriptor, DESCRIPTOR_KEYS, at, errors);
    for (const field of ["params", "bodyProps", "responseFields"] as const) checkParams(descriptor[field], `${at}.${field}`, errors);
    if (descriptor.form !== undefined) {
      if (isObject(descriptor.form)) unknownKeys(descriptor.form, FORM_KEYS, `${at}.form`, errors);
      else errors.push(`[manifest] ${at}.form must be an object`);
    }
    if (descriptor.versions !== undefined) {
      if (!Array.isArray(descriptor.versions)) errors.push(`[manifest] ${at}.versions must be an array`);
      else
        descriptor.versions.forEach((version, j) => {
          if (isObject(version)) unknownKeys(version, VERSION_KEYS, `${at}.versions[${j}]`, errors);
          else errors.push(`[manifest] ${at}.versions[${j}] must be an object`);
        });
    }

    if (typeof descriptor.api !== "string" || !APIS.has(descriptor.api)) {
      errors.push(`[public-data] ${at}: "api" must be "rest" or "scim", got ${JSON.stringify(descriptor.api ?? null)}`);
    }
    if (typeof descriptor.path !== "string" || !descriptor.path.startsWith("/")) {
      errors.push(`[public-data] ${at}: "path" must start with "/", got ${JSON.stringify(descriptor.path ?? null)}`);
    }
    if (typeof descriptor.method !== "string" || !METHODS.has(descriptor.method)) {
      errors.push(`[public-data] ${at}: "method" must be one of ${[...METHODS].join("/")}, got ${JSON.stringify(descriptor.method ?? null)}`);
    }
  });
  return errors;
}

export const MAP_FILE = "src/public-api/commands.json";

type MapRow = { method: string; path: string; api?: string; collapse?: string };
const routeOf = (api: string | undefined, method: string, path: string) => `${api === "scim" ? "scim" : "rest"} ${method.toUpperCase()} ${path.replace(/\{[^}]+\}/g, "{}")}`;

// Every endpoint the map names is in the manifest; a collapsed one passes when its collapse group is.
// With no manifest committed yet there is nothing to compare against, so nothing is checked.
export function checkMapIsPublic(mapText: string, manifestText: string): string[] {
  const descriptors = (JSON.parse(manifestText) as GeneratedManifest).descriptors ?? [];
  if (descriptors.length === 0) return [];
  const published = new Set(descriptors.map((d) => routeOf(d.api, d.method, d.path)));
  const map = JSON.parse(mapText) as MapRow[];
  const collapsedIn = new Set(map.filter((e) => e.collapse && published.has(routeOf(e.api, e.method, e.path))).map((e) => e.collapse));
  return map
    .filter((e) => !published.has(routeOf(e.api, e.method, e.path)) && !(e.collapse && collapsedIn.has(e.collapse)))
    .map((e) => `[public-data] ${MAP_FILE} names ${e.method} ${e.path}, which is not in the public manifest. Remove the entry until the endpoint is documented.`);
}

const DEFINITIONS_URL = /https?:\/\/[^\s"'`<>)]*\/openapi\/definitions/i;

// The tracked files that name a definitions URL, as "file:line".
export function definitionsUrlMentions(files: { path: string; text: string }[]): string[] {
  const found: string[] = [];
  for (const { path, text } of files) {
    text.split("\n").forEach((line, i) => {
      if (DEFINITIONS_URL.test(line)) found.push(`${path}:${i + 1}`);
    });
  }
  return found;
}

// Workflows that request `id-token: write`, at the workflow or the job level.
export function idTokenWriters(workflows: { path: string; text: string }[]): string[] {
  return workflows.filter(({ text }) => /^\s*id-token\s*:\s*write\b/m.test(text)).map(({ path }) => path);
}

function trackedFiles(root: string): { path: string; text: string }[] {
  let list: string[];
  try {
    list = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\0").filter(Boolean);
  } catch {
    return []; // not a git checkout (a test's temporary root)
  }
  return list
    .filter((path) => existsSync(join(root, path)) && !/\.(png|jpg|gif|ico|lock|lockb)$|package-lock\.json$/.test(path))
    .map((path) => ({ path, text: readFileSync(join(root, path), "utf8") }));
}

export function run(argv: string[]): string[] {
  const { values } = parseArgs({ args: argv, options: { root: { type: "string" } } });
  const root = resolve(values.root ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  const manifestPath = join(root, MANIFEST_FILE);
  if (!existsSync(manifestPath)) return [`[manifest] ${MANIFEST_FILE} is missing`];
  const manifestText = readFileSync(manifestPath, "utf8");
  const errors = checkManifest(manifestText);
  const mapPath = join(root, MAP_FILE);
  if (existsSync(mapPath) && errors.length === 0) errors.push(...checkMapIsPublic(readFileSync(mapPath, "utf8"), manifestText));
  const files = trackedFiles(root);
  for (const at of definitionsUrlMentions(files)) errors.push(`[public-data] ${at} names a definitions URL; the release process passes it with --from`);
  for (const path of idTokenWriters(files.filter((f) => /^\.github\/workflows\/.+\.ya?ml$/.test(f.path)))) {
    errors.push(`[public-data] ${path} requests id-token: write; no workflow in this repository may`);
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = run(process.argv.slice(2));
  const ci = process.env.GITHUB_ACTIONS === "true";
  for (const error of errors) process.stderr.write(ci ? `::error::${error}\n` : `[check-public-api] error: ${error}\n`);
  if (errors.length > 0) process.exit(1);
  process.stderr.write("[check-public-api] OK\n");
}
