/**
 * Unit tests for OAuth server/resource metadata (RFC 8414 / RFC 9728).
 *
 * The protected-resource `resource` MUST be the canonical MCP endpoint URL
 * (with `/api/mcp` path), not the bare origin — see the MCP authorization spec
 * (2025-06-18). The bare origin is still accepted as a token audience for
 * backward compatibility.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getIssuer,
  getResourceIdentifier,
  getAcceptedResourceIdentifiers,
  getProtectedResourceMetadata,
  getProtectedResourceMetadataUrl,
  getAuthorizationServerMetadata,
} from "../../src/server/oauth/config";
import { SUPPORTED_TOKEN_ENDPOINT_AUTH_METHODS } from "../../src/server/oauth/utils";

describe("OAuth resource identifiers", () => {
  const original = process.env.NEXT_PUBLIC_APP_URL;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = "https://reader.example.com";
  });

  afterEach(() => {
    // Restore precisely: assigning `undefined` would coerce to the string
    // "undefined" and pollute getIssuer() for later unit tests (files share one
    // worker — fileParallelism is disabled).
    if (original === undefined) {
      delete process.env.NEXT_PUBLIC_APP_URL;
    } else {
      process.env.NEXT_PUBLIC_APP_URL = original;
    }
  });

  it("uses the MCP endpoint URL as the canonical resource identifier", () => {
    expect(getResourceIdentifier()).toBe("https://reader.example.com/api/mcp");
  });

  it("points the protected-resource metadata URL at the path-inserted location", () => {
    // RFC 9728 §3.1: for a resource with a path, the well-known segment is
    // inserted BEFORE the path. Root would be authoritative only for the bare
    // origin; a mismatch aborts discovery in strict clients (claude.ai).
    expect(getProtectedResourceMetadataUrl()).toBe(
      "https://reader.example.com/.well-known/oauth-protected-resource/api/mcp"
    );
  });

  it("advertises the MCP endpoint (not the origin) as the protected resource", () => {
    const metadata = getProtectedResourceMetadata();
    expect(metadata.resource).toBe("https://reader.example.com/api/mcp");
    // Authorization server is still the origin.
    expect(metadata.authorization_servers).toEqual(["https://reader.example.com"]);
  });

  it("accepts both the MCP-endpoint resource and the legacy origin as audience", () => {
    expect(getAcceptedResourceIdentifiers()).toEqual([
      "https://reader.example.com/api/mcp",
      "https://reader.example.com",
    ]);
    // Origin (legacy) must remain accepted so pre-change tokens keep working.
    expect(getAcceptedResourceIdentifiers()).toContain(getIssuer());
  });

  it("does NOT advertise Client ID Metadata Document support", () => {
    // Advertising `client_id_metadata_document_supported` makes claude.ai prefer
    // CIMD over Dynamic Client Registration; its CIMD setup fails inside the
    // connector flow (it never calls /oauth/register or /oauth/authorize) and
    // surfaces as "Couldn't register with the sign-in service". Omitting the flag
    // drops clients to DCR, which works. Do not re-add without confirming
    // claude.ai's CIMD flow actually completes.
    const metadata = getAuthorizationServerMetadata();
    expect("client_id_metadata_document_supported" in metadata).toBe(false);
  });

  it("advertises the endpoints and PKCE claude.ai requires for DCR", () => {
    const metadata = getAuthorizationServerMetadata();
    expect(metadata.registration_endpoint).toBe("https://reader.example.com/oauth/register");
    expect(metadata.revocation_endpoint).toBe("https://reader.example.com/oauth/revoke");
    expect(metadata.code_challenge_methods_supported).toEqual(["S256"]);
  });

  it("advertises the same token-endpoint auth methods /oauth/register accepts", () => {
    // Advertising fewer methods than registration accepts is the
    // metadata/endpoint contradiction of anthropics/claude-ai-mcp#285; the
    // known-working remote MCP servers (Linear, Sentry, Notion) all advertise
    // these three.
    const metadata = getAuthorizationServerMetadata();
    expect(metadata.token_endpoint_auth_methods_supported).toEqual(
      SUPPORTED_TOKEN_ENDPOINT_AUTH_METHODS
    );
    expect(metadata.token_endpoint_auth_methods_supported).toEqual([
      "client_secret_basic",
      "client_secret_post",
      "none",
    ]);
  });
});
