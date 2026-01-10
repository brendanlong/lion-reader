/**
 * Integration tests for email feed resubscription.
 *
 * These tests verify that when an unblocked sender sends a new email,
 * the user's subscription is reactivated if it was previously unsubscribed.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { db } from "../../src/server/db";
import {
  users,
  feeds,
  entries,
  subscriptions,
  userEntries,
  ingestAddresses,
  blockedSenders,
} from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { processInboundEmail, type InboundEmail } from "../../src/server/email/process-inbound";

// ============================================================================
// Test Helpers
// ============================================================================

async function createTestUser(emailPrefix: string = "user"): Promise<string> {
  const userId = generateUuidv7();
  await db.insert(users).values({
    id: userId,
    email: `${emailPrefix}-${userId}@test.com`,
    passwordHash: "test-hash",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return userId;
}

async function createTestIngestAddress(userId: string): Promise<{ id: string; token: string }> {
  const id = generateUuidv7();
  const token = "test-token-" + id.slice(0, 8);
  await db.insert(ingestAddresses).values({
    id,
    userId,
    token,
    createdAt: new Date(),
  });
  return { id, token };
}

async function createTestEmailFeed(
  userId: string,
  senderEmail: string,
  title: string = "Test Sender"
): Promise<string> {
  const feedId = generateUuidv7();
  const now = new Date();
  await db.insert(feeds).values({
    id: feedId,
    type: "email",
    userId,
    emailSenderPattern: senderEmail.toLowerCase(),
    title,
    createdAt: now,
    updatedAt: now,
  });
  return feedId;
}

async function createTestSubscription(
  userId: string,
  feedId: string,
  unsubscribedAt: Date | null = null
): Promise<string> {
  const subscriptionId = generateUuidv7();
  await db.insert(subscriptions).values({
    id: subscriptionId,
    userId,
    feedId,
    subscribedAt: new Date(),
    unsubscribedAt,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return subscriptionId;
}

async function blockSender(userId: string, senderEmail: string): Promise<void> {
  await db.insert(blockedSenders).values({
    id: generateUuidv7(),
    userId,
    senderEmail: senderEmail.toLowerCase(),
    blockedAt: new Date(),
  });
}

function createTestEmail(
  token: string,
  senderEmail: string,
  subject: string = "Test Email"
): InboundEmail {
  return {
    to: `${token}@ingest.lionreader.com`,
    from: {
      address: senderEmail,
      name: "Test Sender",
    },
    subject,
    messageId: `<${generateUuidv7()}@test.com>`,
    html: "<p>Test content</p>",
    headers: {},
  };
}

async function getSubscription(subscriptionId: string) {
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.id, subscriptionId))
    .limit(1);
  return sub;
}

async function getSubscriptionByUserAndFeed(userId: string, feedId: string) {
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, userId), eq(subscriptions.feedId, feedId)))
    .limit(1);
  return sub;
}

// ============================================================================
// Tests
// ============================================================================

describe("Email Feed Resubscription", () => {
  beforeEach(async () => {
    await db.delete(userEntries);
    await db.delete(entries);
    await db.delete(subscriptions);
    await db.delete(blockedSenders);
    await db.delete(feeds);
    await db.delete(ingestAddresses);
    await db.delete(users);
  });

  afterAll(async () => {
    await db.delete(userEntries);
    await db.delete(entries);
    await db.delete(subscriptions);
    await db.delete(blockedSenders);
    await db.delete(feeds);
    await db.delete(ingestAddresses);
    await db.delete(users);
  });

  describe("Resubscribing unsubscribed feeds", () => {
    it("reactivates subscription when unblocked sender sends new email", async () => {
      // Setup: user with ingest address, email feed, and unsubscribed subscription
      const userId = await createTestUser();
      const { token } = await createTestIngestAddress(userId);
      const senderEmail = "newsletter@example.com";
      const feedId = await createTestEmailFeed(userId, senderEmail);
      const subscriptionId = await createTestSubscription(
        userId,
        feedId,
        new Date() // unsubscribed
      );

      // Verify subscription is initially unsubscribed
      let subscription = await getSubscription(subscriptionId);
      expect(subscription.unsubscribedAt).not.toBeNull();

      // Process new email from the sender (sender is NOT blocked)
      const email = createTestEmail(token, senderEmail);
      const result = await processInboundEmail(email);

      expect(result.success).toBe(true);
      expect(result.feedId).toBe(feedId);

      // Verify subscription is now reactivated
      subscription = await getSubscription(subscriptionId);
      expect(subscription.unsubscribedAt).toBeNull();
    });

    it("does not process email when sender is blocked", async () => {
      const userId = await createTestUser();
      const { token } = await createTestIngestAddress(userId);
      const senderEmail = "blocked@example.com";
      const feedId = await createTestEmailFeed(userId, senderEmail);
      await createTestSubscription(userId, feedId, new Date());

      // Block the sender
      await blockSender(userId, senderEmail);

      // Try to process email from blocked sender
      const email = createTestEmail(token, senderEmail);
      const result = await processInboundEmail(email);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Sender blocked");
    });

    it("creates subscription when feed exists but no subscription record", async () => {
      // This edge case might happen due to data inconsistency
      const userId = await createTestUser();
      const { token } = await createTestIngestAddress(userId);
      const senderEmail = "orphan@example.com";
      const feedId = await createTestEmailFeed(userId, senderEmail);
      // No subscription created

      // Verify no subscription exists
      let subscription = await getSubscriptionByUserAndFeed(userId, feedId);
      expect(subscription).toBeUndefined();

      // Process email
      const email = createTestEmail(token, senderEmail);
      const result = await processInboundEmail(email);

      expect(result.success).toBe(true);
      expect(result.feedId).toBe(feedId);

      // Verify subscription was created
      subscription = await getSubscriptionByUserAndFeed(userId, feedId);
      expect(subscription).toBeDefined();
      expect(subscription.unsubscribedAt).toBeNull();
    });

    it("does not modify active subscription", async () => {
      const userId = await createTestUser();
      const { token } = await createTestIngestAddress(userId);
      const senderEmail = "active@example.com";
      const feedId = await createTestEmailFeed(userId, senderEmail);
      const subscriptionId = await createTestSubscription(userId, feedId, null); // active

      // Get original subscription state
      const originalSub = await getSubscription(subscriptionId);
      const originalUpdatedAt = originalSub.updatedAt;

      // Wait a bit to ensure timestamps would differ
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Process email
      const email = createTestEmail(token, senderEmail);
      const result = await processInboundEmail(email);

      expect(result.success).toBe(true);

      // Verify subscription was not modified
      const subscription = await getSubscription(subscriptionId);
      expect(subscription.unsubscribedAt).toBeNull();
      // updatedAt should not have changed since subscription was already active
      expect(subscription.updatedAt.getTime()).toBe(originalUpdatedAt.getTime());
    });
  });

  describe("Email feed creation", () => {
    it("creates new feed and subscription for first email from sender", async () => {
      const userId = await createTestUser();
      const { token } = await createTestIngestAddress(userId);
      const senderEmail = "new-sender@example.com";

      // No feed exists yet
      const [existingFeed] = await db
        .select()
        .from(feeds)
        .where(
          and(eq(feeds.userId, userId), eq(feeds.emailSenderPattern, senderEmail.toLowerCase()))
        )
        .limit(1);
      expect(existingFeed).toBeUndefined();

      // Process first email
      const email = createTestEmail(token, senderEmail, "Welcome!");
      const result = await processInboundEmail(email);

      expect(result.success).toBe(true);
      expect(result.feedId).toBeDefined();

      // Verify feed was created
      const [feed] = await db.select().from(feeds).where(eq(feeds.id, result.feedId!)).limit(1);
      expect(feed).toBeDefined();
      expect(feed.type).toBe("email");
      expect(feed.userId).toBe(userId);
      expect(feed.emailSenderPattern).toBe(senderEmail.toLowerCase());

      // Verify subscription was created
      const subscription = await getSubscriptionByUserAndFeed(userId, feed.id);
      expect(subscription).toBeDefined();
      expect(subscription.unsubscribedAt).toBeNull();
    });
  });
});
