# deel-cli

Public repo (letsdeel/deel-cli): keep ticket keys, internal tool names and internal hostnames out of branch names, commits, PRs and code comments.

## Where things live

- `src/commands.map.ts` + `src/manifest.generated.ts` drive the generated commands (`adjustments`, `jobs`, `logs`). Regenerate the manifest with the `deel-cli-extractor` skill and never hand-edit it; `check:manifest` fails when the map and the manifest disagree.
- Hand-written commands (`auth`, `tokens`, `job`, `webhooks`) live in `src/commands/`, with their logic in `src/core/`. Flags that repeat or stay hidden are read from `rawArgs`, because citty does not expose them.
- `src/commands/shared.ts` holds the flag helpers, including the `nullable*` parsers: `--flag null` clears a nullable field, and `--flag=--x` passes a value that starts with `--`.
- `src/core/executor.ts` sends the request and maps API errors (`errorFromResponse`); `src/core/input.ts` coerces `--input` JSON and `k=v` shorthand.
- `src/core/config.ts` holds the base URLs. They end in `/rest`; a base URL without it returns 404 on every call.
- `src/core/auth.ts` resolves the token: `--token-stdin`, then `DEEL_TOKEN`, then the keychain.

## Before committing

- `/doctor` clears the pre-commit gate (`npm run doctor`). The gate stores file hashes in `scripts/doctor-hashes.json`; when that file conflicts on a merge, take either side and re-run doctor.
- `/ship` pushes and opens the PR. `scripts/check-pr.ts` enforces the PR template and exactly one type label.
- Tests are `node --test test/*.test.ts`; the coverage gate is in `npm run test:coverage`.
