# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`deel` — a thin, spec-driven CLI for selected Deel Public API endpoints. TypeScript run **directly by Node 22.18+ via type-stripping** (no build step for development); Bun is a devDependency used only to compile single-file release binaries. Runtime deps are just `citty` (arg parsing) and `jq-wasm` (`--jq`).

This is a **public repo** (`letsdeel/deel-cli`). Code, fixtures, commit messages and PR text must stay public-safe: no internal hostnames, customer data, credentials, or references to internal tooling.

## Commands

```bash
npm ci                                  # install deps + husky git hooks
node src/main.ts --help                 # run from source (or: npm run deel -- <args>)
npm test                                # node --test test/*.test.ts
node --test test/executor.test.ts       # a single test file
node --test --test-name-pattern="reserved" test/public-api-commands.test.ts   # a single test by name
npm run typecheck                       # tsc --noEmit, strict
npm run check                           # everything CI runs: typecheck, tests + coverage gate, manifest/lockfile/version/shell checks
npm run build:smoke                     # bun compile to dist/deel, then --version / --help
npm run doctor                          # check + build:smoke, then clears the pre-commit doctor gate
```

Coverage floor over `src/**` (in `test:coverage`): lines ≥ 80 %, branches ≥ 75 %, functions ≥ 70 %. It only ever moves up — never lower it to pass.

## Git hooks and the doctor gate

- **pre-commit** asks for confirmation before committing on `dev` (the release line), and **blocks the commit while any file that differs from `origin/dev` hasn't been verified since it last changed**. Clear it with `npm run doctor` (or the `/doctor` skill), which records hashes in `scripts/doctor-hashes.json` — commit that file with the change. Any later edit to a pending file re-blocks the commit, so run doctor last. When `doctor-hashes.json` conflicts on a merge, take either side and re-run doctor.
- **pre-push** runs `npm run check` (skipped for Markdown-only pushes; `SKIP_PUSH_VERIFY=1` bypasses).
- Don't use `--no-verify`.

## Architecture

### Three kinds of commands

1. **Hand-picked generated commands** — data-driven from `src/manifest.generated.ts`, an array of `Descriptor`s (`src/types.ts`) describing method, path, params, body props, body encoding, response fields, async-ness, etc.
   - `src/commands.map.ts` is the hand-authored list of `command ↔ METHOD /path` entries.
   - `src/manifest.generated.ts` is **never hand-edited**. It's regenerated from an OpenAPI spec by the `deel-cli-extractor` skill (`node .claude/skills/deel-cli-extractor/extract.ts <spec>`), which also prints a drift report flagging breaking changes. `npm run check:manifest` enforces map ↔ manifest consistency. A PR changing the manifest needs the `script-generated` label.
   - To expose a new endpoint: add it to `commands.map.ts`, then regenerate.
   - **Variants**: several map entries with the same `command` but different `variant` (e.g. `adjustments create --invoice` / `--payroll`) become one command with mutually exclusive boolean selector flags.
2. **Generated public API commands** — one per documented public endpoint, in `src/public-api/manifest.json` (written by `npm run generate:public-api -- --from <file|url>`, never hand-edited). Names come only from the reviewed command map `src/public-api/commands.json` (rules R1–R11 in CONTRIBUTING.md, checked by `npm run check:command-map`); an endpoint with no entry fails the generator. Path IDs are positional arguments, and fixed selector flags (`--worker-type eor`, `--as worker`, `--file-format pdf`, `--bulk`, `--status <value>`) or scope flags (`--contract <id>`) pick one endpoint among those sharing the words (`src/public-api/commands.ts` `selectForm`).
3. **Static commands** — hand-written in `src/commands/<name>.ts` (`auth`, `job`) for things that don't map 1:1 to one operation. Registered in `src/commands/index.ts` (`staticCommands`); the keys **must** match `RESERVED_COMMANDS` in `src/core/constants.ts`, which stops a generated command from colliding. The pattern is a thin citty command in `src/commands/` with the API/business logic in a matching `src/core/<concern>.ts` (e.g. `commands/auth.ts` → `core/auth.ts`). A static command is kept only for what a generated one can't do; an endpoint the command map names is generated, not hand-written.
   - `src/commands/shared.ts` holds the global flag set (`commonArgs`) and flag helpers. Repeatable and hidden flags are read from `rawArgs` (`gatherFlagValues`, `gatherFiles`, `readHidden`) because citty doesn't expose them; the `--flag=value` form lets a value start with `-`. The `nullable*` parsers send the literal `null` as JSON null to clear a nullable field.

### Request flow

`src/main.ts` (top-level error → JSON error envelope on stderr, exit 1) → `src/cli.ts run()`:
- Builds a nested citty tree from manifest descriptors' multi-token command paths, merged with static commands.
- Handles **offline** paths itself before citty runs (so required-arg enforcement is bypassed): `--version`, `--generate-input` (body skeleton), action `--help` (human, or `--help --json` for the machine-readable contract) — rendered by `src/help.ts`.
- Otherwise citty dispatches; generated actions go through `runDescriptor` → `parseInput` (`core/input.ts`: `--input` as `key=value` shorthand / JSON / `file://` / `-` stdin, coerced and enum-validated against `bodyProps`) → `resolveToken` (`--token-stdin` > `DEEL_TOKEN` > OS keychain) → `createContext` → `execute` (`core/executor.ts`).

### Context and transport (dependency injection)

`core/context.ts` `createContext()` is the single composition point: `Ctx = { io, http, clock, newRequestId, logger, config, token }`. Modules don't reach for `process.*` or globals — they take a `Ctx`. The `http` transport is a middleware stack composed in `core/http.ts`: retry → beta header → request id → CLI version → auth → logging (innermost, sees final headers). Tests inject `baseTransport`, `io` (`captureIO()` from `core/io.ts`), `clock`, `rng`, and `logger` fakes — see `test/executor.test.ts` `ctxWith()` for the standard pattern.

### Conventions baked into the executor/output

- Every mutating request gets an `Idempotency-Key`: a deterministic UUIDv5 over the canonicalized request (`core/idempotency.ts`), overridable with `--idempotency-key`.
- Bodies are wrapped under `{ data: ... }` when the descriptor says `bodyWrapper: "data"` (unless the user already wrapped). Batch-size caps (`maxItems`) are enforced client-side.
- Output is always a JSON envelope `{ data, meta: { request_id }, page? }` by default; `--fields`, `--jq`, `--raw`, `--quiet`, `--no-json` in `core/output.ts`.
- **Exit codes are binary (0/1).** Failure detail lives in the stderr envelope `{ error: { code, message, next, request_id } }`; throw `CliError(code, message, next?)` (`core/errors.ts`) with a dotted code like `usage.variant`, `auth.missing`, `http.<status>`.
- TLS trusts bundled Mozilla + `NODE_EXTRA_CA_CERTS` + OS store (`core/tls.ts`), installed lazily in the transport so offline commands stay fast; on a Bun-binary TLS failure `main.ts` re-execs once.
- Local NDJSON logging (`core/logging.ts`) logs metadata only by default; sensitive keys are masked via `SENSITIVE_LOG_KEYS`.
- Tunables and header names live in `core/constants.ts`.
- Base URLs (`core/config.ts`, `--env prod|demo`) end in `/rest`; every REST endpoint, including jobs, goes through that prefix — a base URL without it 404s on every call. SCIM commands swap it for `/scim` (`apiBaseUrl`).
- Secret response fields (`WITHHELD_RESPONSE_FIELDS` in `core/constants.ts`, e.g. a webhook's `signing_key`) are never printed by generated commands.

### TypeScript constraints

Because Node runs the source via type-stripping (`verbatimModuleSyntax`, `allowImportingTsExtensions`): import with explicit `.ts` extensions, use `import type` for type-only imports, and avoid non-erasable TS syntax (enums, namespaces, parameter properties). `src/types.ts` stays type-only.

## Layout rules (enforced by `/doctor`, see `.claude/skills/doctor/structure.md`)

- `src/core/` and `src/commands/` are **flat** — one file per concern, no sub-directories.
- Only `main.ts`, `cli.ts`, `help.ts`, `version.ts`, `types.ts`, `commands.map.ts`, `manifest.generated.ts` live directly under `src/`. `src/public-api/` holds the generated public API commands: `manifest.json` (generated), `commands.json` (the command map) and `commands.ts` (loader and endpoint selection).
- Tests live only in `test/<module>.test.ts`, named after the module they cover (`src/core/http.ts` → `test/http.test.ts`). Behaviour changes need a test; scripts with real logic in `scripts/` are tested from `test/` too. `test/stubs.ts` provides stub-executable/hermetic-PATH helpers for testing the shell scripts.
- `package.json` version and `src/version.ts` must agree (`check:version`). `package-lock.json` must keep every bun platform binary (`check:lockfile`) — an `npm install` over an existing `node_modules` can drop them; prefer `npm ci`.
- `packaging/install.sh` is POSIX `sh` (users pipe it into `sh`); `check:shell` runs `sh -n`/`bash -n` + shellcheck.

## Pull requests

Base branch `dev`. CI (`.github/workflows/pr.yaml`) runs `validate-pr` (`scripts/check-pr.ts`), `check`, and `build-smoke` (incl. cross-compiling and signature-verifying the macOS binaries). The PR body must follow `.github/pull_request_template.md` with a real `## Description` and a `**How I Tested:**` entry, plus exactly one type label: `bug`, `enhancement`, `refactor`, `documentation`, `chore` (`bug`/`enhancement` must include a test file). Pre-flight locally with `node scripts/check-pr.ts --title ... --body-file ... --labels ...`. The `/ship` skill automates check → push → PR → CI wait.
