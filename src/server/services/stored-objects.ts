/**
 * Objects an entry keeps in storage (its images): their keys, and their
 * deletion with the entry or account they belong to.
 *
 * A user's entry keeps its objects under {@link entryObjectsPrefix}, inside its
 * owner's {@link userObjectsPrefix}, so deleting either is deleting a prefix.
 * A feed's entry, which belongs to no user, keeps them under
 * {@link feedEntryObjectsPrefix}; nothing deletes those yet (#2187). That
 * deletion is a `delete_stored_objects` job enqueued in the transaction that
 * deletes the owner, so it can't be lost to a crash and is retried until
 * storage confirms it. Objects stored for an entry whose save then fails
 * stay until its owner's account is deleted; nobody has their URLs.
 */

import { createHash } from "node:crypto";
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

export function feedEntryObjectsPrefix(feedId: string, entryId: string): string {
  return `feeds/${feedId}/${entryId}/`;
}

/**
 * Stores an image for an entry, returning its public URL. The key ends in the
 * image's hash, so storing the same image for the entry again (a retry) is
 * one object; the entry's id in it keeps the URL unguessable, since the
 * bucket is public, and lets deleting the entry delete its images.
 */
export async function storeEntryImage(
  userId: string,
  entryId: string,
  image: { data: Buffer; mediaType: string; extension: string }
): Promise<string> {
  const hash = createHash("sha256").update(image.data).digest("hex");
  const key = `${entryObjectsPrefix(userId, entryId)}${hash}${image.extension}`;
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
 * Queues the deletion of the stored objects of `entryIds`, saved articles
 * `executor` is hard-deleting: pass the deleting transaction.
 */
export async function enqueueEntriesObjectsDeletion(
  executor: DbOrTx,
  userId: string,
  entryIds: string[]
): Promise<void> {
  for (const entryId of entryIds) {
    await enqueueStoredObjectsDeletion(executor, entryObjectsPrefix(userId, entryId));
  }
}

/**
 * Deletes a prefix's objects (idempotent), returning how many. Throws when
 * storage refuses or isn't configured (the job exists because it was), so the
 * job retries.
 */
export function deleteStoredObjects(prefix: string): Promise<number> {
  return deleteObjectsWithPrefix("public", prefix);
}
