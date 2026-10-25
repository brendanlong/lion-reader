/**
 * Unit tests for the shared Authorization: Bearer header parser.
 */

import { describe, it, expect } from "vitest";
import { extractBearerToken } from "../../src/server/auth/bearer";

describe("extractBearerToken", () => {
  it("extracts the token from a well-formed header", () => {
    expect(extractBearerToken("Bearer abc123")).toBe("abc123");
  });

  it("is case-insensitive on the scheme (RFC 7235)", () => {
    expect(extractBearerToken("bearer abc123")).toBe("abc123");
    expect(extractBearerToken("BEARER abc123")).toBe("abc123");
  });

  it("tolerates extra whitespace and tabs around the token", () => {
    expect(extractBearerToken("Bearer   abc123")).toBe("abc123");
    expect(extractBearerToken("Bearer\tabc123")).toBe("abc123");
    expect(extractBearerToken("Bearer abc123   ")).toBe("abc123");
  });

  it("returns null for missing, empty, or non-Bearer headers", () => {
    expect(extractBearerToken(null)).toBeNull();
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken("")).toBeNull();
    expect(extractBearerToken("Basic dXNlcjpwYXNz")).toBeNull();
    expect(extractBearerToken("Bearer")).toBeNull(); // no separator
    expect(extractBearerToken("Bearer    ")).toBeNull(); // no token
    expect(extractBearerToken(" Bearer abc")).toBeNull(); // leading space => scheme mismatch
  });

  it("does not include the GoogleLogin scheme", () => {
    expect(extractBearerToken("GoogleLogin auth=token")).toBeNull();
  });

  it("resolves a crafted whitespace-heavy header quickly (no ReDoS)", () => {
    const evil = `Bearer ${" ".repeat(200_000)}\n`;
    const start = Date.now();
    expect(extractBearerToken(evil)).toBeNull();
    expect(Date.now() - start).toBeLessThan(100);
  });
});
