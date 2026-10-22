/**
 * The archive of pages behind entries' full content (#2115): the whole fetched
 * page, gzipped, in the private archive bucket under the entry's id. Nothing
 * serves it; it's kept only to re-extract from. Without the archive bucket the
 * page is discarded, since it can be fetched again instead.
 */

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
const KEY_SUFFIX = ".html.gz";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** @testonly */
export function fullContentArchiveKey(entryId: string): string {
  return `${KEY_PREFIX}${entryId}${KEY_SUFFIX}`;
}

function entryIdFromKey(key: string): string | null {
  if (!key.startsWith(KEY_PREFIX) || !key.endsWith(KEY_SUFFIX)) return null;
  const id = key.slice(KEY_PREFIX.length, -KEY_SUFFIX.length);
  return UUID_PATTERN.test(id) ? id : null;
}

/** Archives `html` as the page behind `entryId`'s full content (idempotent). */
export async function archiveFullContentOriginal(entryId: string, html: string): Promise<void> {
  if (!isArchiveAvailable()) return;
  await putArchiveObject(fullContentArchiveKey(entryId), await gzipAsync(html), "application/gzip");
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
    const keyByEntryId = new Map<string, string>();
    for (const key of keys) {
      const entryId = entryIdFromKey(key);
      if (entryId) keyByEntryId.set(entryId, key);
    }
    if (keyByEntryId.size === 0) continue;

    const existing = await db
      .select({ id: entries.id })
      .from(entries)
      .where(inArray(entries.id, [...keyByEntryId.keys()]));
    for (const { id } of existing) keyByEntryId.delete(id);

    for (const key of keyByEntryId.values()) {
      await deleteArchiveObject(key);
      deleted++;
    }
  }
  return deleted;
}
