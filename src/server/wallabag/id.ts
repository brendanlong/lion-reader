/**
 * Wallabag ID Resolution
 *
 * Maps Wallabag integer IDs back to Lion Reader UUIDv7s.
 *
 * Wallabag IDs are 31-bit positive integers derived from a SHA-256 hash
 * of the UUID. The `entries` table has a `wallabag_id` generated column
 * with an index, so reverse lookups are a simple indexed query.
 */

import { eq, and } from "drizzle-orm";
import type { db as dbType } from "@/server/db";
import { visibleEntries } from "@/server/db/schema";

/**
 * Finds an entry UUID given a Wallabag integer ID and user ID.
 *
 * Uses the indexed `wallabag_id` generated column on the entries table,
 * joined through the visible_entries view to enforce user visibility rules.
 */
export async function wallabagIdToUuid(
  db: typeof dbType,
  userId: string,
  wallabagId: number
): Promise<string | null> {
  const result = await db
    .select({ id: visibleEntries.id })
    .from(visibleEntries)
    .where(and(eq(visibleEntries.userId, userId), eq(visibleEntries.wallabagId, wallabagId)))
    .limit(1);

  if (result.length === 0) {
    return null;
  }

  return result[0].id;
}
