#!/usr/bin/env node
// Generates src/public-api/manifest.json from a definitions file or URL (--from), naming every endpoint from the command map.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { manifest as handPicked } from "../src/manifest.generated.ts";
import { RESERVED_COMMANDS } from "../src/core/constants.ts";
import { loadJson, parseDefinitions } from "./public-api/definitions.ts";
import { readCommandMap } from "./public-api/command-map.ts";
import { generate, readGeneratedManifest, renderManifest } from "./public-api/generate.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      from: { type: "string" },
      map: { type: "string" },
      out: { type: "string" },
      summary: { type: "string" },
      previous: { type: "string" },
    },
  });
  if (!values.from) {
    process.stderr.write("Usage: generate-public-api.ts --from <file|url> [--map <commands.json>] [--out <dir>] [--summary <file>] [--previous <manifest>]\n");
    return 1;
  }

  const definitions = parseDefinitions(await loadJson(values.from));
  const mapPath = values.map ? resolve(process.cwd(), values.map) : resolve(REPO_ROOT, "src/public-api/commands.json");
  const map = readCommandMap(mapPath);

  if (definitions.length === 0) {
    process.stderr.write("[error] The input holds no definitions; nothing written.\n");
    return 1;
  }

  const outDir = resolve(process.cwd(), values.out ?? resolve(REPO_ROOT, "src/public-api"));
  const manifestPath = resolve(outDir, "manifest.json");
  // The released names are the committed manifest's, wherever the new one is written, unless --previous names another.
  const lockPath = values.previous ? resolve(process.cwd(), values.previous) : resolve(REPO_ROOT, "src/public-api/manifest.json");
  if (values.previous && !existsSync(lockPath)) throw new Error(`--previous ${values.previous} does not exist`);
  const previous = existsSync(lockPath) ? readGeneratedManifest(lockPath) : undefined;

  const result = generate(definitions, {
    reserved: { commands: handPicked.descriptors, topLevel: RESERVED_COMMANDS },
    map,
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
  // exitCode, not exit(): a long warning list fills the stderr pipe, and exit() would drop what is still queued.
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`[error] ${(error as Error).message}\n`);
      process.exitCode = 1;
    },
  );
}
