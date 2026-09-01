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
 * fragment, userinfo, or dot-segments. The dot-segment rule needs no explicit
 * check — WHATWG URL parsing collapses literal and percent-encoded segments
 * before they reach `pathname`, and a client_id that only *normalizes* to a
 * document's URL still fails the raw-string binding in
 * `validateClientMetadataDocument`.
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
 * The consent screen renders client_name beside the hostname — cap it so it
 * can't crowd the hostname out.
 */
const CLIENT_NAME_MAX_LENGTH = 100;

/** Caps on list/string fields — real documents are tiny; these bound abuse. */
const REDIRECT_URIS_MAX_ENTRIES = 32;
const GRANT_TYPES_MAX_ENTRIES = 32;
const SCOPE_MAX_LENGTH = 512;

/**
 * Strips control characters and Unicode bidi/direction-override characters
 * from a self-asserted display string — a client_name containing e.g. a
 * U+202E right-to-left override must not be able to reorder or hide the
 * hostname the consent screen renders next to it.
 */
function sanitizeDisplayName(name: string): string | undefined {
  const cleaned = name

    .replaceAll(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .trim()
    .slice(0, CLIENT_NAME_MAX_LENGTH);
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Validates an already-JSON-parsed Client ID Metadata Document fetched from
 * `url`. Returns null on any violation (never throws):
 *
 * - must be a JSON object with `client_id` (string) and a non-empty
 *   `redirect_uris` array containing at least one well-formed redirect URI
 *   (malformed entries are dropped rather than failing the whole document, so
 *   an upstream addition of e.g. a custom-scheme URI can't disable a client)
 * - `client_id` must equal the **raw** URL string the caller resolved the
 *   document for — this simple string comparison is the spec's binding
 *   between document and identifier, and it is what defeats
 *   normalization-alias and redirect games: a URL that merely *normalizes or
 *   redirects to* the document's location won't equal the `client_id` inside it
 * - `token_endpoint_auth_method`, if present, must be `none` — a CIMD client
 *   is inherently public; this server has no secret to verify, so a document
 *   demanding secret-based auth is misconfigured or malicious
 */
export function validateClientMetadataDocument(
  url: string,
  parsed: unknown
): ClientMetadata | null {
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
    doc.redirect_uris.length > REDIRECT_URIS_MAX_ENTRIES
  ) {
    return null;
  }
  const redirectUris = doc.redirect_uris.filter(
    (u): u is string => typeof u === "string" && isValidRedirectUriFormat(u)
  );
  if (redirectUris.length === 0) {
    return null;
  }
  if (doc.token_endpoint_auth_method !== undefined && doc.token_endpoint_auth_method !== "none") {
    return null;
  }
  if (doc.client_name !== undefined && typeof doc.client_name !== "string") {
    return null;
  }
  if (
    doc.scope !== undefined &&
    (typeof doc.scope !== "string" || doc.scope.length > SCOPE_MAX_LENGTH)
  ) {
    return null;
  }
  if (
    doc.grant_types !== undefined &&
    (!Array.isArray(doc.grant_types) ||
      doc.grant_types.length > GRANT_TYPES_MAX_ENTRIES ||
      !doc.grant_types.every((g) => typeof g === "string"))
  ) {
    return null;
  }

  return {
    client_id: doc.client_id,
    client_name: doc.client_name !== undefined ? sanitizeDisplayName(doc.client_name) : undefined,
    redirect_uris: redirectUris,
    grant_types: doc.grant_types as string[] | undefined,
    scope: doc.scope as string | undefined,
    token_endpoint_auth_method: doc.token_endpoint_auth_method as string | undefined,
  };
}

/**
 * String-body convenience wrapper over `validateClientMetadataDocument`.
 */
export function parseClientMetadataDocument(url: string, body: string): ClientMetadata | null {
  try {
    return validateClientMetadataDocument(url, JSON.parse(body));
  } catch {
    return null;
  }
}

/**
 * Outcome of a live CIMD fetch, classified for the fallback decision below.
 */
export type CimdFetchOutcome =
  /** Document fetched and validated. */
  | { kind: "ok"; metadata: ClientMetadata }
  /**
   * The fetch itself failed — network error, timeout, SSRF block, a redirect
   * (never followed; see fetchClientMetadataLive), a non-2xx status other
   * than 404/410, or a body that isn't JSON (a Cloudflare challenge page).
   * The document's origin said nothing authoritative about the client.
   */
  | { kind: "transport-failure" }
  /**
   * The origin answered authoritatively and the answer disqualifies the
   * client: 404/410 (document withdrawn — CIMD's revocation mechanism), or a
   * well-formed JSON body that failed validation.
   */
  | { kind: "rejected" };

/**
 * Picks the metadata to use for a client_id given the live fetch outcome.
 * The pinned fallback applies ONLY to transport-shaped failures — a
 * withdrawn (404) or invalid document must not be resurrected from the pin,
 * or pinning would defeat upstream revocation for exactly the highest-value
 * client_ids.
 */
export function selectClientMetadata(
  url: string,
  outcome: CimdFetchOutcome
): ClientMetadata | null {
  if (outcome.kind === "ok") return outcome.metadata;
  if (outcome.kind === "transport-failure") return PINNED_CLIENT_METADATA.get(url) ?? null;
  return null;
}

/** Freezes a pin's arrays — they are security allowlists handed out by reference. */
function frozenMetadata(doc: ClientMetadata): ClientMetadata {
  doc.redirect_uris = Object.freeze(doc.redirect_uris) as string[];
  if (doc.grant_types) doc.grant_types = Object.freeze(doc.grant_types) as string[];
  return Object.freeze(doc);
}

/**
 * Vendored copies of Anthropic's hosted client metadata documents, used per
 * `selectClientMetadata` when the live fetch fails. claude.ai fronts these
 * with Cloudflare, which intermittently serves datacenter IPs (Fly.io
 * included) a managed challenge instead of the JSON
 * (anthropics/claude-ai-mcp#650) — without a fallback, connecting the
 * claude.ai connector would fail whenever our egress IP is having a bad
 * reputation day. The live fetch always takes precedence, so a changed
 * upstream document only needs this updated when the fetch is ALSO being
 * challenged. Vendored 2026-08-31.
 */
export const PINNED_CLIENT_METADATA: ReadonlyMap<string, ClientMetadata> = new Map([
  [
    "https://claude.ai/oauth/mcp-oauth-client-metadata",
    frozenMetadata({
      client_id: "https://claude.ai/oauth/mcp-oauth-client-metadata",
      client_name: "Claude",
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      grant_types: [
        "authorization_code",
        "refresh_token",
        "urn:ietf:params:oauth:grant-type:jwt-bearer",
      ],
      token_endpoint_auth_method: "none",
    }),
  ],
  [
    "https://claude.ai/oauth/claude-code-client-metadata",
    frozenMetadata({
      client_id: "https://claude.ai/oauth/claude-code-client-metadata",
      client_name: "Claude Code",
      redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
    }),
  ],
]);
