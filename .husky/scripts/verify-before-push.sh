#!/usr/bin/env bash
# Runs the same checks CI runs (`npm run check`) before the push leaves the machine, so a red PR
# is the exception rather than the way you find out. Skipped when only Markdown changed.
#
# Bypass for a known-good push: SKIP_PUSH_VERIFY=1 git push   (or git push --no-verify)
set -euo pipefail

if [[ "${SKIP_PUSH_VERIFY:-0}" == "1" ]]; then
  echo "pre-push: verification skipped (SKIP_PUSH_VERIFY=1)." >&2
  exit 0
fi

cd "$(git rev-parse --show-toplevel)" || exit 1

# git exports GIT_DIR (and in some setups GIT_WORK_TREE / GIT_INDEX_FILE) to hook processes. Anything
# `npm run check` spawns — the check-doctor test suite drives git against a scratch repo — would
# inherit them and operate on THIS repository instead. We are at the top level now, so plain
# discovery finds the right repo without them.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE

# Diff base: the upstream tracking branch when there is one, otherwise the merge-base with
# origin/dev. Empty diff -> nothing to verify.
if upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null)"; then
  base="$upstream"
else
  base="$(git merge-base HEAD origin/dev 2>/dev/null || true)"
fi
[[ -z "${base:-}" ]] && base=HEAD

changed="$(git diff --name-only "$base"...HEAD 2>/dev/null || true)"
if [[ -z "$changed" ]]; then
  echo "pre-push: no committed changes vs $base — nothing to verify." >&2
  exit 0
fi

if ! grep -qvE '\.md$' <<< "$changed"; then
  echo "pre-push: only Markdown changed — skipping checks." >&2
  exit 0
fi

if [[ ! -d node_modules ]]; then
  echo "pre-push: node_modules is missing — run 'npm ci' so the checks can run (or SKIP_PUSH_VERIFY=1 to bypass)." >&2
  exit 1
fi

echo "pre-push: running npm run check (what CI runs)..." >&2
if ! npm run --silent check; then
  echo "" >&2
  echo "pre-push: FAILED — CI would fail on this push. Fix it, or bypass with SKIP_PUSH_VERIFY=1 if you know why." >&2
  exit 1
fi
echo "pre-push: all checks passed." >&2
