/**
 * Integration tests for the ingest addresses router's server configuration
 * gate: newsletters work only when this server has both an ingest domain and a
 * Mailgun signing key (#1797).
 */

import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import { db } from "../../src/server/db";
import { users } from "../../src/server/db/schema";
import { createCaller } from "../../src/server/trpc/root";
import { createAuthContext, createTestIngestAddress, createTestUser } from "./helpers";

describe("ingestAddresses", () => {
  async function cleanup(): Promise<void> {
    await db.delete(users);
  }

  beforeEach(cleanup);
  afterAll(cleanup);
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function configure(domain: string, signingKey: string): void {
    vi.stubEnv("INGEST_EMAIL_DOMAIN", domain);
    vi.stubEnv("MAILGUN_WEBHOOK_SIGNING_KEY", signingKey);
  }

  it("creates addresses on the configured domain", async () => {
    configure("in.example.com", "key");
    const caller = createCaller(await createAuthContext(await createTestUser()));

    const { address } = await caller.ingestAddresses.create({ label: "News" });

    expect(address.email).toBe(`${address.token}@in.example.com`);
    const list = await caller.ingestAddresses.list();
    expect(list.enabled).toBe(true);
    expect(list.items.map((a) => a.email)).toEqual([address.email]);
  });

  it.each([
    ["no ingest domain", "", "key"],
    ["no signing key", "in.example.com", ""],
  ])("is disabled with %s", async (_name, domain, signingKey) => {
    configure(domain, signingKey);
    const userId = await createTestUser();
    const addressId = await createTestIngestAddress(userId);
    const caller = createCaller(await createAuthContext(userId));

    await expect(caller.ingestAddresses.list()).resolves.toEqual({ enabled: false, items: [] });
    await expect(caller.ingestAddresses.create({})).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    await expect(
      caller.ingestAddresses.update({ id: addressId, label: "x" })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});
