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
  once it has a name (see [Naming generated commands](#naming-generated-commands)). The generator never
  touches the hand-picked files; it only reserves their names, and a released name never changes.
  Tests use the made-up endpoints in `test/fixtures/definitions/`.

## Naming generated commands

Each entry in `src/public-api/commands.json` names one endpoint:
`{ "method": "GET", "path": "/contracts/{contract_id}", "command": "deel contracts get <contract>" }`.
`npm run check:command-map` checks the map against these rules, and the generator checks that every
argument fills a parameter.

- **R1 One grammar.** `deel <domain> <resources…> <verb> <arguments> [flags]`, lowercase kebab-case,
  resources from parent to child, exactly one verb.
- **R2 Five core verbs.** `list` `get` `create` `update` `delete`. The HTTP method sets the verb; an
  entry may override it only with one of five named cases (`case` in the entry): `read` (a POST that only
  reads: `get`/`list`), `removal` (a POST that removes: `delete`), `overwrite` (a POST that replaces a
  record or setting: `update`), `state` (a change to the record's own state: `update --status <value>`),
  `action` (an action that leaves a record: noun + `create`). Choose in that order: a core case, then a
  registry trigger (R3), then noun + `create`.
- **R3 Registry verbs.** A few verbs beyond the five, each with a scope and the last path segments that
  select it: `sign` (…/sign, …/signatures), `accept` (…/accept, …/acknowledge), `cancel`, `send`
  (…/invitations, …/email-draft-sends; ats, contracts), `approve` (immigration, it), `reject` (…/reject,
  …/decline; contracts, it), `test` (…/simulate; webhooks), `assign`, `unassign` (it). A verb an R2 case
  already covers is never registered.
- **R4 list vs get.** `list` returns a collection and ends on a plural noun; `get` returns one record or a
  singleton.
- **R5 Plural resources.** Every resource word is plural, except things that exist once per parent
  (`location`, `holder`, `preview`, …); new singletons are added to the checker's list.
- **R6 Deel's own names.** Use the product's names (`custom-fields`, `form-definition`), not the path's
  when they differ.
- **R7 Arguments and scopes.** Every path ID is an argument, in path order (`<contract>`), or a scope
  flag (`--contract <contract>`) when it narrows a collection that also exists unscoped.
- **R8 Variant flags.** `--worker-type <eor|gp|daas|contractor|employee>` (taken from the path only:
  `/eor/…`, `/gp/…`, `/payouts/contractors/…`, an `ic` segment), `--as worker` for worker-login
  endpoints, `--file-format pdf|csv`, `--bulk`. When several endpoints share the words the flag is
  required and the bare command calls the endpoint whose path names no type; when only one does it is
  optional (`[--worker-type eor]`). A variant flag never takes a global flag's name (`--raw`, `--json`,
  `--fields`, …).
- **R9 Unique.** Words, flags and flag values are unique together. Two entries may share a command line
  only when they are the same operation and both carry the same `collapse` key; the first is called.
- **R10 Files.** Upload is `create`, download is `get`, a rendered form is `get --file-format pdf`.
- **R11 Adding an endpoint.** Pick the domain, name the resource (R5, R6), choose the verb (R2–R4), add
  arguments (R7) and variants (R8), check R9 with `npm run check:command-map`. When two rules disagree,
  ask in the PR rather than inventing a verb.

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
