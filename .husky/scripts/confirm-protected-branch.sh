#!/usr/bin/env bash
# Usage: confirm-protected-branch.sh commit|push
#
# `dev` is this repo's release line: the release pipeline builds and publishes from dev HEAD.
# Committing or pushing to it directly skips PR review and CI, so ask first — and refuse outright
# when there is no terminal to ask on (scripts, CI, editors running hooks non-interactively).
ACTION="${1:-commit}"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

case "$BRANCH" in
  dev|main|master) ;;
  *) exit 0 ;;
esac

if ! reply="$( (printf 'You are on "%s". Really %s directly to "%s"? Use a feature branch instead. (y/N): ' "$BRANCH" "$ACTION" "$BRANCH" > /dev/tty; read -r r < /dev/tty; printf '%s' "$r") 2>/dev/null)"; then
  echo "Refusing to $ACTION on protected branch \"$BRANCH\": no terminal available to confirm. Use a feature branch and open a PR." >&2
  exit 1
fi

case "$reply" in
  y|Y|yes|YES) exit 0 ;;
  *) echo "$ACTION to \"$BRANCH\" aborted." >&2; exit 1 ;;
esac
