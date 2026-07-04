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
 * The canonical URL of the protected-resource metadata document (RFC 9728).
 *
 * Because our resource identifier has a path (`/api/mcp`), RFC 9728 §3.1 puts
 * the metadata at the **path-inserted** location — `/.well-known/oauth-protected-
 * resource` inserted *before* the resource's path — which is authoritative for a
 * path-bearing resource. The root `/.well-known/oauth-protected-resource` is
 * authoritative only for the bare-origin resource, so pointing clients there
 * while the document declares a `/api/mcp` resource is an inconsistency that
 * strict clients (claude.ai) reject, aborting discovery before registration.
 * This is the URL every known-working remote MCP server (Linear, Sentry, Notion)
 * advertises in its `WWW-Authenticate` `resource_metadata`.
 */
export function getProtectedResourceMetadataUrl(): string {
  const resource = new URL(getResourceIdentifier());
  return `${resource.origin}/.well-known/oauth-protected-resource${resource.pathname}`;
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
    // NB: we intentionally do NOT advertise `client_id_metadata_document_supported`.
    // Clients pick their registration method by priority: pre-registered → CIMD →
    // DCR. claude.ai treats CIMD (when advertised alongside `"none"` auth) as
    // preferred and sets up the client entirely client-side (its own metadata-doc
    // URL as client_id, no /oauth/register call). In practice that CIMD setup
    // fails inside claude.ai's connector flow and it aborts *before* ever calling
    // /oauth/authorize — observed in prod logs as discovery completing, then a
    // silent ~3s gap, then "Couldn't register with the sign-in service" with no
    // register/authorize request reaching us. Not advertising CIMD drops claude.ai
    // (and other clients) to Dynamic Client Registration, which works. The
    // server-side CIMD resolution in `resolveClient` is retained, so a client that
    // explicitly presents a URL client_id still works.
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
