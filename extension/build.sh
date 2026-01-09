#!/bin/bash
#
# Build script for Lion Reader browser extension.
# Creates a zip file ready for submission to browser extension stores.
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

OUTPUT_FILE="lion-reader-extension.zip"

# Remove old build if it exists
rm -f "$OUTPUT_FILE"

# Create zip file with all extension files
zip -r "$OUTPUT_FILE" \
  manifest.json \
  icons/ \
  src/ \
  -x "*.DS_Store" \
  -x "*__MACOSX*"

echo "Built: $OUTPUT_FILE"
echo "Size: $(du -h "$OUTPUT_FILE" | cut -f1)"
