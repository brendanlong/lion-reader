/**
 * OAuth 2.1 Configuration
 *
 * Centralized configuration for the OAuth 2.1 authorization server.
 *
 * ## Multi-host (the mcp.* subdomain)
 *
 * These helpers resolve their URLs from the **request host** so the same app can
 * present two self-consistent OAuth/MCP surfaces:
 *
 * - **Apex** (`lionreader.com`, the default): MCP endpoint at `/api/mcp`, OAuth
 *   endpoints advertised under `/oauth/*` (with root aliases for claude.ai). This
 *   is exactly the behavior that shipped before the subdomain work.
 * - **MCP host** (`mcpConfig.host`, e.g. `mcp.lionreader.com`): MCP endpoint at
 *   `/mcp`, OAuth endpoints advertised at the origin root (`/authorize`,
 *   `/token`, `/register`) — matching Notion/Linear/Sentry, the servers that work
 *   with the claude.ai web connector (issue #986).
 *
 * Callers in route handlers pass `request.headers.get("host")`. Omitting the host
 * (or passing an unrecognized one) resolves to the apex surface, so every
 * existing no-arg call keeps its previous behavior.
 */

import { OAUTH_SCOPES, SUPPORTED_TOKEN_ENDPOINT_AUTH_METHODS } from "./utils";
import { mcpConfig } from "@/server/config/env";

/**
 * The apex issuer — the origin of the primary app. Read at call time (not cached)
 * so tests can override NEXT_PUBLIC_APP_URL per case.
 */
function getApexIssuer(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

/**
 * Strip a `:port` suffix and lower-case a Host header for comparison. Leaves
 * bracketed IPv6 literals (`[::1]:3000`, dev only) untouched.
 */
function normalizeHost(host: string): string {
  const lowered = host.trim().toLowerCase();
  if (lowered.startsWith("[")) return lowered;
  const colon = lowered.indexOf(":");
  return colon === -1 ? lowered : lowered.slice(0, colon);
}

interface Surface {
  /** Origin of this surface (scheme + host, no path). */
  issuer: string;
  /** Path of the MCP endpoint on this surface. */
  resourcePath: string;
  /** Advertise the OAuth endpoints at the origin root rather than under /oauth. */
  rootOauthEndpoints: boolean;
}

/**
 * Resolve the OAuth/MCP surface for a request host. Returns the MCP-subdomain
 * surface when the host matches `mcpConfig.host`, otherwise the apex surface.
 */
function resolveSurface(host?: string | null): Surface {
  const mcpHost = mcpConfig.host;
  if (mcpHost && host && normalizeHost(host) === mcpHost) {
    return {
      issuer: `https://${mcpHost}`,
      resourcePath: "/mcp",
      rootOauthEndpoints: true,
    };
  }
  return {
    issuer: getApexIssuer(),
    resourcePath: "/api/mcp",
    rootOauthEndpoints: false,
  };
}

/**
 * Get the OAuth issuer URL (base URL of the authorization server) for a host.
 */
export function getIssuer(host?: string | null): string {
  return resolveSurface(host).issuer;
}

/**
 * The RFC 8707 resource identifier for our protected resource on this host.
 *
 * Per the MCP authorization spec (2025-06-18) and RFC 9728, this MUST be the
 * canonical URI of the MCP server itself (the endpoint path, not the bare
 * origin): `${issuer}/api/mcp` on the apex, `${issuer}/mcp` on the MCP host.
 * Advertised as `resource` in the protected-resource metadata and bound into
 * every access token's audience.
 */
export function getResourceIdentifier(host?: string | null): string {
  const surface = resolveSurface(host);
  return `${surface.issuer}${surface.resourcePath}`;
}

/**
 * The canonical URL of the protected-resource metadata document (RFC 9728).
 *
 * Because our resource identifier has a path, RFC 9728 §3.1 puts the metadata at
 * the **path-inserted** location — `/.well-known/oauth-protected-resource`
 * inserted *before* the resource's path — which is authoritative for a
 * path-bearing resource. On the apex that is `/.well-known/oauth-protected-
 * resource/api/mcp`; on the MCP host `/.well-known/oauth-protected-resource/mcp`
 * (byte-for-byte what Notion/Linear/Sentry advertise). The root
 * `/.well-known/oauth-protected-resource` is authoritative only for the bare
 * origin, so pointing clients there while the document declares a pathed resource
 * is an inconsistency strict clients (claude.ai) reject, aborting discovery
 * before registration.
 */
export function getProtectedResourceMetadataUrl(host?: string | null): string {
  const resource = new URL(getResourceIdentifier(host));
  return `${resource.origin}/.well-known/oauth-protected-resource${resource.pathname}`;
}

/**
 * Resource identifiers accepted as audience for this server, across all hosts.
 *
 * This is host-independent on purpose: a token minted on one surface must still
 * validate at that surface's `/mcp` (or `/api/mcp`) endpoint regardless of which
 * host the current request arrived on. Includes:
 * - the apex MCP-endpoint resource (`${apex}/api/mcp`) and the apex bare origin
 *   (the pre-2026-07 canonical value; tokens minted then carry it, kept until
 *   they expire), and
 * - when an MCP host is configured, its MCP-endpoint resource (`${mcpHost}/mcp`)
 *   and bare origin.
 */
export function getAcceptedResourceIdentifiers(): string[] {
  const apex = getApexIssuer();
  const ids = [`${apex}/api/mcp`, apex];
  const mcpHost = mcpConfig.host;
  if (mcpHost) {
    const mcpIssuer = `https://${mcpHost}`;
    ids.push(`${mcpIssuer}/mcp`, mcpIssuer);
  }
  return ids;
}

/**
 * OAuth 2.0 Authorization Server Metadata (RFC 8414)
 * Used by /.well-known/oauth-authorization-server
 */
export function getAuthorizationServerMetadata(host?: string | null) {
  const surface = resolveSurface(host);
  const issuer = surface.issuer;
  // On the MCP host the OAuth endpoints live at the origin root (like the
  // known-working servers); on the apex they live under /oauth (root aliases
  // exist for claude.ai's origin-root synthesis, but the advertised endpoints
  // stay under /oauth as before).
  const prefix = surface.rootOauthEndpoints ? "" : "/oauth";

  return {
    issuer,
    authorization_endpoint: `${issuer}${prefix}/authorize`,
    token_endpoint: `${issuer}${prefix}/token`,
    registration_endpoint: `${issuer}${prefix}/register`,
    revocation_endpoint: `${issuer}${prefix}/revoke`,
    scopes_supported: Object.values(OAUTH_SCOPES),
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    // All three methods, matching every known-working remote MCP server (Linear,
    // Sentry, Notion). Advertising only ["none"] while /oauth/register accepted
    // client_secret_post was a metadata/endpoint contradiction (the failure class
    // of anthropics/claude-ai-mcp#285), and it declared manually-registered
    // confidential clients (client ID + secret pasted into claude.ai's Advanced
    // settings) unsupported. Shared with /oauth/register validation so the two
    // can't drift apart again.
    token_endpoint_auth_methods_supported: SUPPORTED_TOKEN_ENDPOINT_AUTH_METHODS,
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
export function getProtectedResourceMetadata(host?: string | null) {
  return {
    resource: getResourceIdentifier(host),
    authorization_servers: [getIssuer(host)],
    scopes_supported: Object.values(OAUTH_SCOPES),
    bearer_methods_supported: ["header"],
  };
}
