#!/usr/bin/env bash
set -euo pipefail

NAME="${1:-}"
OUT="${2:-}"

if [ -z "$NAME" ] || [ -z "$OUT" ]; then
  echo "Usage: $0 \"Emoji Name\" path/to/output.png" >&2
  exit 2
fi

command -v gh >/dev/null 2>&1 || { echo "ERROR: gh not found" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "ERROR: curl not found (Termux: pkg install -y curl)" >&2; exit 1; }

REPO="microsoft/fluentui-emoji-animated"
enc() { printf '%s' "${1// /%20}"; }

base_api="$(enc "assets/${NAME}")"

# Require a style folder literally named "animated" or "Animated"
style="$(
  gh api "repos/${REPO}/contents/${base_api}?ref=main" --jq '.[].name' 2>/dev/null \
  | { grep -x "animated" || true; } | head -n 1
)"
if [ -z "$style" ]; then
  style="$(
    gh api "repos/${REPO}/contents/${base_api}?ref=main" --jq '.[].name' 2>/dev/null \
    | { grep -x "Animated" || true; } | head -n 1
  )"
fi

if [ -z "$style" ]; then
  echo "ERROR: No ANIMATED asset for '$NAME' in ${REPO} (animated-only mode)." >&2
  exit 1
fi

style_api="$(enc "$style")"

path="$(
  gh api "repos/${REPO}/contents/${base_api}/${style_api}?ref=main" \
    --jq '.[] | select(.name|endswith(".png")) | .path' 2>/dev/null \
  | head -n 1
)"

if [ -z "$path" ]; then
  echo "ERROR: Found animated folder for '$NAME' but no .png inside." >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT")"
url="https://media.githubusercontent.com/media/${REPO}/main/$(enc "$path")"
echo "Downloading animated: $NAME -> $OUT"
echo "  from: $url"

curl -L --fail "$url" -o "$OUT"

sig="$(head -c 8 "$OUT" | od -An -tx1 | tr -d ' \n')"
if [ "$sig" != "89504e470d0a1a0a" ]; then
  echo "ERROR: Downloaded file is not a PNG: $OUT" >&2
  head -n 5 "$OUT" >&2 || true
  exit 1
fi

# Extra sanity: APNGs contain 'acTL' chunk. (Not perfect, but good quick check.)
if ! grep -a -q "acTL" "$OUT"; then
  echo "WARN: '$OUT' looks like a plain PNG (no acTL chunk found). Still keeping it." >&2
fi

ls -lh "$OUT"
