#!/usr/bin/env node
/**
 * Doctor gate — detects drift between the last verified state of a branch and the working tree.
 *
 * Every file that differs from `dev` (`git diff <merge-base> --name-only`, which covers commits
 * since the merge-base AND staged/unstaged edits, plus `git ls-files --others --exclude-standard`
 * for new files that aren't gitignored) is hashed and compared against scripts/doctor-hashes.json.
 *
 * Used by:
 *   - .husky/pre-commit, to block a commit on a branch that changed since it was last verified
 *   - `npm run doctor` / the /doctor skill, to re-hash the files once `npm run check` and the
 *     build smoke pass
 *
 * On dev/main/master there is nothing to guard — those commits go through the protected-branch
 * confirmation in .husky/scripts/confirm-protected-branch.sh instead.
 *
 * Usage:
 *   node scripts/check-doctor.ts           check mode: JSON to stdout, exit 1 while files are pending
 *   node scripts/check-doctor.ts --mark    record the current hash of every changed file into the
 *                                          ledger (append/update — never replaces the whole file)
 *   node scripts/check-doctor.ts --seed    backfill an entry for every tracked file that has none
 *                                          (never overwrites, never touches files in the current diff)
 *   node scripts/check-doctor.ts --report  like check mode, but always exits 0 — a reminder, not a gate
 *
 * Output (JSON on stdout):
 *   { "status": "skipped", "reason": "protected branch" }
 *   { "status": "error",   "reason": "no merge-base with dev" }   (e.g. shallow clone; exits 0)
 *   { "status": "clean" }
 *   { "status": "pending", "files": [...], "remaining": N }        (check mode exits 1)
 *   { "status": "marked",  "files": [...], "remaining": 0 }
 *   { "status": "seeded",  "added": N, "skipped": N }
 *
 * Ledger: scripts/doctor-hashes.json, { [repoRelativePath]: sha256 | "__deleted__" }, key-sorted so
 * entries sit on stable lines. It is cumulative: `--mark` only adds/updates the current diff's files
 * and leaves everything else alone, which is what lets git auto-merge two branches that touched
 * different files. Committed (not gitignored) so the verified baseline travels with the branch.
 *
 * DOCTOR_REPO_ROOT overrides the repository root (the test suite points it at a scratch repo).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.DOCTOR_REPO_ROOT
  ? resolve(process.env.DOCTOR_REPO_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HASH_FILE_REL = "scripts/doctor-hashes.json";
const HASH_FILE = join(ROOT, HASH_FILE_REL);
const BASE_BRANCH = "dev";
const PROTECTED_BRANCHES = new Set(["dev", "main", "master"]);

const MARK = process.argv.includes("--mark");
const REPORT = process.argv.includes("--report");
const SEED = process.argv.includes("--seed");

type Ledger = Record<string, string>;

// With DOCTOR_REPO_ROOT set, the caller means "that repository": drop any GIT_DIR / GIT_WORK_TREE /
// GIT_INDEX_FILE a surrounding git hook exported, otherwise git would silently target the hook's
// repository instead of ROOT. Without the override we are the hook's own gate and must inherit them.
const GIT_ENV: NodeJS.ProcessEnv = process.env.DOCTOR_REPO_ROOT
  ? Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")))
  : process.env;

function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: ROOT,
    env: GIT_ENV,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function currentBranch(): string {
  return git(["rev-parse", "--abbrev-ref", "HEAD"]);
}

/** Prefers origin/dev — it is only ever as stale as the last fetch, whereas a local `dev` can sit
 * behind origin for weeks and silently produce the wrong diff. Falls back to the local branch, and
 * returns null when neither resolves (shallow CI clone that never fetched dev). */
function mergeBase(): string | null {
  for (const ref of [`origin/${BASE_BRANCH}`, BASE_BRANCH]) {
    try {
      return git(["merge-base", ref, "HEAD"]);
    } catch {
      // try the next ref
    }
  }
  return null;
}

function splitLines(out: string): string[] {
  return out
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);
}

/** Every tracked file minus the ledger itself. Only used by --seed. */
function trackedFiles(): string[] {
  return splitLines(git(["ls-files"])).filter((f) => f !== HASH_FILE_REL);
}

/** Committed-since-merge-base + staged + unstaged edits to tracked files, plus untracked files that
 * aren't gitignored — `git diff` alone never lists a brand-new file until it is `git add`ed. */
function changedFiles(base: string): string[] {
  const all = new Set([
    ...splitLines(git(["diff", "--name-only", base])),
    ...splitLines(git(["ls-files", "--others", "--exclude-standard"])),
  ]);
  all.delete(HASH_FILE_REL);
  return [...all];
}

function sha256(absPath: string): string {
  return createHash("sha256").update(readFileSync(absPath)).digest("hex");
}

function loadLedger(): Ledger {
  if (!existsSync(HASH_FILE)) return {};
  try {
    return JSON.parse(readFileSync(HASH_FILE, "utf8")) as Ledger;
  } catch {
    process.stderr.write(`doctor: ${HASH_FILE_REL} is not valid JSON — treating it as empty.\n`);
    return {};
  }
}

function saveLedger(ledger: Ledger): void {
  const sorted: Ledger = {};
  for (const key of Object.keys(ledger).sort()) sorted[key] = ledger[key];
  mkdirSync(dirname(HASH_FILE), { recursive: true });
  writeFileSync(HASH_FILE, `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
}

function emit(result: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

// --seed: a dense ledger is what gives git the surrounding context to auto-merge two branches that
// each appended their own entries. Conservative on purpose — never overwrites, and skips anything in
// the current diff so in-progress work can't be recorded as verified.
if (SEED) {
  const seedBase = mergeBase();
  const pendingNow = new Set(seedBase === null ? [] : changedFiles(seedBase));
  const ledger = loadLedger();
  let added = 0;
  let skipped = 0;
  for (const file of trackedFiles()) {
    if (file in ledger) continue;
    if (pendingNow.has(file)) {
      skipped += 1;
      continue;
    }
    const abs = join(ROOT, file);
    if (!existsSync(abs)) continue;
    ledger[file] = sha256(abs);
    added += 1;
  }
  saveLedger(ledger);
  emit({ status: "seeded", added, skipped });
  process.exit(0);
}

const branch = currentBranch();
if (PROTECTED_BRANCHES.has(branch)) {
  if (!REPORT) emit({ status: "skipped", reason: "protected branch" });
  process.exit(0);
}

const base = mergeBase();
if (base === null) {
  if (!REPORT) {
    process.stderr.write("doctor: could not resolve dev or origin/dev to compute a merge-base — skipping.\n");
    emit({ status: "error", reason: "no merge-base with dev" });
  }
  process.exit(0);
}

const files = changedFiles(base);
const current: Ledger = {};
for (const file of files) {
  const abs = join(ROOT, file);
  current[file] = existsSync(abs) ? sha256(abs) : "__deleted__";
}

if (MARK) {
  // Merge into the ledger rather than replacing it: a full overwrite would shrink the file to this
  // branch's diff, and two branches off the same dev would then conflict over the same region.
  saveLedger({ ...loadLedger(), ...current });
  emit({ status: "marked", files: Object.keys(current), remaining: 0 });
  process.exit(0);
}

const stored = loadLedger();
const pending = files.filter((f) => stored[f] !== current[f]);

if (pending.length === 0) {
  if (!REPORT) emit({ status: "clean" });
  process.exit(0);
}

process.stderr.write("\n");
process.stderr.write(`doctor: ${pending.length} file(s) changed since they were last verified:\n`);
for (const f of pending) process.stderr.write(`  - ${f}\n`);
process.stderr.write("\n");
process.stderr.write("Run `npm run doctor` (typecheck + tests + coverage gate + manifest/lockfile/version/shell\n");
process.stderr.write("checks + build smoke, then clears this gate) — or the /doctor skill in Claude Code.\n");
process.stderr.write("\n");

if (REPORT) process.exit(0);

emit({ status: "pending", files: pending, remaining: pending.length });
process.exit(1);
