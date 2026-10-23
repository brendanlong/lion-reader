/**
 * Which tag and Uncategorized lists hold an entry, read from those lists' own
 * rows (`tag_entries`), for the `tagLists` clients place entries by
 * (`src/FRONTEND_STATE.md`).
 */

import { and, eq, inArray } from "drizzle-orm";
import type { DbOrTx } from "@/server/db";
import { tagEntries } from "@/server/db/schema";
import type { TagLists } from "@/lib/events/schemas";

/** Each entry's tag lists, in one primary-key lookup; every id gets an answer. */
export async function listEntryTagLists(
  db: DbOrTx,
  userId: string,
  entryIds: readonly string[]
): Promise<Map<string, TagLists>> {
  const byEntry = new Map<string, TagLists>(
    entryIds.map((entryId) => [entryId, { tagIds: [], uncategorized: false }])
  );
  if (entryIds.length === 0) return byEntry;
  const rows = await db
    .select({ entryId: tagEntries.entryId, listId: tagEntries.listId })
    .from(tagEntries)
    .where(and(eq(tagEntries.userId, userId), inArray(tagEntries.entryId, [...byEntry.keys()])));
  for (const row of rows) {
    const lists = byEntry.get(row.entryId)!;
    // Uncategorized's list id is the user's.
    if (row.listId === userId) lists.uncategorized = true;
    else lists.tagIds.push(row.listId);
  }
  return byEntry;
}

/**
 * Adds each entry's {@link listEntryTagLists} to it, read alongside `entries`
 * (which must be among `entryIds`).
 */
export async function withTagLists<T extends { id: string }>(
  db: DbOrTx,
  userId: string,
  entryIds: readonly string[],
  entries: T[] | PromiseLike<T[]>
): Promise<Array<T & { tagLists: TagLists }>> {
  const [rows, tagLists] = await Promise.all([entries, listEntryTagLists(db, userId, entryIds)]);
  return rows.map((row) => ({ ...row, tagLists: tagLists.get(row.id)! }));
}
