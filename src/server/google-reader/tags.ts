/**
 * Google Reader Tag Resolution Helpers
 *
 * Resolves Google Reader tag/label names to Lion Reader tag IDs.
 */

import { eq, and, isNull } from "drizzle-orm";
import type { db as dbType } from "@/server/db";
import { tags } from "@/server/db/schema";
import { tagNameMatches } from "@/server/services/tags";

/**
 * Finds a tag by name (ignoring case, like tag uniqueness) for a given user.
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
    .where(and(eq(tags.userId, userId), tagNameMatches(name), isNull(tags.deletedAt)))
    .limit(1);

  return result[0] ?? null;
}

/**
 * The user's tags with their Google Reader sortids (`tags.greader_sortid`, an
 * opaque serial that's never reversed). Not `listTags`, whose `Tag` type is kept
 * free of the bigint that a JSON MCP response can't serialize.
 */
export async function listGreaderTags(
  db: typeof dbType,
  userId: string
): Promise<{ name: string; greaderSortid: bigint }[]> {
  return db
    .select({ name: tags.name, greaderSortid: tags.greaderSortid })
    .from(tags)
    .where(and(eq(tags.userId, userId), isNull(tags.deletedAt)));
}
