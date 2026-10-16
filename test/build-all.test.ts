import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { signedBinary } from "./macho-fixture.ts";
import { pathWith, stubDir, tempDir } from "./stubs.ts";

const SCRIPT = new URL("../scripts/build-all.sh", import.meta.url).pathname;
const sha256 = (buf: Buffer | string) => createHash("sha256").update(buf).digest("hex");

/**
 * Runs build-all.sh against stub tools: `bun` writes a darwin binary with a bad signature (or a
 * placeholder for other targets), and `rcodesign` replaces a darwin file with a properly signed one.
 * `uname` pins the Linux branch.
 */
function setup(t: Parameters<typeof tempDir>[0], { withRcodesign = true } = {}) {
  const work = tempDir(t);
  const good = { arm64: signedBinary({ arch: "arm64" }), x64: signedBinary({ arch: "x86_64", seed: 7 }) };
  writeFileSync(join(work, "good-arm64"), good.arm64);
  writeFileSync(join(work, "good-x64"), good.x64);
  const tampered = signedBinary();
  tampered[5000] ^= 0xff;
  writeFileSync(join(work, "tampered"), tampered);
  const stubs = stubDir(t, {
    uname: `[ "$1" = "-s" ] && echo Linux || echo x86_64`,
    bun: `out=""; while [ "$#" -gt 0 ]; do [ "$1" = "--outfile" ] && out="$2"; shift; done
echo "$out" >> "${work}/bun.log"
case "$out" in *deel-darwin-*) cp "${work}/tampered" "$out" ;; *) echo "placeholder for $out" > "$out" ;; esac`,
    // network is never reachable from the tests: a download attempt is logged and fails
    curl: `echo "$@" >> "${work}/curl.log"; exit 22`,
    ...(withRcodesign
      ? {
          rcodesign: `echo "$2" >> "${work}/rcodesign.log"
case "$2" in *arm64) cp "${work}/good-arm64" "$2" ;; *) cp "${work}/good-x64" "$2" ;; esac`,
        }
      : {}),
  });
  const dist = join(work, "dist");
  const run = (args: string[]) =>
    spawnSync("bash", [SCRIPT, ...args], {
      env: { PATH: pathWith(stubs), HOME: work, BUN: join(stubs, "bun"), DIST_DIR: dist },
      encoding: "utf8",
    });
  return { work, dist, good, run };
}

test("--only darwin signs both macOS binaries before SHA256SUMS is written", (t) => {
  const { work, dist, good, run } = setup(t);
  const result = run(["--only", "darwin"]);
  assert.equal(result.status, 0, result.stderr + result.stdout);

  assert.equal(readFileSync(join(work, "bun.log"), "utf8").trim().split("\n").length, 2);
  assert.equal(readFileSync(join(work, "rcodesign.log"), "utf8").trim().split("\n").length, 2);
  // The checksums describe the signed bytes, not the compiler output.
  const sums = readFileSync(join(dist, "SHA256SUMS"), "utf8");
  assert.match(sums, new RegExp(`${sha256(good.arm64)}  deel-darwin-arm64`));
  assert.match(sums, new RegExp(`${sha256(good.x64)}  deel-darwin-x64`));
  assert.match(result.stderr, /deel-darwin-arm64: OK/);
  assert.match(result.stderr, /deel-darwin-x64: OK/);
});

test("the full matrix builds every target and signs only the macOS ones", (t) => {
  const { work, dist, run } = setup(t);
  const result = run([]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(readFileSync(join(work, "bun.log"), "utf8").trim().split("\n").length, 7);
  assert.equal(readFileSync(join(work, "rcodesign.log"), "utf8").trim().split("\n").length, 2);
  assert.equal(readFileSync(join(dist, "SHA256SUMS"), "utf8").trim().split("\n").length, 7);
});

test("--only linux builds without touching the macOS signing step", (t) => {
  const { work, dist, run } = setup(t);
  const result = run(["--only", "linux"]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(existsSync(join(work, "rcodesign.log")), false);
  assert.doesNotMatch(readFileSync(join(dist, "SHA256SUMS"), "utf8"), /darwin/);
});

test("rejects unknown arguments and a mistyped --only before building anything", (t) => {
  const { work, run } = setup(t);
  for (const args of [["--only", "darwn"], ["--only"], ["--bogus"], ["darwin"]]) {
    const result = run(args);
    assert.equal(result.status, 2, `${args.join(" ")}: ${result.stderr}`);
  }
  assert.equal(existsSync(join(work, "bun.log")), false, "nothing may be compiled for a bad invocation");
});

test("fails the build when a macOS binary still does not verify after signing", (t) => {
  const { work, dist, run } = setup(t);
  // rcodesign "succeeds" without repairing anything
  writeFileSync(join(work, "no-op-rcodesign"), "");
  const stubsBroken = stubDir(t, {
    uname: `[ "$1" = "-s" ] && echo Linux || echo x86_64`,
    bun: `out=""; while [ "$#" -gt 0 ]; do [ "$1" = "--outfile" ] && out="$2"; shift; done; cp "${work}/tampered" "$out"`,
    rcodesign: "exit 0",
  });
  const result = spawnSync("bash", [SCRIPT, "--only", "darwin"], {
    env: { PATH: pathWith(stubsBroken), HOME: work, BUN: join(stubsBroken, "bun"), DIST_DIR: dist },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /page hashes do not match/);
  assert.equal(existsSync(join(dist, "SHA256SUMS")), false, "no checksums may be written for an unverified binary");
});

test("downloads the pinned rcodesign when it is missing on Linux", (t) => {
  const { work, dist, run } = setup(t, { withRcodesign: false });
  const result = run(["--only", "darwin"]);
  assert.notEqual(result.status, 0, "the stubbed download fails, so the build must fail");
  const request = readFileSync(join(work, "curl.log"), "utf8");
  assert.match(request, /--proto =https --tlsv1\.2/);
  assert.match(request, /apple-platform-rs\/releases\/download\/apple-codesign\/0\.29\.0\/apple-codesign-0\.29\.0-x86_64-unknown-linux-musl\.tar\.gz/);
  assert.equal(existsSync(join(dist, "SHA256SUMS")), false, "no checksums for unsigned binaries");
});

test("does not download anything when rcodesign is already installed", (t) => {
  const { work, run } = setup(t);
  assert.equal(run(["--only", "darwin"]).status, 0);
  assert.equal(existsSync(join(work, "curl.log")), false);
});
