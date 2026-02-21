/**
 * Google Reader Tag Resolution Helpers
 *
 * Resolves Google Reader tag/label names to Lion Reader tag IDs.
 */

import { eq, and, isNull } from "drizzle-orm";
import type { db as dbType } from "@/server/db";
import { tags } from "@/server/db/schema";

/**
 * Finds a tag by name for a given user.
 * Returns the tag row or null if not found.
 */
export async function resolveTagByName(
  db: typeof dbType,
  userId: string,
  name: string
): Promise<{ id: string; name: string } | null> {
  const result = await db
    .select({ id: tags.id, name: tags.name })
    .from(tags)
    .where(and(eq(tags.userId, userId), eq(tags.name, name), isNull(tags.deletedAt)))
    .limit(1);

  return result[0] ?? null;
}
