import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { OPENAPI_SNAPSHOT_PATH, renderOpenApiSnapshot } from "../../scripts/generate-openapi";

describe("OpenAPI snapshot", () => {
  it("matches the committed docs/api/openapi.json (run `pnpm openapi:generate`)", () => {
    expect(readFileSync(OPENAPI_SNAPSHOT_PATH, "utf8")).toBe(renderOpenApiSnapshot());
  });
});
