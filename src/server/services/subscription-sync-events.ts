/**
 * What subscription and tag events carry, shared by the live publishers and
 * the `sync` catch-up so the two can't drift (entries have theirs in
 * `entry-sync-events.ts`). Each builder copies exactly the wire fields, so a
 * caller passing a whole row can't publish its other columns. Pure: no DB, no
 * Redis.
 */

import type { z } from "zod";
import { type serverSyncEventSchema, type syncTagSchema } from "@/lib/events/schemas";
import type { SUBSCRIPTION_TYPES } from "@/lib/entry-types";

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

/**
 * A subscription_created event. `feed` is null for a subscription without
 * one (#1846), which has only its own name; the feed title falls back to the
 * custom title as `user_feeds.original_title` does.
 */
export function subscriptionCreatedEvent(
  subscription: {
    id: string;
    type: (typeof SUBSCRIPTION_TYPES)[number];
    customTitle: string | null;
    subscribedAt: Date;
    unreadCount: number;
    fetchFullContent: boolean;
  },
  tags: SyncTag[],
  feed: {
    url: string | null;
    title: string | null;
    description: string | null;
    siteUrl: string | null;
  } | null
): EventBody<"subscription_created"> {
  return {
    type: "subscription_created",
    subscriptionId: subscription.id,
    subscription: {
      id: subscription.id,
      customTitle: subscription.customTitle,
      subscribedAt: subscription.subscribedAt.toISOString(),
      unreadCount: subscription.unreadCount,
      tags: tags.map(toSyncTag),
      fetchFullContent: subscription.fetchFullContent,
    },
    feed: {
      type: subscription.type,
      url: feed?.url ?? null,
      title: feed?.title ?? subscription.customTitle,
      description: feed?.description ?? null,
      siteUrl: feed?.siteUrl ?? null,
    },
  };
}

/**
 * A subscription_updated event: the subscription's current tags and settings
 * (`fetchFullContent` undefined only when the subscription row is gone).
 */
export function subscriptionUpdatedEvent(
  subscription: { id: string; customTitle: string | null; fetchFullContent: boolean | undefined },
  tags: SyncTag[]
): EventBody<"subscription_updated"> {
  return {
    type: "subscription_updated",
    subscriptionId: subscription.id,
    tags: tags.map(toSyncTag),
    customTitle: subscription.customTitle,
    fetchFullContent: subscription.fetchFullContent,
  };
}
