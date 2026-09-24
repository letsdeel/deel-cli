## Description
<!-- What changes and why. Anything a user will notice (new command or flag, output shape, exit code, auth behaviour) goes here. -->

## Testing
**How I Tested:**
<!-- Required. Commands you ran, tests you added or updated, manual verification against the API. -->

**Evidence/Proof:**
<!-- Optional: output, screenshots, links. -->

## Release checklist
<!-- dev is the release line: whatever merges here ships in the next beta cut from the release pipeline. -->
- [ ] `npm run check` passes locally (typecheck, tests + coverage gate, manifest / lockfile / version / shell checks)
- [ ] User-facing change → README updated
- [ ] `src/manifest.generated.ts` untouched, or regenerated with the `deel-cli-extractor` skill (never hand-edited) and the PR labelled `script-generated`
- [ ] No credentials, tokens or personal data in tests, fixtures, logs or this description
- [ ] Exactly one type label: `bug` / `enhancement` / `refactor` / `documentation` / `chore`
