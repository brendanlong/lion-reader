/**
 * OAuth 2.1 Configuration
 *
 * Centralized configuration for the OAuth 2.1 authorization server.
 */

import { OAUTH_SCOPES } from "./utils";

/**
 * Get the OAuth issuer URL (base URL of the authorization server).
 */
export function getIssuer(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

/**
 * The canonical RFC 8707 resource identifier for our protected resource.
 *
 * Per the MCP authorization spec (2025-06-18) and RFC 9728, this MUST be the
 * canonical URI of the MCP server itself — i.e. the `/api/mcp` endpoint, not the
 * bare origin. Advertised as `resource` in the protected-resource metadata and
 * bound into every access token's audience.
 */
export function getResourceIdentifier(): string {
  return `${getIssuer()}/api/mcp`;
}

/**
 * Resource identifiers accepted as audience for this server, most-canonical
 * first. Includes the bare origin for backward compatibility: it was the
 * canonical resource before 2026-07, so access tokens minted then carry the
 * origin as their audience and must keep working until they expire.
 */
export function getAcceptedResourceIdentifiers(): string[] {
  return [getResourceIdentifier(), getIssuer()];
}

/**
 * OAuth 2.0 Authorization Server Metadata (RFC 8414)
 * Used by /.well-known/oauth-authorization-server
 */
export function getAuthorizationServerMetadata() {
  const issuer = getIssuer();

  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    scopes_supported: Object.values(OAUTH_SCOPES),
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    // MCP-specific: indicates support for Client ID Metadata Documents
    client_id_metadata_document_supported: true,
  };
}

/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728)
 * Used by /.well-known/oauth-protected-resource
 */
export function getProtectedResourceMetadata() {
  return {
    resource: getResourceIdentifier(),
    authorization_servers: [getIssuer()],
    scopes_supported: Object.values(OAUTH_SCOPES),
    bearer_methods_supported: ["header"],
  };
}
