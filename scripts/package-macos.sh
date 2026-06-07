#!/usr/bin/env bash
# Build a self-contained macOS Jobomate.app bundle carrying the official logo icon.
# Usage: scripts/package-macos.sh [osx-arm64|osx-x64]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export DOTNET_ROOT="${DOTNET_ROOT:-$HOME/.dotnet}"
export PATH="$DOTNET_ROOT:$PATH"

ARCH="${1:-osx-arm64}"
APP="$ROOT/dist/Jobomate.app"
PUB="$ROOT/Jobomate.App/bin/Release/net8.0/$ARCH/publish"

echo "==> Publishing self-contained ($ARCH)…"
dotnet publish "$ROOT/Jobomate.App/Jobomate.App.csproj" -c Release -r "$ARCH" \
  --self-contained true -p:PublishSingleFile=false -o "$PUB"

echo "==> Assembling app bundle…"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp -R "$PUB/." "$APP/Contents/MacOS/"
cp "$ROOT/Jobomate.App/Resources/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"

# Bundle the LM_Browser desktop app (Jobomate's built-in LLM Browser) into Resources, if present.
LM_BROWSER="$ROOT/../LLM_Browser/release/mac-arm64/LM_Browser.app"
if [ -d "$LM_BROWSER" ]; then
  echo "==> Bundling LM_Browser…"
  cp -R "$LM_BROWSER" "$APP/Contents/Resources/LM_Browser.app"
else
  echo "==> (LM_Browser not found at $LM_BROWSER — the app will fall back to its dev location at runtime)"
fi

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Jobomate</string>
  <key>CFBundleDisplayName</key><string>Jobomate</string>
  <key>CFBundleIdentifier</key><string>com.jobomate.app</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>Jobomate</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

chmod +x "$APP/Contents/MacOS/Jobomate"
codesign --force --deep --sign - "$APP" 2>/dev/null && echo "==> Ad-hoc signed." || echo "==> (ad-hoc signing skipped)"
echo "==> Built: $APP"
