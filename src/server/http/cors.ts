/**
 * CORS headers for the OAuth 2.1 + MCP endpoints.
 *
 * claude.ai's connector flow runs discovery/registration/token server-to-server
 * (so CORS is not what gates it), but browser-based MCP clients — the MCP
 * Inspector's "Quick OAuth", Cloudflare's AI Playground, and other in-page
 * clients — fetch these endpoints from the browser and require CORS. These
 * endpoints authenticate with a Bearer token or are public metadata, so no
 * cookies are involved and `Access-Control-Allow-Origin: *` is safe (the token
 * itself is the security boundary, matching the /api/v1/saved endpoint).
 */
const MCP_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  // MCP clients send Authorization + MCP-Protocol-Version; well-known/token/
  // register send Content-Type. Session-based Streamable HTTP uses Mcp-Session-Id.
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, MCP-Protocol-Version, Mcp-Session-Id",
  // Expose the discovery + session headers so in-browser clients can read them
  // (browsers hide response headers cross-origin unless explicitly exposed).
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id",
  "Access-Control-Max-Age": "86400",
};

/**
 * Adds the MCP/OAuth CORS headers to a response in place and returns it.
 * Use to wrap the response of a GET/POST/DELETE handler.
 */
export function withMcpCorsHeaders<T extends Response>(response: T): T {
  for (const [key, value] of Object.entries(MCP_CORS_HEADERS)) {
    response.headers.set(key, value);
  }
  return response;
}

/**
 * Standard CORS preflight response for MCP/OAuth endpoints.
 * Export as the route's `OPTIONS` handler. Never rate-limited — a rejected
 * preflight would block the real request in the browser.
 */
export function mcpCorsPreflight(): Response {
  return new Response(null, { status: 204, headers: MCP_CORS_HEADERS });
}
