/**
 * Migrations 0139–0141 (#1846 phase 6B2): email and saved entries stop naming
 * their per-user feeds, email subscriptions lose theirs (keeping the feed's
 * title as their name), the feeds are deleted, and checks keep it that way.
 * Anything unexpected naming one of those feeds aborts the migration instead
 * of being cascade-deleted.
 *
 * The rows are built as releases before 6B2 wrote them. The schema now forbids
 * them, so each test first puts back the checks 0140 replaces (it replaces
 * them again), all in one transaction. Raw SQL: the factories can't build
 * rows the current schema rejects.
 */

import { readFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "../../src/server/db";
import type { Transaction } from "../../src/server/db";
import { entries, feeds, subscriptions, userEntries, users } from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { processInboundEmail } from "../../src/server/email/process-inbound";
import {
  createTestEntry,
  createTestFeed,
  createTestIngestAddress,
  createTestSubscription,
  createTestUser,
} from "./helpers";

const MIGRATIONS = [
  "0139_clear_personal_feed_owners",
  "0140_delete_personal_feeds",
  "0141_validate_entry_owners",
].map((name) => readFileSync(new URL(`../../migrations/${name}.sql`, import.meta.url), "utf8"));

/** The checks 0140 replaces, as they were before it. */
const CHECKS_BEFORE_0140 = sql`
  ALTER TABLE entries DROP CONSTRAINT entries_owner_matches_type;
  ALTER TABLE subscriptions
    DROP CONSTRAINT subscriptions_feed_iff_web,
    DROP CONSTRAINT subscriptions_named_unless_web,
    ADD CONSTRAINT subscriptions_collection_feedless CHECK (type <> 'collection' OR feed_id IS NULL),
    ADD CONSTRAINT subscriptions_saved_feedless CHECK (type <> 'saved' OR feed_id IS NULL),
    ADD CONSTRAINT subscriptions_collection_named CHECK (type <> 'collection' OR custom_title IS NOT NULL);
  ALTER TABLE feeds
    DROP CONSTRAINT feeds_web_only,
    ADD CONSTRAINT feed_type_user_id CHECK ((type IN ('email', 'saved')) = (user_id IS NOT NULL)),
    ADD CONSTRAINT feeds_type_not_collection CHECK (type <> 'collection');`;

const createdUsers: string[] = [];
const createdFeeds: string[] = [];

async function cleanup(): Promise<void> {
  if (createdFeeds.length > 0) await db.delete(feeds).where(inArray(feeds.id, createdFeeds));
  // Deleting a user cascades to their subscriptions and the entries they own.
  if (createdUsers.length > 0) await db.delete(users).where(inArray(users.id, createdUsers));
  createdFeeds.length = 0;
  createdUsers.length = 0;
}

beforeEach(cleanup);
afterAll(cleanup);

interface Legacy {
  userId: string;
  emailFeedId: string;
  emailSubscriptionId: string;
  emailId: string;
  savedFeedId: string;
  savedId: string;
  webFeedId: string;
  webSubscriptionId: string;
  webEntryId: string;
}

/**
 * A user with an email feed, its email subscription and an email, a saved
 * feed and a saved article, as before 6B2, plus an ordinary web feed. `extra`
 * adds rows a guard should stop at. Then runs the migrations, all in one
 * transaction.
 */
async function migrateFromLegacy(
  extra: (tx: Transaction, legacy: Legacy) => Promise<void> = async () => {}
): Promise<Legacy> {
  const userId = await createTestUser();
  createdUsers.push(userId);
  const webFeedId = await createTestFeed();
  createdFeeds.push(webFeedId);
  const webSubscriptionId = await createTestSubscription(userId, webFeedId);
  const webEntryId = await createTestEntry(webFeedId, { userIds: [userId] });
  const legacy: Legacy = {
    userId,
    emailFeedId: generateUuidv7(),
    emailSubscriptionId: generateUuidv7(),
    emailId: generateUuidv7(),
    savedFeedId: generateUuidv7(),
    savedId: generateUuidv7(),
    webFeedId,
    webSubscriptionId,
    webEntryId,
  };
  await db.transaction(async (tx) => {
    await tx.execute(CHECKS_BEFORE_0140);
    await tx.execute(sql`
      INSERT INTO feeds (id, type, user_id, email_sender_pattern, title) VALUES
        (${legacy.emailFeedId}, 'email', ${userId}, 'news@example.com', 'News Weekly'),
        (${legacy.savedFeedId}, 'saved', ${userId}, NULL, 'Saved Articles')`);
    await tx.execute(sql`
      INSERT INTO subscriptions (id, user_id, feed_id, type, email_sender, custom_title)
      VALUES (${legacy.emailSubscriptionId}, ${userId}, ${legacy.emailFeedId}, 'email', 'news@example.com', '')`);
    await tx.execute(sql`
      INSERT INTO entries (id, owner_feed_id, owner_subscription_id, owner_user_id, type, guid, content_hash, fetched_at)
      VALUES
        (${legacy.emailId}, ${legacy.emailFeedId}, ${legacy.emailSubscriptionId}, NULL, 'email', '<m1@example.com>', 'h', now()),
        (${legacy.savedId}, ${legacy.savedFeedId}, NULL, ${userId}, 'saved', 'https://example.com/a', 'h', now())`);
    await tx.execute(sql`
      INSERT INTO user_entries (user_id, entry_id) VALUES
        (${userId}, ${legacy.emailId}), (${userId}, ${legacy.savedId})`);
    await extra(tx, legacy);
    for (const migration of MIGRATIONS) await tx.execute(sql.raw(migration));
  });
  return legacy;
}

async function entryOwners(ids: string[]) {
  return db
    .select({
      id: entries.id,
      ownerFeedId: entries.ownerFeedId,
      ownerSubscriptionId: entries.ownerSubscriptionId,
      ownerUserId: entries.ownerUserId,
    })
    .from(entries)
    .where(inArray(entries.id, ids))
    .orderBy(entries.id);
}

describe("migrations 0139–0141: per-user feeds go (#1846)", () => {
  it("clears the email and saved rows' feeds, keeps their owners, and deletes the feeds", async () => {
    const legacy = await migrateFromLegacy();

    expect(await entryOwners([legacy.emailId, legacy.savedId, legacy.webEntryId])).toEqual(
      [
        {
          id: legacy.emailId,
          ownerFeedId: null,
          ownerSubscriptionId: legacy.emailSubscriptionId,
          ownerUserId: null,
        },
        {
          id: legacy.savedId,
          ownerFeedId: null,
          ownerSubscriptionId: null,
          ownerUserId: legacy.userId,
        },
        {
          id: legacy.webEntryId,
          ownerFeedId: legacy.webFeedId,
          ownerSubscriptionId: null,
          ownerUserId: null,
        },
      ].sort((a, b) => a.id.localeCompare(b.id))
    );
    const subs = await db
      .select({
        id: subscriptions.id,
        feedId: subscriptions.feedId,
        title: subscriptions.customTitle,
      })
      .from(subscriptions)
      .where(and(eq(subscriptions.userId, legacy.userId), ne(subscriptions.type, "saved")))
      .orderBy(subscriptions.id);
    expect(subs).toEqual(
      [
        // The email subscription keeps its feed's title as its name (a blank
        // custom title counts as none).
        { id: legacy.emailSubscriptionId, feedId: null, title: "News Weekly" },
        { id: legacy.webSubscriptionId, feedId: legacy.webFeedId, title: null },
      ].sort((a, b) => a.id.localeCompare(b.id))
    );
    expect(
      await db
        .select({ id: feeds.id })
        .from(feeds)
        .where(inArray(feeds.id, [legacy.emailFeedId, legacy.savedFeedId, legacy.webFeedId]))
    ).toEqual([{ id: legacy.webFeedId }]);
    // Nothing the users could see went with the feeds.
    expect(
      await db
        .select({ id: userEntries.entryId })
        .from(userEntries)
        .where(eq(userEntries.userId, legacy.userId))
    ).toHaveLength(3);
  });

  it("leaves the next email from the sender in the same subscription", async () => {
    const legacy = await migrateFromLegacy();
    const token = `token-${generateUuidv7()}`;
    await createTestIngestAddress(legacy.userId, { token });

    const result = await processInboundEmail({
      to: `${token}@ingest.lionreader.com`,
      from: { address: "news@example.com", name: "News" },
      subject: "Issue 2",
      messageId: `<${generateUuidv7()}@example.com>`,
      html: "<p>Hi</p>",
      headers: {},
    });

    expect(result.subscriptionId).toBe(legacy.emailSubscriptionId);
    const [row] = await db
      .select({ subscriptionId: userEntries.subscriptionId })
      .from(userEntries)
      .where(and(eq(userEntries.userId, legacy.userId), eq(userEntries.entryId, result.entryId!)));
    expect(row.subscriptionId).toBe(legacy.emailSubscriptionId);
  });

  it("then rejects rows that bring them back", async () => {
    const legacy = await migrateFromLegacy();

    // An entry must have exactly the owner its type calls for.
    await expect(
      db.execute(sql`
        INSERT INTO entries (id, owner_feed_id, owner_user_id, type, guid, content_hash, fetched_at)
        VALUES (${generateUuidv7()}, ${legacy.webFeedId}, ${legacy.userId}, 'saved', 'x', 'h', now())`)
    ).rejects.toMatchObject({ cause: { constraint: "entries_owner_matches_type" } });
    await expect(
      db.execute(sql`
        INSERT INTO entries (id, type, guid, content_hash, fetched_at)
        VALUES (${generateUuidv7()}, 'email', 'y', 'h', now())`)
    ).rejects.toMatchObject({ cause: { constraint: "entries_owner_matches_type" } });
    // Only web subscriptions have a feed, and every other one a name.
    const email = eq(subscriptions.id, legacy.emailSubscriptionId);
    await expect(
      db.update(subscriptions).set({ feedId: legacy.webFeedId }).where(email)
    ).rejects.toMatchObject({ cause: { constraint: "subscriptions_feed_iff_web" } });
    await expect(
      db.update(subscriptions).set({ customTitle: null }).where(email)
    ).rejects.toMatchObject({ cause: { constraint: "subscriptions_named_unless_web" } });
    // Feeds are web feeds.
    await expect(
      db.execute(sql`
        INSERT INTO feeds (id, type, user_id, title)
        VALUES (${generateUuidv7()}, 'saved', ${legacy.userId}, 'Saved Articles')`)
    ).rejects.toMatchObject({ cause: { constraint: "feeds_web_only" } });
  });

  it.each([
    [
      "an entry naming an email feed without the matching owner",
      "0139: 1 entries name an email or saved feed without the matching owner",
      (tx: Transaction, l: Legacy) =>
        tx.execute(sql`
          INSERT INTO entries (id, owner_feed_id, type, guid, content_hash, fetched_at)
          VALUES (${generateUuidv7()}, ${l.emailFeedId}, 'email', '<m2@example.com>', 'h', now())`),
    ],
    [
      "a web entry naming a saved feed",
      "0139: 1 entries name an email or saved feed without the matching owner",
      (tx: Transaction, l: Legacy) =>
        tx.execute(sql`
          INSERT INTO entries (id, owner_feed_id, type, guid, content_hash, fetched_at, last_seen_at)
          VALUES (${generateUuidv7()}, ${l.savedFeedId}, 'web', 'w', 'h', now(), now())`),
    ],
    [
      "a WebSub subscription to an email feed",
      "0140: 1 websub_subscriptions name an email or saved feed",
      (tx: Transaction, l: Legacy) =>
        tx.execute(sql`
          INSERT INTO websub_subscriptions (id, feed_id, hub_url, topic_url, callback_secret)
          VALUES (${generateUuidv7()}, ${l.emailFeedId}, 'https://hub.example', 'https://t.example', 's')`),
    ],
    [
      "a job for a saved feed",
      "0140: 1 jobs name an email or saved feed",
      (tx: Transaction, l: Legacy) =>
        tx.execute(sql`
          INSERT INTO jobs (id, type, payload)
          VALUES (${generateUuidv7()}, 'fetch_feed', ${JSON.stringify({ feedId: l.savedFeedId })}::jsonb)`),
    ],
    [
      "another user's subscription to an email feed",
      "0140: 1 subscriptions name an email or saved feed other than as its email subscription",
      async (tx: Transaction, l: Legacy) => {
        const otherId = await createTestUser();
        createdUsers.push(otherId);
        await tx.execute(sql`
          INSERT INTO subscriptions (id, user_id, feed_id, type, email_sender)
          VALUES (${generateUuidv7()}, ${otherId}, ${l.emailFeedId}, 'email', 'news@example.com')`);
      },
    ],
  ])("stops, deleting nothing, at %s", async (_, message, extra) => {
    let legacyUserId: string | undefined;
    await expect(
      migrateFromLegacy(async (tx, legacy) => {
        legacyUserId = legacy.userId;
        await extra(tx, legacy);
      })
    ).rejects.toMatchObject({ cause: { message } });

    // Rolled back whole, checks included: the per-user feeds were never there.
    expect(
      await db
        .select({ id: feeds.id })
        .from(feeds)
        .where(and(eq(feeds.userId, legacyUserId!)))
    ).toEqual([]);
    expect(
      await db
        .select({ constraint: sql<string>`conname` })
        .from(sql`pg_constraint`)
        .where(sql`conname = 'entries_owner_matches_type' AND convalidated`)
    ).toHaveLength(1);
  });
});
