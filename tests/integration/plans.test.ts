// Set ALLOWLIST_SECRET before any imports so env.ts reads it at module init time
process.env.ALLOWLIST_SECRET = "test-admin-secret";

/**
 * Integration tests for plans (#2222): a user's plan sets their quotas, admins
 * change it, and users can see it with their usage.
 */

import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import { db } from "../../src/server/db";
import { users } from "../../src/server/db/schema";
import { createCaller } from "../../src/server/trpc/root";
import { createSubscription } from "../../src/server/services/subscribe";
import { getAppErrorCode } from "../../src/server/errors";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { PLAN_LIMITS } from "../../src/lib/plans";
import {
  createAuthContext,
  createTestFeed,
  createTestSubscription,
  createTestUser,
  createUnauthContext,
  withPlanLimits,
} from "./helpers";

const adminCaller = () =>
  createCaller(createUnauthContext(new Headers({ authorization: "Bearer test-admin-secret" })));

async function cleanup(): Promise<void> {
  await db.delete(users);
}

function subscribe(userId: string) {
  return createSubscription(
    db,
    userId,
    { url: `https://example.com/${generateUuidv7()}.xml` },
    { skipInitialPopulate: true }
  );
}

describe("plans", () => {
  beforeEach(cleanup);
  afterAll(cleanup);
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("caps subscriptions at the user's plan's limit, and an admin's plan change lifts it", async () => {
    const userId = await createTestUser({ plan: "free" });
    await createTestSubscription(userId, await createTestFeed());

    await withPlanLimits("free", { maxSubscriptions: 1 }, async () => {
      await expect(subscribe(userId)).rejects.toSatisfy(
        (error) => getAppErrorCode(error) === "MAX_SUBSCRIPTIONS_REACHED"
      );

      await adminCaller().admin.setUserPlan({ userId, plan: "unlimited" });
      await expect(subscribe(userId)).resolves.toMatchObject({ alreadyActive: false });
    });
  });

  it("caps ingest addresses at the user's plan's limit", async () => {
    vi.stubEnv("INGEST_EMAIL_DOMAIN", "in.example.com");
    vi.stubEnv("MAILGUN_WEBHOOK_SIGNING_KEY", "key");
    const userId = await createTestUser({ plan: "free" });
    const caller = createCaller(await createAuthContext(userId));
    const limit = PLAN_LIMITS.free.maxIngestAddresses!;
    for (let i = 0; i < limit; i++) await caller.ingestAddresses.create({});

    await expect(caller.ingestAddresses.create({})).rejects.toSatisfy(
      (error) => getAppErrorCode(error) === "MAX_INGEST_ADDRESSES_REACHED"
    );
  });

  it("shows the user their plan, its limits and their usage", async () => {
    const userId = await createTestUser({ plan: "paid" });
    await createTestSubscription(userId, await createTestFeed());
    const caller = createCaller(await createAuthContext(userId));

    await expect(caller.users["me.plan"]()).resolves.toEqual({
      plan: "paid",
      limits: PLAN_LIMITS.paid,
      usage: { subscriptions: 1, ingestAddresses: 0 },
    });
  });

  it("lists each user's plan for admins", async () => {
    const userId = await createTestUser({ plan: "free" });
    await adminCaller().admin.setUserPlan({ userId, plan: "paid" });

    const { items } = await adminCaller().admin.listUsers();
    expect(items.find((u) => u.id === userId)?.plan).toBe("paid");
  });

  it("refuses to set the plan of a user that doesn't exist", async () => {
    await expect(
      adminCaller().admin.setUserPlan({ userId: generateUuidv7(), plan: "paid" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
