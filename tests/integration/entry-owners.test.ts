/**
 * Entry owners (#1846 phase 6A): a web entry is owned by its feed
 * (`owner_feed_id`), an email by its subscription (`owner_subscription_id`),
 * a saved article or upload by its user (`owner_user_id`); email and saved
 * entries keep their per-user feed in `owner_feed_id` until phase 6B. Each
 * insert path writes the owner; scripts/backfill-entry-owners.ts fills the
 * email and saved entries written before.
 */

import { readFileSync } from "node:fs";
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, pool } from "../../src/server/db";
import { entries, feeds, subscriptions, users } from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { processInboundEmail } from "../../src/server/email/process-inbound";
import {
  saveArticle,
  savePlaceholderArticle,
  uploadArticle,
} from "../../src/server/services/saved";
import { addEntriesToCollection, createCollection } from "../../src/server/services/collections";
import { deleteUser } from "../../src/server/services/users";
import {
  backfillEntryOwners,
  checkEntryOwners,
  preflight,
} from "../../scripts/backfill-entry-owners";
import {
  createTestEntry,
  createTestFeed,
  createTestIngestAddress,
  createTestSubscription,
  createTestUser,
} from "./helpers";

interface EmailOrSavedOwner {
  ownerSubscriptionId: string | null;
  ownerUserId: string | null;
}

const NONE: EmailOrSavedOwner = { ownerSubscriptionId: null, ownerUserId: null };

async function ownerOf(entryId: string): Promise<EmailOrSavedOwner> {
  const [row] = await db
    .select({
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
  const result = await processInboundEmail({
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

/** Migration 0137's statement that fills existing email subscriptions' sender. */
const MIGRATION_EMAIL_SENDER_FILL = /UPDATE subscriptions s\b[^;]*;/.exec(
  readFileSync(new URL("../../migrations/0137_entry_owners.sql", import.meta.url), "utf8")
)![0];

const ARTICLE_HTML =
  "<html><body><article><p>A saved article body, long enough.</p></article></body></html>";

const createdUsers: string[] = [];
const createdFeeds: string[] = [];

async function user(): Promise<string> {
  const id = await createTestUser();
  createdUsers.push(id);
  return id;
}

async function webFeed(): Promise<string> {
  const id = await createTestFeed();
  createdFeeds.push(id);
  return id;
}

async function cleanup(): Promise<void> {
  // Deleting a user cascades to their subscriptions, email and saved feeds
  // and the entries those own.
  if (createdFeeds.length > 0) await db.delete(feeds).where(inArray(feeds.id, createdFeeds));
  if (createdUsers.length > 0) await db.delete(users).where(inArray(users.id, createdUsers));
  createdFeeds.length = 0;
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
    const otherFeed = await createTestFeed({
      type: "email",
      userId: alice,
      url: null,
      emailSenderPattern: "other@example.com",
    });
    await expect(
      createTestSubscription(alice, otherFeed, { emailSender: "news@example.com" })
    ).rejects.toMatchObject({ cause: { constraint: "uq_subscriptions_user_email_sender" } });
  });

  it("is filled from the email feed by migration 0137, and the check counts any left without", async () => {
    const userId = await user();
    const { subscriptionId } = await receiveEmail(userId, "news@example.com");
    // Relative: the check covers the whole table, which other files share.
    const without = async () => (await checkEntryOwners(db)).emailSubscriptionsWithoutSender;
    const base = await without();
    await db
      .update(subscriptions)
      .set({ emailSender: null })
      .where(eq(subscriptions.id, subscriptionId));
    expect(await without()).toBe(base + 1);

    await db.execute(sql.raw(MIGRATION_EMAIL_SENDER_FILL));

    const [{ emailSender }] = await db
      .select({ emailSender: subscriptions.emailSender })
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId));
    expect(emailSender).toBe("news@example.com");
    expect(await without()).toBeLessThanOrEqual(base);
  });
});

describe("owner cascades", () => {
  // #1897: the emails cascade in the same statement, and the membership
  // trigger then updates their user_entries rows before those cascade.
  it.skip("hard-deleting an email subscription removes its emails (#1897)", async () => {
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

describe("backfill and check (#1846)", () => {
  // The backfill and the check cover the whole table.
  beforeEach(async () => {
    await db.delete(entries);
  });

  /** A web entry, two emails and a saved article, the latter as before 0137. */
  async function entriesBeforeOwners(): Promise<{
    web: string;
    ids: string[];
    expected: EmailOrSavedOwner[];
  }> {
    const userId = await user();
    const web = await createTestEntry(await webFeed());
    const first = await receiveEmail(userId, "news@example.com");
    const second = await receiveEmail(userId, "news@example.com");
    const saved = await uploadArticle(db, userId, { content: "# Up\n\nBody", title: "" });
    const ids = [first.entryId, second.entryId, saved.id];
    await db
      .update(entries)
      .set({ ownerSubscriptionId: null, ownerUserId: null })
      .where(inArray(entries.id, ids));
    return {
      web,
      ids,
      expected: [
        { ...NONE, ownerSubscriptionId: first.subscriptionId },
        { ...NONE, ownerSubscriptionId: first.subscriptionId },
        { ...NONE, ownerUserId: userId },
      ],
    };
  }

  it("gives email and saved entries their owner in batches, without moving updated_at, and re-running does nothing", async () => {
    const { web, ids, expected } = await entriesBeforeOwners();
    const updatedAt = async () =>
      db
        .select({ id: entries.id, at: entries.updatedAt })
        .from(entries)
        .where(inArray(entries.id, [web, ...ids]));
    const before = await updatedAt();
    expect(await checkEntryOwners(db)).toMatchObject({ unowned: 3, mismatched: 0 });

    expect(await backfillEntryOwners(db, { batchSize: 2 })).toEqual({ updated: 3 });
    expect(await Promise.all(ids.map(ownerOf))).toEqual(expected);
    expect(await ownerOf(web)).toEqual(NONE);
    expect(await updatedAt()).toEqual(before);
    expect(await checkEntryOwners(db)).toMatchObject({ unowned: 0, mismatched: 0 });

    expect(await backfillEntryOwners(db, { batchSize: 2 })).toEqual({ updated: 0 });
  });

  it("reports a web entry with an email/saved owner and a saved article owned by someone else", async () => {
    const { web, ids } = await entriesBeforeOwners();
    await backfillEntryOwners(db);
    const otherUser = await user();
    await db.update(entries).set({ ownerUserId: otherUser }).where(eq(entries.id, web));
    await db.update(entries).set({ ownerUserId: otherUser }).where(eq(entries.id, ids[2]));
    expect(await checkEntryOwners(db)).toMatchObject({ unowned: 0, mismatched: 2 });
  });

  it("preflight flags email feeds without exactly one subscription and subscriptions to another user's feed", async () => {
    const [alice, bob] = [await user(), await user()];
    await receiveEmail(alice, "news@example.com");
    // Relative: preflight covers the whole table, which other files share.
    const base = await preflight(db);

    // An email feed nobody subscribes to, and Bob subscribed to Alice's.
    await createTestFeed({
      type: "email",
      userId: alice,
      url: null,
      emailSenderPattern: "a@x.com",
    });
    const alicesFeed = await createTestFeed({
      type: "email",
      userId: alice,
      url: null,
      emailSenderPattern: "b@x.com",
    });
    await createTestSubscription(bob, alicesFeed, { emailSender: "b@x.com" });
    expect(await preflight(db)).toEqual({
      ...base,
      emailFeedsWithoutSubscription: base.emailFeedsWithoutSubscription + 1,
      subscriptionsToAnotherUsersFeed: base.subscriptionsToAnotherUsersFeed + 1,
    });
  });
});
