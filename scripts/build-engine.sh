#!/bin/bash
# Build the headless Jobomate C# engine.
# Produces a self-contained binary at bin/engine/Jobomate
# Requires: dotnet SDK 8.0+

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

echo "=== Building Jobomate engine ==="

# Determine dotnet path
DOTNET="${DOTNET_ROOT:-$HOME/.dotnet}/dotnet"
if [ ! -f "$DOTNET" ]; then
  DOTNET="dotnet"  # fall back to PATH
fi

cd "$REPO_ROOT"

echo "Restoring..."
$DOTNET restore Jobomate.sln

echo "Building engine..."
$DOTNET publish Jobomate.App/Jobomate.App.csproj \
  -c Release \
  --self-contained true \
  -r osx-arm64 \
  -o bin/engine

echo "Running tests..."
$DOTNET test Jobomate.sln --no-restore || echo "⚠ Tests failed (continuing)"

# Verify output
if [ -f bin/engine/Jobomate ]; then
  echo "✓ Engine built: bin/engine/Jobomate"
elif [ -f bin/engine/Jobomate.dll ]; then
  echo "✓ Engine built: bin/engine/Jobomate.dll (framework-dependent)"
else
  echo "⚠ Engine binary not found — check publish output"
fi

echo ""
echo "The Electron app will auto-detect bin/engine/Jobomate on next launch."
echo "For other platforms, change -r flag:"
echo "  macOS arm64: -r osx-arm64"
echo "  macOS x64:   -r osx-x64"
echo "  Windows x64: -r win-x64"
echo "  Linux x64:   -r linux-x64"
