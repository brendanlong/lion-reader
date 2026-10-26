/**
 * Entry owners (#1846): a web entry is owned by its feed (`owner_feed_id`),
 * an email by its subscription (`owner_subscription_id`), a saved article or
 * upload by its user (`owner_user_id`), and only that column is set
 * (`entries_owner_matches_type`; migration tests in `delete-personal-feeds`).
 * Each insert path writes the owner.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db, pool } from "../../src/server/db";
import { entries, subscriptions, users } from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { processInboundEmail } from "../../src/server/email/process-inbound";
import {
  saveArticle,
  savePlaceholderArticle,
  uploadArticle,
} from "../../src/server/services/saved";
import { addEntriesToCollection, createCollection } from "../../src/server/services/collections";
import { deleteUser } from "../../src/server/services/users";
import { createTestEmailSubscription, createTestIngestAddress, createTestUser } from "./helpers";

interface Owner {
  ownerFeedId: string | null;
  ownerSubscriptionId: string | null;
  ownerUserId: string | null;
}

const NONE: Owner = { ownerFeedId: null, ownerSubscriptionId: null, ownerUserId: null };

async function ownerOf(entryId: string): Promise<Owner> {
  const [row] = await db
    .select({
      ownerFeedId: entries.ownerFeedId,
      ownerSubscriptionId: entries.ownerSubscriptionId,
      ownerUserId: entries.ownerUserId,
    })
    .from(entries)
    .where(eq(entries.id, entryId));
  return row;
}

async function receiveEmail(
  userId: string,
  from: string
): Promise<{ entryId: string; subscriptionId: string }> {
  const token = `token-${generateUuidv7()}`;
  await createTestIngestAddress(userId, { token });
  const result = await processInboundEmail(db, {
    to: `${token}@ingest.lionreader.com`,
    from: { address: from, name: "News" },
    subject: "Hello",
    messageId: `<${generateUuidv7()}@example.com>`,
    html: "<p>Hi</p>",
    headers: {},
  });
  expect(result.success).toBe(true);
  const [{ id: subscriptionId }] = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, userId), eq(subscriptions.type, "email")));
  return { entryId: result.entryId!, subscriptionId };
}

const ARTICLE_HTML =
  "<html><body><article><p>A saved article body, long enough.</p></article></body></html>";

const createdUsers: string[] = [];

async function user(): Promise<string> {
  const id = await createTestUser();
  createdUsers.push(id);
  return id;
}

async function cleanup(): Promise<void> {
  // Deleting a user cascades to their subscriptions and the entries they own.
  if (createdUsers.length > 0) await db.delete(users).where(inArray(users.id, createdUsers));
  createdUsers.length = 0;
}

beforeEach(cleanup);
afterEach(cleanup);
afterAll(async () => {
  await pool.end();
});

describe("each insert path writes the owner (#1846)", () => {
  it("an email is owned by its user's subscription to the sender, which records the sender", async () => {
    const userId = await user();
    const { entryId, subscriptionId } = await receiveEmail(userId, "News@Example.com");
    expect(await ownerOf(entryId)).toEqual({ ...NONE, ownerSubscriptionId: subscriptionId });
    const [{ emailSender }] = await db
      .select({ emailSender: subscriptions.emailSender })
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId));
    expect(emailSender).toBe("news@example.com");
  });

  it.each([
    [
      "a saved URL",
      (userId: string) =>
        saveArticle(db, userId, {
          url: `https://example.com/${generateUuidv7()}`,
          html: ARTICLE_HTML,
          refetch: false,
        }),
    ],
    [
      "a placeholder",
      (userId: string) =>
        savePlaceholderArticle(db, userId, {
          url: `https://example.com/${generateUuidv7()}`,
          reason: "unreachable",
        }),
    ],
    [
      "an upload",
      (userId: string) => uploadArticle(db, userId, { content: "# Up\n\nBody", title: "" }),
    ],
  ])("%s is owned by the user", async (_, save) => {
    const userId = await user();
    const { id } = await save(userId);
    expect(await ownerOf(id)).toEqual({ ...NONE, ownerUserId: userId });
  });
});

describe("email_sender", () => {
  it("is unique per user among email subscriptions, not across users", async () => {
    const [alice, bob] = [await user(), await user()];
    await receiveEmail(alice, "news@example.com");
    await receiveEmail(bob, "news@example.com");

    // A second email subscription of Alice's claiming the same sender.
    await expect(
      createTestEmailSubscription(alice, { emailSender: "news@example.com" })
    ).rejects.toMatchObject({ cause: { constraint: "uq_subscriptions_user_email_sender" } });
  });
});

describe("owner cascades", () => {
  // #1897: the emails cascade in the same statement, so their memberships go
  // before their user_entries rows, which the membership trigger must skip.
  // Account deletion takes this path too: nothing else deletes emails.
  it("hard-deleting an email subscription removes its emails (#1897)", async () => {
    const userId = await user();
    const { entryId, subscriptionId } = await receiveEmail(userId, "news@example.com");
    await db.delete(subscriptions).where(eq(subscriptions.id, subscriptionId));
    expect(await db.select().from(entries).where(eq(entries.id, entryId))).toEqual([]);
  });

  it("deleting an account removes its emails and saved articles, which it owns", async () => {
    const userId = await user();
    const email = await receiveEmail(userId, "news@example.com");
    const saved = await uploadArticle(db, userId, { content: "# Up\n\nBody", title: "" });
    const { subscription: collection } = await createCollection(db, userId, "Keep");
    await addEntriesToCollection(db, userId, collection.id, [email.entryId, saved.id]);

    await deleteUser(db, userId);

    expect(
      await db
        .select({ id: entries.id })
        .from(entries)
        .where(inArray(entries.id, [email.entryId, saved.id]))
    ).toEqual([]);
  });
});

describe("owners stay per user", () => {
  it("two users' copies of the same email or saved URL have their own owners", async () => {
    const [alice, bob] = [await user(), await user()];
    const aliceEmail = await receiveEmail(alice, "news@example.com");
    const bobEmail = await receiveEmail(bob, "news@example.com");
    expect((await ownerOf(aliceEmail.entryId)).ownerSubscriptionId).toBe(aliceEmail.subscriptionId);
    expect((await ownerOf(bobEmail.entryId)).ownerSubscriptionId).toBe(bobEmail.subscriptionId);

    const url = `https://example.com/${generateUuidv7()}`;
    const aliceSaved = await saveArticle(db, alice, { url, html: ARTICLE_HTML, refetch: false });
    const bobSaved = await saveArticle(db, bob, { url, html: ARTICLE_HTML, refetch: false });
    expect(aliceSaved.id).not.toBe(bobSaved.id);
    expect((await ownerOf(aliceSaved.id)).ownerUserId).toBe(alice);
    expect((await ownerOf(bobSaved.id)).ownerUserId).toBe(bob);
  });
});
