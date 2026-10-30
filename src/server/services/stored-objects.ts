/**
 * Objects an entry keeps in storage (its images): their keys, and their
 * deletion with the entry or account they belong to.
 *
 * A user's entry keeps its objects under {@link entryObjectsPrefix}, inside its
 * owner's {@link userObjectsPrefix}, so deleting either is deleting a prefix:
 * a `delete_stored_objects` job enqueued in the transaction that deletes the
 * entry or user, so it can't be lost to a crash and is retried until storage
 * confirms it. A feed's entry has none: anyone can publish a feed, so its
 * images stay inline until per-feed limits exist (#2188). Objects stored for
 * an entry whose save then fails stay until its owner's account is deleted;
 * nobody has their URLs.
 */

import { createHash } from "node:crypto";
import type { DbOrTx } from "@/server/db";
import { createJobs, DELETION_JOB_ENTRIES } from "@/server/jobs/queue";
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

/**
 * Queues the deletion of the prefixes' objects, in `executor`'s transaction:
 * pass the one deleting their owners.
 */
export async function enqueueStoredObjectsDeletion(
  executor: DbOrTx,
  prefixes: string[]
): Promise<void> {
  if (!isStorageAvailable()) return;
  const payloads = [];
  for (let i = 0; i < prefixes.length; i += DELETION_JOB_ENTRIES) {
    payloads.push({ prefixes: prefixes.slice(i, i + DELETION_JOB_ENTRIES) });
  }
  await createJobs("delete_stored_objects", payloads, executor);
}

/**
 * Deletes the prefixes' objects (idempotent), returning how many. Throws when
 * storage refuses or isn't configured (the job exists because it was), so the
 * job retries.
 */
export async function deleteStoredObjects(prefixes: string[]): Promise<number> {
  let deleted = 0;
  for (const prefix of prefixes) {
    deleted += await deleteObjectsWithPrefix("public", prefix);
  }
  return deleted;
}
