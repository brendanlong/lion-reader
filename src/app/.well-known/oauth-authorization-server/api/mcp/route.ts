/**
 * OAuth 2.0 Authorization Server Metadata (RFC 8414) — path-inserted location.
 *
 * Strictly, RFC 8414 path-insertion applies to the *issuer's* path (ours is a
 * bare origin, so the root location is the authoritative one). But some MCP
 * clients — claude.ai's connector included (anthropics/claude-ai-mcp#367,
 * #490) — construct this URL from the *resource's* path (`/api/mcp`) during
 * second-stage discovery, and Linear and Sentry both serve their AS metadata
 * at the equivalent location. Serve the same document here so that discovery
 * style works too.
 *
 * GET /.well-known/oauth-authorization-server/api/mcp
 */

export { GET, OPTIONS } from "@/app/.well-known/oauth-authorization-server/route";
