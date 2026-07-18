#!/usr/bin/env bash
# Upload a build's hashed static assets to the Bunny storage zone that backs
# the /_next/static edge rule (issue #1318; the deploy-skew rationale is issue
# #1350: old builds' assets must stay servable after a deploy deletes them from
# the origin).
#
# Usage: upload-bunny-static.sh <local-static-dir>
#   <local-static-dir> is a directory whose contents are the files served under
#   /_next/static (i.e. the image's /app/.next/static).
#
# Env:
#   BUNNY_STORAGE_ZONE_NAME     - storage zone name (required)
#   BUNNY_STORAGE_ZONE_PASSWORD - storage zone password/API key (required;
#                                 NOT the account API key)
#   BUNNY_STORAGE_ENDPOINT      - optional endpoint base URL, default
#                                 https://storage.bunnycdn.com (use a region
#                                 endpoint like https://ny.storage.bunnycdn.com
#                                 if the zone's primary region isn't Falkenstein)
#
# Uploads are ADDITIVE: nothing is ever deleted, so previous builds' hashed
# files keep working for any HTML that still references them (that persistence
# is the whole point — do not "sync" with deletion). Files are content-hashed
# and immutable, so re-uploading an existing path is a harmless no-op write.
set -euo pipefail

STATIC_DIR="${1:?usage: upload-bunny-static.sh <local-static-dir>}"
: "${BUNNY_STORAGE_ZONE_NAME:?BUNNY_STORAGE_ZONE_NAME is required}"
: "${BUNNY_STORAGE_ZONE_PASSWORD:?BUNNY_STORAGE_ZONE_PASSWORD is required}"
ENDPOINT="${BUNNY_STORAGE_ENDPOINT:-https://storage.bunnycdn.com}"

if [ ! -d "$STATIC_DIR" ]; then
  echo "error: $STATIC_DIR is not a directory" >&2
  exit 1
fi

cd "$STATIC_DIR"
# Newline-delimited list is safe: Next.js asset names are hashed and never
# contain newlines (xargs -I switches to newline delimiting, so spaces are
# fine too).
FILES=$(find . -type f | sed 's|^\./||')
if [ -z "$FILES" ]; then
  # An empty static dir means the extraction step grabbed the wrong path —
  # fail rather than "successfully" uploading nothing and releasing.
  echo "error: no files found under $STATIC_DIR" >&2
  exit 1
fi
COUNT=$(printf '%s\n' "$FILES" | wc -l)
echo "Uploading $COUNT files from $STATIC_DIR to storage zone '$BUNNY_STORAGE_ZONE_NAME' under _next/static/"

# 8-way parallel PUTs; curl -sf makes any HTTP error fail that file, and
# xargs propagates a non-zero exit so the workflow fails loudly rather than
# releasing a build whose assets didn't all land.
printf '%s\n' "$FILES" | xargs -P 8 -I {} \
  curl -sf -o /dev/null --retry 3 --retry-all-errors -X PUT \
    -H "AccessKey: ${BUNNY_STORAGE_ZONE_PASSWORD}" \
    --data-binary "@{}" \
    "${ENDPOINT}/${BUNNY_STORAGE_ZONE_NAME}/_next/static/{}"

echo "Upload complete ($COUNT files)"
