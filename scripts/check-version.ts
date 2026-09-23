// Keeps the version the binary reports in lockstep with the version npm publishes.
//
// package.json "version" is what the release pipeline tags and
// publishes; src/version.ts CLI_VERSION is what `deel --version` prints and is inlined so the
// compiled binary doesn't embed the whole package.json. The release preflight refuses to ship
// when the two disagree — this check catches it at commit time instead of at release time.
//
// The version must also be a clean X.Y.Z: the release pipeline owns pre-release suffixes
// (-beta.N) and rejects a package.json that already carries one.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLEAN_SEMVER = /^\d+\.\d+\.\d+$/;
const CLI_VERSION_LINE = /export const CLI_VERSION = "([^"]*)"/;

/** Pure: takes the two file contents so the test suite can feed it fixtures. */
export function check(packageJson: string, versionTs: string): string[] {
  const errors: string[] = [];

  let pkgVersion: unknown;
  try {
    pkgVersion = (JSON.parse(packageJson) as { version?: unknown }).version;
  } catch {
    return ["[version] package.json is not valid JSON"];
  }
  if (typeof pkgVersion !== "string" || pkgVersion.length === 0) {
    return ['[version] package.json has no "version" string'];
  }
  if (!CLEAN_SEMVER.test(pkgVersion)) {
    errors.push(
      `[version] package.json version "${pkgVersion}" must be a clean X.Y.Z — the release pipeline adds -beta.N suffixes itself`,
    );
  }

  const match = versionTs.match(CLI_VERSION_LINE);
  if (!match) {
    errors.push('[version] src/version.ts must contain `export const CLI_VERSION = "X.Y.Z"`');
    return errors;
  }
  if (match[1] !== pkgVersion) {
    errors.push(
      `[version] package.json (${pkgVersion}) and src/version.ts (${match[1]}) disagree — bump both in the same commit`,
    );
  }

  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = check(
    readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"),
    readFileSync(resolve(REPO_ROOT, "src/version.ts"), "utf8"),
  );
  if (errors.length > 0) {
    for (const err of errors) process.stderr.write(err + "\n");
    process.exit(1);
  }
  process.stderr.write("[check-version] OK — package.json and src/version.ts agree.\n");
}
