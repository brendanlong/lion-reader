/**
 * One SSE connection's view of Redis pub/sub: which channels it follows, and
 * how each message becomes the event this user's client receives. The route
 * (`src/app/api/v1/events/route.ts`) owns auth, the stream and the heartbeat,
 * and hands us `send`.
 */

import { db } from "@/server/db";
import { subscriptions } from "@/server/db/schema";
import { isListedSubscription, isWebSubscription } from "@/server/services/subscriptions";
import { getBulkEntryRelatedCounts, type BulkUnreadCounts } from "@/server/services/counts";
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
  NewEntryListData,
  entryUpdatedEventSchema,
  newEntryEventSchema,
} from "@/lib/events/schemas";
import type { z } from "zod";
import { trackSSEEventSent } from "@/server/metrics/metrics";
import type { EntryType } from "@/lib/entry-types";
import { logger } from "@/lib/logger";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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

/** subscriptionId -> custom title for the user's active subscriptions. */
async function getUserCustomTitles(userId: string): Promise<Map<string, string | null>> {
  const rows = await db
    .select({ id: subscriptions.id, customTitle: subscriptions.customTitle })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, userId),
        isNull(subscriptions.unsubscribedAt),
        // Saved articles show "Saved Articles", not the saved subscription's name.
        isListedSubscription()
      )
    );
  return new Map(rows.map((row) => [row.id, row.customTitle]));
}

/**
 * A new_entry list-item payload as this user sees it: publishers stamp the
 * feed's own title (a web feed's channel is shared, and email ingestion
 * doesn't look the title up), so the user's custom title for the subscription
 * replaces it here, matching what `entries.list` returns for the same entry.
 */
function withCustomFeedTitle(
  entry: NewEntryListData,
  customTitle: string | null | undefined
): NewEntryListData {
  return customTitle == null ? entry : { ...entry, feedTitle: customTitle };
}

/**
 * The fields of an entry event the client receives, whichever channel it came
 * from: a web feed's (with the subscription looked up here) or, for email and
 * saved entries, the user's own (with the subscription already on the event).
 */
interface ClientEntryEvent {
  subscriptionId: string | null;
  entryId: string;
  timestamp: string;
  updatedAt: string;
  feedType: EntryType;
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

  // subscriptionId -> custom title, for new_entry payloads. Loaded only
  // once the user channel is subscribed, so a rename can't fall between
  // the load and the channel; a title an event set first wins over it.
  const customTitles = new Map<string, string | null>();
  const titlesSetByEvents = new Set<string>();
  let markCustomTitlesLoaded = (): void => {};
  const customTitlesLoaded = new Promise<void>((resolve) => {
    markCustomTitlesLoaded = resolve;
  });
  function setCustomTitle(subscriptionId: string, title: string | null): void {
    titlesSetByEvents.add(subscriptionId);
    customTitles.set(subscriptionId, title);
  }

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
        logger.error("Failed to deliver SSE event", { userId, error: errorMessage(err) });
      });
  }

  /**
   * Sends a new_entry event, whether it came from a web feed's channel or
   * (email, saved) the user's channel.
   */
  function sendNewEntry(event: ClientEntryEvent & { entry?: NewEntryListData }): void {
    // Compute this user's absolute unread counts and send them with the
    // event so the client sets counts directly instead of applying a +1
    // delta. That makes new_entry idempotent: a reconnect catch-up sync
    // can re-deliver the same entry without double-counting. All write
    // paths publish new_entry only after the user_entries fanout, so
    // the entry is in visible_entries by the time this query runs.
    // This is a per-subscriber query on the feed fan-out path, the same
    // order as the per-subscriber user_entries inserts the worker
    // already does for each new entry.
    const { subscriptionId } = event;
    enqueueSend(async () => {
      await customTitlesLoaded;
      let counts: BulkUnreadCounts | undefined;
      try {
        // The saved subscription has no list of its own; Saved is a global count.
        counts = await getBulkEntryRelatedCounts(
          db,
          userId,
          event.feedType === "saved" ? [] : [{ subscriptionId }]
        );
      } catch (err) {
        // Leave counts off; the client skips the count update and it
        // self-heals on the next count-bearing event or refetch.
        logger.error("Failed to compute new_entry counts", { userId, error: errorMessage(err) });
      }
      const cursor = new Date().toISOString();
      send(
        `event: new_entry\nid: ${cursor}\ndata: ${JSON.stringify({
          type: "new_entry",
          subscriptionId,
          // A new entry's one membership is its origin (#1846).
          subscriptionIds: subscriptionId ? [subscriptionId] : [],
          entryId: event.entryId,
          timestamp: event.timestamp,
          updatedAt: event.updatedAt,
          feedType: event.feedType,
          ...(counts ? { counts } : {}),
          // List-item data (absent from events published by a previous
          // release) lets the client insert the entry into cached lists.
          // Saved articles have no subscription, so keep their own title.
          ...(event.entry
            ? {
                entry: withCustomFeedTitle(
                  event.entry,
                  subscriptionId ? customTitles.get(subscriptionId) : null
                ),
              }
            : {}),
        } satisfies z.input<typeof newEntryEventSchema>)}\n\n`
      );
      trackSSEEventSent("new_entry");
    });
  }

  /** Sends an entry_updated event, with metadata so the client can update caches directly. */
  function sendEntryUpdated(
    event: Omit<ClientEntryEvent, "feedType"> & { metadata: EntryUpdatedMetadata }
  ): void {
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

    // User events (subscriptions, tags, imports, entry state, email and saved entries)
    if (channel === userEventsChannel) {
      const event = parseUserEvent(message);
      if (!event) return;

      // Keep the feed -> subscription mapping current so feed events can be
      // subscribed to / resolved. Per-user counts on new_entry are computed
      // from the DB, so no tag bookkeeping is needed. (Done synchronously,
      // outside the send chain, so channel membership updates aren't delayed
      // behind pending count queries.)
      if (event.type === "subscription_created") {
        // Email entries need the title too, though they come on this channel.
        setCustomTitle(event.subscriptionId, event.subscription.customTitle);
        if (event.feed.type === "web" && event.feedId !== null) {
          subscribeToFeed(event.feedId, event.subscriptionId);
        }
      } else if (event.type === "subscription_updated") {
        setCustomTitle(event.subscriptionId, event.customTitle);
      } else if (event.type === "subscription_deleted") {
        setCustomTitle(event.subscriptionId, null);
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

  function subscribeToFeed(feedId: string, subscriptionId: string): void {
    if (closed || !subscription) return;

    const channel = getFeedEventsChannel(feedId);
    if (subscribedFeedChannels.has(channel)) return;

    subscribedFeedChannels.add(channel);
    feedSubscriptions.set(feedId, subscriptionId);
    subscription.subscribe(channel).catch((err) => {
      logger.error("Failed to subscribe to SSE feed channel", {
        userId,
        feedId,
        error: errorMessage(err),
      });
      subscribedFeedChannels.delete(channel);
      feedSubscriptions.delete(feedId);
    });
  }

  function unsubscribeFromFeed(feedId: string): void {
    if (closed || !subscription) return;

    const channel = getFeedEventsChannel(feedId);
    if (!subscribedFeedChannels.has(channel)) return;

    subscribedFeedChannels.delete(channel);
    feedSubscriptions.delete(feedId);
    subscription.unsubscribe(channel);
  }

  const feedChannels = Array.from(feedSubscriptions.keys(), getFeedEventsChannel);
  for (const channel of feedChannels) {
    subscribedFeedChannels.add(channel);
  }
  const subscribed = subscription.subscribe(userEventsChannel, siteStatusChannel, ...feedChannels);
  subscribed
    .then(
      async () => {
        for (const [id, title] of await getUserCustomTitles(userId)) {
          if (!titlesSetByEvents.has(id)) customTitles.set(id, title);
        }
      },
      () => {} // a failed subscribe is the caller's to handle
    )
    .catch((err) => {
      // new_entry then carries the feed's own title; nothing else breaks.
      logger.error("Failed to load subscription custom titles", {
        userId,
        error: errorMessage(err),
      });
    })
    .finally(markCustomTitlesLoaded);

  return {
    subscribed,
    close(): void {
      if (closed) return;
      closed = true;
      subscription.close();
    },
  };
}
