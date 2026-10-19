// Helpers for tests that run the repo's shell scripts against stub `uname`, `codesign`, `rcodesign`,
// `curl` and `bun` executables, so the Linux and macOS code paths run identically on any machine.
import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";

export function tempDir(t: TestContext, prefix = "deel-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A directory of executable `/bin/sh` stubs; `stubs` maps command name -> script body. */
export function stubDir(t: TestContext, stubs: Record<string, string>): string {
  const dir = tempDir(t, "deel-stubs-");
  for (const [name, body] of Object.entries(stubs)) {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  }
  return dir;
}

/** PATH with the stubs first, then only what the scripts need (node, sh/bash, coreutils, shasum). */
export function pathWith(stubs: string): string {
  return [stubs, dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
}

const SYSTEM_TOOLS = [
  "awk", "cat", "chmod", "cp", "cut", "dirname", "grep", "head", "ln", "ls", "mkdir", "mktemp", "mv", "readlink",
  "rm", "sed", "sha256sum", "shasum", "sort", "tail", "touch", "tr", "uname", "wc", "xargs",
];

/** PATH made only of the stubs and a short list of system tools: nothing else on the machine can be found. */
export function hermeticPath(t: TestContext, stubs: string): string {
  const tools = tempDir(t, "deel-tools-");
  for (const tool of SYSTEM_TOOLS) {
    const source = ["/usr/bin", "/bin"].map((dir) => join(dir, tool)).find((path) => existsSync(path));
    if (source) symlinkSync(source, join(tools, tool));
  }
  return [stubs, tools].join(":");
}
