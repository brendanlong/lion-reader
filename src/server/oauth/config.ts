/**
 * OAuth 2.1 Configuration
 *
 * Centralized configuration for the OAuth 2.1 authorization server. There is
 * one OAuth/MCP surface: the app origin, with the MCP endpoint at `/api/mcp`
 * and the OAuth endpoints under `/oauth/*`.
 */

import { OAUTH_SCOPES, SUPPORTED_TOKEN_ENDPOINT_AUTH_METHODS } from "./utils";

/**
 * The OAuth issuer URL (base URL of the authorization server). Read at call
 * time (not cached) so tests can override NEXT_PUBLIC_APP_URL per case.
 */
export function getIssuer(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

/**
 * The RFC 8707 resource identifier for our protected resource.
 *
 * Per the MCP authorization spec (2025-06-18) and RFC 9728, this MUST be the
 * canonical URI of the MCP server itself (the endpoint path, not the bare
 * origin): `${issuer}/api/mcp`. Advertised as `resource` in the
 * protected-resource metadata and bound into every access token's audience.
 */
export function getResourceIdentifier(): string {
  return `${getIssuer()}/api/mcp`;
}

/**
 * The canonical URL of the protected-resource metadata document (RFC 9728).
 *
 * Because our resource identifier has a path, RFC 9728 §3.1 puts the metadata
 * at the **path-inserted** location — `/.well-known/oauth-protected-resource`
 * inserted *before* the resource's path, i.e.
 * `/.well-known/oauth-protected-resource/api/mcp` — which is authoritative for
 * a path-bearing resource. The root `/.well-known/oauth-protected-resource` is
 * authoritative only for the bare origin, so pointing clients there while the
 * document declares a pathed resource is an inconsistency strict clients
 * reject, aborting discovery before registration.
 */
export function getProtectedResourceMetadataUrl(): string {
  const resource = new URL(getResourceIdentifier());
  return `${resource.origin}/.well-known/oauth-protected-resource${resource.pathname}`;
}

/**
 * Resource identifiers accepted as audience for this server: the canonical
 * MCP-endpoint resource plus the bare origin (the pre-2026-07 canonical value;
 * tokens minted then carry it, kept until they expire).
 */
export function getAcceptedResourceIdentifiers(): string[] {
  const issuer = getIssuer();
  return [`${issuer}/api/mcp`, issuer];
}

/**
 * The `registration_client_uri` returned from Dynamic Client Registration
 * (RFC 7591). The URI intentionally 404s (RFC 7592 client management is not
 * implemented — see registerClient); only its origin-consistency matters.
 */
export function getRegistrationClientUri(clientId: string): string {
  return `${getIssuer()}/oauth/register/${clientId}`;
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
    revocation_endpoint: `${issuer}/oauth/revoke`,
    scopes_supported: Object.values(OAUTH_SCOPES),
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    // All three methods, matching every known-working remote MCP server (Linear,
    // Sentry, Notion). Advertising only ["none"] while /oauth/register accepted
    // client_secret_post was a metadata/endpoint contradiction (the failure class
    // of anthropics/claude-ai-mcp#285), and it declared manually-registered
    // confidential clients (client ID + secret pasted into a client's Advanced
    // settings) unsupported. Shared with /oauth/register validation so the two
    // can't drift apart again.
    token_endpoint_auth_methods_supported: SUPPORTED_TOKEN_ENDPOINT_AUTH_METHODS,
    // Client ID Metadata Documents (see cimd.ts). claude.ai's connector only
    // offers its hosted metadata document when this flag is true AND
    // token_endpoint_auth_methods_supported includes "none" (CIMD clients are
    // public); missing either, it silently falls back to DCR.
    //
    // Rollback criterion: an earlier claude.ai connector auto-preferred CIMD
    // whenever it was advertised, then aborted client-side before ever calling
    // /oauth/authorize ("Couldn't register with the sign-in service", #986). If
    // that signature reappears in LOG_MCP_REQUESTS — discovery completes, no
    // register/authorize follows — set this back to false to force DCR.
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
    // RFC 9728 §2 display name; Notion includes it and clients may show it in
    // their connect UI.
    resource_name: "Lion Reader",
  };
}
