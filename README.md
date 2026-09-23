# Deel CLI

A command-line client for selected endpoints from the [Deel Public API](https://developer.deel.com).

```bash
deel auth status --json                              # verify your token and identity
deel adjustments create --invoice --generate-input  # explore required fields
deel jobs list --jq '.[] | {job_id, status}'        # filter recent async jobs
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
- [Idempotency](#idempotency)
- [Environments](#environments)
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

A Personal Access Token (PAT) is required for every command that hits the API. It is never logged (the local log redacts `Authorization` to `Bearer ***`).

Resolution precedence (first match wins):

| Source          | How                                                          |
| --------------- | ------------------------------------------------------------ |
| `--token-stdin` | `echo "$PAT" \| deel <cmd> --token-stdin`                    |
| `DEEL_TOKEN`    | the token value directly (handy for CI)                      |
| OS keychain     | stored by `deel auth login`, used automatically otherwise    |

`--token-stdin` and `DEEL_TOKEN` are pass-through and never written to disk. For a long-lived token, prefer the OS keychain over exporting `DEEL_TOKEN`.

```bash
deel auth login                  # prompts for the PAT (hidden input), validates, stores in the OS keychain
echo "$PAT" | deel auth login    # non-interactive (CI): read the PAT from stdin
deel auth status                 # validates; reports the source (stdin / env / keychain)
deel auth logout                 # removes the stored token
```

Keychain backends: macOS Keychain (`security`) and Linux libsecret (`secret-tool`); tokens are stored per environment. Where no keychain is available, use `--token-stdin` or `DEEL_TOKEN`.

## Discovering commands

Help is available at three levels, plus a machine-readable form for agents:

```bash
deel --help                                             # all commands + global options
deel adjustments --help                                 # subcommands in a group
deel adjustments create --help                          # params + request/response contract
deel adjustments create --help --json                   # machine-readable contract
deel adjustments create --invoice --generate-input      # JSON body skeleton to fill in
```

`--help` for an action shows what generic `--help` cannot: the request-body fields (which arrive via `--input`, not as flags) and the response fields.

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

## Idempotency

Every mutating request (`POST`/`PUT`/`PATCH`/`DELETE`) carries an `Idempotency-Key`. By default it is a **deterministic UUIDv5** derived from a canonicalized form of the request (method + path + query + body), so re-running the identical command sends the identical key and the server can dedupe a retry. Override it with `--idempotency-key <value>` when you want a fresh attempt.

## Environments

| `--env`          | Base URL                                       |
| ---------------- | ---------------------------------------------- |
| `prod` (default) | `https://api.letsdeel.com/rest`                |
| `demo`           | `https://api-staging.letsdeel.com/rest`        |

Every API call — including `deel job status`/`deel job list` and the generated
`deel jobs status`/`deel jobs list` — goes through this same `/rest`-prefixed
base URL. There is no separate, unprefixed origin for any endpoint.


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

Opt in to full response bodies with `--log-bodies` per command, or `DEEL_LOG_BODIES=1` globally. When bodies are logged, keys whose names look sensitive (`token`, `password`, `email`, `iban`, `tax_id`, and similar) are masked — but a response body may still contain personal data, so enable this only when you need it. Disable logging entirely per-command with `--no-log`, or globally with `DEEL_LOG=off`.

Location: `~/Library/Logs/deel/deel.log` (macOS),
`%LOCALAPPDATA%\deel\logs` (Windows), `$XDG_STATE_HOME/deel/logs` (Linux).

## Configuration reference

| Variable            | Purpose                                                     |
| ------------------- | ----------------------------------------------------------- |
| `DEEL_TOKEN`        | PAT value                                                   |
| `DEEL_ENV`          | Default environment (`prod` / `demo`)                       |
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
  build-all.sh             # cross-compile all binary targets + checksums
  pack-npm.ts              # assemble the npm launcher + platform packages from dist/
  check-manifest.ts        # assert manifest ↔ command map consistency
  check-lockfile.ts        # assert package-lock.json carries every bun platform binary
  check-version.ts         # assert package.json ↔ src/version.ts, clean semver
  check-shell.sh           # sh -n / bash -n + shellcheck for installer, build scripts, hooks
  check-pr.ts              # PR requirements (used by CI and by the /ship skill)
  check-doctor.ts          # pre-commit doctor gate; doctor-hashes.json is its ledger
src/
  main.ts                  # entry point + top-level error handling
  cli.ts                   # command-tree wiring + routing
  help.ts                  # help / usage / contract / skeleton rendering
  version.ts               # CLI_VERSION (kept in sync with package.json by check-version)
  types.ts                 # shared descriptor/manifest types
  manifest.generated.ts    # command descriptors (generated by the deel-cli-extractor skill — never hand-edited)
  commands.map.ts          # command ↔ API endpoint mapping
  commands/                # static commands (auth, job)
  core/                    # http, auth, keychain, config, tls, input, output, logging, …
test/                      # automated tests (node --test), one file per module
```

## Local development

```bash
npm ci              # install dependencies and the git hooks
npm test            # run the automated test suite (node --test)
npm run typecheck   # type-check with tsc (no emit)
npm run check       # everything CI runs: typecheck, tests + coverage gate, manifest / lockfile / version / shell checks
npm run doctor      # npm run check + build smoke, then clears the pre-commit gate for your changed files
```

The git hooks keep `dev` (the release line) clean: pre-commit blocks files that haven't passed
`npm run doctor` since they last changed, and pre-push runs `npm run check`. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow, the PR requirements and what CI checks.
