#!/usr/bin/env bash
# Generate Jobomate app icons (macOS .icns + Windows .ico) and the in-app logo
# from a single square source PNG. Uses native macOS sips/iconutil; the .ico is
# packed by scripts/pack-ico.py (no ImageMagick required).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:?usage: generate-icons.sh <source.png>}"
RES="$ROOT/Jobomate.App/Resources"
mkdir -p "$RES"

cp "$SRC" "$RES/JobomateLogo.png"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- macOS .icns ---
ICONSET="$WORK/Jobomate.iconset"
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z "$s" "$s" "$SRC" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  d=$(( s * 2 ))
  sips -z "$d" "$d" "$SRC" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$RES/AppIcon.icns"

# --- Windows .ico (PNG-embedded, 16..256) ---
PNGS=()
for s in 16 32 48 64 128 256; do
  sips -z "$s" "$s" "$SRC" --out "$WORK/i_${s}.png" >/dev/null
  PNGS+=("$WORK/i_${s}.png")
done
python3 "$ROOT/scripts/pack-ico.py" "${PNGS[@]}" "$RES/AppIcon.ico"

echo "Generated:"
ls -la "$RES"
