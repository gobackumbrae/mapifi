#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   scripts/fetch-fluent-emoji.sh "Bus" public/emoji/bus.png

EMOJI_NAME="${1:-}"
OUT="${2:-}"

if [ -z "$EMOJI_NAME" ] || [ -z "$OUT" ]; then
  echo "Usage: $0 \"Emoji Name\" path/to/output.png" >&2
  exit 2
fi

command -v gh >/dev/null 2>&1 || { echo "ERROR: gh not found" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "ERROR: curl not found (Termux: pkg install -y curl)" >&2; exit 1; }

REPO_ANIM="microsoft/fluentui-emoji-animated"
REPO_STATIC="microsoft/fluentui-emoji"

mkdir -p "$(dirname "$OUT")"

# Encode just spaces for GitHub API paths and URLs.
# (Good enough for our emoji names; avoids needing python/jq for full URL encoding.)
enc_spaces() { printf '%s' "${1// /%20}"; }

pick_style_and_png_path () {
  local repo="$1"
  local base="assets/${EMOJI_NAME}"
  local base_api
  base_api="$(enc_spaces "$base")"

  # List style folders under assets/<EMOJI_NAME> (e.g. animated, 3D, Color...)
  local styles
  styles="$(gh api "repos/${repo}/contents/${base_api}?ref=main" --jq '.[].name' 2>/dev/null || true)"
  [ -n "$styles" ] || return 1

  # Prefer animated if it exists, else 3D, else Color, else whatever is first.
  local style=""
  for pref in animated 3D Color Flat "High Contrast"; do
    if printf '%s\n' "$styles" | grep -qx "$pref"; then
      style="$pref"
      break
    fi
  done
  if [ -z "$style" ]; then
    style="$(printf '%s\n' "$styles" | head -n 1)"
  fi

  local style_api
  style_api="$(enc_spaces "$style")"

  # Pick first PNG inside the chosen style folder
  local p
  p="$(gh api "repos/${repo}/contents/${base_api}/${style_api}?ref=main" \
        --jq '.[] | select(.name|endswith(".png")) | .path' 2>/dev/null | head -n 1 || true)"
  [ -n "$p" ] || return 1

  printf '%s|%s\n' "$repo" "$p"
}

download_png_validate () {
  local repo="$1"
  local path="$2"

  # IMPORTANT: use media.githubusercontent.com so we get the *real binary* (not LFS pointer text)
  local path_url
  path_url="$(enc_spaces "$path")"
  local url="https://media.githubusercontent.com/media/${repo}/main/${path_url}"

  curl -L --fail "$url" -o "$OUT"

  # Validate PNG signature
  local sig
  sig="$(head -c 8 "$OUT" | od -An -tx1 | tr -d ' \n')"
  if [ "$sig" != "89504e470d0a1a0a" ]; then
    echo "ERROR: Downloaded file is not a PNG: $OUT" >&2
    echo "First lines:" >&2
    head -n 5 "$OUT" >&2 || true
    exit 1
  fi
}

combo=""
if combo="$(pick_style_and_png_path "$REPO_ANIM")"; then
  repo="${combo%%|*}"
  pth="${combo#*|}"
  echo "Using animated repo: $repo / $pth"
else
  echo "Animated not found for '$EMOJI_NAME' — falling back to static repo." >&2
  combo="$(pick_style_and_png_path "$REPO_STATIC")" || {
    echo "ERROR: Emoji not found in either repo: '$EMOJI_NAME'" >&2
    exit 1
  }
  repo="${combo%%|*}"
  pth="${combo#*|}"
  echo "Using static repo: $repo / $pth"
fi

download_png_validate "$repo" "$pth"
echo "OK saved: $OUT"
ls -lh "$OUT"
