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
| `node scripts/check-macho-signature.ts <binary>...` | a macOS binary's code signature still matches its bytes — page hashes, requirements/entitlements hashes, nothing appended after the signature, expected CPU (what `codesign --verify` checks). Run by `scripts/build-all.sh` on every darwin build |

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
- `src/public-api/manifest.json` is also **never hand-edited**. It holds one command per documented
  public API endpoint, written by `npm run generate:public-api -- --from <file|url>` from the public
  definitions (`scripts/generate-public-api.ts`). Every name comes from the reviewed command map,
  `src/public-api/commands.json`: an endpoint with no entry there is a generator error, so it ships only
  once it has a name (see [The command map](#the-command-map)). The generator never
  touches the hand-picked files; it only reserves their names, and a released name never changes.
  Tests use the made-up endpoints in `test/fixtures/definitions/`.

## The command map

Each entry in `src/public-api/commands.json` names one endpoint:
`{ "method": "GET", "path": "/contracts/{contract_id}", "command": "deel contracts get <contract>" }`.
A command line is `deel <domain> <resources…> <verb>`, then one `<label>` per path ID in path order, then
any flags that pick this endpoint among those sharing the words: a scope flag with a label
(`--contract <contract>`), a fixed selector (`--worker-type eor`, `--as worker`), or an optional one in
brackets (`[--worker-type eor]`). Two more keys are allowed:

| Key | Meaning |
|-----|---------|
| `api` | `"scim"` for a SCIM endpoint; REST when absent |
| `collapse` | entries with the same key are one operation under one command line; the first is called |

`npm run check:command-map` checks that every entry makes a command the CLI can call: the line parses,
every path ID has an argument in path order, no flag takes a global flag's name, command lines and
endpoints are unique, no entry takes a hand-picked or static command's name, and a released command line
(one in `src/public-api/manifest.json`) never changes. The generator also checks that every argument fills a
parameter and that a flag that picks an endpoint isn't another endpoint's own flag. Every domain (the first word)
needs an entry in `src/public-api/domains.json` with its stage and description, for `deel --help`. Names
for new endpoints are reviewed by the maintainers; when you're unsure of one, ask in the PR.

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
| | …then cross-compiles both macOS targets (`scripts/build-all.sh --only darwin`), which signs them with `rcodesign` and fails if the signature does not verify |

The workflow uses only public, SHA-pinned actions and picks its runner from the repository's
visibility, so fork PRs never execute on Deel infrastructure. Releases are cut manually by
maintainers from a separate, private pipeline; there is nothing to do in this repo to release.
