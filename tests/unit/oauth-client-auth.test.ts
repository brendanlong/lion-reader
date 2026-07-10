/**
 * Unit tests for OAuth client authentication (client-auth.ts): HTTP Basic
 * credential extraction (client_secret_basic, RFC 6749 §2.3.1) merged with
 * body credentials (client_secret_post / public clients), and client-secret
 * validation.
 *
 * claude.ai and other MCP clients may register with any of the advertised
 * token-endpoint auth methods; before this existed the token endpoint silently
 * ignored Basic credentials and failed with "Missing client_id parameter"
 * while every known-working remote MCP server accepts them.
 */

import { describe, it, expect } from "vitest";
import { extractClientCredentials, clientSecretError } from "../../src/server/oauth/client-auth";
import { hashToken } from "../../src/server/oauth/utils";
import type { ResolvedClient } from "../../src/server/oauth/service";

function basicHeader(clientId: string, clientSecret: string): string {
  // RFC 6749 §2.3.1: form-urlencode each part, then base64 the joined pair
  const encoded = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`;
  return `Basic ${Buffer.from(encoded, "utf-8").toString("base64")}`;
}

describe("extractClientCredentials", () => {
  it("passes through body credentials when there is no Basic header", () => {
    const result = extractClientCredentials(null, {
      client_id: "client-1",
      client_secret: "s3cret",
    });
    expect(result).toEqual({
      success: true,
      credentials: { clientId: "client-1", clientSecret: "s3cret" },
    });
  });

  it("ignores a non-Basic Authorization header", () => {
    const result = extractClientCredentials("Bearer some-token", { client_id: "client-1" });
    expect(result).toEqual({
      success: true,
      credentials: { clientId: "client-1", clientSecret: undefined },
    });
  });

  it("extracts credentials from a Basic header (client_secret_basic)", () => {
    const result = extractClientCredentials(basicHeader("client-1", "s3cret"), {});
    expect(result).toEqual({
      success: true,
      credentials: { clientId: "client-1", clientSecret: "s3cret" },
    });
  });

  it("is case-insensitive on the Basic scheme", () => {
    const header = basicHeader("client-1", "s3cret").replace("Basic", "basic");
    const result = extractClientCredentials(header, {});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.credentials.clientId).toBe("client-1");
    }
  });

  it("percent-decodes the RFC 6749 §2.3.1 form-urlencoded parts", () => {
    // A client_id with reserved characters must round-trip
    const result = extractClientCredentials(basicHeader("client:with colon", "p@ss:word"), {});
    expect(result).toEqual({
      success: true,
      credentials: { clientId: "client:with colon", clientSecret: "p@ss:word" },
    });
  });

  it("accepts a matching client_id duplicated in the body", () => {
    const result = extractClientCredentials(basicHeader("client-1", "s3cret"), {
      client_id: "client-1",
    });
    expect(result).toEqual({
      success: true,
      credentials: { clientId: "client-1", clientSecret: "s3cret" },
    });
  });

  it("rejects a body client_id that contradicts the Basic header", () => {
    const result = extractClientCredentials(basicHeader("client-1", "s3cret"), {
      client_id: "client-2",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.error).toBe("invalid_request");
      expect(result.status).toBe(400);
    }
  });

  it("rejects using Basic and body secrets together (RFC 6749 §2.3)", () => {
    const result = extractClientCredentials(basicHeader("client-1", "s3cret"), {
      client_id: "client-1",
      client_secret: "other-secret",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.error).toBe("invalid_request");
    }
  });

  it.each([
    ["not base64 at all", "Basic %%%%"],
    ["no colon separator", `Basic ${Buffer.from("just-a-client-id").toString("base64")}`],
    ["empty value", "Basic "],
  ])("rejects a malformed Basic header (%s)", (_name, header) => {
    const result = extractClientCredentials(header, {});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.error).toBe("invalid_request");
      expect(result.status).toBe(400);
    }
  });
});

describe("clientSecretError", () => {
  const baseClient: ResolvedClient = {
    clientId: "client-1",
    name: "Test",
    redirectUris: ["https://example.com/callback"],
    grantTypes: ["authorization_code"],
    scopes: null,
    isPublic: false,
    clientSecretHash: hashToken("correct-secret"),
    fromDatabase: true,
  };

  it("passes public clients without a secret", () => {
    expect(
      clientSecretError({ ...baseClient, isPublic: true, clientSecretHash: null }, undefined)
    ).toBeNull();
  });

  it("passes a confidential client with the correct secret", () => {
    expect(clientSecretError(baseClient, "correct-secret")).toBeNull();
  });

  it("rejects a confidential client with a missing secret", () => {
    expect(clientSecretError(baseClient, undefined)?.error).toBe("invalid_client");
  });

  it("rejects a confidential client with a wrong secret", () => {
    expect(clientSecretError(baseClient, "wrong-secret")?.error).toBe("invalid_client");
  });
});
