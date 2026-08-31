/**
 * Client ID Metadata Documents (CIMD)
 *
 * Pure validation/parsing for OAuth clients identified by an HTTPS URL
 * (MCP authorization spec 2025-11-25 §Client ID Metadata Documents /
 * draft-ietf-oauth-client-id-metadata-document). The client_id IS the URL of a
 * JSON document describing the client; the authorization server fetches it
 * instead of requiring registration. claude.ai's "Use Anthropic's hosted client
 * metadata" connector option is this mechanism, with
 * `https://claude.ai/oauth/mcp-oauth-client-metadata` as the client_id.
 *
 * The network fetch lives in service.ts (`fetchClientMetadata`, SSRF-protected);
 * everything here is unit-testable without I/O (tests/unit/oauth-cimd.test.ts).
 */

import { isValidRedirectUriFormat } from "./utils";

/**
 * Client metadata from a Client ID Metadata Document.
 */
export interface ClientMetadata {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  grant_types?: string[];
  scope?: string;
  token_endpoint_auth_method?: string;
}

/**
 * Whether a client_id is a well-formed CIMD URL worth fetching.
 *
 * Per the CIMD draft: https scheme, a non-root path component, and no
 * fragment, userinfo, or dot-segments. No explicit dot-segment check is
 * needed: WHATWG URL parsing collapses both literal (`..`) and
 * percent-encoded (`%2e%2e`) dot-segments before they reach `pathname`
 * (verified in tests/unit/oauth-cimd.test.ts), and a client_id that only
 * *normalizes* to a document's URL is rejected anyway by
 * `parseClientMetadataDocument`'s string-equality binding between the raw
 * client_id and the document's `client_id` field.
 */
export function isValidClientIdMetadataUrl(clientId: string): boolean {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.hash || url.username || url.password) return false;
  return url.pathname !== "" && url.pathname !== "/";
}

/**
 * Parses and validates a Client ID Metadata Document body fetched from `url`.
 * Returns null on any violation (never throws):
 *
 * - must be a JSON object with `client_id` (string) and a non-empty
 *   `redirect_uris` array of well-formed redirect URIs
 * - `client_id` must equal the URL the document was fetched from, by simple
 *   string comparison (the spec's binding between document and identifier)
 * - `token_endpoint_auth_method`, if present, must be `none` — a CIMD client
 *   is inherently public; this server has no secret to verify, so a document
 *   demanding secret-based auth is misconfigured or malicious
 */
export function parseClientMetadataDocument(url: string, body: string): ClientMetadata | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const doc = parsed as Record<string, unknown>;

  if (typeof doc.client_id !== "string" || doc.client_id !== url) {
    return null;
  }
  if (
    !Array.isArray(doc.redirect_uris) ||
    doc.redirect_uris.length === 0 ||
    !doc.redirect_uris.every((u) => typeof u === "string" && isValidRedirectUriFormat(u))
  ) {
    return null;
  }
  if (doc.token_endpoint_auth_method !== undefined && doc.token_endpoint_auth_method !== "none") {
    return null;
  }
  if (doc.client_name !== undefined && typeof doc.client_name !== "string") {
    return null;
  }
  if (doc.scope !== undefined && typeof doc.scope !== "string") {
    return null;
  }
  if (
    doc.grant_types !== undefined &&
    (!Array.isArray(doc.grant_types) || !doc.grant_types.every((g) => typeof g === "string"))
  ) {
    return null;
  }

  return {
    client_id: doc.client_id,
    client_name: doc.client_name as string | undefined,
    redirect_uris: doc.redirect_uris as string[],
    grant_types: doc.grant_types as string[] | undefined,
    scope: doc.scope as string | undefined,
    token_endpoint_auth_method: doc.token_endpoint_auth_method as string | undefined,
  };
}

/**
 * Vendored copies of Anthropic's hosted client metadata documents, used as a
 * fallback when the live fetch fails. claude.ai fronts these with Cloudflare,
 * which intermittently serves datacenter IPs (Fly.io included) a managed
 * challenge instead of the JSON (anthropics/claude-ai-mcp#650) — without a
 * fallback, connecting the claude.ai connector would fail whenever our egress
 * IP is having a bad reputation day. The live fetch always takes precedence,
 * so a changed upstream document only needs this updated when the fetch is
 * ALSO being challenged. Vendored 2026-08-31.
 */
export const PINNED_CLIENT_METADATA: ReadonlyMap<string, ClientMetadata> = new Map([
  [
    "https://claude.ai/oauth/mcp-oauth-client-metadata",
    {
      client_id: "https://claude.ai/oauth/mcp-oauth-client-metadata",
      client_name: "Claude",
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      grant_types: [
        "authorization_code",
        "refresh_token",
        "urn:ietf:params:oauth:grant-type:jwt-bearer",
      ],
      token_endpoint_auth_method: "none",
    },
  ],
  [
    "https://claude.ai/oauth/claude-code-client-metadata",
    {
      client_id: "https://claude.ai/oauth/claude-code-client-metadata",
      client_name: "Claude Code",
      redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
    },
  ],
]);
