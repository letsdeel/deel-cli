---
name: ship
description: >
  Ships the current deel-cli branch: verifies `npm run check` + build smoke pass locally,
  pre-flights the PR body with scripts/check-pr.ts (the same rules CI enforces), pushes, opens or
  updates a PR against dev with the required type label, waits for the pr workflow (validate-pr,
  check, build-smoke) to go green, then runs a low-noise self code-review before human review and
  surfaces critical findings for a fix-or-continue decision.
  Triggers on "/ship", "ship it", "ship this", "open a PR".
---

# ship

Take the current branch from "code is done" to "PR open, self-reviewed". Assumes commits already
exist (typically after [[doctor]] cleared the pre-commit gate).

Remember what merging means here: **`dev` is the release line.** The release pipeline cuts
betas and stable releases from `dev` HEAD, and the repo is public — PR titles, bodies and commit
messages are visible to the world. No internal hostnames, ticket contents, customer names or
credentials in any of them.

## Step 0 — Guard: correct branch

If on `dev`, stop and tell the user to check out a feature branch first (a short, descriptive name).
ship opens a PR *from* a feature branch *against* `dev`; it never runs on `dev` itself.

## Step 1 — Verify locally

```bash
npm run check
npm run build:smoke
```

Red → report and **stop**. Never create or update a PR from a tree that doesn't pass what CI runs.
(If [[doctor]] just ran on this exact tree, this passes again in seconds.)

## Step 2 — Compose the PR body and pre-flight it

`.github/pull_request_template.md` is the structure; `scripts/check-pr.ts` is the judge (CI runs the
same file in the `validate-pr` job). Fill every section:

```markdown
## Description
<one or two sentences: what this PR does, at a glance — what a user of the CLI would notice>

## Testing
**How I Tested:**
- <what you ran / added: `npm run check`, new cases in test/<name>.test.ts, manual run against the API>

**Evidence/Proof:**
<output, or "n/a">

## Release checklist
- [x] `npm run check` passes locally
- [x] User-facing change → README updated   (or "n/a — no user-facing change")
- [x] `src/manifest.generated.ts` untouched / regenerated with the extractor and labelled `script-generated`
- [x] No credentials, tokens or personal data anywhere in the diff or this description
- [x] Exactly one type label
```

Pick the **type label** (`bug` / `enhancement` / `refactor` / `documentation` / `chore`) from the
change; add `ai-assisted` always, and `script-generated` when `src/manifest.generated.ts` is in the
diff. Then pre-flight — this is what makes a body-format miss in CI impossible:

```bash
git diff --name-only origin/dev...HEAD > /tmp/ship-files.txt
node scripts/check-pr.ts --title "<title>" --body-file /tmp/ship-body.md \
  --labels "<type>,ai-assisted" --files /tmp/ship-files.txt
```

Fix anything it reports before moving on. The rules that bite most often: `**How I Tested:**` must be
that exact label with ≥10 characters of real text after it; a `bug`/`enhancement` PR must include a
`test/` file in the diff; a changed generated manifest needs the `script-generated` label.

## Step 3 — Push, then create or update the PR

```bash
git push -u origin <branch>
gh pr view --json url,state 2>/dev/null
```

- **Exists and open** → re-run of ship (e.g. after a fix). Reuse it; make sure the labels are still
  right (`gh pr edit --add-label ...`). Go to Step 4.
- **Doesn't exist** → create it:

  ```bash
  gh pr create --base dev --title "<title under 70 chars>" --body-file /tmp/ship-body.md \
    --label "<type>" --label "ai-assisted"
  ```

  Add `--label script-generated` when applicable. Never `--generate-notes`-style content: nothing in
  the PR should be something you wouldn't publish.

## Step 4 — Wait for CI

```bash
until gh pr checks <pr-url> --json name,state 2>/dev/null | jq -e 'all(.[]; .state != "PENDING" and .state != "IN_PROGRESS")' >/dev/null; do sleep 15; done
gh pr checks <pr-url>
```

Expect three checks from `.github/workflows/pr.yaml`: `validate-pr`, `check`, `build-smoke`.

- All passed → Step 5.
- Any failed → report which and stop. `validate-pr` red means Step 2 was skipped or the body was
  edited afterwards; `check` red names the failing npm script; `build-smoke` red means the compiled
  binary didn't start or reported a version other than `package.json`'s.
- `mergeable`/`mergeStateStatus` is about conflicts and required reviews, not CI — `BLOCKED` with all
  checks green just means a reviewer approval is outstanding.

## Step 5 — Self code-review, run directly

Tell the user: **"Self review is being conducted before we let other team members do the review."**

Call the `code-review` skill **directly** — `Skill({ skill: "code-review", args: "low <branch> vs
dev" })` — never wrapped in an extra Agent/subagent (nesting has previously ignored the effort level
and run for 25 minutes). Low effort, correctness/security/critical only. For this repo, weigh
especially: anything that could log or print a token, PII in `auth status` output, `--base-url`
downgrades, installer changes.

## Step 6 — Handle findings

- **No critical issues** → say so; ship is done.
- **Critical issues** → report plainly, then `AskUserQuestion`: "Fix now or continue without fixing?"
  - **Fix now**: apply the fix, run [[doctor]] again (the gate re-opens for the touched files), commit,
    push, back to Step 4.
  - **Continue**: proceed. The user's call — don't argue.

## Key rules

- Never open a PR against anything but `dev`.
- Never skip Step 2's pre-flight — CI would fail on the same rules anyway, and every red run on a
  public repo is public.
- Never skip CI while checks are failing.
- The self-review is a low-noise gate, not a full audit.
- Never put internal-only information in PR titles, bodies or commits — the repo is public.
