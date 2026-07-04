/**
 * Unit tests for RFC 8707 resource indicator matching.
 *
 * See issue #870: OAuth tokens are audience-bound to this server's MCP
 * endpoint; the resource indicator is validated server-side at authorization
 * time and again at /api/mcp.
 */

import { describe, it, expect } from "vitest";
import { isResourceForThisServer } from "../../src/server/oauth/utils";

const CANONICAL = "https://reader.example.com";

describe("isResourceForThisServer", () => {
  it("matches the exact canonical resource", () => {
    expect(isResourceForThisServer(CANONICAL, CANONICAL)).toBe(true);
  });

  it("ignores a trailing slash difference", () => {
    expect(isResourceForThisServer("https://reader.example.com/", CANONICAL)).toBe(true);
    expect(isResourceForThisServer(CANONICAL, "https://reader.example.com/")).toBe(true);
  });

  it("is case-insensitive for scheme and host", () => {
    expect(isResourceForThisServer("HTTPS://Reader.Example.com", CANONICAL)).toBe(true);
  });

  it("matches when both include the same path", () => {
    expect(
      isResourceForThisServer(
        "https://reader.example.com/api/mcp",
        "https://reader.example.com/api/mcp"
      )
    ).toBe(true);
  });

  it("rejects a different host", () => {
    expect(isResourceForThisServer("https://evil.example.com", CANONICAL)).toBe(false);
  });

  it("rejects a different scheme", () => {
    expect(isResourceForThisServer("http://reader.example.com", CANONICAL)).toBe(false);
  });

  it("rejects a different port", () => {
    expect(isResourceForThisServer("https://reader.example.com:8443", CANONICAL)).toBe(false);
  });

  it("rejects a different path", () => {
    expect(isResourceForThisServer("https://reader.example.com/other", CANONICAL)).toBe(false);
  });

  it("rejects a resource with a fragment (RFC 8707 forbids fragments)", () => {
    expect(isResourceForThisServer("https://reader.example.com/#frag", CANONICAL)).toBe(false);
  });

  it("rejects malformed / non-absolute resources", () => {
    expect(isResourceForThisServer("not-a-url", CANONICAL)).toBe(false);
    expect(isResourceForThisServer("", CANONICAL)).toBe(false);
    expect(isResourceForThisServer("/relative/path", CANONICAL)).toBe(false);
  });

  describe("with a list of accepted identifiers", () => {
    // The canonical resource is the MCP endpoint, but the bare origin is kept as
    // an accepted audience for tokens minted before the identifier change.
    const ACCEPTED = ["https://reader.example.com/api/mcp", "https://reader.example.com"];

    it("matches the canonical MCP-endpoint identifier", () => {
      expect(isResourceForThisServer("https://reader.example.com/api/mcp", ACCEPTED)).toBe(true);
    });

    it("matches the legacy origin identifier (backward compat)", () => {
      expect(isResourceForThisServer("https://reader.example.com", ACCEPTED)).toBe(true);
      expect(isResourceForThisServer("https://reader.example.com/", ACCEPTED)).toBe(true);
    });

    it("rejects a resource matching none of the accepted identifiers", () => {
      expect(isResourceForThisServer("https://reader.example.com/other", ACCEPTED)).toBe(false);
      expect(isResourceForThisServer("https://evil.example.com", ACCEPTED)).toBe(false);
    });

    it("rejects malformed resources against a list", () => {
      expect(isResourceForThisServer("not-a-url", ACCEPTED)).toBe(false);
    });
  });
});
