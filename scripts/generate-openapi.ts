/**
 * Writes the REST API's OpenAPI document to docs/api/openapi.json.
 *
 * The committed copy is the contract installed native apps are built against:
 * CI fails when it's stale (tests/integration/openapi-snapshot.test.ts) and
 * when a change to it is breaking (the `openapi-breaking` CI job).
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openApiDocument } from "../src/server/trpc/openapi";

export const OPENAPI_SNAPSHOT_PATH = "docs/api/openapi.json";

export function renderOpenApiSnapshot(): string {
  return `${JSON.stringify(openApiDocument, null, 2)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(OPENAPI_SNAPSHOT_PATH, renderOpenApiSnapshot());
  console.log(`Wrote ${OPENAPI_SNAPSHOT_PATH}`);
  process.exit(0);
}
