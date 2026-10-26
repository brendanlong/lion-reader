/**
 * Integration tests for email subscription creation and resubscription.
 *
 * These tests verify that when an unblocked sender sends a new email,
 * the user's subscription is reactivated if it was previously unsubscribed.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import Redis from "ioredis";
import { db } from "../../src/server/db";
import {
  users,
  entries,
  subscriptions,
  userEntries,
  ingestAddresses,
  blockedSenders,
} from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { processInboundEmail, type InboundEmail } from "../../src/server/email/process-inbound";
import { createTestEmailSubscription, createTestUser } from "./helpers";
import { getUserEventsChannel } from "../../src/server/redis/pubsub";
import { waitForMessages } from "../utils/pubsub";

// ============================================================================
// Test Helpers
// ============================================================================

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

// ============================================================================
// Tests
// ============================================================================

describe("Email subscriptions", () => {
  async function cleanup(): Promise<void> {
    await db.delete(userEntries);
    await db.delete(entries);
    await db.delete(subscriptions);
    await db.delete(blockedSenders);
    await db.delete(ingestAddresses);
    await db.delete(users);
  }

  beforeEach(cleanup);
  afterAll(cleanup);

  describe("Resubscribing", () => {
    it("reactivates subscription when unblocked sender sends new email", async () => {
      const userId = await createTestUser();
      const { token } = await createTestIngestAddress(userId);
      const senderEmail = "newsletter@example.com";
      const subscriptionId = await createTestEmailSubscription(userId, {
        emailSender: senderEmail,
        unsubscribedAt: new Date(),
      });

      const result = await processInboundEmail(db, createTestEmail(token, senderEmail));

      expect(result.success).toBe(true);
      expect(result.subscriptionId).toBe(subscriptionId);
      expect((await getSubscription(subscriptionId)).unsubscribedAt).toBeNull();
    });

    it("does not process email when sender is blocked", async () => {
      const userId = await createTestUser();
      const { token } = await createTestIngestAddress(userId);
      const senderEmail = "blocked@example.com";
      await createTestEmailSubscription(userId, {
        emailSender: senderEmail,
        unsubscribedAt: new Date(),
      });
      await blockSender(userId, senderEmail);

      const result = await processInboundEmail(db, createTestEmail(token, senderEmail));

      expect(result.success).toBe(false);
      expect(result.error).toBe("Sender blocked");
    });

    it("does not modify active subscription", async () => {
      const userId = await createTestUser();
      const { token } = await createTestIngestAddress(userId);
      const senderEmail = "active@example.com";
      const subscriptionId = await createTestEmailSubscription(userId, {
        emailSender: senderEmail,
      });
      const originalUpdatedAt = (await getSubscription(subscriptionId)).updatedAt;

      // Wait a bit to ensure timestamps would differ
      await new Promise((resolve) => setTimeout(resolve, 10));

      const result = await processInboundEmail(db, createTestEmail(token, senderEmail));

      expect(result.success).toBe(true);
      const subscription = await getSubscription(subscriptionId);
      expect(subscription.unsubscribedAt).toBeNull();
      // updatedAt should not have changed since subscription was already active
      expect(subscription.updatedAt.getTime()).toBe(originalUpdatedAt.getTime());
    });
  });

  it("creates a subscription, named after the sender and without a feed, for a sender's first email", async () => {
    const userId = await createTestUser();
    const { token } = await createTestIngestAddress(userId);

    const result = await processInboundEmail(
      db,
      createTestEmail(token, "New-Sender@example.com", "Welcome!")
    );

    expect(result.success).toBe(true);
    expect(await getSubscription(result.subscriptionId!)).toMatchObject({
      userId,
      type: "email",
      emailSender: "new-sender@example.com",
      customTitle: "Test Sender",
      feedId: null,
      unsubscribedAt: null,
    });
  });

  // The new subscription's real row, not a guessed count: its first entry,
  // announced next, brings the count with it.
  it("announces the new subscription's row before its first entry", async () => {
    const userId = await createTestUser();
    const { token } = await createTestIngestAddress(userId);
    const subscriber = new Redis(process.env.REDIS_URL!);
    try {
      const channel = getUserEventsChannel(userId);
      await subscriber.subscribe(channel);
      const messages = waitForMessages(subscriber, channel, 2);

      const result = await processInboundEmail(db, createTestEmail(token, "news@example.com"));

      const [created, newEntry] = (await messages).map((message) => JSON.parse(message));
      expect(created).toMatchObject({
        type: "subscription_created",
        subscriptionId: result.subscriptionId,
        row: {
          id: result.subscriptionId,
          type: "email",
          title: "Test Sender",
          unreadCount: 0,
          tags: [],
        },
      });
      expect(newEntry).toMatchObject({ type: "new_entry", subscriptionId: result.subscriptionId });
    } finally {
      await subscriber.quit();
    }
  });
});
