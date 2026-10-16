#!/usr/bin/env bash
# Installs a pinned `rcodesign` (apple-codesign, https://github.com/indygreg/apple-platform-rs) on a
# Linux build host so scripts/sign-darwin.sh can sign the cross-compiled macOS binaries there.
# The tarball is verified against a SHA-256 pinned below before anything is extracted.
#
#   RCODESIGN_INSTALL_DIR  where to put the binary (default: $HOME/.local/bin)
set -euo pipefail

VERSION="0.29.0"
SHA256_X86_64="dbe85cedd8ee4217b64e9a0e4c2aef92ab8bcaaa41f20bde99781ff02e600002"
SHA256_AARCH64="4af92c87ddf52f5f2d1258a3b4e56c7dcb8f1b2468df744976c5f139e031961f"

if [ "$(uname -s)" != "Linux" ]; then
  echo "[install-rcodesign] Linux only — macOS hosts sign with the built-in codesign" >&2
  exit 1
fi

case "$(uname -m)" in
  x86_64 | amd64) target="x86_64-unknown-linux-musl"; expected="$SHA256_X86_64" ;;
  aarch64 | arm64) target="aarch64-unknown-linux-musl"; expected="$SHA256_AARCH64" ;;
  *) echo "[install-rcodesign] unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

dir="${RCODESIGN_INSTALL_DIR:-$HOME/.local/bin}"
name="apple-codesign-${VERSION}-${target}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl --proto '=https' --tlsv1.2 -fsSL "https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign/${VERSION}/${name}.tar.gz" -o "$tmp/rcodesign.tar.gz"
actual="$(sha256sum "$tmp/rcodesign.tar.gz" | awk '{print $1}')"
if [ "$actual" != "$expected" ]; then
  echo "[install-rcodesign] checksum mismatch for ${name}.tar.gz (expected $expected, got $actual)" >&2
  exit 1
fi

tar -xzf "$tmp/rcodesign.tar.gz" -C "$tmp"
mkdir -p "$dir"
install -m 0755 "$tmp/${name}/rcodesign" "$dir/rcodesign"
echo "[install-rcodesign] installed rcodesign ${VERSION} to $dir/rcodesign" >&2
