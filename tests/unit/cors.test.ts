/**
 * Unit tests for the MCP/OAuth CORS helpers.
 *
 * In-browser MCP clients (MCP Inspector "Quick OAuth", playgrounds) fetch the
 * OAuth/MCP endpoints cross-origin, so the preflight must succeed and responses
 * must carry Access-Control headers, including exposing WWW-Authenticate.
 */

import { describe, it, expect } from "vitest";
import { withMcpCorsHeaders, mcpCorsPreflight } from "../../src/server/http/cors";

describe("mcpCorsPreflight", () => {
  it("returns 204 with permissive CORS headers", () => {
    const res = mcpCorsPreflight();
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
  });
});

describe("withMcpCorsHeaders", () => {
  it("adds CORS headers to an existing response without changing status/body", () => {
    const res = withMcpCorsHeaders(
      new Response(JSON.stringify({ ok: true }), {
        status: 401,
        headers: { "WWW-Authenticate": 'Bearer resource_metadata="x"' },
      })
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    // Existing headers are preserved.
    expect(res.headers.get("WWW-Authenticate")).toBe('Bearer resource_metadata="x"');
    // WWW-Authenticate must be exposed so browsers can read it cross-origin.
    expect(res.headers.get("Access-Control-Expose-Headers")).toContain("WWW-Authenticate");
  });
});
