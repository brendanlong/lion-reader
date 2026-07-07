/**
 * Integration tests for WebSub subscription flow.
 *
 * These tests use a real database to verify WebSub subscription creation,
 * verification handling, and content notification processing.
 *
 * Note: Since we can't easily mock external HTTP calls in integration tests,
 * we test the subscription record management and callback handlers directly.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { createHmac } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import { feeds, entries, websubSubscriptions } from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import {
  generateCallbackSecret,
  handleVerificationChallenge,
  handleVerificationChallengeByFeed,
  verifyHmacSignature,
  verifyHmacSignatureByFeed,
} from "../../src/server/feed/websub";

// Sample RSS feed content for testing content notifications
const SAMPLE_RSS_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Feed</title>
    <link>https://example.com</link>
    <description>A test feed for WebSub</description>
    <item>
      <title>New Article</title>
      <link>https://example.com/article-1</link>
      <guid>article-1</guid>
      <description>This is a new article pushed via WebSub</description>
      <pubDate>Mon, 01 Jan 2024 12:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

// Helper to create a test feed in the database
async function createTestFeed(overrides: Partial<typeof feeds.$inferInsert> = {}) {
  const [feed] = await db
    .insert(feeds)
    .values({
      id: generateUuidv7(),
      type: "web",
      url: `https://example.com/feed-${generateUuidv7()}.xml`,
      title: "Test Feed",
      hubUrl: "https://hub.example.com/",
      selfUrl: `https://example.com/feed-${generateUuidv7()}.xml`,
      ...overrides,
    })
    .returning();
  return feed;
}

// Helper to create a test WebSub subscription
async function createTestSubscription(
  feedId: string,
  overrides: Partial<typeof websubSubscriptions.$inferInsert> = {}
) {
  const secret = generateCallbackSecret();
  const [subscription] = await db
    .insert(websubSubscriptions)
    .values({
      id: generateUuidv7(),
      feedId,
      hubUrl: "https://hub.example.com/",
      topicUrl: `https://example.com/feed.xml`,
      callbackSecret: secret,
      state: "pending",
      ...overrides,
    })
    .returning();
  return { subscription, secret };
}

describe("WebSub Integration", () => {
  // Clean up tables before each test
  beforeEach(async () => {
    await db.delete(entries);
    await db.delete(websubSubscriptions);
    await db.delete(feeds);
  });

  // Clean up after all tests
  afterAll(async () => {
    await db.delete(entries);
    await db.delete(websubSubscriptions);
    await db.delete(feeds);
  });

  describe("generateCallbackSecret", () => {
    it("generates a 64-character hex string", () => {
      const secret = generateCallbackSecret();
      expect(secret).toMatch(/^[a-f0-9]{64}$/);
    });

    it("generates unique secrets", () => {
      const secret1 = generateCallbackSecret();
      const secret2 = generateCallbackSecret();
      expect(secret1).not.toBe(secret2);
    });
  });

  // Core verification behavior, exercised through the legacy per-feed entry point
  // (handleVerificationChallengeByFeed). The per-subscription entry point shares
  // the same core and is covered separately below.
  describe("handleVerificationChallengeByFeed (legacy per-feed)", () => {
    it("returns error when required parameters are missing", async () => {
      const feed = await createTestFeed();
      await createTestSubscription(feed.id, { topicUrl: feed.url ?? "" });

      const result = await handleVerificationChallengeByFeed(feed.id, {
        mode: null,
        topic: null,
        challenge: null,
        leaseSeconds: null,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Missing required parameters");
    });

    it("returns error for unsupported mode", async () => {
      const feed = await createTestFeed();
      await createTestSubscription(feed.id, { topicUrl: feed.url ?? "" });

      const result = await handleVerificationChallengeByFeed(feed.id, {
        mode: "invalid",
        topic: feed.url ?? "",
        challenge: "test-challenge-123",
        leaseSeconds: null,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Unsupported mode: invalid");
    });

    it("returns error when subscription not found", async () => {
      const nonExistentId = generateUuidv7();

      const result = await handleVerificationChallengeByFeed(nonExistentId, {
        mode: "subscribe",
        topic: "https://example.com/feed.xml",
        challenge: "test-challenge-123",
        leaseSeconds: null,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Subscription not found");
    });

    it("returns error when topic does not match", async () => {
      const feed = await createTestFeed();
      await createTestSubscription(feed.id, { topicUrl: "https://example.com/correct-feed.xml" });

      const result = await handleVerificationChallengeByFeed(feed.id, {
        mode: "subscribe",
        topic: "https://example.com/wrong-feed.xml",
        challenge: "test-challenge-123",
        leaseSeconds: null,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Topic mismatch");
    });

    it("successfully verifies subscription and returns challenge", async () => {
      const feed = await createTestFeed();
      const topicUrl = "https://example.com/my-feed.xml";
      await createTestSubscription(feed.id, { topicUrl });

      const challenge = "random-challenge-string-456";
      const result = await handleVerificationChallengeByFeed(feed.id, {
        mode: "subscribe",
        topic: topicUrl,
        challenge,
        leaseSeconds: "86400",
      });

      expect(result.success).toBe(true);
      expect(result.challenge).toBe(challenge);

      // Verify subscription was updated to active
      const [subscription] = await db.select().from(websubSubscriptions).limit(1);

      expect(subscription.state).toBe("active");
      expect(subscription.leaseSeconds).toBe(86400);
      expect(subscription.expiresAt).toBeInstanceOf(Date);
      expect(subscription.lastChallengeAt).toBeInstanceOf(Date);
    });

    it("falls back to a default lease when the hub omits lease_seconds", async () => {
      // A hub that verifies without hub.lease_seconds must still get a concrete
      // expiresAt, otherwise the subscription never matches the renewal filter
      // and stays "active" in our DB forever even after the hub drops it.
      const feed = await createTestFeed();
      const topicUrl = "https://example.com/feed-no-lease.xml";
      await createTestSubscription(feed.id, { topicUrl });

      const challenge = "test-challenge-no-lease";
      const before = Date.now();
      const result = await handleVerificationChallengeByFeed(feed.id, {
        mode: "subscribe",
        topic: topicUrl,
        challenge,
        leaseSeconds: null,
      });

      expect(result.success).toBe(true);
      expect(result.challenge).toBe(challenge);

      const [subscription] = await db.select().from(websubSubscriptions).limit(1);

      expect(subscription.state).toBe("active");
      // Default lease is 24 hours; expiresAt is stamped so renewal can keep it alive.
      expect(subscription.leaseSeconds).toBe(24 * 60 * 60);
      expect(subscription.expiresAt).toBeInstanceOf(Date);
      const expiresMs = subscription.expiresAt!.getTime();
      expect(expiresMs).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000);
      expect(expiresMs).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60 * 1000 + 5000);
    });

    it("confirms unsubscribe when we requested it", async () => {
      const feed = await createTestFeed();
      const topicUrl = "https://example.com/unsub-requested.xml";
      const { subscription: createdSub } = await createTestSubscription(feed.id, {
        topicUrl,
        state: "active",
        unsubscribeRequestedAt: new Date(),
      });

      // Mark feed as WebSub active
      await db.update(feeds).set({ websubActive: true }).where(eq(feeds.id, feed.id));

      const challenge = "unsubscribe-challenge-123";
      const result = await handleVerificationChallengeByFeed(feed.id, {
        mode: "unsubscribe",
        topic: topicUrl,
        challenge,
        leaseSeconds: null,
      });

      expect(result.success).toBe(true);
      expect(result.challenge).toBe(challenge);

      // Verify subscription was marked as unsubscribed
      const [subscription] = await db
        .select()
        .from(websubSubscriptions)
        .where(eq(websubSubscriptions.id, createdSub.id));
      expect(subscription.state).toBe("unsubscribed");
      expect(subscription.lastError).toBeNull();
      expect(subscription.lastChallengeAt).toBeInstanceOf(Date);

      // Verify feed is no longer marked as WebSub active
      const [updatedFeed] = await db.select().from(feeds).where(eq(feeds.id, feed.id)).limit(1);
      expect(updatedFeed.websubActive).toBe(false);
    });

    it("rejects unsubscribe verification we never requested", async () => {
      const feed = await createTestFeed();
      const topicUrl = "https://example.com/hub-initiated.xml";
      const { subscription: createdSub } = await createTestSubscription(feed.id, {
        topicUrl,
        state: "active",
        // No unsubscribeRequestedAt - we never asked to unsubscribe. The
        // callback URL (feedId) and topic URL are both discoverable, so
        // confirming this would let anyone silently downgrade the feed from
        // push to polling.
      });

      // Mark feed as WebSub active
      await db.update(feeds).set({ websubActive: true }).where(eq(feeds.id, feed.id));

      const challenge = "hub-unsubscribe-challenge";
      const result = await handleVerificationChallengeByFeed(feed.id, {
        mode: "unsubscribe",
        topic: topicUrl,
        challenge,
        leaseSeconds: null,
      });

      expect(result.success).toBe(false);
      expect(result.challenge).toBeUndefined();

      // Verify subscription is untouched
      const [subscription] = await db
        .select()
        .from(websubSubscriptions)
        .where(eq(websubSubscriptions.id, createdSub.id));
      expect(subscription.state).toBe("active");

      // Verify feed is still marked as WebSub active
      const [updatedFeed] = await db.select().from(feeds).where(eq(feeds.id, feed.id)).limit(1);
      expect(updatedFeed.websubActive).toBe(true);
    });

    it("rejects unsubscribe with topic mismatch", async () => {
      const feed = await createTestFeed();
      await createTestSubscription(feed.id, {
        topicUrl: "https://example.com/correct-feed.xml",
        state: "active",
        unsubscribeRequestedAt: new Date(),
      });

      const result = await handleVerificationChallengeByFeed(feed.id, {
        mode: "unsubscribe",
        topic: "https://example.com/wrong-feed.xml",
        challenge: "challenge",
        leaseSeconds: null,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Topic mismatch");
    });
  });

  // Core HMAC behavior, exercised through the legacy per-feed entry point.
  describe("verifyHmacSignatureByFeed (legacy per-feed)", () => {
    it("returns false when signature is missing", async () => {
      const feed = await createTestFeed();
      await createTestSubscription(feed.id, { state: "active" });

      const isValid = await verifyHmacSignatureByFeed(feed.id, null, "test body");

      expect(isValid).toBe(false);
    });

    it("returns false when subscription is not active", async () => {
      const feed = await createTestFeed();
      const { secret } = await createTestSubscription(feed.id, { state: "pending" });

      const body = "test body content";
      const hmac = createHmac("sha256", secret);
      hmac.update(body);
      const signature = `sha256=${hmac.digest("hex")}`;

      const isValid = await verifyHmacSignatureByFeed(feed.id, signature, body);

      expect(isValid).toBe(false);
    });

    it("returns false when subscription does not exist", async () => {
      const nonExistentId = generateUuidv7();
      const isValid = await verifyHmacSignatureByFeed(nonExistentId, "sha256=abc123", "test body");

      expect(isValid).toBe(false);
    });

    it("returns false for malformed signature", async () => {
      const feed = await createTestFeed();
      await createTestSubscription(feed.id, { state: "active" });

      const isValid = await verifyHmacSignatureByFeed(
        feed.id,
        "invalid-signature-format",
        "test body"
      );

      expect(isValid).toBe(false);
    });

    it("returns false for invalid signature", async () => {
      const feed = await createTestFeed();
      await createTestSubscription(feed.id, { state: "active" });

      // Create a signature with a different body
      const wrongSignature =
        "sha256=0000000000000000000000000000000000000000000000000000000000000000";

      const isValid = await verifyHmacSignatureByFeed(feed.id, wrongSignature, "test body");

      expect(isValid).toBe(false);
    });

    it("returns true for valid SHA256 signature", async () => {
      const feed = await createTestFeed();
      const { secret } = await createTestSubscription(feed.id, { state: "active" });

      const body = SAMPLE_RSS_FEED;
      const hmac = createHmac("sha256", secret);
      hmac.update(body);
      const signature = `sha256=${hmac.digest("hex")}`;

      const isValid = await verifyHmacSignatureByFeed(feed.id, signature, body);

      expect(isValid).toBe(true);
    });

    it("returns true for valid SHA1 signature", async () => {
      const feed = await createTestFeed();
      const { secret } = await createTestSubscription(feed.id, { state: "active" });

      const body = "simple test body";
      const hmac = createHmac("sha1", secret);
      hmac.update(body);
      const signature = `sha1=${hmac.digest("hex")}`;

      const isValid = await verifyHmacSignatureByFeed(feed.id, signature, body);

      expect(isValid).toBe(true);
    });

    it("returns true for valid signature with Buffer body", async () => {
      const feed = await createTestFeed();
      const { secret } = await createTestSubscription(feed.id, { state: "active" });

      const body = Buffer.from("buffer body content", "utf-8");
      const hmac = createHmac("sha256", secret);
      hmac.update(body);
      const signature = `sha256=${hmac.digest("hex")}`;

      const isValid = await verifyHmacSignatureByFeed(feed.id, signature, body);

      expect(isValid).toBe(true);
    });
  });

  describe("WebSub subscription lifecycle", () => {
    it("complete subscription flow: create pending -> verify -> active", async () => {
      const feed = await createTestFeed();
      const topicUrl = feed.url ?? "https://example.com/feed.xml";
      const { secret } = await createTestSubscription(feed.id, {
        topicUrl,
        state: "pending",
      });

      // 1. Subscription is pending
      const [pending] = await db.select().from(websubSubscriptions).limit(1);
      expect(pending.state).toBe("pending");

      // 2. Hub sends verification challenge
      const challenge = "verification-challenge-xyz";
      const result = await handleVerificationChallengeByFeed(feed.id, {
        mode: "subscribe",
        topic: topicUrl,
        challenge,
        leaseSeconds: "604800", // 1 week
      });

      expect(result.success).toBe(true);
      expect(result.challenge).toBe(challenge);

      // 3. Subscription is now active
      const [active] = await db.select().from(websubSubscriptions).limit(1);
      expect(active.state).toBe("active");
      expect(active.leaseSeconds).toBe(604800);
      expect(active.expiresAt).not.toBeNull();

      // 4. Feed is marked as WebSub active
      const [updatedFeed] = await db.select().from(feeds).limit(1);
      expect(updatedFeed.websubActive).toBe(true);

      // 5. Content notifications can be verified
      const body = "content notification body";
      const hmac = createHmac("sha256", secret);
      hmac.update(body);
      const signature = `sha256=${hmac.digest("hex")}`;

      const isValid = await verifyHmacSignatureByFeed(feed.id, signature, body);
      expect(isValid).toBe(true);
    });

    it("multiple subscriptions for same feed get updated", async () => {
      const feed = await createTestFeed();
      const topicUrl = feed.url ?? "https://example.com/feed.xml";

      // Create first subscription
      await createTestSubscription(feed.id, {
        topicUrl,
        state: "pending",
      });

      // Verify first subscription
      await handleVerificationChallengeByFeed(feed.id, {
        mode: "subscribe",
        topic: topicUrl,
        challenge: "challenge-1",
        leaseSeconds: "3600",
      });

      // Check state
      const [first] = await db.select().from(websubSubscriptions).limit(1);
      expect(first.state).toBe("active");
      expect(first.leaseSeconds).toBe(3600);

      // Update the subscription (simulating re-subscription)
      await db
        .update(websubSubscriptions)
        .set({ state: "pending", leaseSeconds: null, expiresAt: null });

      // Verify again with different lease
      await handleVerificationChallengeByFeed(feed.id, {
        mode: "subscribe",
        topic: topicUrl,
        challenge: "challenge-2",
        leaseSeconds: "7200",
      });

      const [second] = await db.select().from(websubSubscriptions).limit(1);
      expect(second.state).toBe("active");
      expect(second.leaseSeconds).toBe(7200);
    });

    it("legacy hub switch: verification activates the new hub row, not the stale one", async () => {
      // Legacy per-feed callback path: a publisher switched hubs, so the feed has
      // an old (unsubscribed) row and a new (pending) row sharing feed + topic.
      // The per-feed callback is ambiguous, so the newest row must win. (The
      // per-subscription callback below resolves this exactly, without ordering.)
      const feed = await createTestFeed();
      const topicUrl = feed.url ?? "https://example.com/feed.xml";

      // Old subscription to hub A, torn down during the switch.
      const { subscription: oldSub } = await createTestSubscription(feed.id, {
        hubUrl: "https://hub-a.example.com/",
        topicUrl,
        state: "unsubscribed",
        unsubscribeRequestedAt: new Date(),
        createdAt: new Date("2026-01-01T00:00:00Z"),
      });

      // New pending subscription to hub B, created after the switch.
      const { secret: newSecret, subscription: newSub } = await createTestSubscription(feed.id, {
        hubUrl: "https://hub-b.example.com/",
        topicUrl,
        state: "pending",
        createdAt: new Date("2026-01-02T00:00:00Z"),
      });

      const challenge = "hub-b-challenge";
      const result = await handleVerificationChallengeByFeed(feed.id, {
        mode: "subscribe",
        topic: topicUrl,
        challenge,
        leaseSeconds: "3600",
      });

      expect(result.success).toBe(true);
      expect(result.challenge).toBe(challenge);

      // The new (hub B) row is now active; the old (hub A) row stays unsubscribed.
      const [activatedNew] = await db
        .select()
        .from(websubSubscriptions)
        .where(eq(websubSubscriptions.id, newSub.id));
      expect(activatedNew.state).toBe("active");

      const [staleOld] = await db
        .select()
        .from(websubSubscriptions)
        .where(eq(websubSubscriptions.id, oldSub.id));
      expect(staleOld.state).toBe("unsubscribed");

      // Feed is active, and only the new hub's secret verifies notifications.
      const [updatedFeed] = await db.select().from(feeds).where(eq(feeds.id, feed.id)).limit(1);
      expect(updatedFeed.websubActive).toBe(true);

      const body = "content from hub b";
      const hmac = createHmac("sha256", newSecret);
      hmac.update(body);
      const isValid = await verifyHmacSignatureByFeed(
        feed.id,
        `sha256=${hmac.digest("hex")}`,
        body
      );
      expect(isValid).toBe(true);
    });
  });

  // Primary path: callbacks carry both feed and subscription IDs, so they resolve
  // to exactly one row - no feed-scoped ordering needed even with multiple rows.
  describe("per-subscription callbacks", () => {
    it("verification activates the exact subscription named in the callback", async () => {
      const feed = await createTestFeed();
      const topicUrl = feed.url ?? "https://example.com/feed.xml";

      // Two pending rows for the same feed + topic (e.g. a prior subscribe that
      // never verified, plus a fresh one). Only the one named in the URL activates.
      const { subscription: other } = await createTestSubscription(feed.id, {
        hubUrl: "https://hub-a.example.com/",
        topicUrl,
        state: "pending",
      });
      const { subscription: target } = await createTestSubscription(feed.id, {
        hubUrl: "https://hub-b.example.com/",
        topicUrl,
        state: "pending",
      });

      const challenge = "target-challenge";
      const result = await handleVerificationChallenge(feed.id, target.id, {
        mode: "subscribe",
        topic: topicUrl,
        challenge,
        leaseSeconds: "3600",
      });

      expect(result.success).toBe(true);
      expect(result.challenge).toBe(challenge);

      const [activatedTarget] = await db
        .select()
        .from(websubSubscriptions)
        .where(eq(websubSubscriptions.id, target.id));
      expect(activatedTarget.state).toBe("active");

      // The other row is untouched, even though it's for the same feed + topic.
      const [untouched] = await db
        .select()
        .from(websubSubscriptions)
        .where(eq(websubSubscriptions.id, other.id));
      expect(untouched.state).toBe("pending");
    });

    it("returns not found when the subscription ID is unknown", async () => {
      const feed = await createTestFeed();
      const topicUrl = feed.url ?? "https://example.com/feed.xml";
      await createTestSubscription(feed.id, { topicUrl, state: "pending" });

      const result = await handleVerificationChallenge(feed.id, generateUuidv7(), {
        mode: "subscribe",
        topic: topicUrl,
        challenge: "c",
        leaseSeconds: "3600",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Subscription not found");
    });

    it("returns not found when the subscription belongs to a different feed", async () => {
      const feedA = await createTestFeed();
      const feedB = await createTestFeed();
      const topicUrl = feedA.url ?? "https://example.com/feed.xml";
      const { subscription } = await createTestSubscription(feedA.id, {
        topicUrl,
        state: "pending",
      });

      // Right subscription ID, wrong feed ID in the path -> rejected.
      const result = await handleVerificationChallenge(feedB.id, subscription.id, {
        mode: "subscribe",
        topic: topicUrl,
        challenge: "c",
        leaseSeconds: "3600",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Subscription not found");
    });

    it("verifies HMAC only for the named active subscription", async () => {
      const feed = await createTestFeed();
      const { subscription, secret } = await createTestSubscription(feed.id, { state: "active" });

      const body = SAMPLE_RSS_FEED;
      const hmac = createHmac("sha256", secret);
      hmac.update(body);
      const signature = `sha256=${hmac.digest("hex")}`;

      expect(await verifyHmacSignature(feed.id, subscription.id, signature, body)).toBe(true);
      // Same secret/body but an unknown subscription ID -> rejected.
      expect(await verifyHmacSignature(feed.id, generateUuidv7(), signature, body)).toBe(false);
    });
  });
});
