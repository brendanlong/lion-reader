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
  const originalMcpHost = process.env.MCP_HOST;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = "https://reader.example.com";
    delete process.env.MCP_HOST;
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
    if (originalMcpHost === undefined) {
      delete process.env.MCP_HOST;
    } else {
      process.env.MCP_HOST = originalMcpHost;
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

describe("OAuth resource identifiers on the dedicated MCP host", () => {
  const original = process.env.NEXT_PUBLIC_APP_URL;
  const originalMcpHost = process.env.MCP_HOST;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = "https://reader.example.com";
    process.env.MCP_HOST = "mcp.example.com";
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.NEXT_PUBLIC_APP_URL;
    } else {
      process.env.NEXT_PUBLIC_APP_URL = original;
    }
    if (originalMcpHost === undefined) {
      delete process.env.MCP_HOST;
    } else {
      process.env.MCP_HOST = originalMcpHost;
    }
  });

  it("serves the MCP endpoint at /mcp with the host as issuer", () => {
    // Matches the shape of every server that works with the claude.ai web
    // connector (Notion/Linear/Sentry are all https://mcp.*/mcp).
    expect(getIssuer("mcp.example.com")).toBe("https://mcp.example.com");
    expect(getResourceIdentifier("mcp.example.com")).toBe("https://mcp.example.com/mcp");
  });

  it("matches the host case-insensitively and ignores the port", () => {
    expect(getResourceIdentifier("MCP.Example.com:443")).toBe("https://mcp.example.com/mcp");
  });

  it("points the metadata URL at the path-inserted /mcp location", () => {
    expect(getProtectedResourceMetadataUrl("mcp.example.com")).toBe(
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp"
    );
  });

  it("advertises OAuth endpoints at the origin root on the MCP host", () => {
    const metadata = getAuthorizationServerMetadata("mcp.example.com");
    expect(metadata.issuer).toBe("https://mcp.example.com");
    expect(metadata.authorization_endpoint).toBe("https://mcp.example.com/authorize");
    expect(metadata.token_endpoint).toBe("https://mcp.example.com/token");
    expect(metadata.registration_endpoint).toBe("https://mcp.example.com/register");
    // Served by the root alias in src/app/revoke/route.ts.
    expect(metadata.revocation_endpoint).toBe("https://mcp.example.com/revoke");
  });

  it("advertises the MCP host itself as its own authorization server", () => {
    const metadata = getProtectedResourceMetadata("mcp.example.com");
    expect(metadata.resource).toBe("https://mcp.example.com/mcp");
    expect(metadata.authorization_servers).toEqual(["https://mcp.example.com"]);
  });

  it("falls back to the apex surface for the apex host or an unknown host", () => {
    expect(getResourceIdentifier("reader.example.com")).toBe("https://reader.example.com/api/mcp");
    expect(getResourceIdentifier(null)).toBe("https://reader.example.com/api/mcp");
    const apexMetadata = getAuthorizationServerMetadata("reader.example.com");
    expect(apexMetadata.registration_endpoint).toBe("https://reader.example.com/oauth/register");
  });

  it("accepts audiences from BOTH surfaces so cross-host tokens validate", () => {
    // Host-independent: a token minted on either surface must be accepted at that
    // surface's endpoint regardless of the current request host.
    expect(getAcceptedResourceIdentifiers()).toEqual([
      "https://reader.example.com/api/mcp",
      "https://reader.example.com",
      "https://mcp.example.com/mcp",
      "https://mcp.example.com",
    ]);
  });
});
