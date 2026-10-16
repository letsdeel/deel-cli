#!/usr/bin/env bash
# Ad-hoc signs macOS binaries, then verifies them.
#
#   scripts/sign-darwin.sh [--arch A] <binary>...                sign in place, then verify
#   scripts/sign-darwin.sh [--arch A] --verify-only <binary>...  verify only
#
# --arch (arm64 | x86_64) asserts the CPU type of every file; without it the arch is inferred from a
# file name containing "arm64" or "x64".
#
# macOS host: `codesign`. Linux host: `rcodesign` (see scripts/install-rcodesign.sh). Verification is
# scripts/check-macho-signature.ts on every host, plus `codesign --verify --strict` on macOS.
set -euo pipefail

usage() { echo "usage: $0 [--arch arm64|x86_64] [--verify-only] <binary>..." >&2; exit 2; }

mode=sign
arch_args=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --verify-only) mode=verify; shift ;;
    --arch) [ "$#" -ge 2 ] || usage; arch_args=(--arch "$2"); shift 2 ;;
    --*) usage ;;
    *) break ;;
  esac
done
[ "$#" -gt 0 ] || usage

# Resolve paths against the caller's directory before moving to the repo root.
files=()
for f in "$@"; do
  case "$f" in
    /*) files+=("$f") ;;
    *) files+=("$PWD/$f") ;;
  esac
done

cd "$(dirname "$0")/.."

verify() {
  node scripts/check-macho-signature.ts ${arch_args[@]+"${arch_args[@]}"} "$@"
  if [ "$(uname -s)" = "Darwin" ]; then
    for f in "$@"; do
      codesign --verify --strict "$f" || { echo "[sign-darwin] codesign --verify rejected $f" >&2; exit 1; }
    done
  fi
}

if [ "$mode" = "sign" ]; then
  for f in "${files[@]}"; do
    if [ "$(uname -s)" = "Darwin" ]; then
      codesign --force --sign - "$f"
    else
      if ! command -v rcodesign >/dev/null 2>&1; then
        echo "[sign-darwin] rcodesign not found — run scripts/install-rcodesign.sh first" >&2
        exit 1
      fi
      rcodesign sign "$f" >/dev/null
    fi
  done
fi

verify "${files[@]}"
