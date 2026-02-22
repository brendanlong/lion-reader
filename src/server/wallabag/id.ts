/**
 * Wallabag ID Resolution
 *
 * Maps Wallabag integer IDs back to Lion Reader UUIDv7s.
 *
 * Unlike Google Reader's deterministic int64 derivation, Wallabag IDs use
 * a SHA-256 hash which isn't reversible. We resolve IDs by searching the
 * user's visible entries and computing the hash for each candidate.
 *
 * For the entry-by-ID endpoint, we use the `_lion_reader_id` (UUID) directly
 * when available in request parameters, or fall back to scanning.
 */

import { eq } from "drizzle-orm";
import type { db as dbType } from "@/server/db";
import { visibleEntries } from "@/server/db/schema";
import { uuidToWallabagId } from "./format";

/**
 * Finds an entry UUID given a Wallabag integer ID and user ID.
 *
 * Scans the user's visible entries to find one whose hash matches.
 * This is expensive for large datasets, so callers should prefer
 * passing the UUID directly when possible.
 */
export async function wallabagIdToUuid(
  db: typeof dbType,
  userId: string,
  wallabagId: number
): Promise<string | null> {
  // Query entries in batches and check IDs
  const batchSize = 500;
  let offset = 0;
  const maxBatches = 20; // Safety limit: 10,000 entries max

  for (let batch = 0; batch < maxBatches; batch++) {
    const candidates = await db
      .select({ id: visibleEntries.id })
      .from(visibleEntries)
      .where(eq(visibleEntries.userId, userId))
      .limit(batchSize)
      .offset(offset);

    if (candidates.length === 0) break;

    for (const candidate of candidates) {
      if (uuidToWallabagId(candidate.id) === wallabagId) {
        return candidate.id;
      }
    }

    offset += batchSize;
  }

  return null;
}
