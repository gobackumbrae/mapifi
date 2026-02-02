#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

[ -x ./scripts/fetch-fluent-emoji.sh ] || { echo "ERROR: missing ./scripts/fetch-fluent-emoji.sh" >&2; exit 1; }
[ -x ./scripts/fetch-fluent-emoji-alias.sh ] || { echo "ERROR: missing ./scripts/fetch-fluent-emoji-alias.sh" >&2; exit 1; }

mkdir -p public/emoji

# Side-view, full-body ONLY (no front-only train heads, etc)
./scripts/fetch-fluent-emoji-alias.sh public/emoji/bus.png        "Bus"
./scripts/fetch-fluent-emoji-alias.sh public/emoji/motor-boat.png "Motor boat" "Motor Boat"
./scripts/fetch-fluent-emoji-alias.sh public/emoji/tram-car.png   "Tram car" "Tram Car"
./scripts/fetch-fluent-emoji-alias.sh public/emoji/railway-car.png "Railway car" "Railway Car"
./scripts/fetch-fluent-emoji-alias.sh public/emoji/locomotive.png "Locomotive"
./scripts/fetch-fluent-emoji-alias.sh public/emoji/rocket.png     "Rocket"

echo
echo "== downloaded =="
ls -lh public/emoji/{bus,motor-boat,tram-car,railway-car,locomotive,rocket}.png

echo
echo "== PNG signature check =="
for f in bus motor-boat tram-car railway-car locomotive rocket; do
  printf "%-12s " "$f"
  head -c 8 "public/emoji/${f}.png" | od -An -tx1
done
