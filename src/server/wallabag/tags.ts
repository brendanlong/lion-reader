/**
 * Wallabag tags are Lion Reader collections (#1822).
 *
 * Like a Wallabag tag, a collection is a set of articles, and an article can be
 * in several. A tag's label is the collection's displayed name and its id is
 * the collection subscription's stored serial (`greader_stream_id`). Labels
 * match case-insensitively: Wallabag lowercases the labels it stores, while
 * collection names keep the case the user typed.
 */

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { db as dbType } from "@/server/db";
import { entries, subscriptionEntries, subscriptions } from "@/server/db/schema";
import { isInt64 } from "@/server/google-reader/id";
import {
  addEntriesToCollection,
  createCollection,
  removeEntriesFromCollection,
} from "@/server/services/collections";
import { isCollectionSubscription, unsubscribe } from "@/server/services/subscriptions";
import { COLLECTION_NAME_MAX_LENGTH, MAX_SAVE_COLLECTIONS } from "@/lib/collections";
import { errors } from "@/server/trpc/errors";
import { formatTag, type WallabagTag } from "./format";

export interface CollectionTag {
  subscriptionId: string;
  label: string;
  greaderStreamId: bigint;
}

const collectionTagSelection = {
  subscriptionId: subscriptions.id,
  // Never NULL for a collection (`subscriptions_collection_named`).
  label: sql<string>`${subscriptions.customTitle}`,
  greaderStreamId: subscriptions.greaderStreamId,
};

function activeCollectionsOf(userId: string) {
  return and(
    eq(subscriptions.userId, userId),
    isNull(subscriptions.unsubscribedAt),
    isCollectionSubscription()
  );
}

export function toWallabagTag(tag: CollectionTag): WallabagTag {
  return formatTag({ id: tag.greaderStreamId, label: tag.label });
}

async function listCollectionTags(db: typeof dbType, userId: string): Promise<CollectionTag[]> {
  return db
    .select(collectionTagSelection)
    .from(subscriptions)
    .where(activeCollectionsOf(userId))
    .orderBy(collectionTagSelection.label, subscriptions.id);
}

export async function listWallabagTags(db: typeof dbType, userId: string): Promise<WallabagTag[]> {
  return (await listCollectionTags(db, userId)).map(toWallabagTag);
}

/** Each entry's tags (the user's collections holding it), keyed by entry id. */
export async function listEntryTags(
  db: typeof dbType,
  userId: string,
  entryIds: string[]
): Promise<Map<string, WallabagTag[]>> {
  const result = new Map<string, WallabagTag[]>(entryIds.map((id) => [id, []]));
  if (entryIds.length === 0) return result;
  const rows = await db
    .select({ entryId: subscriptionEntries.entryId, ...collectionTagSelection })
    .from(subscriptionEntries)
    .innerJoin(subscriptions, eq(subscriptions.id, subscriptionEntries.subscriptionId))
    .where(
      and(
        eq(subscriptionEntries.userId, userId),
        inArray(subscriptionEntries.entryId, entryIds),
        activeCollectionsOf(userId)
      )
    )
    .orderBy(collectionTagSelection.label, subscriptions.id);
  for (const row of rows) {
    result.get(row.entryId)?.push(toWallabagTag(row));
  }
  return result;
}

/**
 * Resolves the `{tag}` path parameter (a tag id, optionally with a `.json`
 * format suffix) to one of the user's collections.
 */
export async function resolveWallabagTag(
  db: typeof dbType,
  userId: string,
  tagParam: string
): Promise<CollectionTag | null> {
  const id = tagParam.replace(/\.(json|xml)$/i, "");
  if (!/^\d+$/.test(id) || !isInt64(BigInt(id))) return null;
  const [row] = await db
    .select(collectionTagSelection)
    .from(subscriptions)
    .where(and(activeCollectionsOf(userId), eq(subscriptions.greaderStreamId, BigInt(id))))
    .limit(1);
  return row ?? null;
}

/**
 * For each label, the ids of the user's collections with that name, or null
 * when some label matches no collection, so a filter on it can match nothing.
 */
export async function collectionIdGroupsForLabels(
  db: typeof dbType,
  userId: string,
  labels: string[]
): Promise<string[][] | null> {
  const byLabel = groupByLabel(await listCollectionTags(db, userId));
  const groups = labels.map((label) => byLabel.get(label.toLowerCase()) ?? []);
  return groups.some((group) => group.length === 0) ? null : groups;
}

function groupByLabel(collections: CollectionTag[]): Map<string, string[]> {
  const byLabel = new Map<string, string[]>();
  for (const collection of collections) {
    const key = collection.label.toLowerCase();
    byLabel.set(key, [...(byLabel.get(key) ?? []), collection.subscriptionId]);
  }
  return byLabel;
}

/**
 * Adds an entry to the collections named by `labels`, creating the missing
 * ones (creating an existing name returns that collection).
 */
export async function addEntryTags(
  db: typeof dbType,
  userId: string,
  entryId: string,
  labels: string[]
): Promise<void> {
  if (labels.length > MAX_SAVE_COLLECTIONS) {
    throw errors.validation(`At most ${MAX_SAVE_COLLECTIONS} tags can be added at once`);
  }
  if (labels.some((label) => label.length > COLLECTION_NAME_MAX_LENGTH)) {
    throw errors.validation(`Tags must be at most ${COLLECTION_NAME_MAX_LENGTH} characters`);
  }
  for (const label of labels) {
    const { subscription } = await createCollection(db, userId, label);
    await addEntriesToCollection(db, userId, subscription.id, [entryId]);
  }
}

/**
 * Deleting a tag removes it from every saved article. The collection itself is
 * deleted only when it holds nothing else: it may also hold feed articles,
 * which a Wallabag client never sees and so can't have meant to remove. Such
 * a collection stays in the tag list.
 */
export async function deleteWallabagTag(
  db: typeof dbType,
  userId: string,
  tag: CollectionTag
): Promise<void> {
  const members = await db
    .select({ entryId: subscriptionEntries.entryId, type: entries.type })
    .from(subscriptionEntries)
    .innerJoin(entries, eq(entries.id, subscriptionEntries.entryId))
    .where(
      and(
        eq(subscriptionEntries.subscriptionId, tag.subscriptionId),
        eq(subscriptionEntries.userId, userId)
      )
    );
  if (members.every((member) => member.type === "saved")) {
    // Deleting the collection takes it off every article.
    await unsubscribe(db, userId, tag.subscriptionId);
    return;
  }
  await removeEntriesFromCollection(
    db,
    userId,
    tag.subscriptionId,
    members.filter((member) => member.type === "saved").map((member) => member.entryId)
  );
}
