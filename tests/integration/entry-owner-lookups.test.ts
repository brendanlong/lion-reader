/**
 * Every lookup of an email or saved article goes by its owner (#1846): its
 * subscription or its user, never a feed, which email and saved entries no
 * longer have.
 */

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../src/server/db";
import {
  blockedSenders,
  entries,
  subscriptionEntries,
  subscriptions,
  users,
} from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { processInboundEmail } from "../../src/server/email/process-inbound";
import {
  deleteSavedArticle,
  saveArticle,
  savedArticleExistsByUrl,
} from "../../src/server/services/saved";
import { resolveGreaderIdsForEntries } from "../../src/server/google-reader/id";
import { listEntries } from "../../src/server/services/entries";
import { unsubscribe } from "../../src/server/services/subscription-updates";
import { createCaller } from "../../src/server/trpc/root";
import { createAuthContext, createTestIngestAddress, createTestUser } from "./helpers";

const ARTICLE_HTML =
  "<html><body><article><p>A saved article body, long enough to keep.</p></article></body></html>";

const createdUsers: string[] = [];

async function removeCreatedUsers(): Promise<void> {
  if (createdUsers.length === 0) return;
  // Cascades to their subscriptions and the entries they own.
  await db.delete(users).where(inArray(users.id, createdUsers));
  createdUsers.length = 0;
}

async function receiveEmail(
  userId: string,
  options: { messageId?: string; listUnsubscribe?: string } = {}
) {
  const token = `token-${generateUuidv7()}`;
  await createTestIngestAddress(userId, { token });
  return processInboundEmail({
    to: `${token}@ingest.lionreader.com`,
    from: { address: "news@example.com", name: "The News" },
    subject: "Hello",
    messageId: options.messageId ?? `<${generateUuidv7()}@example.com>`,
    html: "<p>Hi</p>",
    headers: { listUnsubscribe: options.listUnsubscribe },
  });
}

async function entryRow(entryId: string) {
  const [row] = await db.select().from(entries).where(eq(entries.id, entryId));
  return row;
}

async function subscriptionRow(subscriptionId: string) {
  const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, subscriptionId));
  return row;
}

describe("email and saved lookups by owner (#1846)", () => {
  afterEach(removeCreatedUsers);
  afterAll(removeCreatedUsers);

  async function user(): Promise<string> {
    const id = await createTestUser();
    createdUsers.push(id);
    return id;
  }

  it("an email belongs to its sender's subscription, which holds, counts and names it", async () => {
    const userId = await user();
    const messageId = `<${generateUuidv7()}@example.com>`;
    const result = await receiveEmail(userId, { messageId });
    expect(result.success).toBe(true);
    const subscriptionId = result.subscriptionId!;

    const subscription = await subscriptionRow(subscriptionId);
    expect(subscription).toMatchObject({
      type: "email",
      emailSender: "news@example.com",
      unreadCount: 1,
      // The subscription carries the sender's name.
      customTitle: "The News",
      feedId: null,
    });

    const entry = await entryRow(result.entryId!);
    expect(entry.ownerSubscriptionId).toBe(subscriptionId);
    expect(entry.ownerFeedId).toBeNull();
    expect(
      await db
        .select({ subscriptionId: subscriptionEntries.subscriptionId })
        .from(subscriptionEntries)
        .where(
          and(eq(subscriptionEntries.userId, userId), eq(subscriptionEntries.entryId, entry.id))
        )
    ).toEqual([{ subscriptionId }]);

    const listed = await listEntries(db, { userId, type: "email", showSpam: false });
    expect(listed.items).toMatchObject([
      { id: entry.id, subscriptionId, feedTitle: "The News", subscriptionIds: [subscriptionId] },
    ]);

    expect(await receiveEmail(userId, { messageId })).toEqual({
      success: false,
      error: "Duplicate email",
    });
  });

  it("clearing an email subscription's name shows its sender", async () => {
    const userId = await user();
    const { subscriptionId } = await receiveEmail(userId);
    const caller = createCaller(await createAuthContext(userId));

    await caller.subscriptions.update({ id: subscriptionId!, customTitle: "Renamed" });
    const cleared = await caller.subscriptions.update({ id: subscriptionId!, customTitle: null });

    expect(cleared.title).toBe("news@example.com");
  });

  it("unsubscribing blocks the sender only when asked (#1964), with its emails' List-Unsubscribe", async () => {
    const userId = await user();
    const { subscriptionId } = await receiveEmail(userId, {
      listUnsubscribe: "<mailto:leave@example.com>",
    });
    const caller = createCaller(await createAuthContext(userId));

    await caller.subscriptions.delete({ id: subscriptionId! });
    expect(await db.select().from(blockedSenders).where(eq(blockedSenders.userId, userId))).toEqual(
      []
    );
    // Without a block, the sender's next email resubscribes.
    const again = await receiveEmail(userId);
    expect(again.subscriptionId).toBe(subscriptionId);
    expect((await subscriptionRow(subscriptionId!)).unsubscribedAt).toBeNull();

    await caller.subscriptions.delete({ id: subscriptionId!, blockSender: true });
    const [blocked] = await db
      .select()
      .from(blockedSenders)
      .where(eq(blockedSenders.userId, userId));
    expect(blocked).toMatchObject({
      senderEmail: "news@example.com",
      listUnsubscribeMailto: "mailto:leave@example.com",
    });
    expect(await receiveEmail(userId)).toEqual({ success: false, error: "Sender blocked" });
  });

  it("only an active email subscription's own user gets its sender", async () => {
    const userId = await user();
    const otherUserId = await user();
    const { subscriptionId } = await receiveEmail(userId);

    const caller = createCaller(await createAuthContext(userId));
    expect(await caller.subscriptions.getEmailSender({ id: subscriptionId! })).toEqual({
      emailSender: "news@example.com",
    });
    const otherCaller = createCaller(await createAuthContext(otherUserId));
    expect(await otherCaller.subscriptions.getEmailSender({ id: subscriptionId! })).toEqual({
      emailSender: null,
    });

    await unsubscribe(db, userId, subscriptionId!);
    expect(await caller.subscriptions.getEmailSender({ id: subscriptionId! })).toEqual({
      emailSender: null,
    });
  });

  it("a saved article belongs to its user, who alone finds it by URL and deletes it", async () => {
    const [userId, otherId] = [await user(), await user()];
    const url = `https://example.com/${generateUuidv7()}`;
    const saved = await saveArticle(db, userId, { url, html: ARTICLE_HTML, refetch: false });

    const entry = await entryRow(saved.id);
    expect(entry.ownerUserId).toBe(userId);
    expect(entry.ownerFeedId).toBeNull();

    expect(await savedArticleExistsByUrl(db, userId, url)).toBe(saved.id);
    expect(await savedArticleExistsByUrl(db, otherId, url)).toBeNull();
    const again = await saveArticle(db, userId, { url, html: ARTICLE_HTML, refetch: false });
    expect(again).toMatchObject({ id: saved.id, outcome: "existing" });

    const [{ savedSubscriptionId, streamId }] = await db
      .select({ savedSubscriptionId: subscriptions.id, streamId: subscriptions.greaderStreamId })
      .from(subscriptions)
      .where(and(eq(subscriptions.userId, userId), eq(subscriptions.type, "saved")));
    const listed = await listEntries(db, { userId, type: "saved", showSpam: false });
    expect(listed.items).toMatchObject([
      { id: saved.id, subscriptionId: savedSubscriptionId, feedTitle: "Saved Articles" },
    ]);
    // Google Reader's "Saved Articles" stream (#730).
    const greaderIds = await resolveGreaderIdsForEntries(db, userId, [saved.id]);
    expect(greaderIds.get(saved.id)?.originStreamId).toBe(streamId);

    expect(await deleteSavedArticle(db, otherId, saved.id)).toBeNull();
    expect(await deleteSavedArticle(db, userId, saved.id)).not.toBeNull();
    expect(await entryRow(saved.id)).toBeUndefined();
    expect(await deleteSavedArticle(db, userId, saved.id)).toBeNull();
  });
});
