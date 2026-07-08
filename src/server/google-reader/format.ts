/**
 * Google Reader API Response Formatting
 *
 * Transforms Lion Reader service data into the JSON format expected
 * by Google Reader clients.
 */

import { uuidToInt64, int64ToLongFormId, subscriptionToStreamId, feedStreamId } from "./id";
import { stateStreamId, labelStreamId } from "./streams";
import type { EntryFull } from "@/server/services/entries";
import type { Subscription } from "@/server/services/subscriptions";
import type { ListTagsResult } from "@/server/services/tags";

// ============================================================================
// Item (Entry) Formatting
// ============================================================================

interface GoogleReaderItem {
  id: string;
  crawlTimeMsec: string;
  timestampUsec: string;
  published: number;
  updated: number;
  title: string;
  canonical: Array<{ href: string }>;
  alternate: Array<{ href: string; type: string }>;
  summary: { direction: string; content: string };
  author: string;
  origin: {
    streamId: string;
    title: string;
    htmlUrl: string;
  };
  categories: string[];
}

/**
 * Formats a full entry (with content) as a Google Reader item.
 */
export function formatEntryAsItem(entry: EntryFull): GoogleReaderItem {
  const itemId = uuidToInt64(entry.id);
  const publishedTs = entry.publishedAt
    ? Math.floor(entry.publishedAt.getTime() / 1000)
    : Math.floor(entry.fetchedAt.getTime() / 1000);
  const updatedTs = Math.floor(entry.updatedAt.getTime() / 1000);
  const crawlTimeMs = entry.fetchedAt.getTime().toString();

  const categories: string[] = [];
  // All items are in the reading list
  categories.push(stateStreamId("reading-list"));
  if (entry.read) {
    categories.push(stateStreamId("read"));
  }
  if (entry.starred) {
    categories.push(stateStreamId("starred"));
  }

  // Build content from cleaned or original HTML
  const content = entry.contentCleaned ?? entry.contentOriginal ?? entry.summary ?? "";

  return {
    id: int64ToLongFormId(itemId),
    crawlTimeMsec: crawlTimeMs,
    timestampUsec: (BigInt(crawlTimeMs) * BigInt(1000)).toString(),
    published: publishedTs,
    updated: updatedTs,
    title: entry.title ?? "",
    canonical: entry.url ? [{ href: entry.url }] : [],
    alternate: entry.url ? [{ href: entry.url, type: "text/html" }] : [],
    summary: {
      direction: "ltr",
      content,
    },
    author: entry.author ?? "",
    origin: {
      // Saved articles have no subscription; address them by their saved-feed id
      // (exposed as the synthetic "Saved Articles" subscription — issue #730) so
      // clients attach them to a known feed instead of dropping an empty origin.
      streamId: entryFeedStreamId(entry) ?? "",
      title: entry.feedTitle ?? "",
      htmlUrl: entry.feedUrl ?? entry.url ?? "",
    },
    categories,
  };
}

/**
 * The `feed/{int64}` stream an entry belongs to, or null if it has none. Regular
 * entries use their subscription's stream id; saved articles (no subscription)
 * use their saved-feed id (the synthetic "Saved Articles" subscription — issue
 * #730). Shared by item formatting and the stream/items/ids item refs so both
 * address saved articles the same way.
 */
export function entryFeedStreamId(entry: {
  subscriptionId: string | null;
  feedId: string;
  type: "web" | "email" | "saved";
}): string | null {
  if (entry.subscriptionId) {
    return subscriptionToStreamId(entry.subscriptionId);
  }
  if (entry.type === "saved") {
    return feedStreamId(entry.feedId);
  }
  return null;
}

// ============================================================================
// Subscription Formatting
// ============================================================================

interface GoogleReaderSubscription {
  id: string;
  title: string;
  categories: Array<{ id: string; label: string }>;
  sortid: string;
  firstitemmsec: string;
  url: string;
  htmlUrl: string;
  iconUrl: string;
}

/**
 * Formats a subscription as a Google Reader subscription object.
 */
export function formatSubscription(sub: Subscription): GoogleReaderSubscription {
  const int64Id = uuidToInt64(sub.id);

  return {
    id: feedStreamId(sub.id),
    title: sub.title ?? "",
    categories: sub.tags.map((tag) => ({
      id: labelStreamId(tag.name),
      label: tag.name,
    })),
    sortid: int64Id.toString(16).padStart(16, "0"),
    firstitemmsec: sub.subscribedAt.getTime().toString(),
    url: sub.url ?? "",
    htmlUrl: sub.siteUrl ?? sub.url ?? "",
    iconUrl: "",
  };
}

// ============================================================================
// Tag Formatting
// ============================================================================

interface GoogleReaderTag {
  id: string;
  sortid?: string;
  type?: string;
}

/**
 * Formats tags as Google Reader tag list.
 * Includes system tags (reading-list, starred) and user labels.
 */
export function formatTagList(tagsResult: ListTagsResult): GoogleReaderTag[] {
  const result: GoogleReaderTag[] = [];

  // System tags
  result.push({
    id: stateStreamId("reading-list"),
    sortid: "00000000",
  });
  result.push({
    id: stateStreamId("starred"),
    sortid: "00000001",
  });

  // User labels (tags)
  for (const tag of tagsResult.items) {
    result.push({
      id: labelStreamId(tag.name),
      sortid: uuidToInt64(tag.id).toString(16).padStart(16, "0"),
      type: "folder",
    });
  }

  return result;
}

// ============================================================================
// Unread Count Formatting
// ============================================================================

interface GoogleReaderUnreadCount {
  id: string;
  count: number;
  newestItemTimestampUsec: string;
}

/**
 * Formats unread counts per subscription for the Google Reader unread-count
 * endpoint. The saved-articles feed arrives as a synthetic subscription in
 * `subscriptions` (issue #730), so it is counted and folded into the
 * reading-list total exactly like a real feed — no special case here.
 *
 * `newestItemTimestampUsec` is the newest visible item's time (from
 * `getGreaderNewestItemAt`, keyed by the same feed-stream id), in microseconds.
 * Clients use it to decide whether a stream has new content since their last sync,
 * so it must reflect the actual newest item and stay stable when nothing changes.
 * The reading-list total carries the newest across all feeds.
 *
 * A feed with unread items normally has a visible entry, so the map is populated
 * for every line we emit. The counts and the newest map are two independent reads,
 * though, so a feed that gains its first visible entry between them can be counted
 * (unread > 0) yet still be absent from the map. `Date.now()` is the fallback for
 * that gap — deliberately, not "0": on such a miss content genuinely did just
 * arrive, so signalling "new" (and prompting one refetch) is correct, and it
 * reverts to the real, earlier item time on the next poll. "0" would instead read
 * as never-updated and risk the client *skipping* the new content — the original
 * bug from deriving this field off the saved feed's epoch `subscribedAt`.
 */
export function formatUnreadCounts(
  subscriptions: Array<{ id: string; unreadCount: number }>,
  newestItemAtById: Map<string, Date>
): {
  max: number;
  unreadcounts: GoogleReaderUnreadCount[];
} {
  const unreadcounts: GoogleReaderUnreadCount[] = [];

  const toUsec = (ms: number): string => (ms * 1000).toString();

  let totalUnread = 0;
  let newestOverallMs = 0;
  for (const sub of subscriptions) {
    if (sub.unreadCount > 0) {
      const newestMs = newestItemAtById.get(sub.id)?.getTime() ?? Date.now();
      unreadcounts.push({
        id: feedStreamId(sub.id),
        count: sub.unreadCount,
        newestItemTimestampUsec: toUsec(newestMs),
      });
      totalUnread += sub.unreadCount;
      newestOverallMs = Math.max(newestOverallMs, newestMs);
    }
  }

  // Add total unread count for reading-list
  if (totalUnread > 0) {
    unreadcounts.push({
      id: stateStreamId("reading-list"),
      count: totalUnread,
      newestItemTimestampUsec: toUsec(newestOverallMs),
    });
  }

  return {
    max: 1000,
    unreadcounts,
  };
}

// ============================================================================
// User Info Formatting
// ============================================================================

export function formatUserInfo(userId: string, email: string) {
  return {
    userId: uuidToInt64(userId).toString(),
    userName: email,
    userProfileId: uuidToInt64(userId).toString(),
    userEmail: email,
    isBloggerUser: false,
    signupTimeSec: 0,
    isMultiLoginEnabled: false,
  };
}
