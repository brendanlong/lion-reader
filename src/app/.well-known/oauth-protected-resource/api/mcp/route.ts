/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728) — path-inserted location.
 *
 * Our resource identifier is `${issuer}/api/mcp` (it has a path), so RFC 9728
 * §3.1-compliant clients construct the metadata URL by inserting the well-known
 * segment before the path: `/.well-known/oauth-protected-resource/api/mcp`.
 * Serve the same metadata here as at the root location so both discovery styles
 * work. This is the URL the 401 `WWW-Authenticate` `resource_metadata` points
 * at (see `getProtectedResourceMetadataUrl`).
 *
 * GET /.well-known/oauth-protected-resource/api/mcp
 */

export { GET, OPTIONS } from "@/app/.well-known/oauth-protected-resource/route";
