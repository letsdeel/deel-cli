#!/usr/bin/env bash
# Syntax-checks (and shellchecks, when installed) every shell script this repo ships or runs.
#
# packaging/install.sh is what end users pipe straight into `sh` from a GitHub Release, so it
# must stay valid POSIX sh — it is checked with `sh -n` and `shellcheck -s sh`, never bash.
# Everything else (build scripts, git hooks) is bash.
set -euo pipefail
cd "$(dirname "$0")/.."

status=0

check() { # $1 = shell (sh|bash), rest = files
  local shell="$1"; shift
  for f in "$@"; do
    [ -f "$f" ] || continue
    if ! "$shell" -n "$f"; then
      echo "[check-shell] syntax error: $f" >&2
      status=1
    fi
    if command -v shellcheck >/dev/null 2>&1; then
      if ! shellcheck -S warning -s "$shell" "$f"; then
        echo "[check-shell] shellcheck failed: $f" >&2
        status=1
      fi
    fi
  done
}

check sh packaging/install.sh .husky/pre-commit .husky/pre-push
check bash scripts/*.sh .husky/scripts/*.sh

if ! command -v shellcheck >/dev/null 2>&1; then
  echo "[check-shell] shellcheck not installed — syntax check only (brew install shellcheck / apt-get install shellcheck)" >&2
fi

if [ "$status" -eq 0 ]; then
  echo "[check-shell] OK — all shell scripts pass." >&2
fi
exit "$status"
