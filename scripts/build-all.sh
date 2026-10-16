#!/usr/bin/env bash
# Cross-compile every distributable target from this single runner, with
# --bytecode (faster cold start) and --minify, then emit checksums.
# One runner produces all targets, so a single CI job covers the matrix.
# Linux ships both glibc and musl builds (Alpine agents can't run glibc binaries).
set -euo pipefail

cd "$(dirname "$0")/.."

# `--only <os>` builds just that OS's targets (e.g. `--only darwin`); default is everything.
only=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --only)
      only="${2:-}"
      case "$only" in
        darwin | linux | windows) ;;
        *) echo "usage: build-all.sh [--only darwin|linux|windows]" >&2; exit 2 ;;
      esac
      shift 2
      ;;
    *) echo "build-all.sh: unknown argument '$1' (usage: build-all.sh [--only darwin|linux|windows])" >&2; exit 2 ;;
  esac
done

# BUN and DIST_DIR are overridable so the test suite can run this script against a stub compiler.
BUN="${BUN:-./node_modules/.bin/bun}"
OUT="${DIST_DIR:-dist}"
ENTRY="./src/main.ts"
mkdir -p "$OUT"

# target triple  ->  output filename
targets=(
  "bun-darwin-arm64:deel-darwin-arm64"
  "bun-darwin-x64:deel-darwin-x64"
  "bun-linux-x64:deel-linux-x64"
  "bun-linux-arm64:deel-linux-arm64"
  "bun-linux-x64-musl:deel-linux-x64-musl"
  "bun-linux-arm64-musl:deel-linux-arm64-musl"
  "bun-windows-x64:deel-windows-x64.exe"
)

echo "Building targets${only:+ ($only only)}..."
darwin_outputs=()
for entry in "${targets[@]}"; do
  target="${entry%%:*}"
  name="${entry##*:}"
  if [ -n "$only" ] && [[ "$name" != deel-"$only"-* ]]; then continue; fi
  echo "  -> $name ($target)"
  "$BUN" build "$ENTRY" --compile --minify --bytecode --target="$target" --outfile "$OUT/$name" >/dev/null
  if [[ "$name" == deel-darwin-* ]]; then darwin_outputs+=("$OUT/$name"); fi
done

# Sign and verify the macOS binaries before the checksums are taken, so SHA256SUMS only covers
# binaries that verify.
if [ -z "$only" ] || [ "$only" = "darwin" ]; then
  expected_darwin=0
  for entry in "${targets[@]}"; do
    if [[ "${entry##*:}" == deel-darwin-* ]]; then expected_darwin=$((expected_darwin + 1)); fi
  done
  # Every darwin target must have been built and signed.
  if [ "$expected_darwin" -eq 0 ] || [ "${#darwin_outputs[@]}" -ne "$expected_darwin" ]; then
    echo "build-all.sh: expected $expected_darwin macOS binaries but built ${#darwin_outputs[@]} — refusing to continue unsigned" >&2
    exit 1
  fi
  if [ "$(uname -s)" = "Linux" ] && ! command -v rcodesign >/dev/null 2>&1; then
    rcodesign_dir="$(mktemp -d)"
    trap 'rm -rf "$rcodesign_dir"' EXIT
    RCODESIGN_INSTALL_DIR="$rcodesign_dir" bash scripts/install-rcodesign.sh
    export PATH="$rcodesign_dir:$PATH"
  fi
  echo "Signing macOS binaries..."
  bash scripts/sign-darwin.sh "${darwin_outputs[@]}"
fi

# Checksums (portable: shasum on macOS, sha256sum on Linux).
cd "$OUT"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum deel-* > SHA256SUMS
else
  shasum -a 256 deel-* > SHA256SUMS
fi

echo
echo "Artifacts:"
ls -lh deel-* | awk '{printf "  %-26s %s\n", $9, $5}'
echo
echo "SHA256SUMS:"
sed 's/^/  /' SHA256SUMS
