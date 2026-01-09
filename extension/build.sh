#!/bin/bash
#
# Build script for Lion Reader browser extension.
# Creates zip files ready for submission to browser extension stores.
# Generates separate builds for Chrome and Firefox due to Manifest V3 differences.
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

BUILD_DIR="$SCRIPT_DIR/build"
CHROME_OUTPUT="lion-reader-chrome.zip"
FIREFOX_OUTPUT="lion-reader-firefox.zip"

# Clean up old builds
rm -rf "$BUILD_DIR"
rm -f "$CHROME_OUTPUT" "$FIREFOX_OUTPUT"

# Create build directory
mkdir -p "$BUILD_DIR"

# Copy common files
cp -r icons src "$BUILD_DIR/"

# Build Chrome extension (uses service_worker)
echo "Building Chrome extension..."
cp manifest.json "$BUILD_DIR/manifest.json"
(cd "$BUILD_DIR" && zip -r "../$CHROME_OUTPUT" . -x "*.DS_Store" -x "*__MACOSX*")
echo "Built: $CHROME_OUTPUT ($(du -h "$CHROME_OUTPUT" | cut -f1))"

# Build Firefox extension (uses scripts instead of service_worker)
echo "Building Firefox extension..."
# Firefox requires "scripts" array instead of "service_worker" for background
# Also add browser_specific_settings for Firefox
node -e '
const fs = require("fs");
const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));

// Firefox uses scripts array instead of service_worker
manifest.background = {
  scripts: [manifest.background.service_worker],
  type: manifest.background.type
};

// Add Firefox-specific settings
manifest.browser_specific_settings = {
  gecko: {
    id: "lion-reader@lionreader.com",
    strict_min_version: "109.0"
  }
};

fs.writeFileSync("build/manifest.json", JSON.stringify(manifest, null, 2));
'
(cd "$BUILD_DIR" && zip -r "../$FIREFOX_OUTPUT" . -x "*.DS_Store" -x "*__MACOSX*")
echo "Built: $FIREFOX_OUTPUT ($(du -h "$FIREFOX_OUTPUT" | cut -f1))"

# Clean up
rm -rf "$BUILD_DIR"

echo ""
echo "Done! Extension packages ready for store submission."
