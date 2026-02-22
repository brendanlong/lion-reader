#!/bin/bash
#
# Build script for Lion Reader browser extension.
# Creates zip files ready for submission to browser extension stores.
# Generates separate builds for Chrome and Firefox due to Manifest V3 differences.
#

set -e

RELEASE=false
for arg in "$@"; do
  case "$arg" in
    --release) RELEASE=true ;;
    *) echo "Unknown option: $arg"; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

BUILD_DIR="$SCRIPT_DIR/build"
CHROME_OUTPUT="lion-reader-chrome.zip"
FIREFOX_OUTPUT="lion-reader-firefox.zip"

if [ "$RELEASE" = true ]; then
  echo "Building RELEASE (localhost permissions removed)..."
fi

# Clean up old builds
rm -rf "$BUILD_DIR"
rm -f "$CHROME_OUTPUT" "$FIREFOX_OUTPUT"

# Create build directory
mkdir -p "$BUILD_DIR"

# Copy common files
cp -r icons src "$BUILD_DIR/"

# Build Chrome extension (uses service_worker)
echo "Building Chrome extension..."
node -e '
const fs = require("fs");
const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));

const release = process.argv[1] === "true";
if (release) {
  manifest.host_permissions = manifest.host_permissions.filter(
    (p) => !p.includes("localhost")
  );
}

fs.writeFileSync("build/manifest.json", JSON.stringify(manifest, null, 2));
' "$RELEASE"
(cd "$BUILD_DIR" && zip -r "../$CHROME_OUTPUT" . -x "*.DS_Store" -x "*__MACOSX*")
echo "Built: $CHROME_OUTPUT ($(du -h "$CHROME_OUTPUT" | cut -f1))"

# Build Firefox extension (uses scripts instead of service_worker)
echo "Building Firefox extension..."
# Firefox requires "scripts" array instead of "service_worker" for background
node -e '
const fs = require("fs");
const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));

// Firefox uses scripts array instead of service_worker
manifest.background = {
  scripts: [manifest.background.service_worker],
  type: manifest.background.type
};

const release = process.argv[1] === "true";
if (release) {
  manifest.host_permissions = manifest.host_permissions.filter(
    (p) => !p.includes("localhost")
  );
}

fs.writeFileSync("build/manifest.json", JSON.stringify(manifest, null, 2));
' "$RELEASE"
(cd "$BUILD_DIR" && zip -r "../$FIREFOX_OUTPUT" . -x "*.DS_Store" -x "*__MACOSX*")
echo "Built: $FIREFOX_OUTPUT ($(du -h "$FIREFOX_OUTPUT" | cut -f1))"

# Clean up
rm -rf "$BUILD_DIR"

echo ""
echo "Done! Extension packages ready for store submission."
