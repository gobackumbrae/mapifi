#!/usr/bin/env bash
set -euo pipefail
OUT="${1:-}"
shift || true

if [ -z "$OUT" ] || [ "$#" -lt 1 ]; then
  echo "Usage: $0 path/to/output.png \"Name1\" \"Name2\" ..." >&2
  exit 2
fi

for name in "$@"; do
  echo
  echo "Trying animated name: $name"
  if ./scripts/fetch-fluent-emoji-animated-only.sh "$name" "$OUT"; then
    echo "Picked: $name"
    exit 0
  fi
done

echo "ERROR: none of the names had an ANIMATED asset for $OUT" >&2
exit 1
