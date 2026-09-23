# Structure & test-coverage rules

`/doctor` applies these rules to every pending file (files that differ from `origin/dev`, per
`scripts/check-doctor.ts`). They describe how this repo is actually laid out — keep them in sync
with the README "Project layout" section when the layout changes.

## 1. Where files belong

| Path | Role | Rule |
|------|------|------|
| `src/main.ts`, `src/cli.ts`, `src/help.ts`, `src/version.ts`, `src/types.ts`, `src/commands.map.ts`, `src/manifest.generated.ts` | entry point, routing, help rendering, version, shared types, command↔endpoint map, generated descriptors | the **only** files allowed directly under `src/`; anything else loose in `src/` is misplaced |
| `src/core/<concern>.ts` | one flat file per concern: `http`, `auth`, `keychain`, `config`, `tls`, `input`, `output`, `logging`, `jobs`, `idempotency`, `io`, `errors`, `constants`, `context`, `executor` | flat — no sub-directories; a new cross-cutting concern is a new `src/core/<name>.ts` |
| `src/commands/<name>.ts` | static (non-generated) commands: `auth`, `job`, plus `shared.ts` helpers and `index.ts` registry | flat; a new static command is `src/commands/<name>.ts` **and** a registration in `src/commands/index.ts` |
| `test/<name>.test.ts` | `node --test` suites, flat, named after the module under test (`src/core/http.ts` → `test/http.test.ts`, `src/commands/shared.ts` → `test/shared.test.ts`, `scripts/check-pr.ts` → `test/check-pr.test.ts`) | tests live **only** here — never co-located under `src/` |
| `scripts/` | repo tooling run by npm scripts / CI: `check-*.ts`, `check-shell.sh`, `check-doctor.ts`, `build-all.sh`, `pack-npm.ts`, `doctor-hashes.json` | scripts with real logic get a `test/<name>.test.ts` (see `check-pr`, `check-version`, `check-doctor`) or are exercised by `npm run check` itself |
| `packaging/install.sh` | the installer users pipe into `sh` | POSIX sh only; `npm run check:shell` enforces it |
| `.claude/skills/<skill>/` | agent skills (`deel-cli-extractor`, `doctor`, `ship`) | executable skill code (`extract.ts`) is tested from `test/` like any script |
| `.github/`, `.husky/` | CI workflow, PR template, Dependabot; git hooks | workflow changes must keep the public-repo rules in the header comment of `pr.yaml` |

Flag as **misplaced**:
- a new top-level directory (anything other than `src/`, `test/`, `scripts/`, `packaging/`, `.claude/`, `.github/`, `.husky/`);
- a new file loose in `src/` that is not in the first row above;
- a sub-directory under `src/core/` or `src/commands/`;
- a test file anywhere but `test/`;
- a hand edit to `src/manifest.generated.ts` — it must come from the `deel-cli-extractor` skill (banner intact, fully expanded JSON) and the PR must carry the `script-generated` label. A new entry in `src/commands.map.ts` without a regenerated manifest fails `npm run check:manifest`.

## 2. What counts as "implementation" (needs a test)

Needs a test when a pending file adds or changes behaviour: anything in `src/core/`, `src/commands/`,
`src/cli.ts`, `src/help.ts`, `src/main.ts`, and any `scripts/*.ts` with branching logic.

Does **not** need a dedicated test on its own: `src/types.ts` (type-only), `src/constants.ts` and
`src/version.ts` (plain values), `src/manifest.generated.ts` and `src/commands.map.ts` (data,
validated by `check:manifest`), Markdown, `.github/`, `.husky/`, `package.json`, `package-lock.json`.
Shell scripts are covered by `check:shell` (syntax + shellcheck); a behaviour change in
`packaging/install.sh` still deserves a manual run noted in the PR's "How I Tested".

## 3. Deciding "is there a test" — reason about it, don't just check a path exists

- The clean case: the matching `test/<name>.test.ts` is also pending, with cases for the new/changed
  path.
- Otherwise, open the existing `test/<name>.test.ts` and check whether it actually exercises the
  changed code (acceptable for a signature-preserving refactor). Skim it — a test file existing is
  not the same as the behaviour being tested.
- If neither holds, that is a violation. Don't accept "I'll add tests later": the coverage gate in
  `npm run test:coverage` (lines ≥ 80 %, branches ≥ 75 %, functions ≥ 70 % over `src/**`) is a
  floor, and per-file coverage is what keeps it from eroding.

## 4. Coverage ratchet

The thresholds in `package.json` (`test:coverage`) only ever go **up**. When a PR raises the
`all files` line noticeably (check the table `npm run test:coverage` prints), suggest bumping the
thresholds in the same PR. Never lower them to get a PR through — fix the coverage instead.
