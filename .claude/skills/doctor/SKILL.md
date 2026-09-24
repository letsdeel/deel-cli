---
name: doctor
description: >
  Clears the pre-commit doctor gate for the current branch. Audits every pending file (vs
  origin/dev) for correct placement in this repo's layout (flat src/core, src/commands, test/) and
  for test coverage on new/changed implementation, then runs the full local health check —
  `npm run check` (typecheck, tests with the coverage gate, manifest/lockfile/version/shell checks)
  plus the bun build smoke. Only if the audit finds no violations and health is green does it
  re-hash the pending files into scripts/doctor-hashes.json so the pre-commit hook stops blocking;
  a violation or a red check stops the run and leaves the gate red. When it clears the gate, asks
  whether to continue on to /ship.
  Triggers on "/doctor", "run doctor", "clear the doctor gate", "why is my commit blocked", or when
  a commit fails with a "doctor: N file(s) changed since they were last verified" message.
---

# doctor

Verifies the branch is healthy and clears the pre-commit guard (`scripts/check-doctor.ts`, wired
into `.husky/pre-commit`) that blocks commits once files have drifted from what was last verified.
Does not open a PR or touch Slack — that's [[ship]]'s job.

Humans without Claude clear the same gate with `npm run doctor` (check + build smoke + `--mark`).
This skill adds the reasoning steps a script can't do: placement and "is this change actually
tested". Rules live in `structure.md` — read it before Step 2.

## Step 1 — See what's pending

```bash
node scripts/check-doctor.ts
```

Parse the JSON on stdout:

- `{"status":"skipped","reason":"protected branch"}` — you're on `dev`. The guard doesn't apply;
  `dev` is the release line and nothing should be committed there directly anyway. Tell the user and
  stop.
- `{"status":"clean"}` — nothing has drifted since the last mark. Skip to Step 5 (still worth
  offering to ship if there's a real diff vs `origin/dev`).
- `{"status":"pending","files":[...],"remaining":N}` — the normal case after new commits/edits.
  Continue to Step 2.
- `{"status":"error","reason":"no merge-base with dev"}` — `git fetch origin dev` and re-run.

If the pending set is empty and there's no diff at all against `origin/dev`, say there's nothing to
ship and stop.

## Step 2 — Audit placement and test coverage

A reasoning step, not a script. Read `structure.md` and apply it file by file.

1. Change type for every pending file, against `origin/dev` (a local `dev` can silently sit behind
   origin and give the wrong diff):
   ```bash
   git fetch origin dev --quiet
   git diff --name-status $(git merge-base origin/dev HEAD)
   git status --porcelain   # untracked (??) files aren't in the diff but still need a judgment
   ```
2. **Placement** — every `A` (added) file against `structure.md` §1. Modified files aren't
   re-litigated; they already had a home.
3. **Test coverage** — every added or modified file that §2 calls implementation must be covered per
   §3: a matching `test/<name>.test.ts` is pending too, or an existing one demonstrably exercises the
   changed path (open it and look).
4. **Generated manifest** — if `src/manifest.generated.ts` is pending, confirm the banner still reads
   `// GENERATED FILE — DO NOT EDIT. Produced by the deel-cli-extractor skill …` and that the diff
   looks like extractor output (fully expanded JSON). A hand edit is a violation; point at the
   `deel-cli-extractor` skill.
5. **Version bump** — if `package.json` `version` is pending, `src/version.ts` must be pending too
   (`npm run check:version` will enforce it in Step 3; say so up front).

If **any** violation was found: report each one plainly (file, rule, what's missing) and **stop**.
Do not run Step 3 or 4 — the gate stays red until the developer fixes it and re-runs `/doctor`.
"I'll add tests later" is exactly the case this gate exists for.

## Step 3 — Run the health check

```bash
npm run check          # typecheck → tests + coverage gate → manifest → lockfile → version → shell
npm run build:smoke    # bun --compile the host binary, then `dist/deel --version` and `--help`
```

About 10 s total. If either fails, report the failing step with its output and **stop**. Do **not**
mark. Typical causes and fixes:
- coverage gate: the table names the file — add cases to its `test/<name>.test.ts`; never lower the
  thresholds;
- `check:manifest`: a `commands.map.ts` entry without a regenerated manifest (or vice versa) — run the
  `deel-cli-extractor` skill;
- `check:lockfile`: `npm install` against an existing `node_modules` pruned other platforms' bun
  binaries — `rm -rf node_modules package-lock.json && npm install`;
- `check:version`: bump `package.json` and `src/version.ts` together, clean `X.Y.Z` only;
- `check:shell`: `packaging/install.sh` must stay POSIX sh.

## Step 4 — Mark the hashes clean

Only reached if Steps 2 and 3 passed:

```bash
node scripts/check-doctor.ts --mark
git add scripts/doctor-hashes.json
```

The `git add` matters: the ledger is read from disk by the hook, but it has to land in the commit so
the verified baseline travels with the branch.

Report: `✓ doctor clear — N file(s) re-hashed (placement ✓, tests ✓, check + build smoke green)`.

### If `doctor-hashes.json` conflicts on a merge

`--mark` appends/updates entries rather than replacing the file, so branches touching different files
normally auto-merge; adjacent-line entries can still conflict. Keep **both** sides' lines (or take
either side and re-run `--mark` — it rebuilds your diff's entries on top of whatever survived), then
confirm `{"status":"clean"}`. Never hand-edit hashes. `node scripts/check-doctor.ts --seed` rebuilds a
truncated ledger without ever marking in-progress work.

## Step 5 — Offer to ship

Ask via `AskUserQuestion`: "Checks pass and the gate is clear. Run `/ship` now to open/update the
PR?" Options: **Run /ship** / **Not yet**. On yes, invoke the `ship` skill; otherwise stop.

## Key rules

- Never mark while a placement violation, missing test, or red check is outstanding.
- Placement is judged for newly added files only.
- Test-coverage judgment means reading the test, not checking that a path exists.
- Coverage thresholds only go up (`structure.md` §4).
- Never open a PR, run a code review, or touch Slack from here — hand off to [[ship]].
- Never use `--no-verify`; if the hook blocks, that's the signal to run this skill.
