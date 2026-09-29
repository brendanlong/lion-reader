/**
 * Tombstones for hard-deleted entries, so delta-sync clients (the native app's
 * offline store) learn about deletions they would otherwise never see — a
 * deleted row just stops appearing in `sync.events`.
 *
 * Kept for {@link ENTRY_TOMBSTONE_RETENTION_MS}; a client whose deletions cursor
 * is older than that has missed some and must resync.
 */

import { sql } from "drizzle-orm";
import type { DbOrTx } from "@/server/db";
import { entryTombstones } from "@/server/db/schema";

export const ENTRY_TOMBSTONE_RETENTION_MS = 60 * 24 * 60 * 60 * 1000;

export async function recordEntryTombstone(
  db: DbOrTx,
  userId: string,
  entryId: string
): Promise<void> {
  await db
    .insert(entryTombstones)
    .values({ userId, entryId })
    .onConflictDoUpdate({
      target: [entryTombstones.userId, entryTombstones.entryId],
      set: { deletedAt: sql`now()` },
    });
}

export async function pruneEntryTombstones(db: DbOrTx, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - ENTRY_TOMBSTONE_RETENTION_MS);
  const result = await db
    .delete(entryTombstones)
    .where(sql`${entryTombstones.deletedAt} < ${cutoff.toISOString()}::timestamptz`);
  return result.rowCount ?? 0;
}
