import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { signedBinary } from "./macho-fixture.ts";
import { pathWith, stubDir, tempDir } from "./stubs.ts";

const SCRIPT = new URL("../scripts/sign-darwin.sh", import.meta.url).pathname;

// `uname` stub: always Linux, so the rcodesign branch and the node-only verification run everywhere.
const UNAME_LINUX = `[ "$1" = "-s" ] && echo Linux || echo x86_64`;

function run(args: string[], opts: { cwd?: string; stubs: string }) {
  return spawnSync("bash", [SCRIPT, ...args], {
    cwd: opts.cwd,
    env: { PATH: pathWith(opts.stubs), HOME: opts.cwd ?? "/" },
    encoding: "utf8",
  });
}

test("signs with rcodesign before verifying: a bad file that rcodesign repairs passes", (t) => {
  const dir = tempDir(t);
  const good = join(dir, "good");
  writeFileSync(good, signedBinary());
  const tampered = join(dir, "deel-darwin-arm64");
  const tamperedBytes = signedBinary();
  tamperedBytes[5000] ^= 0xff; // a hashed page no longer matches
  writeFileSync(tampered, tamperedBytes);
  // stub rcodesign "re-signs" by restoring the valid file and records that it ran
  const stubs = stubDir(t, {
    uname: UNAME_LINUX,
    rcodesign: `echo "$@" >> "${dir}/rcodesign.log"; cp "${good}" "$2"`,
  });
  // rcodesign is called as `rcodesign sign <file>`
  const result = run([tampered], { stubs });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(join(dir, "rcodesign.log"), "utf8"), /^sign .*deel-darwin-arm64/);
  assert.match(result.stderr, /deel-darwin-arm64: OK/);
});

test("fails with a clear message when rcodesign is missing on Linux", (t) => {
  const dir = tempDir(t);
  const file = join(dir, "deel-darwin-arm64");
  writeFileSync(file, signedBinary());
  const result = run([file], { stubs: stubDir(t, { uname: UNAME_LINUX }) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /rcodesign not found/);
});

test("fails when the signature still does not verify after signing", (t) => {
  const dir = tempDir(t);
  const file = join(dir, "deel-darwin-arm64");
  const broken = signedBinary();
  broken[5000] ^= 0xff;
  writeFileSync(file, broken);
  const stubs = stubDir(t, { uname: UNAME_LINUX, rcodesign: "exit 0" }); // signing "succeeds" but fixes nothing
  const result = run([file], { stubs });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /page hashes do not match/);
});

test("--verify-only never signs and fails on a tampered file", (t) => {
  const dir = tempDir(t);
  const good = join(dir, "deel-darwin-arm64");
  const bad = join(dir, "deel-darwin-x64");
  writeFileSync(good, signedBinary());
  const tampered = signedBinary({ arch: "x86_64", trailing: 16 });
  writeFileSync(bad, tampered);
  const stubs = stubDir(t, { uname: UNAME_LINUX, rcodesign: `echo called >> "${dir}/rcodesign.log"` });

  assert.equal(run(["--verify-only", good], { stubs }).status, 0);
  const result = run(["--verify-only", good, bad], { stubs });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /deel-darwin-x64: 16 bytes follow the code signature/);
  assert.throws(() => readFileSync(join(dir, "rcodesign.log")), /ENOENT/, "verify-only must not call rcodesign");
});

test("resolves relative paths against the caller's directory, not the repo root", (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, "deel-darwin-arm64"), signedBinary());
  const result = run(["--verify-only", "deel-darwin-arm64"], { cwd: dir, stubs: stubDir(t, { uname: UNAME_LINUX }) });
  assert.equal(result.status, 0, result.stderr);
});

test("--arch asserts the CPU type", (t) => {
  const dir = tempDir(t);
  const file = join(dir, "deel");
  writeFileSync(file, signedBinary({ arch: "x86_64" }));
  const stubs = stubDir(t, { uname: UNAME_LINUX });
  assert.equal(run(["--arch", "x86_64", "--verify-only", file], { stubs }).status, 0);
  const result = run(["--arch", "arm64", "--verify-only", file], { stubs });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /expected arm64/);
});

test("usage errors exit 2", (t) => {
  const stubs = stubDir(t, { uname: UNAME_LINUX });
  assert.equal(run([], { stubs }).status, 2);
  assert.equal(run(["--nope", "x"], { stubs }).status, 2);
  assert.equal(run(["--arch"], { stubs }).status, 2);
});
