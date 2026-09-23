# Contributing to the Deel CLI

Thanks for helping. This page is the contract between contributors and the `dev` branch — `dev` is
the release line: whatever merges there ships in the next release cut by the Deel Public API team.

## Set up

```bash
git clone https://github.com/letsdeel/deel-cli.git && cd deel-cli
npm ci                      # Node 22.18+; also installs the git hooks (husky)
node src/main.ts --help     # run from source — no build step
```

## Before you open a PR

```bash
npm run check               # what CI runs: typecheck, tests + coverage gate, manifest / lockfile / version / shell checks
npm run build:smoke         # compile the host binary and make sure it starts
npm run doctor              # both of the above, then clears the pre-commit gate (see "Git hooks")
```

Each piece on its own:

| Command | What it guards |
|---------|----------------|
| `npm run typecheck` | `tsc --noEmit`, strict |
| `npm test` | the `node --test` suite in `test/` |
| `npm run test:coverage` | same suite with a coverage floor over `src/**` — lines ≥ 80 %, branches ≥ 75 %, functions ≥ 70 %. The floor only ever moves up. |
| `npm run check:manifest` | `src/manifest.generated.ts` ↔ `src/commands.map.ts` stay consistent |
| `npm run check:lockfile` | `package-lock.json` still carries every bun platform binary (an `npm install` against an existing `node_modules` can silently drop them) |
| `npm run check:version` | `package.json` and `src/version.ts` agree and are a clean `X.Y.Z` |
| `npm run check:shell` | `packaging/install.sh` (POSIX sh — users pipe it into `sh`), build scripts and hooks pass `sh -n`/`bash -n` and shellcheck |

## Git hooks

`npm ci` installs two hooks via husky. They exist so `dev` only ever receives verified code:

- **pre-commit** — refuses to commit on `dev` without an explicit confirmation; blocks the commit
  while any file that differs from `origin/dev` hasn't been verified since it last changed (the
  *doctor gate*, `scripts/check-doctor.ts`); runs the cheap lockfile and version checks.
  Clear the gate with `npm run doctor` — it runs the full check suite and the build smoke and then
  records the verified hashes in `scripts/doctor-hashes.json` (commit that file with your change).
- **pre-push** — same `dev` confirmation, then `npm run check` (skipped for Markdown-only pushes).
  `SKIP_PUSH_VERIFY=1 git push` bypasses it when you know why.

Please don't `--no-verify` your way past them; if a hook blocks you, it is telling you what CI will
say a minute later.

## Layout and tests

- `src/core/<concern>.ts` and `src/commands/<name>.ts` are flat — one file per concern, no
  sub-directories. Only the entry point, routing, help, version, types, the command map and the
  generated manifest live directly under `src/`.
- Tests live in `test/<name>.test.ts`, named after the module they cover. Behaviour changes come with
  a test; type-only, constants and generated files don't need one.
- `src/manifest.generated.ts` is **never hand-edited**. It is produced by the `deel-cli-extractor`
  skill from the OpenAPI spec (Deel-internal). To expose a new endpoint, add it to
  `src/commands.map.ts` and regenerate; a PR that changes the manifest carries the `script-generated`
  label.

## Pull requests

- Base branch: `dev`. Use a short, descriptive feature-branch name.
- Fill in the template — CI (`validate-pr`) checks for a real `## Description`, a `**How I Tested:**`
  entry, and one type label: `bug`, `enhancement`, `refactor`, `documentation`, `chore`. `bug` and
  `enhancement` PRs must include a test file.
- Link the relevant issue in the PR body when there is one. The label rule doesn't block fork PRs;
  a maintainer fills it in during triage.
- Keep everything public-safe: no internal hostnames, customer data, credentials or tokens in code,
  fixtures, logs, commit messages or PR text. Security issues go to the address in
  [SECURITY.md](SECURITY.md), not to an issue.

## CI

`.github/workflows/pr.yaml` runs on every PR and on every push to `dev`:

| Job | Runs |
|-----|------|
| `validate-pr` | `scripts/check-pr.ts` against the PR title, body, labels and changed files |
| `check` | `npm run check`, one step per script so the failure names itself |
| `build-smoke` | `npm run build`, then `dist/deel --version` must equal the package version and `--help` must render |

The workflow uses only public, SHA-pinned actions and picks its runner from the repository's
visibility, so fork PRs never execute on Deel infrastructure. Releases are cut manually by
maintainers from a separate, private pipeline; there is nothing to do in this repo to release.
