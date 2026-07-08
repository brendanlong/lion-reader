import { describe, it, expect } from "vitest";
import { parseScopes, OAUTH_SCOPES } from "@/server/oauth/utils";

describe("parseScopes", () => {
  it("returns [] for empty/undefined input", () => {
    expect(parseScopes(undefined)).toEqual([]);
    expect(parseScopes("")).toEqual([]);
  });

  it("parses known scope values", () => {
    expect(parseScopes("mcp")).toEqual(["mcp"]);
    expect(parseScopes("mcp saved:write")).toEqual(["mcp", "saved:write"]);
  });

  it("drops unknown scopes", () => {
    expect(parseScopes("mcp bogus admin")).toEqual(["mcp"]);
  });

  it("does NOT accept enum KEY names as scopes", () => {
    // Regression: `s in OAUTH_SCOPES` used to match the uppercase keys
    // ("MCP", "SAVED_WRITE", "READER_FULL_ACCESS"), treating them as valid.
    for (const key of Object.keys(OAUTH_SCOPES)) {
      expect(parseScopes(key)).toEqual([]);
    }
  });
});
