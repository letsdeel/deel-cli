import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const EXPECTED_BUN_PLATFORMS = [
  "@oven/bun-darwin-aarch64",
  "@oven/bun-darwin-x64",
  "@oven/bun-freebsd-aarch64",
  "@oven/bun-freebsd-x64",
  "@oven/bun-linux-aarch64",
  "@oven/bun-linux-aarch64-android",
  "@oven/bun-linux-aarch64-musl",
  "@oven/bun-linux-x64",
  "@oven/bun-linux-x64-android",
  "@oven/bun-linux-x64-musl",
  "@oven/bun-windows-aarch64",
  "@oven/bun-windows-x64",
];

function check(): string[] {
  const errors: string[] = [];
  const lock = JSON.parse(readFileSync(resolve(REPO_ROOT, "package-lock.json"), "utf8"));
  const packages = lock.packages ?? {};

  const bun = packages["node_modules/bun"];
  if (!bun) return ['[lockfile] Missing bun entry in package-lock.json'];

  for (const name of EXPECTED_BUN_PLATFORMS) {
    const entry = packages[`node_modules/${name}`];
    if (!entry || entry.version !== bun.version) {
      errors.push(`[lockfile] Missing or stale entry for optional dependency: ${name}@${bun.version}`);
    }
  }

  if (errors.length > 0) {
    errors.push(
      "[lockfile] `npm i` run against an already-installed node_modules can prune platform " +
        "binaries other than your own from package-lock.json. Fix with: rm -rf node_modules package-lock.json && npm install",
    );
  }

  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = check();
  if (errors.length > 0) {
    for (const err of errors) process.stderr.write(err + "\n");
    process.exit(1);
  }
  process.stderr.write("[check-lockfile] OK — all bun platform binaries present in package-lock.json.\n");
}
