/**
 * Objects an entry keeps in storage (an uploaded ebook's images): their keys,
 * and their deletion with the entry or account they belong to.
 *
 * An entry's objects live under {@link entryObjectsPrefix}, inside its owner's
 * {@link userObjectsPrefix}, so deleting either is deleting a prefix. That
 * deletion is a `delete_stored_objects` job enqueued in the transaction that
 * deletes the owner, so it can't be lost to a crash and is retried until
 * storage confirms it.
 */

import { randomUUID } from "node:crypto";
import type { DbOrTx } from "@/server/db";
import { createJob } from "@/server/jobs/queue";
import {
  deleteObjectsWithPrefix,
  getPublicObjectUrl,
  isStorageAvailable,
  uploadObject,
} from "@/server/storage/s3";

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

/** Deletes a prefix's objects; `null` when there's no storage to delete from. */
export async function deleteStoredObjects(prefix: string): Promise<number | null> {
  if (!isStorageAvailable()) return null;
  return deleteObjectsWithPrefix(prefix);
}
