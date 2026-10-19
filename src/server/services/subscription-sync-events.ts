/**
 * What subscription and tag events carry, shared by the live publishers and
 * the `sync` catch-up so the two can't drift (entries have theirs in
 * `entry-sync-events.ts`). Each builder copies exactly the wire fields, so a
 * caller passing a whole row can't publish its other columns. Pure: no DB, no
 * Redis.
 */

import type { z } from "zod";
import {
  type serverSyncEventSchema,
  type SyncSubscription,
  type syncTagSchema,
} from "@/lib/events/schemas";
import type { Subscription } from "@/server/services/subscriptions";

type ServerSyncEvent = z.infer<typeof serverSyncEventSchema>;
/** An event without the stamps (and counts) its publisher or catch-up adds. */
type EventBody<T extends ServerSyncEvent["type"]> = Omit<
  Extract<ServerSyncEvent, { type: T }>,
  "timestamp" | "updatedAt" | "counts"
>;
type SyncTag = z.infer<typeof syncTagSchema>;

export function toSyncTag(tag: SyncTag): SyncTag {
  return { id: tag.id, name: tag.name, color: tag.color };
}

function toSyncSubscription(row: Subscription): SyncSubscription {
  return {
    id: row.id,
    type: row.type,
    url: row.url,
    title: row.title,
    originalTitle: row.originalTitle,
    description: row.description,
    siteUrl: row.siteUrl,
    subscribedAt: row.subscribedAt.toISOString(),
    unreadCount: row.unreadCount,
    unreadCountAsOf: row.unreadCountAsOf,
    tags: row.tags.map(toSyncTag),
    fetchFullContent: row.fetchFullContent,
  };
}

/** A subscription_created event: the subscription's row and the deprecated fields. */
export function subscriptionCreatedEvent(row: Subscription): EventBody<"subscription_created"> {
  const syncRow = toSyncSubscription(row);
  return {
    type: "subscription_created",
    subscriptionId: row.id,
    row: syncRow,
    subscription: {
      id: syncRow.id,
      customTitle: syncRow.title,
      subscribedAt: syncRow.subscribedAt,
      unreadCount: syncRow.unreadCount,
      tags: syncRow.tags,
      fetchFullContent: syncRow.fetchFullContent,
    },
    feed: {
      type: syncRow.type,
      url: syncRow.url,
      title: syncRow.originalTitle,
      description: syncRow.description,
      siteUrl: syncRow.siteUrl,
    },
  };
}

/** A subscription_updated event: the subscription's row and the deprecated fields. */
export function subscriptionUpdatedEvent(row: Subscription): EventBody<"subscription_updated"> {
  const syncRow = toSyncSubscription(row);
  return {
    type: "subscription_updated",
    subscriptionId: row.id,
    row: syncRow,
    tags: syncRow.tags,
    customTitle: syncRow.title,
    fetchFullContent: syncRow.fetchFullContent,
  };
}
