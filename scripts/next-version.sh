#!/usr/bin/env bash
# Next eve-fit-engine version, aligned with the Go twin (tag vX.Y.Z there = X.Y.Z here).
#   auto  (default)  twin's highest tag > mine -> reach the twin's version; otherwise mine + patch
#   sde              strictly above BOTH (patch of the higher): a data release must never reuse a
#                    version the Go twin already tagged with older data
#   minor | major    bump of the higher of the two (manual releases)
# Prints X.Y.Z on stdout. Test hooks: MINE=x.y.z and TWIN=x.y.z (empty = the twin has no tag).
set -euo pipefail
MODE="${1:-auto}"
TWIN_REPO="${TWIN_REPO:-https://github.com/capsuleers-app/capsuleers.fitting-engine-go.git}"
SEMVER='^[0-9]+\.[0-9]+\.[0-9]+$'

gt() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" = "$1" ]; }
bump() {
  local a b c
  IFS=. read -r a b c <<<"$1"
  case "$2" in
    major) echo "$((a + 1)).0.0" ;;
    minor) echo "$a.$((b + 1)).0" ;;
    *) echo "$a.$b.$((c + 1))" ;;
  esac
}

mine="${MINE:-$(node -p "require('./package.json').version")}"
if [ -z "${TWIN+x}" ]; then
  # A network failure must stop the release, not read as "no twin tags" (that would misalign versions).
  refs="$(git ls-remote --tags --refs "$TWIN_REPO" 'v*')"
  TWIN="$(printf '%s\n' "$refs" | sed -n 's#.*refs/tags/v##p' | { grep -E "$SEMVER" || true; } | sort -V | tail -1)"
fi
twin="${TWIN:-0.0.0}"
grep -qE "$SEMVER" <<<"$mine" || { echo "bad package version '$mine'" >&2; exit 1; }
if gt "$twin" "$mine"; then top="$twin"; else top="$mine"; fi

case "$MODE" in
  auto) if gt "$twin" "$mine"; then next="$twin"; else next="$(bump "$mine" patch)"; fi ;;
  sde) next="$(bump "$top" patch)" ;;
  minor | major) next="$(bump "$top" "$MODE")" ;;
  *) echo "usage: next-version.sh [auto|sde|minor|major]" >&2; exit 1 ;;
esac
echo "mine=$mine twin=$twin mode=$MODE -> $next" >&2
echo "$next"
