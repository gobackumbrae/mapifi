#!/usr/bin/env bash
set -euo pipefail

EMOJI_NAME="Bus"
OUT="public/emoji/bus.png"

REPO_ANIM="microsoft/fluentui-emoji-animated"
REPO_STATIC="microsoft/fluentui-emoji"

mkdir -p "$(dirname "$OUT")"

pick_png_path () {
  local repo="$1"
  local base="assets/${EMOJI_NAME}"

  # Prefer 3D if present
  if gh api "repos/${repo}/contents/${base}/3D?ref=main" >/dev/null 2>&1; then
    gh api "repos/${repo}/contents/${base}/3D?ref=main" \
      --jq '.[] | select(.name|endswith(".png")) | .path' | head -n 1
    return 0
  fi

  # Otherwise pick the first style folder, then first png in it
  local style
  style="$(gh api "repos/${repo}/contents/${base}?ref=main" --jq '.[].name' | head -n 1)"
  gh api "repos/${repo}/contents/${base}/${style}?ref=main" \
    --jq '.[] | select(.name|endswith(".png")) | .path' | head -n 1
}

download_and_validate () {
  local repo="$1"
  local path="$2"

  # Try github.com/raw first (sometimes works for LFS via redirects)
  local url1="https://github.com/${repo}/raw/main/${path}"
  curl -L --fail "$url1" -o "$OUT"

  local sig
  sig="$(head -c 8 "$OUT" | od -An -tx1 | tr -d ' \n')"
  if [ "$sig" = "89504e470d0a1a0a" ]; then
    return 0
  fi

  # If not PNG, retry via media.githubusercontent.com (works for LFS binaries)
  local url2="https://media.githubusercontent.com/media/${repo}/main/${path}"
  curl -L --fail "$url2" -o "$OUT"

  sig="$(head -c 8 "$OUT" | od -An -tx1 | tr -d ' \n')"
  if [ "$sig" != "89504e470d0a1a0a" ]; then
    echo "ERROR: Downloaded file is still not a PNG. First lines are:" >&2
    head -n 5 "$OUT" || true
    exit 1
  fi
}

REPO="$REPO_ANIM"
PNG_PATH="$(pick_png_path "$REPO" || true)"

if [ -z "${PNG_PATH}" ]; then
  echo "Animated Bus not found; falling back to static Fluent emoji." >&2
  REPO="$REPO_STATIC"
  PATH="$(pick_png_path "$REPO")"
fi

echo "Using: $REPO / $PNG_PATH"
download_and_validate "$REPO" "$PNG_PATH"

echo "OK saved: $OUT"
ls -la "$OUT"
