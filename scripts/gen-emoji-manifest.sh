#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="public/emoji/manifest.json"
TMP="$(mktemp)"

printf '{\n' > "$TMP"
first=1

for f in public/emoji/*.png; do
  [ -f "$f" ] || continue
  base="$(basename "$f" .png)"
  src="/emoji/${base}.png"

  # Fluent vehicle emoji default direction: RIGHT (East)
  points=90

  if [ $first -eq 0 ]; then
    printf ',\n' >> "$TMP"
  fi
  first=0
  printf '  "%s": {"src":"%s","pointsToDeg":%s}' "$base" "$src" "$points" >> "$TMP"
done

printf '\n}\n' >> "$TMP"
mv "$TMP" "$OUT"
echo "Wrote $OUT"
