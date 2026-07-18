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
#                                 https://storage.bunnycdn.com. That default is
#                                 ONLY valid for zones whose primary region is
#                                 Falkenstein — any other region needs its
#                                 region endpoint (e.g. https://la.storage.bunnycdn.com,
#                                 https://ny.storage.bunnycdn.com) or every
#                                 request 401s.
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
# Exported for the per-file sh -c workers spawned by xargs below.
export BUNNY_STORAGE_ZONE_NAME BUNNY_STORAGE_ZONE_PASSWORD ENDPOINT

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

# Preflight one cheap authenticated request so a bad credential or wrong
# region endpoint fails in seconds with a diagnosis, instead of 240 files
# each silently retrying a 401 (which looks like a hang in CI logs).
# curl prints 000 via -w itself when the connection fails; || true keeps
# set -e from aborting before we can report it.
PREFLIGHT_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  --connect-timeout 10 --max-time 30 \
  -H "AccessKey: ${BUNNY_STORAGE_ZONE_PASSWORD}" \
  "${ENDPOINT}/${BUNNY_STORAGE_ZONE_NAME}/" || true)
PREFLIGHT_CODE="${PREFLIGHT_CODE:-000}"
if [ "$PREFLIGHT_CODE" != "200" ]; then
  {
    echo "error: preflight GET ${ENDPOINT}/${BUNNY_STORAGE_ZONE_NAME}/ returned HTTP ${PREFLIGHT_CODE}"
    echo "  401: wrong password (must be the STORAGE ZONE password, not the account API key)"
    echo "       or wrong region endpoint — a zone whose primary region isn't Falkenstein"
    echo "       needs BUNNY_STORAGE_ENDPOINT, e.g. https://la.storage.bunnycdn.com"
    echo "  404: wrong BUNNY_STORAGE_ZONE_NAME"
    echo "  000: connection failed or timed out"
  } >&2
  exit 1
fi

echo "Uploading $COUNT files from $STATIC_DIR to storage zone '$BUNNY_STORAGE_ZONE_NAME' under _next/static/"

# 8-way parallel PUTs. Each worker has hard timeouts so a stalled connection
# can't hang the deploy, and prints the failing path so CI logs show what
# broke; any failure makes xargs exit non-zero, aborting before release.
printf '%s\n' "$FILES" | xargs -P 8 -I {} sh -c '
  curl -sS -f -o /dev/null \
    --connect-timeout 10 --max-time 120 \
    --retry 3 --retry-all-errors -X PUT \
    -H "AccessKey: ${BUNNY_STORAGE_ZONE_PASSWORD}" \
    --data-binary "@$1" \
    "${ENDPOINT}/${BUNNY_STORAGE_ZONE_NAME}/_next/static/$1" \
  || { echo "upload FAILED: $1" >&2; exit 1; }
' upload-one {}

echo "Upload complete ($COUNT files)"
