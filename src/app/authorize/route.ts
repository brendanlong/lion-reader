/**
 * OAuth 2.1 Authorization Endpoint (standard path)
 *
 * Forwards to /oauth/authorize for MCP clients that use the default
 * OAuth endpoint paths instead of discovering them from metadata.
 */

export { GET, POST } from "@/app/oauth/authorize/route";
