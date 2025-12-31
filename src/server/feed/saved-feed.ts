/**
 * Saved feed management utilities.
 *
 * Saved articles are stored as entries in a special per-user feed with type='saved'.
 * This module provides utilities for managing these saved feeds.
 */

import { eq, and } from "drizzle-orm";
import type { Database } from "../db";
import { feeds } from "../db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";

/**
 * Gets or creates the user's saved articles feed.
 *
 * This is idempotent - safe to call multiple times.
 * If the saved feed doesn't exist, it will be created.
 * If it already exists, its ID is returned.
 *
 * @param db - Database instance
 * @param userId - User ID
 * @returns The feed ID of the user's saved articles feed
 */
export async function getOrCreateSavedFeed(db: Database, userId: string): Promise<string> {
  // Try to find existing saved feed
  const existing = await db
    .select({ id: feeds.id })
    .from(feeds)
    .where(and(eq(feeds.type, "saved"), eq(feeds.userId, userId)))
    .limit(1);

  if (existing.length > 0) {
    return existing[0].id;
  }

  // Create new saved feed
  const feedId = generateUuidv7();
  const now = new Date();

  await db.insert(feeds).values({
    id: feedId,
    type: "saved",
    userId,
    title: "Saved Articles",
    // URL-based fields are NULL for saved feeds
    url: null,
    emailSenderPattern: null,
    // Metadata fields
    description: null,
    siteUrl: null,
    // Fetch state fields are NULL for saved feeds (not polled)
    etag: null,
    lastModifiedHeader: null,
    lastFetchedAt: null,
    nextFetchAt: null,
    // Error tracking
    consecutiveFailures: 0,
    lastError: null,
    // WebSub fields are NULL for saved feeds
    hubUrl: null,
    selfUrl: null,
    websubActive: false,
    createdAt: now,
    updatedAt: now,
  });

  return feedId;
}
