#!/bin/sh
# Deel CLI installer — downloads the right self-contained binary from GitHub
# Releases. No runtime required. macOS + Linux (incl. Alpine/musl).
#
#   curl -fsSL https://cli.deel.com/install.sh | sh
#   curl -fsSL https://cli.deel.com/install.sh | sh -s -- v0.1.0
#
# Pinned version:
#   curl -fsSL https://cli.deel.com/v0.1.0/install.sh | sh
#
# The version can be given as the first argument (as above), or via DEEL_VERSION.
#
# Env overrides:
#   DEEL_INSTALL_DIR    install location (default: /usr/local/bin, else ~/.local/bin)
#   DEEL_VERSION        version tag to install (default: latest), e.g. v0.1.0
#   DEEL_REQUIRE_COSIGN set to 1 to abort when cosign is not installed (default: warn)
set -eu

REPO="letsdeel/deel-cli"

# Default version; overridden by an argument or DEEL_VERSION. Set per release.
DEFAULT_VERSION="latest"

# Release-signing public key; when empty, signature verification is skipped.
COSIGN_PUBLIC_KEY=""

err() { echo "deel-install: $*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

fetch_to() {
  if have curl; then
    curl -fsSL "$1" -o "$2"
  elif have wget; then
    wget -qO "$2" "$1"
  else
    err "need curl or wget"
  fi
}

canon_dir() { (cd "$1" 2>/dev/null && pwd -P) || echo "$1"; }

sha256_of() {
  if have sha256sum; then
    sha256sum "$1" | awk '{print $1}'
  elif have shasum; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    err "need sha256sum or shasum to verify download"
  fi
}

# Warn when a different deel comes first on PATH: that one runs, not the one just installed.
warn_if_shadowed() {
  first=""
  oldifs="$IFS"
  IFS=":"
  for p in $PATH; do
    [ -n "$p" ] || p="$PWD"
    if [ -f "$p/deel" ] && [ -x "$p/deel" ]; then first="$p"; break; fi
  done
  IFS="$oldifs"
  if [ -n "$first" ] && [ "$(canon_dir "$first")" != "$(canon_dir "$1")" ]; then
    other="$first/deel"
    target="$(readlink "$other" 2>/dev/null || true)"
    echo "deel-install: warning: another deel is first on your PATH and will run instead:" >&2
    echo "deel-install:   $other${target:+ -> $target}" >&2
    case "$target$other" in
      *node_modules*) echo "deel-install: it looks like an npm install; remove it with: npm uninstall -g @deel-org/cli" >&2 ;;
      *) echo "deel-install: remove it, or put $1 earlier on your PATH." >&2 ;;
    esac
    echo "deel-install: then run 'hash -r' (or open a new terminal) so your shell forgets the old location." >&2
  fi
}

main() {
  os="$(uname -s)"
  case "$os" in
    Darwin) os="darwin" ;;
    Linux) os="linux" ;;
    *) err "unsupported OS '$os' — on Windows use: npm i -g @deel-org/cli" ;;
  esac

  arch="$(uname -m)"
  case "$arch" in
    x86_64 | amd64) arch="x64" ;;
    aarch64 | arm64) arch="arm64" ;;
    *) err "unsupported architecture '$arch'" ;;
  esac

  # glibc vs musl (Alpine). Bun's glibc binaries won't run on musl.
  suffix=""
  if [ "$os" = "linux" ]; then
    if (ldd --version 2>&1 | grep -qi musl) \
      || [ -e /lib/ld-musl-x86_64.so.1 ] || [ -e /lib/ld-musl-aarch64.so.1 ]; then
      suffix="-musl"
    fi
  fi

  asset="deel-${os}-${arch}${suffix}"
  version="${1:-${DEEL_VERSION:-$DEFAULT_VERSION}}"
  if [ "$version" = "latest" ]; then
    base="https://github.com/${REPO}/releases/latest/download"
  else
    base="https://github.com/${REPO}/releases/download/${version}"
  fi
  url="${base}/${asset}"
  sumsurl="${base}/SHA256SUMS"
  sigurl="${base}/SHA256SUMS.sigstore"

  if [ -n "${DEEL_INSTALL_DIR:-}" ]; then
    dir="$DEEL_INSTALL_DIR"
  elif [ -w /usr/local/bin ] 2>/dev/null; then
    dir="/usr/local/bin"
  else
    dir="$HOME/.local/bin"
  fi
  mkdir -p "$dir"

  echo "deel-install: downloading $asset ($version) -> $dir/deel"
  tmp="$(mktemp)"
  tmpsum="$(mktemp)"
  tmpsig="$(mktemp)"
  keyfile="$(mktemp)"
  trap 'rm -f "$tmp" "$tmpsum" "$tmpsig" "$keyfile"' EXIT

  fetch_to "$url" "$tmp" || err "download failed: $url"
  fetch_to "$sumsurl" "$tmpsum" || err "download failed: $sumsurl"

  # Integrity: binary matches the published checksum.
  expected=$(grep "  ${asset}$" "$tmpsum" | awk '{print $1}')
  [ -n "$expected" ] || err "${asset} not found in SHA256SUMS"
  actual=$(sha256_of "$tmp")
  [ "$expected" = "$actual" ] || err "checksum mismatch (expected $expected, got $actual)"

  # Authenticity: verify the signed SHA256SUMS when a key is embedded and cosign is present.
  if [ -z "$COSIGN_PUBLIC_KEY" ]; then
    if [ "${DEEL_REQUIRE_COSIGN:-}" = "1" ]; then err "no embedded signing key to verify against (DEEL_REQUIRE_COSIGN=1)"; fi
    echo "deel-install: no embedded signing key — skipping signature check (checksum still verified)." >&2
  elif have cosign; then
    fetch_to "$sigurl" "$tmpsig" || err "signature download failed: $sigurl"
    printf '%s\n' "$COSIGN_PUBLIC_KEY" > "$keyfile"
    # Key-based signing skips the transparency log, so ignore it.
    if cosign verify-blob --key "$keyfile" --bundle "$tmpsig" --insecure-ignore-tlog "$tmpsum" >/dev/null 2>&1; then
      echo "deel-install: signature verified"
    else
      err "cosign signature verification FAILED for SHA256SUMS — aborting"
    fi
  elif [ "${DEEL_REQUIRE_COSIGN:-}" = "1" ]; then
    err "cosign is required (DEEL_REQUIRE_COSIGN=1) but not installed"
  else
    echo "deel-install: cosign not found — skipping signature check (checksum still verified)." >&2
    echo "deel-install: install cosign, or set DEEL_REQUIRE_COSIGN=1, to require signature verification." >&2
  fi

  chmod +x "$tmp"
  mv "$tmp" "$dir/deel"

  # Re-sign ad hoc when the installed macOS binary's signature does not verify.
  if [ "$os" = "darwin" ] && have codesign && ! codesign --verify "$dir/deel" >/dev/null 2>&1; then
    echo "deel-install: embedded code signature is invalid — re-signing $dir/deel ad hoc" >&2
    codesign --force --sign - "$dir/deel" >/dev/null 2>&1 || err "could not re-sign $dir/deel (try: codesign --force --sign - $dir/deel)"
  fi

  # The binary must run, but report PATH problems too before failing: the user may have both.
  problem=""
  if smoke="$("$dir/deel" --version 2>&1)"; then
    echo "deel-install: installed to $dir/deel"
  else
    rc=$?
    if [ "$rc" -gt 128 ]; then problem="terminated by signal $((rc - 128))"; else problem="exit $rc: $smoke"; fi
  fi

  warn_if_shadowed "$dir"
  [ -z "$problem" ] || err "the installed binary did not run: $problem ($dir/deel)"

  case ":$PATH:" in
    *":$dir:"*) : ;;
    *) echo "deel-install: add $dir to your PATH to run 'deel'." ;;
  esac
}

main "$@"
