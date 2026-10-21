/**
 * Objects an entry keeps in storage (an uploaded ebook's images): their keys,
 * and their deletion with the entry or account they belong to.
 *
 * An entry's objects live under {@link entryObjectsPrefix}, inside its owner's
 * {@link userObjectsPrefix}, so deleting either is deleting a prefix. That
 * deletion is a `delete_stored_objects` job enqueued in the transaction that
 * deletes the owner, so it can't be lost to a crash and is retried until
 * storage confirms it. Objects stored for an entry not yet saved are covered
 * the same way, by {@link guardUnsavedEntryObjects}.
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DbOrTx } from "@/server/db";
import { entries } from "@/server/db/schema";
import { createJob, type JobPayloads } from "@/server/jobs/queue";
import {
  deleteObjectsWithPrefix,
  getPublicObjectUrl,
  isStorageAvailable,
  uploadObject,
} from "@/server/storage/s3";

/**
 * How long objects stored for an entry may wait for it to be saved before
 * they're deleted as orphans. Saving follows storing within seconds.
 */
const UNSAVED_ENTRY_GRACE_MS = 60 * 60 * 1000;

export function userObjectsPrefix(userId: string): string {
  return `uploads/${userId}/`;
}

export function entryObjectsPrefix(userId: string, entryId: string): string {
  return `${userObjectsPrefix(userId)}${entryId}/`;
}

/**
 * Stores an image for an entry, returning its public URL. The key's random
 * part keeps the URL unguessable: the bucket is public.
 */
export async function storeEntryImage(
  userId: string,
  entryId: string,
  image: { data: Buffer; mediaType: string; extension: string }
): Promise<string> {
  const key = `${entryObjectsPrefix(userId, entryId)}${randomUUID()}${image.extension}`;
  await uploadObject(key, image.data, image.mediaType);
  const url = getPublicObjectUrl(key);
  if (url === null) throw new Error("Object storage has no public URL");
  return url;
}

/** Queues the deletion of a prefix's objects, in `executor`'s transaction. */
export async function enqueueStoredObjectsDeletion(
  executor: DbOrTx,
  prefix: string
): Promise<void> {
  if (!isStorageAvailable()) return;
  await createJob({ type: "delete_stored_objects", payload: { prefix } }, executor);
}

/**
 * Call before storing objects for an entry that isn't saved yet: if it never
 * is (the save fails, the process dies, or a concurrent save of the same
 * article wins with another id), its objects are deleted once the grace
 * period passes.
 */
export async function guardUnsavedEntryObjects(
  db: DbOrTx,
  userId: string,
  entryId: string
): Promise<void> {
  await createJob(
    {
      type: "delete_stored_objects",
      payload: { prefix: entryObjectsPrefix(userId, entryId), unlessEntryExists: entryId },
      nextRunAt: new Date(Date.now() + UNSAVED_ENTRY_GRACE_MS),
    },
    db
  );
}

/**
 * Runs a `delete_stored_objects` job, returning how many objects it deleted.
 * Throws when storage isn't configured: the job exists because it was.
 */
export async function deleteStoredObjects(
  db: DbOrTx,
  { prefix, unlessEntryExists }: JobPayloads["delete_stored_objects"]
): Promise<number> {
  if (unlessEntryExists !== undefined) {
    const [saved] = await db
      .select({ id: entries.id })
      .from(entries)
      .where(eq(entries.id, unlessEntryExists))
      .limit(1);
    if (saved) return 0;
  }
  return deleteObjectsWithPrefix(prefix);
}
