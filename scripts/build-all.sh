#!/usr/bin/env bash
# Cross-compile every distributable target from this single runner, with
# --bytecode (faster cold start) and --minify, then emit checksums.
# One runner produces all targets, so a single CI job covers the matrix.
# Linux ships both glibc and musl builds (Alpine agents can't run glibc binaries).
set -euo pipefail

cd "$(dirname "$0")/.."
BUN="./node_modules/.bin/bun"
OUT="dist"
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

echo "Building ${#targets[@]} targets..."
for entry in "${targets[@]}"; do
  target="${entry%%:*}"
  name="${entry##*:}"
  echo "  -> $name ($target)"
  "$BUN" build "$ENTRY" --compile --minify --bytecode --target="$target" --outfile "$OUT/$name" >/dev/null
done

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
