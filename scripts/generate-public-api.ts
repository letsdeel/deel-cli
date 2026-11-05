#!/usr/bin/env node
// Generates src/public-api/manifest.json from a definitions file or URL (--from) or from the
// public OpenAPI documents (--from-openapi; prefix scim= for the SCIM one). Exit 1 on any naming error,
// and when the input holds no definitions at all.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { manifest as handPicked } from "../src/manifest.generated.ts";
import { overrides } from "../src/public-api/overrides.ts";
import { RESERVED_COMMANDS } from "../src/core/constants.ts";
import type { GeneratedManifest } from "../src/types.ts";
import { definitionsFromOpenApi, loadJson, parseDefinitions } from "./public-api/definitions.ts";
import type { Definition } from "./public-api/definitions.ts";
import { generate, renderManifest } from "./public-api/generate.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      from: { type: "string" },
      "from-openapi": { type: "string", multiple: true },
      out: { type: "string" },
      summary: { type: "string" },
      previous: { type: "string" },
    },
  });
  const openapi = values["from-openapi"] ?? [];
  if (Boolean(values.from) === openapi.length > 0) {
    process.stderr.write("Usage: generate-public-api.ts --from <file|url> | --from-openapi <file|url> [--from-openapi scim=<file|url>] [--out <dir>] [--summary <file>] [--previous <manifest>]\n");
    return 1;
  }

  let definitions: Definition[];
  if (values.from) {
    definitions = parseDefinitions(await loadJson(values.from));
  } else {
    definitions = [];
    for (const arg of openapi) {
      const [api, source] = arg.startsWith("scim=") ? (["scim", arg.slice(5)] as const) : (["rest", arg.replace(/^rest=/, "")] as const);
      definitions.push(...definitionsFromOpenApi((await loadJson(source)) as Record<string, any>, api));
    }
  }

  // An input with nothing in it would otherwise replace the manifest with an empty one and release-remove every command.
  if (definitions.length === 0) {
    process.stderr.write("[error] The input holds no definitions; nothing written.\n");
    return 1;
  }

  const outDir = resolve(process.cwd(), values.out ?? resolve(REPO_ROOT, "src/public-api"));
  const manifestPath = resolve(outDir, "manifest.json");
  // The released names are the committed manifest's, wherever the new one is written, unless --previous names another.
  const lockPath = values.previous ? resolve(process.cwd(), values.previous) : resolve(REPO_ROOT, "src/public-api/manifest.json");
  if (values.previous && !existsSync(lockPath)) throw new Error(`--previous ${values.previous} does not exist`);
  let previous: GeneratedManifest | undefined;
  if (existsSync(lockPath)) {
    // A wrong file would otherwise read as "nothing released" and switch the name lock off.
    const parsed = JSON.parse(readFileSync(lockPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.descriptors)) throw new Error(`${lockPath} is not a generated manifest`);
    previous = parsed as GeneratedManifest;
  }

  const result = generate(definitions, {
    reserved: { commands: handPicked.descriptors, topLevel: RESERVED_COMMANDS },
    overrides,
    previous,
  });

  for (const warning of result.warnings) process.stderr.write(`[warn] ${warning}\n`);
  if (result.errors.length) {
    for (const error of result.errors) process.stderr.write(`[error] ${error}\n`);
    process.stderr.write(`\n${result.errors.length} error(s); nothing written.\n`);
    return 1;
  }

  mkdirSync(outDir, { recursive: true });
  writeFileSync(manifestPath, renderManifest(result.manifest));
  if (values.summary) writeFileSync(resolve(process.cwd(), values.summary), JSON.stringify(result.summary, null, 2) + "\n");

  const { added, changed, removed, bump } = result.summary;
  process.stderr.write(
    `${result.manifest.descriptors.length} command(s) from ${definitions.length} definition(s): ` +
      `${added.length} added, ${changed.length} changed, ${removed.length} removed (bump: ${bump})\n`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`[error] ${(error as Error).message}\n`);
      process.exit(1);
    },
  );
}
