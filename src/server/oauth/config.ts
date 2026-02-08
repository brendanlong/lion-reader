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
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
    // MCP-specific: indicates support for Client ID Metadata Documents
    client_id_metadata_document_supported: true,
  };
}

/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728)
 * Used by /.well-known/oauth-protected-resource
 */
export function getProtectedResourceMetadata() {
  const issuer = getIssuer();

  return {
    resource: issuer,
    authorization_servers: [issuer],
    scopes_supported: Object.values(OAUTH_SCOPES),
    bearer_methods_supported: ["header"],
  };
}
