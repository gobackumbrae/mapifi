#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

FETCH="./scripts/fetch-fluent-emoji.sh"
OUTDIR="public/emoji"
mkdir -p "$OUTDIR"

# "All" (transport-focused) pack:
# Add/remove items freely.
items=(
  "Bus|bus.png"
  "Tram|tram.png"
  "Light Rail|light-rail.png"
  "Train|train.png"
  "Metro|metro.png"
  "Subway|subway.png"
  "Ferry|ferry.png"
  "Ship|ship.png"
  "Taxi|taxi.png"
  "Automobile|car.png"
  "Bicycle|bicycle.png"
  "Motorcycle|motorcycle.png"
  "Airplane|airplane.png"
)

fails=0
for item in "${items[@]}"; do
  emoji="${item%%|*}"
  file="${item#*|}"
  out="${OUTDIR}/${file}"

  echo
  echo "==> ${emoji} -> ${out}"
  if "$FETCH" "$emoji" "$out"; then
    :
  else
    echo "WARN: failed to fetch '${emoji}'" >&2
    fails=$((fails+1))
  fi
done

echo
echo "Pack finished. failures=$fails"
du -sh "$OUTDIR" || true
ls -lh "$OUTDIR" || true
