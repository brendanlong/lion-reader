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
