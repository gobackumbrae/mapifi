#!/usr/bin/env bash
set -euo pipefail

OUT_DIR="public/emoji"
OUT_FILE="${OUT_DIR}/bus.png"
EMOJI="Bus"

mkdir -p "$OUT_DIR"

find_dir() {
  local repo="$1"
  gh api "repos/${repo}/contents/assets?ref=main" --jq '.[].name' \
    | grep -i "^${EMOJI}$" \
    | head -n 1 \
    || true
}

pick_style() {
  local repo="$1"
  local dir="$2"

  local style=""
  style="$(gh api "repos/${repo}/contents/assets/${dir}?ref=main" --jq '.[].name' \
    | grep -i -E '^(3d|color|flat)$' \
    | head -n 1 \
    || true)"

  if [ -z "$style" ]; then
    style="$(gh api "repos/${repo}/contents/assets/${dir}?ref=main" --jq '.[].name' | head -n 1)"
  fi

  printf '%s' "$style"
}

download_first_png() {
  local repo="$1"
  local dir="$2"
  local style="$3"

  local url=""
  url="$(gh api "repos/${repo}/contents/assets/${dir}/${style}?ref=main" \
    --jq '.[] | select(.name|endswith(".png")) | .download_url' \
    | head -n 1)"

  echo "Downloading:"
  echo "$url"

  curl -L "$url" -o "$OUT_FILE"
}

REPO="microsoft/fluentui-emoji-animated"
DIR="$(find_dir "$REPO")"

if [ -z "$DIR" ]; then
  echo "Animated '${EMOJI}' not found in ${REPO}; falling back to microsoft/fluentui-emoji" >&2
  REPO="microsoft/fluentui-emoji"
  DIR="$(find_dir "$REPO")"
fi

if [ -z "$DIR" ]; then
  echo "Could not find '${EMOJI}' in either Fluent emoji repo." >&2
  exit 1
fi

STYLE="$(pick_style "$REPO" "$DIR")"
download_first_png "$REPO" "$DIR" "$STYLE"

echo "Saved:"
ls -la "$OUT_FILE"
