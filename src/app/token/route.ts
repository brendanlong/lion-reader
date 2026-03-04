/**
 * OAuth 2.1 Token Endpoint (standard path)
 *
 * Forwards to /oauth/token for MCP clients that use the default
 * OAuth endpoint paths instead of discovering them from metadata.
 */

export { POST } from "@/app/oauth/token/route";
