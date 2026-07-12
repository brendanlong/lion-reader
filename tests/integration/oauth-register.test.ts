/**
 * Integration tests for OAuth Dynamic Client Registration (RFC 7591) scope handling.
 *
 * See issue #870: registration previously fell back to `scopes = null` ("allow
 * all") when none of the requested scopes were recognized. It must instead
 * reject the registration, and only ever store the supported subset.
 */

import { describe, it, expect, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import { db } from "../../src/server/db";
import { oauthClients } from "../../src/server/db/schema";
import { registerClient } from "../../src/server/oauth/service";

const registeredClientIds: string[] = [];

async function register(scope: string | undefined) {
  const result = await registerClient({
    redirect_uris: ["https://example.com/callback"],
    client_name: "Test Client",
    scope,
  });
  if (result.success) {
    registeredClientIds.push(result.data.client_id);
  }
  return result;
}

afterAll(async () => {
  if (registeredClientIds.length > 0) {
    await db.delete(oauthClients).where(inArray(oauthClients.clientId, registeredClientIds));
  }
});

describe("OAuth Dynamic Client Registration auth methods", () => {
  async function registerWithAuthMethod(method: string | undefined) {
    const result = await registerClient({
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      client_name: "Auth Method Test Client",
      token_endpoint_auth_method: method,
    });
    if (result.success) {
      registeredClientIds.push(result.data.client_id);
    }
    return result;
  }

  it.each(["client_secret_basic", "client_secret_post"])(
    "accepts %s and issues a secret",
    async (method) => {
      const result = await registerWithAuthMethod(method);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.token_endpoint_auth_method).toBe(method);
        expect(result.data.client_secret).toBeTruthy();
        expect(result.data.client_secret_expires_at).toBe(0);
        // Notion and Linear both include this alongside client_secret; a strict
        // client response model built against them may require it (#986).
        expect(result.data.client_secret_issued_at).toBe(result.data.client_id_issued_at);
      }
    }
  );

  it("registers a public client (no secret) for method none", async () => {
    const result = await registerWithAuthMethod("none");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.token_endpoint_auth_method).toBe("none");
      expect(result.data.client_secret).toBeUndefined();
    }
  });

  it("defaults an omitted method to client_secret_basic per RFC 7591 §2", async () => {
    const result = await registerWithAuthMethod(undefined);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.token_endpoint_auth_method).toBe("client_secret_basic");
      expect(result.data.client_secret).toBeTruthy();
    }
  });

  it("rejects an unsupported auth method", async () => {
    const result = await registerWithAuthMethod("private_key_jwt");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.error).toBe("invalid_client_metadata");
    }
  });

  it("includes a registration_client_uri like the working remote MCP servers", async () => {
    const result = await registerWithAuthMethod("none");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.registration_client_uri).toMatch(
        new RegExp(`/oauth/register/${result.data.client_id}$`)
      );
    }
  });

  it("expresses registration_client_uri on the requesting host's surface", async () => {
    // A registration on the dedicated MCP host must not reference the apex
    // origin — a cross-origin registration_client_uri is an inconsistency a
    // strict client can reject.
    process.env.MCP_HOST = "mcp.example.com";
    try {
      const result = await registerClient(
        {
          redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
          client_name: "MCP Host Test Client",
          token_endpoint_auth_method: "none",
        },
        "mcp.example.com"
      );
      expect(result.success).toBe(true);
      if (result.success) {
        registeredClientIds.push(result.data.client_id);
        // Origin root (no /oauth prefix), matching the MCP host's advertised
        // registration_endpoint.
        expect(result.data.registration_client_uri).toBe(
          `https://mcp.example.com/register/${result.data.client_id}`
        );
      }
    } finally {
      delete process.env.MCP_HOST;
    }
  });
});

describe("OAuth Dynamic Client Registration scope handling", () => {
  it("rejects registration when no requested scope is recognized", async () => {
    const result = await register("totally-made-up another-bogus-scope");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.error).toBe("invalid_client_metadata");
    }
  });

  it("stores only the supported subset of requested scopes", async () => {
    const result = await register("mcp bogus-scope");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scope).toBe("mcp");
    }
  });

  it("accepts a single valid scope", async () => {
    const result = await register("saved:write");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scope).toBe("saved:write");
    }
  });
});
