#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

FETCH="./scripts/fetch-fluent-emoji.sh"
OUTDIR="public/emoji"
mkdir -p "$OUTDIR"

# Format:
#   "output.png|Name1|Name2|Name3..."
items=(
  "bus.png|Bus"
  "tram.png|Tram"
  "light-rail.png|Light Rail|Light rail|Tram"
  "train.png|Train|High-Speed Train|Locomotive"
  "metro.png|Metro"
  "ferry.png|Ferry"
  "ship.png|Ship"
  "taxi.png|Taxi"
  "car.png|Automobile|Car"
  "bicycle.png|Bicycle|Bike"
  "motorcycle.png|Motorcycle"
  "airplane.png|Airplane"
)

fails=0

for item in "${items[@]}"; do
  IFS='|' read -r -a parts <<< "$item"
  file="${parts[0]}"
  out="${OUTDIR}/${file}"

  echo
  echo "==> ${file}"

  ok=0
  for ((i=1; i<${#parts[@]}; i++)); do
    name="${parts[i]}"
    echo "    trying: ${name}"
    if "$FETCH" "$name" "$out"; then
      ok=1
      break
    fi
  done

  if [ "$ok" -ne 1 ]; then
    echo "WARN: failed to fetch ${file}" >&2
    fails=$((fails+1))
  fi
done

echo
echo "Pack finished. failures=$fails"
du -sh "$OUTDIR" || true
ls -lh "$OUTDIR" || true
