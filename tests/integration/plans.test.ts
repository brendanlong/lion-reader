// Set ALLOWLIST_SECRET before any imports so env.ts reads it at module init time
process.env.ALLOWLIST_SECRET = "test-admin-secret";

/**
 * Integration tests for plans (#2222): a user's plan sets their quotas, admins
 * change it, and users can see it with their usage.
 */

import { eq } from "drizzle-orm";
import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import { db } from "../../src/server/db";
import { entries, subscriptions, users } from "../../src/server/db/schema";
import { createCaller } from "../../src/server/trpc/root";
import { createSubscription } from "../../src/server/services/subscribe";
import { processInboundEmail } from "../../src/server/email/process-inbound";
import { saveArticle, uploadArticle, uploadFile } from "../../src/server/services/saved";
import {
  feedWantsFullContent,
  fetchAndStoreFullContent,
} from "../../src/server/services/full-content";
import { retrySubscriptionFeed } from "../../src/server/services/feeds";
import { getAppErrorCode } from "../../src/server/errors";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { PLAN_LIMITS } from "../../src/lib/plans";
import {
  createAuthContext,
  createTestEntry,
  createTestFeed,
  createTestIngestAddress,
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

  describe("continuous quotas", () => {
    const html =
      "<html><head><title>T</title></head><body><article><p>Body text here.</p></article></body></html>";
    const save = (userId: string, path: string) =>
      saveArticle(db, userId, { url: `https://example.com/${path}`, html });
    const upload = (userId: string, name: string) =>
      uploadFile(db, userId, {
        content: Buffer.from(`# ${name}\n\nBody`).toString("base64"),
        filename: `${name}.md`,
      });

    it("refuses saves past the plan's burst, saying when to retry, but re-saving costs nothing", async () => {
      const userId = await createTestUser({ plan: "free" });
      await withPlanLimits(
        "free",
        { quotas: { ...PLAN_LIMITS.free.quotas, pageFetches: { burst: 1, perDay: 1 } } },
        async () => {
          await save(userId, "a");
          // Already saved, so nothing is fetched and nothing is charged.
          await save(userId, "a");

          const error = await save(userId, "b").catch((e: unknown) => e);
          expect(getAppErrorCode(error)).toBe("QUOTA_EXCEEDED");
          expect(error).toMatchObject({ cause: { details: { retryAfter: expect.any(Number) } } });
        }
      );
    });

    it("refuses uploads past the plan's burst, separately from page fetches", async () => {
      const userId = await createTestUser({ plan: "free" });
      await withPlanLimits(
        "free",
        { quotas: { ...PLAN_LIMITS.free.quotas, fileConversions: { burst: 1, perDay: 1 } } },
        async () => {
          await upload(userId, "one");
          await expect(upload(userId, "two")).rejects.toSatisfy(
            (error) => getAppErrorCode(error) === "QUOTA_EXCEEDED"
          );
          await expect(save(userId, "still-allowed")).resolves.toBeDefined();
        }
      );
    });

    const pageFetchers: [string, (userId: string) => Promise<unknown>][] = [
      [
        "refetching an entry's full content",
        async (userId) => {
          const feedId = await createTestFeed();
          await createTestSubscription(userId, feedId);
          const entryId = await createTestEntry(feedId, {
            userIds: [userId],
            url: "https://example.com/full",
            fullContentFetchedAt: new Date(),
          });
          return fetchAndStoreFullContent(db, userId, entryId);
        },
      ],
      [
        "retrying a broken feed",
        async (userId) =>
          retrySubscriptionFeed(
            db,
            userId,
            await createTestSubscription(userId, await createTestFeed())
          ),
      ],
    ];

    it.each(pageFetchers)("charges %s as a page fetch", async (_name, fetchPage) => {
      const userId = await createTestUser({ plan: "free" });
      await withPlanLimits(
        "free",
        { quotas: { ...PLAN_LIMITS.free.quotas, pageFetches: { burst: 1, perDay: 1 } } },
        async () => {
          await save(userId, "spends-the-quota");
          await expect(fetchPage(userId)).rejects.toSatisfy(
            (error) => getAppErrorCode(error) === "QUOTA_EXCEEDED"
          );
        }
      );
    });

    it("charges a Markdown upload as a file upload", async () => {
      const userId = await createTestUser({ plan: "free" });
      await withPlanLimits(
        "free",
        { quotas: { ...PLAN_LIMITS.free.quotas, fileConversions: { burst: 1, perDay: 1 } } },
        async () => {
          await upload(userId, "spends-the-quota");
          await expect(
            uploadArticle(db, userId, { content: "# Notes", title: "Notes" })
          ).rejects.toSatisfy((error) => getAppErrorCode(error) === "QUOTA_EXCEEDED");
        }
      );
    });

    it("starts the quotas full when an admin changes the plan", async () => {
      const userId = await createTestUser({ plan: "free" });
      const oneFetch = {
        quotas: { ...PLAN_LIMITS.free.quotas, pageFetches: { burst: 1, perDay: 1 } },
      };
      await withPlanLimits("free", oneFetch, () =>
        withPlanLimits("paid", oneFetch, async () => {
          await save(userId, "spends-the-quota");
          await expect(save(userId, "refused")).rejects.toSatisfy(
            (error) => getAppErrorCode(error) === "QUOTA_EXCEEDED"
          );

          await adminCaller().admin.setUserPlan({ userId, plan: "paid" });
          await expect(save(userId, "allowed-again")).resolves.toBeDefined();
        })
      );
    });

    it("doesn't limit a plan without the quota", async () => {
      const userId = await createTestUser({ plan: "unlimited" });
      await withPlanLimits(
        "free",
        { quotas: { ...PLAN_LIMITS.free.quotas, fileConversions: { burst: 1, perDay: 1 } } },
        async () => {
          for (let i = 0; i < 2; i++) await upload(userId, `file-${i}`);
        }
      );
    });
  });

  it("drops newsletter emails past the plan's quota, without adding them", async () => {
    const userId = await createTestUser({ plan: "free" });
    const token = `token-${generateUuidv7()}`;
    await createTestIngestAddress(userId, { token });
    const receive = () =>
      processInboundEmail(db, {
        to: `${token}@ingest.lionreader.com`,
        from: { address: "news@example.com", name: "News" },
        subject: "Hello",
        messageId: `<${generateUuidv7()}@example.com>`,
        html: "<p>Hi</p>",
        headers: {},
      });

    await withPlanLimits(
      "free",
      { quotas: { ...PLAN_LIMITS.free.quotas, newsletterEmails: { burst: 1, perDay: 1 } } },
      async () => {
        expect((await receive()).success).toBe(true);
        expect(await receive()).toMatchObject({ success: false });
      }
    );
    const emails = await db
      .select({ id: entries.id })
      .from(entries)
      .innerJoin(subscriptions, eq(subscriptions.id, entries.ownerSubscriptionId))
      .where(eq(subscriptions.userId, userId));
    expect(emails).toHaveLength(1);
  });

  it("fetches a feed's full content in the background only for a plan that includes it", async () => {
    const feedId = await createTestFeed();
    const free = await createTestUser({ plan: "free" });
    await createTestSubscription(free, feedId, { fetchFullContent: true });

    await withPlanLimits("free", { backgroundFullContent: false }, async () => {
      expect(await feedWantsFullContent(db, feedId)).toBe(false);
      const paid = await createTestUser({ plan: "paid" });
      await withPlanLimits("paid", { backgroundFullContent: true }, async () => {
        await createTestSubscription(paid, feedId, { fetchFullContent: true });
        expect(await feedWantsFullContent(db, feedId)).toBe(true);
      });
    });
  });

  it("shows the user their plan, its limits and their usage", async () => {
    const userId = await createTestUser({ plan: "paid" });
    await createTestSubscription(userId, await createTestFeed());
    const caller = createCaller(await createAuthContext(userId));

    await expect(caller.users["me.plan"]()).resolves.toEqual({
      plan: "paid",
      limits: PLAN_LIMITS.paid,
      serverKeyModels: null,
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
