/**
 * The archive of pages behind entries' full content (#2115): each fetched page,
 * gzipped, in the private archive bucket. Nothing serves it; it's kept only to
 * re-extract from. Without the archive bucket the page is discarded, since it
 * can be fetched again instead.
 *
 * A page's key names its entry and its content hash, so a write never replaces
 * another page: a refetch adds the new page beside the old, and an archive of
 * a page already there is a no-op.
 */

import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { inArray } from "drizzle-orm";
import type { db as dbType } from "@/server/db";
import { entries } from "@/server/db/schema";
import {
  deleteArchiveObject,
  isArchiveAvailable,
  listArchiveKeys,
  putArchiveObject,
} from "@/server/storage/s3";

const gzipAsync = promisify(gzip);

const KEY_PREFIX = "full-content/";
const KEY_PATTERN =
  /^full-content\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/[0-9a-f]{64}\.html\.gz$/;

function fullContentArchiveKey(entryId: string, html: string): string {
  const hash = createHash("sha256").update(html, "utf8").digest("hex");
  // Postgres reads a UUID in either case; the key must spell it one way.
  return `${KEY_PREFIX}${entryId.toLowerCase()}/${hash}.html.gz`;
}

/** Archives `html` as a page behind `entryId`'s full content (idempotent). */
export async function archiveFullContentOriginal(entryId: string, html: string): Promise<void> {
  if (!isArchiveAvailable()) return;
  await putArchiveObject(
    fullContentArchiveKey(entryId, html),
    await gzipAsync(html),
    "application/gzip"
  );
}

/**
 * Deletes archived pages whose entry no longer exists. Entries are
 * hard-deleted by several cascades (account deletion, deleting a saved
 * article, a feed nobody holds), so the archive is swept rather than cleaned
 * up on each path. An entry deleted mid-sweep is caught by the next one.
 *
 * @returns how many pages were deleted
 */
export async function deleteOrphanedFullContentArchives(db: typeof dbType): Promise<number> {
  if (!isArchiveAvailable()) return 0;

  let deleted = 0;
  for await (const keys of listArchiveKeys(KEY_PREFIX)) {
    const keysByEntryId = new Map<string, string[]>();
    for (const key of keys) {
      const entryId = KEY_PATTERN.exec(key)?.[1];
      if (!entryId) continue;
      keysByEntryId.set(entryId, [...(keysByEntryId.get(entryId) ?? []), key]);
    }
    if (keysByEntryId.size === 0) continue;

    const existing = await db
      .select({ id: entries.id })
      .from(entries)
      .where(inArray(entries.id, [...keysByEntryId.keys()]));
    for (const { id } of existing) keysByEntryId.delete(id);

    for (const key of [...keysByEntryId.values()].flat()) {
      await deleteArchiveObject(key);
      deleted++;
    }
  }
  return deleted;
}
