// Assemble the publishable npm packages from the compiled binaries in dist/.
//
// npm distribution uses the "binary launcher + optionalDependencies" model
// (same as esbuild / turbo / swc): one launcher package that users install,
// plus one package per platform that carries a single Bun-compiled binary and
// is gated by "os"/"cpu" so npm installs only the matching one.
//
//   @deel-org/cli                     -> launcher (bin/deel = tiny JS shim)
//   @deel-org/cli-darwin-arm64        -> carries deel-darwin-arm64
//   @deel-org/cli-darwin-x64          -> carries deel-darwin-x64
//   @deel-org/cli-linux-x64           -> carries deel-linux-x64
//   @deel-org/cli-linux-arm64         -> carries deel-linux-arm64
//   @deel-org/cli-win32-x64           -> carries deel-windows-x64.exe
//
// Output: dist/npm/<pkg>/ trees, each ready for `npm publish`.
// Run: node scripts/pack-npm.ts

import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const OUT = join(DIST, "npm");

const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const NAME: string = rootPkg.name; // "@deel-org/cli"
const VERSION: string = rootPkg.version;
const REPO = "https://github.com/letsdeel/deel-cli";

// npm platform key -> { built binary filename in dist/, os, cpu, libc, in-package binary name }
// Linux has glibc + musl variants: npm's `libc` field selects at install time (recent npm),
// and the launcher detects musl at runtime as a backstop.
type Plat = { key: string; artifact: string; os: string; cpu: string; libc?: string; bin: string };
const PLATFORMS: Plat[] = [
  { key: "darwin-arm64", artifact: "deel-darwin-arm64", os: "darwin", cpu: "arm64", bin: "deel" },
  { key: "darwin-x64", artifact: "deel-darwin-x64", os: "darwin", cpu: "x64", bin: "deel" },
  { key: "linux-x64", artifact: "deel-linux-x64", os: "linux", cpu: "x64", libc: "glibc", bin: "deel" },
  { key: "linux-x64-musl", artifact: "deel-linux-x64-musl", os: "linux", cpu: "x64", libc: "musl", bin: "deel" },
  { key: "linux-arm64", artifact: "deel-linux-arm64", os: "linux", cpu: "arm64", libc: "glibc", bin: "deel" },
  { key: "linux-arm64-musl", artifact: "deel-linux-arm64-musl", os: "linux", cpu: "arm64", libc: "musl", bin: "deel" },
  { key: "win32-x64", artifact: "deel-windows-x64.exe", os: "win32", cpu: "x64", bin: "deel.exe" },
];

const common = {
  version: VERSION,
  license: rootPkg.license,
  author: rootPkg.author,
  homepage: rootPkg.homepage,
  repository: rootPkg.repository,
  bugs: rootPkg.bugs,
  publishConfig: { registry: "https://registry.npmjs.org/", access: "public" },
};

function writePkg(dir: string, pkg: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
}

// npm always includes README/LICENSE in the tarball regardless of `files`, so
// just drop them into each package dir.
const LICENSE_SRC = join(ROOT, "LICENSE");
const README_SRC = join(ROOT, "README.md");
function copyIfExists(src: string, dst: string): void {
  if (existsSync(src)) cpSync(src, dst);
}

// Fresh output dir.
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// --- Platform packages ---------------------------------------------------
const optionalDependencies: Record<string, string> = {};
for (const p of PLATFORMS) {
  const src = join(DIST, p.artifact);
  if (!existsSync(src)) {
    throw new Error(`Missing built binary ${src}. Run \`bash scripts/build-all.sh\` first.`);
  }
  const pkgName = `${NAME}-${p.key}`;
  const dir = join(OUT, `cli-${p.key}`);
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  cpSync(src, join(binDir, p.bin));
  if (p.os !== "win32") chmodSync(join(binDir, p.bin), 0o755);

  const platformPkg: Record<string, unknown> = {
    name: pkgName,
    description: `${NAME} binary for ${p.key}`,
    ...common,
    os: [p.os],
    cpu: [p.cpu],
    files: ["bin/"],
  };
  if (p.libc) platformPkg.libc = [p.libc];
  writePkg(dir, platformPkg);
  copyIfExists(LICENSE_SRC, join(dir, "LICENSE"));
  optionalDependencies[pkgName] = VERSION;
}

// --- Launcher package ----------------------------------------------------
const launcherDir = join(OUT, "cli");
const launcherBinDir = join(launcherDir, "bin");
mkdirSync(launcherBinDir, { recursive: true });

const launcher = `#!/usr/bin/env node
// Launcher for ${NAME}: resolves the platform-specific binary installed as an
// optionalDependency and execs it, passing through args, stdio and exit code.
"use strict";
const { execFileSync } = require("node:child_process");

const PKG_BY_KEY = {
${PLATFORMS.map((p) => `  "${p.key}": { pkg: "${NAME}-${p.key}", bin: "${p.bin}" },`).join("\n")}
};

// Alpine/musl Linux can't run glibc binaries — pick the musl variant there.
// glibc Node exposes glibcVersionRuntime in its process report; musl does not.
function isMuslLinux() {
  if (process.platform !== "linux") return false;
  try {
    const report = typeof process.report?.getReport === "function" ? process.report.getReport() : null;
    if (report && report.header && report.header.glibcVersionRuntime) return false;
  } catch {}
  return true;
}

let key = process.platform + "-" + process.arch;
if (isMuslLinux()) key += "-musl";
const entry = PKG_BY_KEY[key];
if (!entry) {
  console.error("deel: unsupported platform " + key);
  process.exit(1);
}

let binPath;
try {
  binPath = require.resolve(entry.pkg + "/bin/" + entry.bin);
} catch {
  console.error(
    "deel: the platform package " + entry.pkg + " is not installed.\\n" +
      "If you installed with --no-optional / --omit=optional, reinstall without it."
  );
  process.exit(1);
}

try {
  execFileSync(binPath, process.argv.slice(2), { stdio: "inherit" });
} catch (err) {
  process.exit(typeof err.status === "number" ? err.status : 1);
}
`;
writeFileSync(join(launcherBinDir, "deel"), launcher);
chmodSync(join(launcherBinDir, "deel"), 0o755);

writePkg(launcherDir, {
  name: NAME,
  description: rootPkg.description,
  ...common,
  bin: { deel: "bin/deel" },
  keywords: rootPkg.keywords,
  optionalDependencies,
  files: ["bin/"],
});
copyIfExists(LICENSE_SRC, join(launcherDir, "LICENSE"));
copyIfExists(README_SRC, join(launcherDir, "README.md"));

console.log(`Assembled ${PLATFORMS.length + 1} packages in ${OUT} at version ${VERSION}:`);
console.log(`  ${NAME}`);
for (const p of PLATFORMS) console.log(`  ${NAME}-${p.key}`);
