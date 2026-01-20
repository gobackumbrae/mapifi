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

# Minimal encoding for GitHub content paths (good enough for our emoji names)
enc_spaces() { printf '%s' "${1// /%20}"; }

pick_style_and_png_path () {
  local repo="$1"
  local base="assets/${EMOJI_NAME}"
  local base_api
  base_api="$(enc_spaces "$base")"

  local styles
  styles="$(gh api "repos/${repo}/contents/${base_api}?ref=main" --jq '.[].name' 2>/dev/null || true)"
  [ -n "$styles" ] || return 1

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

  local p
  p="$(gh api "repos/${repo}/contents/${base_api}/${style_api}?ref=main" \
        --jq '.[] | select(.name|endswith(".png")) | .path' 2>/dev/null | head -n 1 || true)"
  [ -n "$p" ] || return 1

  printf '%s|%s\n' "$repo" "$p"
}

is_png () {
  local f="$1"
  local sig
  sig="$(head -c 8 "$f" | od -An -tx1 | tr -d ' \n')"
  [ "$sig" = "89504e470d0a1a0a" ]
}

try_download () {
  local url="$1"
  local tmp="$2"

  [ -n "$url" ] || return 1

  if curl -L --fail --retry 2 --retry-delay 1 "$url" -o "$tmp" >/dev/null 2>&1; then
    if is_png "$tmp"; then
      return 0
    fi
  fi

  return 1
}

download_png_validate () {
  local repo="$1"
  local path="$2"

  local tmp="${OUT}.tmp"
  rm -f "$tmp"

  # 1) Prefer GitHub API download_url (raw) — works for normal git blobs
  local path_api
  path_api="$(enc_spaces "$path")"

  local raw_url
  raw_url="$(gh api "repos/${repo}/contents/${path_api}?ref=main" --jq '.download_url' 2>/dev/null || true)"

  if try_download "$raw_url" "$tmp"; then
    mv -f "$tmp" "$OUT"
    return 0
  fi

  # 2) Fallback to media.githubusercontent.com — works for LFS/large binaries
  local path_url
  path_url="$(enc_spaces "$path")"
  local media_url="https://media.githubusercontent.com/media/${repo}/main/${path_url}"

  if try_download "$media_url" "$tmp"; then
    mv -f "$tmp" "$OUT"
    return 0
  fi

  rm -f "$tmp" || true
  echo "ERROR: Could not download a valid PNG for repo=${repo} path=${path}" >&2
  echo "Tried raw_url:   ${raw_url:-<none>}" >&2
  echo "Tried media_url: ${media_url}" >&2
  return 1
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
