# Deel CLI

A command-line client for selected endpoints from the [Deel Public API](https://developer.deel.com).

```bash
deel auth status --json                              # verify your token and identity
deel adjustments create --invoice --generate-input  # explore required fields
deel jobs list --jq '.[] | {job_id, status}'        # filter recent async jobs
deel dev logs list --status_class 4xx --beta        # your organization's failed API requests
```

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Verifying downloads](#verifying-downloads)
- [Quickstart](#quickstart)
- [Authentication](#authentication)
- [Discovering commands](#discovering-commands)
- [Request input (`--input`, `--file`, `--form`)](#request-input)
- [Output (`--json`, `--fields`, `--jq`, `--quiet`)](#output)
- [API tokens](#api-tokens)
- [Idempotency](#idempotency)
- [Webhooks](#webhooks)
- [API versions](#api-versions)
- [Environments](#environments)
- [Beta endpoints](#beta-endpoints)
- [Corporate proxies & custom CAs](#corporate-proxies--custom-cas)
- [Exit codes](#exit-codes)
- [Logging](#logging)
- [Configuration reference](#configuration-reference)
- [Building single-file binaries](#building-single-file-binaries)
- [Project layout](#project-layout)
- [Local development](#local-development)

## Requirements

- **Node 22.18+** to run from source (executes the TypeScript directly via type-stripping — no build step for local use).
- Optional: **Bun** is bundled as a devDependency and used to compile the single-file binaries; you don't need it on your PATH.

## Install

**npm (Node 22.18+ / MCP agents):**

```bash
npm install -g @deel-org/cli    # installs the binary for your platform
npx @deel-org/cli --help        # or run without installing
```

**Direct binary download (no Node required — Linux / macOS / Alpine):**

```bash
curl -fsSL https://cli.deel.com/install.sh | sh
```

> The installer always verifies the SHA256 checksum and, when [cosign](https://docs.sigstore.dev/system_config/installation/) is installed, also verifies the release signature against the release's public key (baked into the installer at release time). Set `DEEL_REQUIRE_COSIGN=1` to abort if cosign is not available.

**From source:**

```bash
npm install                 # citty + jq-wasm (runtime), typescript + bun (dev)
node src/main.ts --help     # or: npm run deel -- --help
```

Once built (see [Building single-file binaries](#building-single-file-binaries)) the binary is invoked as `deel`.

## Verifying downloads

Every GitHub Release ships `SHA256SUMS`, `SHA256SUMS.sigstore`, and `cosign.pub`. Use these to confirm the binary was produced by the official release pipeline and has not been tampered with.

**1. Install [cosign](https://docs.sigstore.dev/system_config/installation/)** (one-time):

```bash
# macOS
brew install cosign

# Linux
curl -sLO https://github.com/sigstore/cosign/releases/latest/download/cosign-linux-amd64
chmod +x cosign-linux-amd64 && sudo mv cosign-linux-amd64 /usr/local/bin/cosign
```

**2. Download the release artifacts:**

```bash
VERSION=v1.0.0   # replace with the version you downloaded
BASE=https://github.com/letsdeel/deel-cli/releases/download/$VERSION

curl -sLO $BASE/SHA256SUMS
curl -sLO $BASE/SHA256SUMS.sigstore
curl -sLO $BASE/cosign.pub
```

**3. Verify the signature:**

```bash
cosign verify-blob \
  --key cosign.pub \
  --bundle SHA256SUMS.sigstore \
  --insecure-ignore-tlog \
  SHA256SUMS
```

Expected output: `Verified OK`

> `--insecure-ignore-tlog` is required because the release pipeline intentionally skips uploading to the Sigstore public transparency log. The integrity guarantee comes from the `cosign.pub` key, not the log.

**4. Verify the binary checksum:**

```bash
# download the binary for your platform first, e.g.:
# curl -sLO $BASE/deel-linux-x64

sha256sum --check SHA256SUMS --ignore-missing
```

Expected output: `deel-<platform>: OK`

## Quickstart

Set a Personal Access Token and validate it:

```bash
export DEEL_TOKEN="<your-pat>"
export DEEL_ENV=demo                              # use staging while exploring

deel auth status                                  # verify the token
deel adjustments create --invoice --generate-input # print the required fields
```

Use `--env demo` for staging or `--env prod` (default) for production.

> Mutating commands hit the real API. Prefer staging while exploring — every
> `create` has real effects.

## Authentication

Sign in with your browser; the CLI keeps a short-lived access token and refreshes it for you.

```bash
deel auth login                  # opens your browser, asks for consent, stores the login in the OS keychain
deel auth login --no-browser     # print the sign-in URL without opening a browser (open it in a browser on this machine)
deel auth login --read-only      # request read-only (*:read) scopes only
deel auth login --scopes people:read,contracts:read   # request specific scopes (default: the server's default set)
deel auth status                 # validates; reports the auth type (oauth / pat), source, scope and expiry
deel auth logout                 # revokes the login on the server (best effort) and removes it from the keychain
```

`deel auth login` listens on a one-time port on `127.0.0.1` for the browser's redirect and shuts it down after the first response. Browser sign-in needs an OS keychain (macOS Keychain or Linux libsecret via `secret-tool`); it is not available on Windows yet.

For CI and other non-interactive use, a Personal Access Token (PAT) works without signing in. Tokens are never logged (the local log redacts `Authorization` to `Bearer ***`).

Resolution precedence (first match wins):

| Source          | How                                                          |
| --------------- | ------------------------------------------------------------ |
| `--token-stdin` | `echo "$PAT" \| deel <cmd> --token-stdin`                    |
| `DEEL_TOKEN`    | the PAT value directly (handy for CI)                        |
| OS keychain     | the login stored by `deel auth login`, used automatically otherwise |

`--token-stdin` and `DEEL_TOKEN` are pass-through and never written to disk. `deel auth login` no longer accepts a PAT: use `DEEL_TOKEN` or `--token-stdin`. A PAT saved in the keychain by an earlier version keeps working until you run `deel auth login` or `deel auth logout`, which remove it.

A stored login (browser login or saved PAT) is only sent to the API of its own environment. `--base-url` (or `DEEL_CLI_BASE_URL`) without `--env` is treated as a separate environment named after its host, so nothing stored for `prod` or `demo` is sent to it. Combining `--env prod` or `--env demo` with a `--base-url` on another host is refused; use `DEEL_TOKEN` or `--token-stdin` for that.

## Discovering commands

Help is available at three levels, plus a machine-readable form for agents:

```bash
deel --help                                             # every domain, one line each, + global options
deel contracts --help                                   # the commands of a domain, one line per endpoint
deel contracts get --help                               # the endpoints that share these words
deel contracts get --worker-type eor --help             # arguments, flags + request/response contract
deel contracts get --worker-type eor --help --json      # machine-readable contract
deel adjustments create --invoice --generate-input      # JSON body skeleton to fill in
deel commands --filter amendment                        # search every command (--json for scripts)
```

When several endpoints share a command's words, a few flags pick one, and the group help lists each line:

```
  get <contract_id>                     Retrieve a single contract
  get <contract_id> --worker-type eor   Retrieve EOR Contract Details
```

`--worker-type <eor|gp|daas|contractor|employee>` names the contract or worker type, `--as worker` is the worker's side of an action, `--file-format pdf|csv` returns a document and `--bulk` acts on many at once. The line without a `--worker-type` calls the endpoint whose path names no type. A mistyped word gets a "did you mean".

`--help` for an action shows what generic `--help` cannot: its arguments, the request-body fields (which arrive via `--input`, not as flags) and the response fields.

Flags before `--help` show one endpoint's full help, and for the line without flags its ID does:

```bash
deel contracts get --help                               # one line per endpoint of 'contracts get'
deel contracts get --worker-type eor --help             # the EOR endpoint's arguments, options and fields
deel contracts get 12345 --help                         # the endpoint the plain line calls
```

## Request input

Body content is supplied with `--input`, which accepts four interchangeable forms:

```bash
# key=value shorthand (scalar coercion + enum validation against the spec)
deel adjustments create --invoice \
  --input type=BONUS,amount=500,contract_id=C123,description="Q1 bonus",date_submitted=2025-01-01

# inline JSON
deel adjustments create --invoice \
  --input '{"type":"BONUS","amount":500,"contract_id":"C123","description":"Q1 bonus","date_submitted":"2025-01-01"}'

# a file
deel adjustments create --invoice --input file://payload.json

# stdin
echo '{"type":"BONUS","amount":500,...}' | deel adjustments create --invoice --input -
```

The shorthand grammar supports nested objects, lists, and space-separated scalar lists, with backslash escaping:

```bash
--input 'tags=approved urgent,meta={source=api,ref=123}'
```

Scalar values are coerced to the type declared in the spec (numbers, booleans, enums) and enum values are validated before the request is sent.

Top-level body fields the spec marks nullable accept the literal `null` in shorthand (`--input note=null`) to clear them; JSON input accepts `null` for them as well. Limit: nested fields (`--input addr={line2=null}`) are not coerced and still receive the text `"null"` (JSON input is unchanged: use a real JSON `null`). `--help` and `--help --json` mark nullable fields. With `--form`, a multipart form has no null value, so `note=null` is rejected with a pointer to JSON input. The extractor reads OpenAPI 3.0 `nullable: true` as well as 3.1 `type: ["string", "null"]` and `oneOf`/`anyOf` with a null member.

**Array query params** are repeatable — pass the flag once per value:

```bash
deel <command> --some_ids id1 --some_ids id2   # -> ?some_ids=id1&some_ids=id2
```

**File uploads.** Endpoints that accept `multipart/form-data` take `--file`:

```bash
deel <command> --input field=value --file attachment=@/path/to/file.pdf
```

`--file` is repeatable across fields and within a single field (multiple files under the same part). Some endpoints accept both JSON and multipart— those default to JSON; add `--form` to switch.

## Output

Output is the JSON envelope by default. Use `--no-json` on a TTY to get a human-readable view instead. The envelope is:

```json
{ "data": { ... }, "meta": { "request_id": "..." } }
```

List endpoints that paginate return a `page` object next to `data`; pass its `cursor` back as `--cursor` to fetch the next page (`has_next_page` tells you when to stop):

```json
{ "data": [ ... ], "page": { "cursor": "eyJ0cyI6...", "has_next_page": true }, "meta": { "request_id": "..." } }
```

```bash
deel dev logs list --limit 100 --beta                        # first page; read page.cursor from the envelope
deel dev logs list --limit 100 --cursor <page.cursor> --beta # next page, until has_next_page is false
```

`--jq` and `--quiet` see only `data`, so to page read `page.cursor` from the full JSON envelope (or with `--fields`, which keeps `page`). The CLI also prints `next page: --cursor <value>` on stderr whenever there is a next page, and reports a list that returns a bare top-level `cursor` the same way, as `page`.

A flag that takes a value (`--fields`, `--jq`, `--input`, `--env`, `--limit`...) and gets none, or gets the next flag in its place, fails before anything is sent. A value that starts with `-` is written attached: `--jq=-.a`.

| Flag              | Effect                                                                 |
| ----------------- | ---------------------------------------------------------------------- |
| `--no-json`       | Human-readable view on a TTY (default is always JSON)                  |
| `--fields a,b.c`  | Project only these fields (dotted paths; maps over arrays)             |
| `--jq '<filter>'` | Transform the `data` payload with an embedded jq (no external binary)  |
| `--raw`           | With `--jq`, print scalar string results unquoted (like `jq -r`)       |
| `--quiet`         | Print ids only (`id` / `job_id` / `oid`)                               |

```bash
deel jobs list --fields job_id,status
deel jobs list --jq '.[] | select(.status == "SUCCEEDED") | .job_id' --raw
deel jobs list --quiet
```

## API tokens

`deel dev tokens` lists and inspects the API tokens of your organization, and your own personal tokens, and invalidates one. The calling token needs the `tokens:read` scope, plus `tokens:write` to invalidate. The API never returns a token's secret value. These endpoints are in beta, so each command takes `--beta`.

```bash
deel dev tokens list --beta                            # newest first; --limit/--cursor to page
deel dev tokens get <token_id> --beta
deel dev tokens revocations create <token_id> --input reason=rotated --beta   # invalidates the token; there is no undo
deel dev logs tokens list --beta                       # what each token has been used for
```

There is no confirmation prompt and no `--yes`: `revocations create` invalidates the token as soon as it is typed. Check the ID with `deel dev tokens get <token_id> --beta` first.

## Idempotency

Every mutating request (`POST`/`PUT`/`PATCH`/`DELETE`) carries an `Idempotency-Key`. By default it is a **deterministic UUIDv5** derived from a canonicalized form of the request (method + path + query + body), so re-running the identical command sends the identical key and the server can dedupe a retry. Override it with `--idempotency-key <value>` when you want a fresh attempt. The exception is a call that must act every time it runs, such as `deel webhooks test`: it is sent once, with no retry and no derived key (an explicit `--idempotency-key` is still sent).

## Webhooks

`deel webhooks list`, `get <id>` and `events list` read webhook subscriptions; the signing key is never printed (reveal it in Developer Center → Webhooks).

```bash
deel webhooks create --input file://webhook.json             # deel webhooks create --generate-input for the fields
deel webhooks update <id> --input status=disabled       # changes only the given fields
deel webhooks delete <id>
deel webhooks test <webhook_id> --input event_type=contract.created --beta   # Deel delivers a test event to the receiver
```

Like every generated command, `delete` runs as soon as it is typed: there is no confirmation prompt and no `--yes`, so check the ID with `deel webhooks get <id>` first.

A webhook id can start with `-`, which the argument parser reads as a flag. Put it after `--`, which ends the options: `deel webhooks get -- -WZ1uT2DFF01`. The same works for any generated command.

`test` runs the delivery from Deel's servers, so the receiver URL must be publicly reachable; it is limited to 10 simulations per hour per event type. It prints the delivery, then exits 1 when the response reports `is_success: false`. Each run sends a new event: it is sent once, with no retry and no derived `Idempotency-Key`; the retry of a rejected beta (see [API versions](#api-versions)) does not apply to it.

## API versions

Each command calls one version of its endpoint (sent as `X-Version`): the newest stable version, or the newest beta when nothing is stable yet (then `X-Beta: true` is sent too). `deel <command> --help` shows it.

| Flag                     | Sends                                                                          |
| ------------------------ | ------------------------------------------------------------------------------ |
| (none)                   | the command's version; plus `X-Beta: true` when that version is beta-only      |
| `--version <YYYY-MM-DD>` | that version (warns on stderr if the command doesn't list it, sends it anyway) |
| `--version none`         | no `X-Version`: the API picks its oldest stable version                        |
| `--beta`                 | the newest beta version, with `X-Beta: true`                                   |
| `--versions`             | nothing: lists the versions with their beta and sunset dates, and exits        |

```bash
deel <command> --versions             # JSON; --no-json for a table
deel <command> --beta
deel <command> --version 2026-01-01
```

Requests to a non-prod environment (`--env demo`) do not send `X-Version` by default, because versions might differ between environments. `--version <YYYY-MM-DD>` still sends one.

If a beta graduates (or ends) after this CLI was released, the API rejects `X-Beta` before running anything; the CLI then retries once, without `X-Beta` (with the same version, or with the stable version the API names (else the newest stable one in the CLI's own list) when nothing is in beta any more and you did not pin a version with `--version`) and with the same idempotency key. `--debug` shows the retry. A command that is sent once (`webhooks test`) is never retried.

## Environments

| `--env`          | Base URL                                       |
| ---------------- | ---------------------------------------------- |
| `prod` (default) | `https://api.letsdeel.com/rest`                |
| `demo`           | `https://api-staging.letsdeel.com/rest`        |

Every REST call — including `deel job status`/`deel job list` and the generated
`deel jobs status`/`deel jobs list` — goes through this same `/rest`-prefixed
base URL. The `deel scim …` commands use the sibling `/scim` base path
(`https://api.letsdeel.com/scim`).


## Beta endpoints

A command whose only version is a beta sends `X-Beta: true` by itself, so `--beta` is optional on `deel dev logs list`, `deel dev tokens list` or `deel webhooks test …`; the examples in this README spell it out. `--beta` picks the newest beta of a command that also has a stable version, and fails with `usage.beta` when it has none; on a hand-picked command (`adjustments`, `jobs`), which lists no versions, it only adds `X-Beta`. A beta called without the header (for example with `--version none`) answers `BETA_ACCESS_REQUIRED`; the CLI then suggests `--beta`. See [API versions](#api-versions).

## Corporate proxies & custom CAs

The CLI **trusts your OS certificate store by default**, so a corporate TLS-inspection proxy or an internal CA **works with no configuration** as long as its root is installed on the machine. At startup it merges `bundled Mozilla + NODE_EXTRA_CA_CERTS + OS system store` via `tls.setDefaultCACertificates()` (Node 22.15+ and Bun), so the packaged binary behaves the same as the dev path.

If a root *isn't* in the OS store, add it explicitly (no verification-disabling):

```bash
deel auth status --ca-cert /path/to/root.pem    # extra CA (repeatable)
export NODE_EXTRA_CA_CERTS=/path/to/root.pem    # or via env
```

Control the trust sources with `DEEL_CERT_STORE` (default `bundled,system`; set to `bundled` to skip the OS store). Proxies are honored via `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`. Verification is never disabled by default — this tool carries tokens and PII.

## Exit codes

The exit status is deliberately binary:

| Code | Meaning |
| ---- | ------- |
| 0    | success |
| 1    | error   |

All failure detail lives in the error envelope printed to stderr — never encoded in the exit code:

```json
{ "error": { "code": "auth.missing", "message": "No token found", "next": "Set DEEL_TOKEN or pass --token-stdin", "request_id": "..." } }
```

`code` distinguishes failures programmatically (e.g. `auth.missing`, `input.enum`, `network.timeout`, `http.<status>`, or the API's own error code); scripts should branch on `code`, not on the exit status.

## Logging

Each HTTP exchange is written as NDJSON to a size-capped, rotating local log (separate from any network telemetry). **By default only metadata is logged** — command, method, URL path (query string omitted), status, request id, duration, and request headers (the `Authorization` header masked to `Bearer ***`). **Response bodies are not written by default.**

Opt in to full response bodies with `--log-bodies` per command, or `DEEL_LOG_BODIES=1` globally. When bodies are logged, these values are masked as `***`: credentials (keys such as `token`, `password`, `secret`, `signature`), and every response field the API definition marks as personal or employment data. Which fields carry that mark is decided by the owner of each endpoint, and the CLI follows it for that field of that endpoint's response, and the same name elsewhere is logged as it is. A link (a key named `url`, `link`, `href`...) is logged without its query string and fragment, where a pre-signed link keeps its signature. The request's own query string is never written to the log, with or without `--log-bodies`; the URL in `--debug` output and in a timeout or TLS error masks the values of credential query parameters. Whatever its key, a value that is an email address or a JWT (a `?q=` search, a free-text `note`) is masked too. Names of people and companies, record ids, dates and amounts of a contract stay, so the log still says what was called. A response body may still contain personal data in a field nobody has marked, so enable this only when you need it. Disable logging entirely per-command with `--no-log`, or globally with `DEEL_LOG=off`.

Location: `~/Library/Logs/deel/deel.log` (macOS),
`%LOCALAPPDATA%\deel\logs` (Windows), `$XDG_STATE_HOME/deel/logs` (Linux).

## Configuration reference

| Variable            | Purpose                                                     |
| ------------------- | ----------------------------------------------------------- |
| `DEEL_TOKEN`        | PAT value                                                   |
| `DEEL_ENV`          | Default environment (`prod` / `demo`)                       |
| `DEEL_CLI_BASE_URL` | Override the API base URL (https only); `--base-url` beats it, it beats `--env`/`DEEL_ENV` |
| `DEEL_LOG`          | `off` to disable local logging                              |
| `DEEL_LOG_BODIES`   | `1` to include response bodies in the local log (off by default) |
| `DEEL_LOG_DIR`      | Override the log directory                                  |
| `DEEL_LOG_MAX_SIZE` | Rotate threshold in bytes (default 10 MiB)                  |
| `DEEL_LOG_MAX_FILES`| Rotated files to keep (default 5)                           |
| `DEEL_CERT_STORE`   | Trust sources, comma-separated (default `bundled,system`)   |
| `DEEL_CA_CERT`      | Extra CA PEM path (same as `--ca-cert`)                     |
| `NODE_EXTRA_CA_CERTS` | Extra CA PEM path honored by the runtime                  |
| `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` | Proxy configuration                   |

## Building single-file binaries

```bash
npm run build       # -> dist/deel  (standalone, --minify --bytecode)
./dist/deel --version

npm run build:all   # -> dist/deel-{darwin,linux}-{arm64,x64}, deel-windows-x64.exe + SHA256SUMS
```

`bun build --compile` bundles all sources and dependencies into one self-contained executable. Cross-compilation to every target runs from a single Linux runner (`scripts/build-all.sh`).

## Project layout

```
.github/
  workflows/pr.yaml        # PR gate: validate-pr, check, build-smoke (public-safe, SHA-pinned actions)
  pull_request_template.md, dependabot.yml
.husky/                    # git hooks: pre-commit (dev guard, doctor gate, lockfile/version), pre-push (npm run check)
packaging/
  install.sh               # POSIX-sh installer shipped on every GitHub Release
scripts/
  build-all.sh             # cross-compile all binary targets, sign + verify the macOS ones, write checksums
  sign-darwin.sh           # ad-hoc sign and verify macOS binaries (codesign, or rcodesign on Linux)
  install-rcodesign.sh     # fetch the pinned rcodesign used for signing on Linux
  pack-npm.ts              # assemble the npm launcher + platform packages from dist/
  check-manifest.ts        # assert manifest ↔ command map consistency
  check-lockfile.ts        # assert package-lock.json carries every bun platform binary
  check-version.ts         # assert package.json ↔ src/version.ts, clean semver
  check-macho-signature.ts # verify a macOS binary's embedded code signature (any OS)
  check-shell.sh           # sh -n / bash -n + shellcheck for installer, build scripts, hooks
  check-pr.ts              # PR requirements (used by CI and by the /ship skill)
  check-doctor.ts          # pre-commit doctor gate; doctor-hashes.json is its ledger
  generate-public-api.ts   # writes src/public-api/manifest.json from the public definitions
  check-command-map.ts     # checks every src/public-api/commands.json entry makes a callable command
  public-api/              # the generator: definitions input, command-map parsing, generation checks
src/
  main.ts                  # entry point + top-level error handling
  cli.ts                   # command-tree wiring + routing
  help.ts                  # help / usage / contract / skeleton rendering
  version.ts               # CLI_VERSION (kept in sync with package.json by check-version)
  types.ts                 # shared descriptor/manifest types
  manifest.generated.ts    # hand-picked command descriptors (generated by the deel-cli-extractor skill — never hand-edited)
  commands.map.ts          # hand-picked command ↔ API endpoint mapping
  public-api/              # generated public API commands: manifest.json (never hand-edited), commands.json (the command map), domains.json (each domain's description for help; its stage orders `deel --help`), loader
  commands/                # static commands (auth, job, commands)
  core/                    # http, auth, keychain, config, tls, input, output, logging, …
test/                      # automated tests (node --test), one file per module
```

## Local development

```bash
npm ci              # install dependencies and the git hooks
npm test            # run the automated test suite (node --test)
npm run typecheck   # type-check with tsc (no emit)
npm run check       # everything CI runs: typecheck, tests + coverage gate, manifest / command map / lockfile / version / shell checks
npm run doctor      # npm run check + build smoke, then clears the pre-commit gate for your changed files
```

The git hooks keep `dev` (the release line) clean: pre-commit blocks files that haven't passed
`npm run doctor` since they last changed, and pre-push runs `npm run check`. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow, the PR requirements and what CI checks.
