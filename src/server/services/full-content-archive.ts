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
import type { DbOrTx } from "@/server/db";
import { createJobs } from "@/server/jobs/queue";
import { deleteObjectsWithPrefix, isArchiveAvailable, putArchiveObject } from "@/server/storage/s3";

const gzipAsync = promisify(gzip);

const KEY_PREFIX = "full-content/";

/**
 * Entries per deletion job, here and in `stored-objects.ts`. Each costs a list
 * request, so this keeps a job well inside `DEFAULT_JOB_TIMEOUT_MS` however
 * many entries a delete removes.
 */
export const DELETION_JOB_ENTRIES = 200;

function fullContentArchiveKey(entryId: string, html: string): string {
  const hash = createHash("sha256").update(html, "utf8").digest("hex");
  // Postgres reads a UUID in either case; the key must spell it one way.
  return `${KEY_PREFIX}${entryId.toLowerCase()}/${hash}.html.gz`;
}

/**
 * Archives `html` as a page behind `entryId`'s full content (idempotent).
 *
 * @returns whether it did: false when there's no archive bucket
 */
export async function archiveFullContentOriginal(entryId: string, html: string): Promise<boolean> {
  if (!isArchiveAvailable()) return false;
  await putArchiveObject(
    fullContentArchiveKey(entryId, html),
    await gzipAsync(html),
    "application/gzip"
  );
  return true;
}

/**
 * Queues deletion of the archived pages of `entryIds`, which `executor` is
 * hard-deleting: pass the deleting transaction, so the job commits with the
 * delete. Entries never fetched have no pages, so callers pass only those with
 * a `full_content_fetched_at`.
 */
export async function enqueueFullContentArchiveDeletion(
  executor: DbOrTx,
  entryIds: string[]
): Promise<void> {
  if (!isArchiveAvailable()) return;
  const payloads = [];
  for (let i = 0; i < entryIds.length; i += DELETION_JOB_ENTRIES) {
    payloads.push({ entryIds: entryIds.slice(i, i + DELETION_JOB_ENTRIES) });
  }
  await createJobs("delete_full_content_archives", payloads, executor);
}

/**
 * Deletes every archived page of `entryIds` (idempotent). Throws when the
 * archive refuses or isn't configured (the job exists because it was), so the
 * job retries.
 *
 * @returns how many pages were deleted
 */
export async function deleteFullContentArchives(entryIds: string[]): Promise<number> {
  let deleted = 0;
  for (const entryId of entryIds) {
    deleted += await deleteObjectsWithPrefix("archive", `${KEY_PREFIX}${entryId.toLowerCase()}/`);
  }
  return deleted;
}
