import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Exercises scripts/check-doctor.ts end to end against a scratch git repository, pointed at via
// DOCTOR_REPO_ROOT. Each scenario is what the pre-commit hook / `npm run doctor` sees in practice.

const SCRIPT = fileURLToPath(new URL("../scripts/check-doctor.ts", import.meta.url));
let repo: string;

// When this suite runs from a git hook (pre-push runs `npm run check`), git exports GIT_DIR (and
// friends) for the hook process. Any `git` we spawn would inherit it and operate on the REAL
// repository regardless of cwd — `git init`/`symbolic-ref`/`commit` below would then rewrite the
// developer's branch. Scrub every GIT_* variable so the scratch repo is the only thing touched.
const CLEAN_ENV: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
);

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    env: CLEAN_ENV,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function doctor(...args: string[]): { code: number; json: Record<string, unknown> | null; stderr: string } {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...CLEAN_ENV, DOCTOR_REPO_ROOT: repo },
  });
  const line = res.stdout.trim().split("\n").filter(Boolean).pop();
  return { code: res.status ?? -1, json: line ? (JSON.parse(line) as Record<string, unknown>) : null, stderr: res.stderr };
}

before(() => {
  repo = mkdtempSync(join(tmpdir(), "deel-cli-doctor-"));
  git("init", "--quiet");
  git("symbolic-ref", "HEAD", "refs/heads/dev");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Doctor Test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "a.txt"), "one\n");
  writeFileSync(join(repo, ".gitignore"), "ignored.txt\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", "init");
});

after(() => {
  rmSync(repo, { recursive: true, force: true });
});

test("on the protected dev branch the gate is skipped", () => {
  const r = doctor();
  assert.equal(r.code, 0);
  assert.deepEqual(r.json, { status: "skipped", reason: "protected branch" });
});

test("a feature branch with no diff against dev is clean", () => {
  git("checkout", "--quiet", "-b", "feature-1");
  const r = doctor();
  assert.equal(r.code, 0);
  assert.deepEqual(r.json, { status: "clean" });
});

test("--seed backfills tracked files without touching the current diff", () => {
  writeFileSync(join(repo, "a.txt"), "two\n"); // unstaged edit -> in the diff
  const r = doctor("--seed");
  assert.equal(r.code, 0);
  assert.deepEqual(r.json, { status: "seeded", added: 1, skipped: 1 }); // .gitignore seeded, a.txt skipped
  const ledger = JSON.parse(readFileSync(join(repo, "scripts/doctor-hashes.json"), "utf8"));
  assert.ok(".gitignore" in ledger);
  assert.ok(!("a.txt" in ledger));
});

test("an edited tracked file and an untracked new file are both pending (exit 1)", () => {
  writeFileSync(join(repo, "b.txt"), "new\n"); // untracked, not ignored
  writeFileSync(join(repo, "ignored.txt"), "x\n"); // untracked, gitignored -> invisible
  const r = doctor();
  assert.equal(r.code, 1);
  assert.equal(r.json?.status, "pending");
  assert.deepEqual((r.json?.files as string[]).sort(), ["a.txt", "b.txt"]);
  assert.match(r.stderr, /Run `npm run doctor`/);
});

test("--report is a reminder, not a gate", () => {
  const r = doctor("--report");
  assert.equal(r.code, 0);
  assert.equal(r.json, null);
  assert.match(r.stderr, /2 file\(s\) changed/);
});

test("--mark records the current hashes and the gate turns clean; further edits re-open it", () => {
  const marked = doctor("--mark");
  assert.equal(marked.code, 0);
  assert.equal(marked.json?.status, "marked");
  assert.deepEqual((marked.json?.files as string[]).sort(), ["a.txt", "b.txt"]);

  assert.deepEqual(doctor().json, { status: "clean" });

  // Staging/committing does not change content, so it stays clean.
  git("add", "-A");
  git("commit", "--quiet", "-m", "feat: change a, add b");
  assert.deepEqual(doctor().json, { status: "clean" });

  writeFileSync(join(repo, "b.txt"), "changed again\n");
  const reopened = doctor();
  assert.equal(reopened.code, 1);
  assert.deepEqual(reopened.json?.files, ["b.txt"]);
});

test("deleting a file that exists on dev is tracked as __deleted__ and clears once marked", () => {
  // b.txt never existed on dev, so removing it again would simply drop it from the diff. a.txt does
  // exist on dev: deleting it is a real change and must be verified like any other.
  rmSync(join(repo, "a.txt"));
  const r = doctor();
  assert.equal(r.code, 1);
  assert.deepEqual((r.json?.files as string[]).sort(), ["a.txt", "b.txt"]);
  doctor("--mark");
  const ledger = JSON.parse(readFileSync(join(repo, "scripts/doctor-hashes.json"), "utf8"));
  assert.equal(ledger["a.txt"], "__deleted__");
  assert.deepEqual(doctor().json, { status: "clean" });
  assert.ok(existsSync(join(repo, "scripts/doctor-hashes.json")));
});
