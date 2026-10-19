import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathWith, stubDir, tempDir } from "./stubs.ts";

const INSTALL = new URL("../packaging/install.sh", import.meta.url).pathname;
const FAKE_BINARY = "#!/bin/sh\necho fake deel\n";

interface InstallOptions {
  /** Contents of the "downloaded" binary (default: one that prints a line and exits 0). */
  binary?: string;
  /** Directories to put on PATH before everything else. */
  pathFirst?: string[];
  /** Put the install directory first on PATH. */
  installDirFirst?: boolean;
}

/** Runs install.sh with stub uname/curl/codesign; `verifyExit` is what `codesign --verify` returns. */
function install(
  t: Parameters<typeof tempDir>[0],
  os: "Darwin" | "Linux",
  verifyExit: number,
  resignExit = 0,
  opts: InstallOptions = {},
) {
  const work = tempDir(t);
  const binary = opts.binary ?? FAKE_BINARY;
  const sums = `${createHash("sha256").update(binary).digest("hex")}  deel-${os.toLowerCase()}-arm64\n`;
  const stubs = stubDir(t, {
    uname: `case "$1" in -s) echo ${os} ;; -m) echo arm64 ;; esac`,
    curl: `out=""; url=""; while [ "$#" -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; http*) url="$1" ;; esac; shift; done
case "$url" in */SHA256SUMS) printf '%s' '${sums}' > "$out" ;; *) printf '%s' '${binary}' > "$out" ;; esac`,
    codesign: `echo "$@" >> "${work}/codesign.log"
case "$1" in --verify) exit ${verifyExit} ;; --force) exit ${resignExit} ;; esac`,
  });
  const result = spawnSync("sh", [INSTALL], {
    env: {
      PATH: [...(opts.installDirFirst ? [join(work, "bin")] : []), ...(opts.pathFirst ?? []), pathWith(stubs)].join(":"),
      HOME: work, DEEL_INSTALL_DIR: join(work, "bin"),
      DEEL_VERSION: "v9.9.9",
    },
    encoding: "utf8",
  });
  const log = existsSync(join(work, "codesign.log")) ? readFileSync(join(work, "codesign.log"), "utf8") : "";
  return { result, log, bin: join(work, "bin", "deel"), work };
}

test("macOS: re-signs ad hoc when the installed binary's signature does not verify", (t) => {
  const { result, log, bin } = install(t, "Darwin", 1);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /embedded code signature is invalid/);
  assert.match(log, new RegExp(`--force --sign - ${bin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("macOS: leaves a binary alone when its signature verifies", (t) => {
  const { result, log } = install(t, "Darwin", 0);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(log, /--force/);
});

test("macOS: fails the install, with a manual command, when re-signing fails", (t) => {
  const { result } = install(t, "Darwin", 1, 1);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /could not re-sign .*codesign --force --sign -/);
});

test("Linux: never calls codesign", (t) => {
  const { result, log } = install(t, "Linux", 1);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(log, "");
});

test("fails with the signal when the installed binary is killed", (t) => {
  const { result } = install(t, "Linux", 0, 0, { binary: "#!/bin/sh\nkill -9 $$\n" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /the installed binary did not run: terminated by signal 9/);
});

test("fails with the exit code and output when the installed binary exits non-zero", (t) => {
  const { result } = install(t, "Linux", 0, 0, { binary: "#!/bin/sh\necho boom >&2\nexit 3\n" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /the installed binary did not run: exit 3: boom/);
});

test("warns, but still succeeds, when another deel is first on PATH", (t) => {
  const other = stubDir(t, { deel: 'echo "deel 0.1.1-beta.6"' });
  const { result } = install(t, "Linux", 0, 0, { pathFirst: [other] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /another deel is first on your PATH and will run instead/);
  assert.ok(result.stderr.includes(`${other}/deel (deel 0.1.1-beta.6)`), result.stderr);
  assert.match(result.stderr, /remove it, or put .* earlier on your PATH/);
  assert.match(result.stderr, /hash -r/);
  assert.doesNotMatch(result.stderr, /npm uninstall/);
});

test("recognises an npm install as the shadowing copy and says how to remove it", (t) => {
  const prefix = tempDir(t);
  const launcher = join(prefix, "lib", "node_modules", "@deel-org", "cli", "bin", "deel");
  mkdirSync(join(prefix, "lib", "node_modules", "@deel-org", "cli", "bin"), { recursive: true });
  mkdirSync(join(prefix, "bin"), { recursive: true });
  writeFileSync(launcher, '#!/bin/sh\necho "deel 0.2.0"\n');
  chmodSync(launcher, 0o755);
  symlinkSync("../lib/node_modules/@deel-org/cli/bin/deel", join(prefix, "bin", "deel"));
  const { result } = install(t, "Linux", 0, 0, { pathFirst: [join(prefix, "bin")] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /it looks like an npm install; remove it with: npm uninstall -g @deel-org\/cli/);
});

test("reports a shadowing deel that does not run", (t) => {
  const broken = stubDir(t, { deel: "exit 5" });
  const { result } = install(t, "Linux", 0, 0, { pathFirst: [broken] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /did not run \(exit 5\)/);
});

test("stays quiet when the installed copy is the first deel on PATH, even with another behind it", (t) => {
  const behind = stubDir(t, { deel: 'echo "deel 0.1.1-beta.6"' });
  const { result } = install(t, "Linux", 0, 0, { installDirFirst: true, pathFirst: [behind] });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /another deel/);
});

test("stays quiet when there is no other deel", (t) => {
  const { result } = install(t, "Linux", 0);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /another deel/);
});

test("still reports a shadowing deel when the installed binary does not run, with the failure last", (t) => {
  const other = stubDir(t, { deel: 'echo "deel 0.1.1-beta.6"' });
  const { result } = install(t, "Linux", 0, 0, { binary: "#!/bin/sh\nkill -9 $$\n", pathFirst: [other] });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /another deel is first on your PATH and will run instead/);
  assert.ok(result.stderr.includes(`${other}/deel (deel 0.1.1-beta.6)`), result.stderr);
  const lines = result.stderr.trim().split("\n");
  assert.match(lines[lines.length - 1], /the installed binary did not run: terminated by signal 9/);
});

test("does not claim success when the installed binary does not run", (t) => {
  const { result } = install(t, "Linux", 0, 0, { binary: "#!/bin/sh\nexit 4\n" });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /installed to/);
});
