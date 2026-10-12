/**
 * The per-user email and saved feeds, until #1846 phase 6B2 deletes them.
 *
 * Saved articles are owned by their user (`entries.owner_user_id`) and emails
 * by their subscription (`owner_subscription_id`), and every read goes through
 * those. New entries still name their per-user feed in `owner_feed_id` while
 * that column is NOT NULL, which the previous release's reads rely on during a
 * rollout.
 */

import { sql } from "drizzle-orm";
import type { DbOrTx } from "../db";
import { feeds } from "../db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";

/** Title given to every per-user saved-articles feed. */
export const SAVED_FEED_TITLE = "Saved Articles";

/**
 * Whether new email and saved entries must still name a per-user feed in
 * `owner_feed_id`: true until 6B2's migration drops the column's NOT NULL and
 * deletes those feeds, after which none may be created.
 *
 * Temporary, so this release runs on the schema both before and after 6B2;
 * 6B2's code removes it with the per-user feeds. Ask inside the transaction
 * that writes the entry: a write racing 6B2's migration fails (a foreign key
 * or check violation) rather than writing a bad row, and its caller retries
 * (Mailgun redelivers; a save reports the error).
 */
export async function personalFeedsRequired(db: DbOrTx): Promise<boolean> {
  const result = await db.execute<{ required: boolean }>(sql`
    SELECT attnotnull AS required FROM pg_attribute
    WHERE attrelid = 'entries'::regclass AND attname = 'owner_feed_id'`);
  return result.rows[0]?.required ?? false;
}

/**
 * Gets or creates the user's saved articles feed, which new saved entries name
 * in `owner_feed_id` while {@link personalFeedsRequired}.
 *
 * Idempotent: INSERT ON CONFLICT handles a concurrent first save.
 */
export async function getOrCreateSavedFeed(db: DbOrTx, userId: string): Promise<string> {
  const now = new Date();

  // ON CONFLICT DO NOTHING + RETURNING yields the inserted row only when we
  // actually created the feed (empty on conflict); otherwise read the existing one.
  const inserted = await db
    .insert(feeds)
    .values({
      id: generateUuidv7(),
      type: "saved",
      userId,
      title: SAVED_FEED_TITLE,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: feeds.id });

  if (inserted.length > 0) {
    return inserted[0].id;
  }

  const result = await db.execute<{ id: string }>(
    sql`SELECT id FROM feeds WHERE type = 'saved' AND user_id = ${userId} LIMIT 1`
  );
  return result.rows[0].id;
}
