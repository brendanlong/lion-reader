/**
 * One SSE connection's view of Redis pub/sub: which channels it follows, and
 * how each message becomes the event this user's client receives. The route
 * (`src/app/api/v1/events/route.ts`) owns auth, the stream and the heartbeat,
 * and hands us `send`.
 */

import { db } from "@/server/db";
import { subscriptions } from "@/server/db/schema";
import { isWebSubscription } from "@/server/services/subscriptions";
import { getBulkEntryRelatedCounts, type BulkUnreadCounts } from "@/server/services/counts";
import { listEntryTagLists } from "@/server/services/entry-tag-lists";
import {
  createPubSubSubscription,
  getFeedEventsChannel,
  getUserEventsChannel,
  getSiteStatusChannel,
  parseFeedEvent,
  parseUserEvent,
  parseSiteStatusEvent,
  type EntryUpdatedMetadata,
  type UserEvent,
} from "@/server/redis/pubsub";
import { eq, and, isNull } from "drizzle-orm";
import type {
  TagLists,
  NewEntryListData,
  entryUpdatedEventSchema,
  newEntryEventSchema,
} from "@/lib/events/schemas";
import type { z } from "zod";
import { trackSSEEventSent } from "@/server/metrics/metrics";
import type { EntryType } from "@/lib/entry-types";
import { logger } from "@/lib/logger";

/**
 * Gets a mapping of feedId -> subscriptionId for a user's active web
 * subscriptions. This lets the connection transform feed events (which use
 * feedId) into subscription-centric events (which use subscriptionId) for the
 * client. Only web feeds publish on feed channels: email and saved entries
 * arrive on the user's channel, and collections have no entries of their own.
 */
export async function getUserFeedSubscriptionMap(userId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({
      feedId: subscriptions.feedId,
      subscriptionId: subscriptions.id,
    })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, userId),
        isNull(subscriptions.unsubscribedAt),
        isWebSubscription()
      )
    );

  const map = new Map<string, string>();
  for (const row of rows) {
    if (row.feedId !== null) map.set(row.feedId, row.subscriptionId);
  }
  return map;
}

/**
 * The fields of an entry event the client receives, whichever channel it came
 * from: a web feed's (with the subscription looked up here) or the user's own
 * (with the subscription already on the event).
 */
interface ClientEntryEvent {
  subscriptionId: string | null;
  entryId: string;
  timestamp: string;
  updatedAt: string;
}

/** A user event's `feedId` only routes feed channels here: clients only ever see subscription IDs. */
function withoutFeedId(event: UserEvent): object {
  if (!("feedId" in event)) return event;
  const clientEvent: Partial<typeof event> = { ...event };
  delete clientEvent.feedId;
  return clientEvent;
}

/**
 * Formats an SSE event message for user events.
 * Includes an `id` field with server timestamp for client sync cursor tracking.
 */
function formatSSEUserEvent(event: UserEvent): string {
  const cursor = new Date().toISOString();
  return `event: ${event.type}\nid: ${cursor}\ndata: ${JSON.stringify(withoutFeedId(event))}\n\n`;
}

interface SseConnectionOptions {
  userId: string;
  /** From `getUserFeedSubscriptionMap`; the connection keeps it current and owns it from here. */
  feedSubscriptions: Map<string, string>;
  /** Writes one formatted SSE message to the client. */
  send: (data: string) => void;
}

export interface SseConnection {
  /**
   * Settles once every initial channel is subscribed; rejects if any
   * subscribe fails, which leaves the connection unusable.
   */
  subscribed: Promise<void>;
  /** Releases every channel. Nothing is sent afterwards. */
  close(): void;
}

/**
 * Subscribes to the user's channel, the site-status channel and each of
 * `feedSubscriptions`' feed channels, and forwards their events through
 * `send` in Redis-delivery order. Returns null when Redis isn't configured.
 */
export function startSseConnection({
  userId,
  feedSubscriptions,
  send,
}: SseConnectionOptions): SseConnection | null {
  const userEventsChannel = getUserEventsChannel(userId);
  // The single global site-status channel (announcement banner broadcasts).
  const siteStatusChannel = getSiteStatusChannel();

  let closed = false;
  const subscribedFeedChannels = new Set<string>();

  /**
   * Serializes event delivery so clients receive events in Redis-delivery
   * order even though new_entry needs an async count query before sending.
   * Without this, a new_entry carrying an older counts snapshot could
   * arrive after a newer count-bearing event (e.g. entry_state_changed)
   * and briefly regress the badge, and two new_entry queries could
   * complete out of order.
   */
  let sendChain: Promise<void> = Promise.resolve();
  function enqueueSend(task: () => void | Promise<void>): void {
    sendChain = sendChain
      .then(() => (closed ? undefined : task()))
      .catch((err) => {
        logger.error("Failed to deliver SSE event", {
          userId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  /**
   * The new_entry events queued and not yet sent, and the subscriptions
   * they're in: see sendNewEntry.
   */
  let queuedNewEntries = 0;
  const queuedNewEntrySubscriptionIds = new Set<string>();
  /** Queued new_entry ids whose tag lists aren't read yet, and those read but not sent. */
  const queuedNewEntryIds = new Set<string>();
  const queuedTagLists = new Map<string, TagLists>();

  /**
   * An entry's tag lists, per user (a web feed's event is shared by every
   * subscriber). The first new_entry of a burst reads every queued one's in a
   * single lookup; undefined when that lookup failed.
   */
  async function takeQueuedTagLists(entryId: string): Promise<TagLists | undefined> {
    if (!queuedTagLists.has(entryId)) {
      // Itself too: an entry queued twice in a burst was taken by the first.
      const entryIds = [...queuedNewEntryIds.add(entryId)];
      queuedNewEntryIds.clear();
      try {
        for (const [id, lists] of await listEntryTagLists(db, userId, entryIds)) {
          queuedTagLists.set(id, lists);
        }
      } catch (err) {
        logger.error("Failed to read new_entry tag lists", {
          userId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const tagLists = queuedTagLists.get(entryId);
    queuedTagLists.delete(entryId);
    return tagLists;
  }

  /** Counts for every queued new_entry's subscription, which the last one queued carries. */
  async function readQueuedNewEntryCounts(): Promise<BulkUnreadCounts | undefined> {
    const subscriptionIds = [...queuedNewEntrySubscriptionIds];
    queuedNewEntrySubscriptionIds.clear();
    try {
      return await getBulkEntryRelatedCounts(
        db,
        userId,
        subscriptionIds.map((id) => ({ subscriptionId: id }))
      );
    } catch (err) {
      // Leave counts off; the client skips the count update and it
      // self-heals on the next count-bearing event or refetch.
      logger.error("Failed to compute new_entry counts", {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  /**
   * Sends a new_entry event, whether it came from a web feed's channel or
   * the user's channel.
   */
  function sendNewEntry(
    // `feedType` only decides the counts; clients get the payload's `type`.
    event: ClientEntryEvent & {
      feedType: EntryType;
      subscriptionIds?: string[];
      entry?: NewEntryListData;
    }
  ): void {
    // The user's absolute unread counts go with the event so the client
    // sets counts directly instead of applying a +1 delta. That makes
    // new_entry idempotent: a reconnect catch-up sync can re-deliver the
    // same entry without double-counting. All write paths publish
    // new_entry only after the user_entries fanout, so the entry is
    // counted by the time this query runs. A fetch's new entries arrive
    // as a burst, and one snapshot after the last covers them all, so
    // only the last new_entry queued carries counts, for every
    // subscription the queued ones are in.
    const { subscriptionId } = event;
    queuedNewEntries++;
    // Saved's count is the global `saved` one (it's in no tag or Uncategorized).
    if (subscriptionId && event.feedType !== "saved") {
      queuedNewEntrySubscriptionIds.add(subscriptionId);
    }
    queuedNewEntryIds.add(event.entryId);
    enqueueSend(async () => {
      queuedNewEntries--;
      const carriesCounts = queuedNewEntries === 0;
      const tagLists = await takeQueuedTagLists(event.entryId);
      // Without them the client can't place the entry, so it isn't sent (its
      // lists pick it up on their next fetch), and the queued subscriptions'
      // counts wait for the next new_entry.
      if (!tagLists) return;
      const counts = carriesCounts ? await readQueuedNewEntryCounts() : undefined;
      if (closed) return;
      const cursor = new Date().toISOString();
      send(
        `event: new_entry\nid: ${cursor}\ndata: ${JSON.stringify({
          type: "new_entry",
          subscriptionId,
          // A new entry's one membership is its origin (#1846).
          subscriptionIds: event.subscriptionIds ?? (subscriptionId ? [subscriptionId] : []),
          tagLists,
          entryId: event.entryId,
          timestamp: event.timestamp,
          updatedAt: event.updatedAt,
          ...(counts ? { counts } : {}),
          // List-item data (absent for spam) lets the client insert the
          // entry into cached lists.
          ...(event.entry ? { entry: event.entry } : {}),
        } satisfies z.input<typeof newEntryEventSchema>)}\n\n`
      );
      trackSSEEventSent("new_entry");
    });
  }

  /** Sends an entry_updated event, with metadata so the client can update caches directly. */
  function sendEntryUpdated(event: ClientEntryEvent & { metadata: EntryUpdatedMetadata }): void {
    enqueueSend(() => {
      const cursor = new Date().toISOString();
      send(
        `event: entry_updated\nid: ${cursor}\ndata: ${JSON.stringify({
          type: "entry_updated",
          subscriptionId: event.subscriptionId,
          entryId: event.entryId,
          timestamp: event.timestamp,
          updatedAt: event.updatedAt, // Database updated_at for cursor tracking
          metadata: event.metadata,
        } satisfies z.input<typeof entryUpdatedEventSchema>)}\n\n`
      );
      trackSSEEventSent("entry_updated");
    });
  }

  /** Handles messages from this connection's channels on the shared subscriber. */
  function handleMessage(channel: string, message: string): void {
    // Global site-status events (announcement banner), forwarded as-is.
    if (channel === siteStatusChannel) {
      const event = parseSiteStatusEvent(message);
      if (!event) return;
      enqueueSend(() => {
        const cursor = new Date().toISOString();
        send(`event: ${event.type}\nid: ${cursor}\ndata: ${JSON.stringify(event)}\n\n`);
        trackSSEEventSent(event.type);
      });
      return;
    }

    // User events (subscriptions, tags, imports, entry state, single-recipient entries)
    if (channel === userEventsChannel) {
      const event = parseUserEvent(message);
      if (!event) return;

      // Keep the feed -> subscription mapping current so feed events can be
      // subscribed to / resolved. Per-user counts on new_entry are computed
      // from the DB, so no tag bookkeeping is needed. (Done synchronously,
      // outside the send chain, so channel membership updates aren't delayed
      // behind pending count queries.)
      if (event.type === "subscription_created") {
        // Only a web subscription has a feed channel.
        if (event.feedId !== null) subscribeToFeed(event.feedId, event.subscriptionId);
      } else if (event.type === "subscription_deleted") {
        if (event.feedId !== null) unsubscribeFromFeed(event.feedId);
      } else if (event.type === "new_entry") {
        sendNewEntry(event);
        return;
      } else if (event.type === "entry_updated") {
        sendEntryUpdated(event);
        return;
      }

      enqueueSend(() => {
        send(formatSSEUserEvent(event));
        trackSSEEventSent(event.type);
      });
      return;
    }

    // Web feed events (new_entry, entry_updated), translating the shared feed
    // into this user's subscription for the client.
    if (subscribedFeedChannels.has(channel)) {
      const event = parseFeedEvent(message);
      if (!event) return;

      const subscriptionId = feedSubscriptions.get(event.feedId) ?? null;
      if (event.type === "new_entry") {
        sendNewEntry({ ...event, subscriptionId });
      } else {
        sendEntryUpdated({ ...event, subscriptionId });
      }
    }
  }

  const subscription = createPubSubSubscription(handleMessage);
  if (!subscription) return null;

  const subscribeToFeed = (feedId: string, subscriptionId: string): void => {
    if (closed) return;

    const channel = getFeedEventsChannel(feedId);
    if (subscribedFeedChannels.has(channel)) return;

    subscribedFeedChannels.add(channel);
    feedSubscriptions.set(feedId, subscriptionId);
    subscription.subscribe(channel).catch((err) => {
      logger.error("Failed to subscribe to SSE feed channel", {
        userId,
        feedId,
        error: err instanceof Error ? err.message : String(err),
      });
      subscribedFeedChannels.delete(channel);
      feedSubscriptions.delete(feedId);
    });
  };

  const unsubscribeFromFeed = (feedId: string): void => {
    if (closed) return;

    const channel = getFeedEventsChannel(feedId);
    if (!subscribedFeedChannels.has(channel)) return;

    subscribedFeedChannels.delete(channel);
    feedSubscriptions.delete(feedId);
    subscription.unsubscribe(channel);
  };

  const feedChannels = Array.from(feedSubscriptions.keys(), getFeedEventsChannel);
  for (const channel of feedChannels) {
    subscribedFeedChannels.add(channel);
  }
  const subscribed = subscription.subscribe(userEventsChannel, siteStatusChannel, ...feedChannels);

  return {
    subscribed,
    close(): void {
      if (closed) return;
      closed = true;
      subscription.close();
    },
  };
}
