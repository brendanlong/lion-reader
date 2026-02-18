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
  verifyHmacSignature,
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

  describe("handleVerificationChallenge", () => {
    it("returns error when required parameters are missing", async () => {
      const feed = await createTestFeed();
      await createTestSubscription(feed.id, { topicUrl: feed.url ?? "" });

      const result = await handleVerificationChallenge(feed.id, {
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

      const result = await handleVerificationChallenge(feed.id, {
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

      const result = await handleVerificationChallenge(nonExistentId, {
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

      const result = await handleVerificationChallenge(feed.id, {
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
      const result = await handleVerificationChallenge(feed.id, {
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

    it("handles verification without lease_seconds", async () => {
      const feed = await createTestFeed();
      const topicUrl = "https://example.com/feed-no-lease.xml";
      await createTestSubscription(feed.id, { topicUrl });

      const challenge = "test-challenge-no-lease";
      const result = await handleVerificationChallenge(feed.id, {
        mode: "subscribe",
        topic: topicUrl,
        challenge,
        leaseSeconds: null,
      });

      expect(result.success).toBe(true);
      expect(result.challenge).toBe(challenge);

      const [subscription] = await db.select().from(websubSubscriptions).limit(1);

      expect(subscription.state).toBe("active");
      expect(subscription.leaseSeconds).toBeNull();
      expect(subscription.expiresAt).toBeNull();
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
      const result = await handleVerificationChallenge(feed.id, {
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

    it("confirms hub-initiated unsubscribe", async () => {
      const feed = await createTestFeed();
      const topicUrl = "https://example.com/hub-initiated.xml";
      const { subscription: createdSub } = await createTestSubscription(feed.id, {
        topicUrl,
        state: "active",
        // No unsubscribeRequestedAt - this is hub-initiated
      });

      // Mark feed as WebSub active
      await db.update(feeds).set({ websubActive: true }).where(eq(feeds.id, feed.id));

      const challenge = "hub-unsubscribe-challenge";
      const result = await handleVerificationChallenge(feed.id, {
        mode: "unsubscribe",
        topic: topicUrl,
        challenge,
        leaseSeconds: null,
      });

      expect(result.success).toBe(true);
      expect(result.challenge).toBe(challenge);

      // Verify subscription was marked as unsubscribed with note
      const [subscription] = await db
        .select()
        .from(websubSubscriptions)
        .where(eq(websubSubscriptions.id, createdSub.id));
      expect(subscription.state).toBe("unsubscribed");
      expect(subscription.lastError).toBe("Hub-initiated unsubscribe confirmed");

      // Verify feed is no longer marked as WebSub active
      const [updatedFeed] = await db.select().from(feeds).where(eq(feeds.id, feed.id)).limit(1);
      expect(updatedFeed.websubActive).toBe(false);
    });

    it("rejects unsubscribe with topic mismatch", async () => {
      const feed = await createTestFeed();
      await createTestSubscription(feed.id, {
        topicUrl: "https://example.com/correct-feed.xml",
        state: "active",
        unsubscribeRequestedAt: new Date(),
      });

      const result = await handleVerificationChallenge(feed.id, {
        mode: "unsubscribe",
        topic: "https://example.com/wrong-feed.xml",
        challenge: "challenge",
        leaseSeconds: null,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Topic mismatch");
    });
  });

  describe("verifyHmacSignature", () => {
    it("returns false when signature is missing", async () => {
      const feed = await createTestFeed();
      await createTestSubscription(feed.id, { state: "active" });

      const isValid = await verifyHmacSignature(feed.id, null, "test body");

      expect(isValid).toBe(false);
    });

    it("returns false when subscription is not active", async () => {
      const feed = await createTestFeed();
      const { secret } = await createTestSubscription(feed.id, { state: "pending" });

      const body = "test body content";
      const hmac = createHmac("sha256", secret);
      hmac.update(body);
      const signature = `sha256=${hmac.digest("hex")}`;

      const isValid = await verifyHmacSignature(feed.id, signature, body);

      expect(isValid).toBe(false);
    });

    it("returns false when subscription does not exist", async () => {
      const nonExistentId = generateUuidv7();
      const isValid = await verifyHmacSignature(nonExistentId, "sha256=abc123", "test body");

      expect(isValid).toBe(false);
    });

    it("returns false for malformed signature", async () => {
      const feed = await createTestFeed();
      await createTestSubscription(feed.id, { state: "active" });

      const isValid = await verifyHmacSignature(feed.id, "invalid-signature-format", "test body");

      expect(isValid).toBe(false);
    });

    it("returns false for invalid signature", async () => {
      const feed = await createTestFeed();
      await createTestSubscription(feed.id, { state: "active" });

      // Create a signature with a different body
      const wrongSignature =
        "sha256=0000000000000000000000000000000000000000000000000000000000000000";

      const isValid = await verifyHmacSignature(feed.id, wrongSignature, "test body");

      expect(isValid).toBe(false);
    });

    it("returns true for valid SHA256 signature", async () => {
      const feed = await createTestFeed();
      const { secret } = await createTestSubscription(feed.id, { state: "active" });

      const body = SAMPLE_RSS_FEED;
      const hmac = createHmac("sha256", secret);
      hmac.update(body);
      const signature = `sha256=${hmac.digest("hex")}`;

      const isValid = await verifyHmacSignature(feed.id, signature, body);

      expect(isValid).toBe(true);
    });

    it("returns true for valid SHA1 signature", async () => {
      const feed = await createTestFeed();
      const { secret } = await createTestSubscription(feed.id, { state: "active" });

      const body = "simple test body";
      const hmac = createHmac("sha1", secret);
      hmac.update(body);
      const signature = `sha1=${hmac.digest("hex")}`;

      const isValid = await verifyHmacSignature(feed.id, signature, body);

      expect(isValid).toBe(true);
    });

    it("returns true for valid signature with Buffer body", async () => {
      const feed = await createTestFeed();
      const { secret } = await createTestSubscription(feed.id, { state: "active" });

      const body = Buffer.from("buffer body content", "utf-8");
      const hmac = createHmac("sha256", secret);
      hmac.update(body);
      const signature = `sha256=${hmac.digest("hex")}`;

      const isValid = await verifyHmacSignature(feed.id, signature, body);

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
      const result = await handleVerificationChallenge(feed.id, {
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

      const isValid = await verifyHmacSignature(feed.id, signature, body);
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
      await handleVerificationChallenge(feed.id, {
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
      await handleVerificationChallenge(feed.id, {
        mode: "subscribe",
        topic: topicUrl,
        challenge: "challenge-2",
        leaseSeconds: "7200",
      });

      const [second] = await db.select().from(websubSubscriptions).limit(1);
      expect(second.state).toBe("active");
      expect(second.leaseSeconds).toBe(7200);
    });
  });
});
