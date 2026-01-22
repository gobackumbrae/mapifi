#!/usr/bin/env bash
set -euo pipefail

REPO="microsoft/fluentui-emoji"
OUTDIR="public/emoji/static"

command -v gh >/dev/null 2>&1 || { echo "ERROR: gh not found" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "ERROR: curl not found (Termux: pkg install -y curl)" >&2; exit 1; }

mkdir -p "$OUTDIR"

enc_spaces() { printf '%s' "${1// /%20}"; }

pick_png_combo() {
  local emoji="$1"
  local base="assets/${emoji}"
  local base_api
  base_api="$(enc_spaces "$base")"

  local styles
  styles="$(gh api "repos/${REPO}/contents/${base_api}?ref=main" \
    --jq '.[] | select(.type=="dir") | .name' 2>/dev/null || true)"
  [ -n "$styles" ] || return 1

  local style=""
  for pref in 3D Color Flat "High Contrast"; do
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

  local combo
  combo="$(gh api "repos/${REPO}/contents/${base_api}/${style_api}?ref=main" \
    --jq '.[] | select(.type=="file") | select(.name|endswith(".png")) | (.path + "|" + .download_url)' \
    2>/dev/null | head -n 1 || true)"
  [ -n "$combo" ] || return 1

  printf '%s\n' "$combo"
}

download_png() {
  local emoji="$1"
  local out="$2"

  local combo
  combo="$(pick_png_combo "$emoji")" || { echo "WARN: not found in static repo: $emoji" >&2; return 1; }

  local path="${combo%%|*}"
  local url="${combo#*|}"

  rm -f "${out}.tmp" 2>/dev/null || true

  curl -L --fail "$url" -o "${out}.tmp" || true

  local sig
  sig="$(head -c 8 "${out}.tmp" 2>/dev/null | od -An -tx1 | tr -d ' \n' || true)"
  if [ "$sig" != "89504e470d0a1a0a" ]; then
    local path_url
    path_url="$(enc_spaces "$path")"
    local url2="https://media.githubusercontent.com/media/${REPO}/main/${path_url}"
    curl -L --fail "$url2" -o "${out}.tmp"
    sig="$(head -c 8 "${out}.tmp" | od -An -tx1 | tr -d ' \n')"
  fi

  if [ "$sig" != "89504e470d0a1a0a" ]; then
    echo "ERROR: downloaded file is not a PNG for $emoji -> $out" >&2
    head -n 5 "${out}.tmp" >&2 || true
    rm -f "${out}.tmp" 2>/dev/null || true
    return 1
  fi

  mv -f "${out}.tmp" "$out"
  echo "OK: $emoji -> $out ($(ls -lh "$out" | awk '{print $5}'))"
}

items=(
  "Bus|bus.png"
  "Ferry|ferry.png"
  "Ship|ship.png"
  "Taxi|taxi.png"
  "Automobile|car.png"
  "Motorcycle|motorcycle.png"
  "Airplane|airplane.png"
)

fails=0
for item in "${items[@]}"; do
  emoji="${item%%|*}"
  file="${item#*|}"
  out="${OUTDIR}/${file}"
  if ! download_png "$emoji" "$out"; then
    fails=$((fails+1))
  fi
done

echo "Done. failures=$fails"
ls -lh "$OUTDIR" || true
