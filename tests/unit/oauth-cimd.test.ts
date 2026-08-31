/**
 * Client ID Metadata Document (CIMD) validation tests.
 *
 * Pure-logic coverage for src/server/oauth/cimd.ts — the URL and document
 * validation that stands between an unauthenticated /oauth/authorize request
 * carrying an arbitrary URL client_id and our SSRF-protected fetch of it.
 */

import { describe, it, expect } from "vitest";
import {
  isValidClientIdMetadataUrl,
  parseClientMetadataDocument,
  PINNED_CLIENT_METADATA,
} from "@/server/oauth/cimd";

const CLAUDE_CIMD_URL = "https://claude.ai/oauth/mcp-oauth-client-metadata";

/** The document claude.ai actually serves (fetched live 2026-08-31). */
const CLAUDE_CIMD_DOC = {
  client_id: CLAUDE_CIMD_URL,
  client_name: "Claude",
  client_uri: "https://claude.ai",
  redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
  grant_types: [
    "authorization_code",
    "refresh_token",
    "urn:ietf:params:oauth:grant-type:jwt-bearer",
  ],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};

describe("isValidClientIdMetadataUrl", () => {
  it("accepts Anthropic's hosted client metadata URLs", () => {
    expect(isValidClientIdMetadataUrl(CLAUDE_CIMD_URL)).toBe(true);
    expect(isValidClientIdMetadataUrl("https://claude.ai/oauth/claude-code-client-metadata")).toBe(
      true
    );
  });

  it("rejects non-URL client ids (ordinary DCR client ids)", () => {
    expect(isValidClientIdMetadataUrl("client_abc123")).toBe(false);
    expect(isValidClientIdMetadataUrl("")).toBe(false);
  });

  it("rejects non-https schemes", () => {
    expect(isValidClientIdMetadataUrl("http://claude.ai/oauth/metadata")).toBe(false);
    expect(isValidClientIdMetadataUrl("ftp://claude.ai/metadata")).toBe(false);
  });

  it("rejects URLs without a path component", () => {
    expect(isValidClientIdMetadataUrl("https://claude.ai")).toBe(false);
    expect(isValidClientIdMetadataUrl("https://claude.ai/")).toBe(false);
  });

  it("rejects fragments and userinfo", () => {
    expect(isValidClientIdMetadataUrl("https://claude.ai/metadata#frag")).toBe(false);
    expect(isValidClientIdMetadataUrl("https://user@claude.ai/metadata")).toBe(false);
    expect(isValidClientIdMetadataUrl("https://user:pass@claude.ai/metadata")).toBe(false);
  });

  it("dot-segments (literal and percent-encoded) are collapsed by URL parsing", () => {
    // The spec's dot-segment rejection is satisfied by WHATWG normalization —
    // this test documents the parser behavior isValidClientIdMetadataUrl's
    // no-explicit-check design relies on. A normalized-but-unequal client_id is
    // then rejected by parseClientMetadataDocument's string-equality binding.
    expect(new URL("https://claude.ai/a/%2e%2e/metadata").pathname).toBe("/metadata");
    expect(new URL("https://claude.ai/a/../metadata").pathname).toBe("/metadata");
    expect(isValidClientIdMetadataUrl("https://claude.ai/a/%2e%2e/metadata")).toBe(true);
    expect(
      parseClientMetadataDocument(
        "https://claude.ai/a/%2e%2e/metadata",
        JSON.stringify({ ...CLAUDE_CIMD_DOC, client_id: "https://claude.ai/metadata" })
      )
    ).toBeNull();
  });
});

describe("parseClientMetadataDocument", () => {
  it("accepts claude.ai's live document", () => {
    const parsed = parseClientMetadataDocument(CLAUDE_CIMD_URL, JSON.stringify(CLAUDE_CIMD_DOC));
    expect(parsed).not.toBeNull();
    expect(parsed?.client_id).toBe(CLAUDE_CIMD_URL);
    expect(parsed?.client_name).toBe("Claude");
    expect(parsed?.redirect_uris).toEqual(["https://claude.ai/api/mcp/auth_callback"]);
    expect(parsed?.token_endpoint_auth_method).toBe("none");
  });

  it("rejects a document whose client_id does not match the fetch URL", () => {
    const doc = { ...CLAUDE_CIMD_DOC, client_id: "https://evil.example/impersonation" };
    expect(parseClientMetadataDocument(CLAUDE_CIMD_URL, JSON.stringify(doc))).toBeNull();
  });

  it("rejects non-JSON bodies (e.g. a Cloudflare challenge page)", () => {
    expect(parseClientMetadataDocument(CLAUDE_CIMD_URL, "<html>challenge</html>")).toBeNull();
  });

  it("rejects non-object JSON", () => {
    expect(parseClientMetadataDocument(CLAUDE_CIMD_URL, '"string"')).toBeNull();
    expect(parseClientMetadataDocument(CLAUDE_CIMD_URL, "[1,2]")).toBeNull();
    expect(parseClientMetadataDocument(CLAUDE_CIMD_URL, "null")).toBeNull();
  });

  it("rejects missing or empty redirect_uris", () => {
    // JSON.stringify drops undefined-valued keys, yielding a doc without the field.
    const noUris = { ...CLAUDE_CIMD_DOC, redirect_uris: undefined };
    expect(parseClientMetadataDocument(CLAUDE_CIMD_URL, JSON.stringify(noUris))).toBeNull();
    expect(
      parseClientMetadataDocument(
        CLAUDE_CIMD_URL,
        JSON.stringify({ ...CLAUDE_CIMD_DOC, redirect_uris: [] })
      )
    ).toBeNull();
  });

  it("rejects malformed redirect_uris", () => {
    for (const bad of [
      ["not a url"],
      ["https://claude.ai/cb#frag"],
      ["http://claude.ai/cb"], // http only allowed for loopback
      [42],
    ]) {
      expect(
        parseClientMetadataDocument(
          CLAUDE_CIMD_URL,
          JSON.stringify({ ...CLAUDE_CIMD_DOC, redirect_uris: bad })
        )
      ).toBeNull();
    }
  });

  it("accepts loopback http redirect_uris (native clients like Claude Code)", () => {
    const doc = {
      ...CLAUDE_CIMD_DOC,
      redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
    };
    expect(
      parseClientMetadataDocument(CLAUDE_CIMD_URL, JSON.stringify(doc))?.redirect_uris
    ).toEqual(["http://localhost/callback", "http://127.0.0.1/callback"]);
  });

  it("rejects secret-based token_endpoint_auth_method (CIMD clients are public)", () => {
    for (const method of ["client_secret_basic", "client_secret_post", "private_key_jwt"]) {
      expect(
        parseClientMetadataDocument(
          CLAUDE_CIMD_URL,
          JSON.stringify({ ...CLAUDE_CIMD_DOC, token_endpoint_auth_method: method })
        )
      ).toBeNull();
    }
    // Absent is fine — defaults to public.
    const noMethod = { ...CLAUDE_CIMD_DOC, token_endpoint_auth_method: undefined };
    expect(parseClientMetadataDocument(CLAUDE_CIMD_URL, JSON.stringify(noMethod))).not.toBeNull();
  });

  it("rejects wrong-typed optional fields", () => {
    expect(
      parseClientMetadataDocument(
        CLAUDE_CIMD_URL,
        JSON.stringify({ ...CLAUDE_CIMD_DOC, client_name: 42 })
      )
    ).toBeNull();
    expect(
      parseClientMetadataDocument(
        CLAUDE_CIMD_URL,
        JSON.stringify({ ...CLAUDE_CIMD_DOC, grant_types: "authorization_code" })
      )
    ).toBeNull();
    expect(
      parseClientMetadataDocument(
        CLAUDE_CIMD_URL,
        JSON.stringify({ ...CLAUDE_CIMD_DOC, scope: ["mcp"] })
      )
    ).toBeNull();
  });
});

describe("PINNED_CLIENT_METADATA", () => {
  it("every pinned document passes the same validation as a live fetch", () => {
    // The pinned copies are the fallback when Cloudflare challenges our egress
    // IP; they must be at least as valid as what a live fetch would accept, so
    // the fallback path can never resurrect a document validation would reject.
    for (const [url, doc] of PINNED_CLIENT_METADATA) {
      expect(isValidClientIdMetadataUrl(url)).toBe(true);
      const reparsed = parseClientMetadataDocument(url, JSON.stringify(doc));
      expect(reparsed).not.toBeNull();
      expect(reparsed?.client_id).toBe(url);
    }
  });

  it("pins claude.ai's connector client with its auth callback", () => {
    const doc = PINNED_CLIENT_METADATA.get(CLAUDE_CIMD_URL);
    expect(doc?.redirect_uris).toContain("https://claude.ai/api/mcp/auth_callback");
    expect(doc?.token_endpoint_auth_method).toBe("none");
  });
});
