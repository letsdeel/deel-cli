import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathWith, stubDir, tempDir } from "./stubs.ts";

const INSTALL = new URL("../packaging/install.sh", import.meta.url).pathname;
const FAKE_BINARY = "#!/bin/sh\necho fake deel\n";

/** Runs install.sh with stub uname/curl/codesign; `verifyExit` is what `codesign --verify` returns. */
function install(t: Parameters<typeof tempDir>[0], os: "Darwin" | "Linux", verifyExit: number, resignExit = 0) {
  const work = tempDir(t);
  const sums = `${createHash("sha256").update(FAKE_BINARY).digest("hex")}  deel-${os.toLowerCase()}-arm64\n`;
  const stubs = stubDir(t, {
    uname: `case "$1" in -s) echo ${os} ;; -m) echo arm64 ;; esac`,
    curl: `out=""; url=""; while [ "$#" -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; http*) url="$1" ;; esac; shift; done
case "$url" in */SHA256SUMS) printf '%s' '${sums}' > "$out" ;; *) printf '%s' '${FAKE_BINARY}' > "$out" ;; esac`,
    codesign: `echo "$@" >> "${work}/codesign.log"
case "$1" in --verify) exit ${verifyExit} ;; --force) exit ${resignExit} ;; esac`,
  });
  const result = spawnSync("sh", [INSTALL], {
    env: { PATH: pathWith(stubs), HOME: work, DEEL_INSTALL_DIR: join(work, "bin"), DEEL_VERSION: "v9.9.9" },
    encoding: "utf8",
  });
  const log = existsSync(join(work, "codesign.log")) ? readFileSync(join(work, "codesign.log"), "utf8") : "";
  return { result, log, bin: join(work, "bin", "deel") };
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
