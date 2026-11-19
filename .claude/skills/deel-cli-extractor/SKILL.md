# Skill: deel-cli-extractor

Regenerate `src/manifest.generated.ts` from a Deel OpenAPI spec and the hand-authored `src/commands.map.ts`.

## When to use

Run this skill whenever the Deel API spec changes and the embedded metadata needs to be refreshed, or when new entries have been added to `src/commands.map.ts`.

## Inputs

The user must supply:
- **spec** — path to a local OpenAPI JSON/YAML file, or an URL

## Steps

Follow these steps in order. Do not skip any step.

### 1. Confirm the spec source

Ask the user for the spec path or URL if they didn't provide it.

### 2. Run the extractor

```bash
node .claude/skills/deel-cli-extractor/extract.ts <spec-path-or-url>
```

The script:
- Reads `src/commands.map.ts` (the hand-authored command surface)
- Extracts metadata for every mapped endpoint from the spec
- Compares the result against the current `src/manifest.generated.ts` and prints a drift report
- Writes the updated `src/manifest.generated.ts`

If the script exits non-zero, it found hard errors. Diagnose each error type before deciding how to proceed:

- **`Missing operation: METHOD /path`** — the spec does not contain that endpoint. This usually means the spec is intentionally scoped (a partial spec). For each missing entry, explain to the user which command loses coverage and what the impact is. Then propose removing those entries from `src/commands.map.ts` and ask for confirmation. Once confirmed, make the edits and re-run the extractor. Treat the removals as BREAKING changes in Step 3.

- **Variant/param collision** — a variant name clashes with a param flag. Explain which command is affected and suggest renaming the variant in `src/commands.map.ts`. Ask the user to confirm the new name, make the edit, and re-run.

- **Duplicate variant** — two map entries share the same command + variant. Show the duplicates and ask the user which one to keep before editing.

Only stop without a proposed fix if the error cannot be resolved without domain knowledge the agent does not have.

### 3. Present the drift report

Show the user the drift report from stdout. Explain any `BREAKING` entries clearly: these are removed or renamed params/fields/enum values that existing callers depend on.

If there are breaking changes, ask the user whether to proceed before continuing.

### 4. Run the consistency check and test suite

```bash
npm run check:manifest
npm test
npm run typecheck
```

If any of these fail, show the errors and stop. Do not open a PR with a broken manifest.

### 5. Review the diff

Show the user a summary of what changed in `src/manifest.generated.ts` (`git diff src/manifest.generated.ts`). Highlight:
- New commands or variants
- Changed parameters (new required fields are especially important)
- Removed commands or variants

### 6. Open a PR

Commit the updated manifest and open a PR against `dev` (the release line) with:
- **Title**: `chore: regenerate manifest from spec <version or date>`
- **Body**: paste the drift report; call out any breaking changes; note which commands are new/changed/removed; mention that `npm run check:manifest` and tests pass
- **Labels**: `script-generated` (required by CI whenever `src/manifest.generated.ts` changes) plus a type label — normally `enhancement`

Only open the PR if the user confirms.

## Notes

- The spec never leaves the local machine. Only `src/manifest.generated.ts` (the extracted, mapped subset) is committed to the public repo.
- If new commands are wanted but not yet in `src/commands.map.ts`, edit that file first and re-run the skill.
- The drift report lists endpoints in the spec that are not in the map under `[unmapped]` — these are candidates to add in a future pass.
- Requires Node ≥ 22.18 (native TypeScript stripping).
- **Format**: `src/manifest.generated.ts` must always use fully expanded JSON — one property per line, no inline objects. The extractor produces this via `JSON.stringify(manifest, null, 2)`. Never hand-edit the file into a compact inline style; if you see inline objects in a diff, reject them.
